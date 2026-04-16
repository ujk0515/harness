#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const SUBJECT_PATTERN =
  /^\[(Batch\d+)\]\[(R\d+)\]\[(planner|designer|developer|qa|tester|secretary)\]\s+(.+)$/;
const DEFAULT_ROLE_ORDER = [
  "planner",
  "designer",
  "developer",
  "qa",
  "tester",
  "secretary",
];

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}

function resolveProjectRoot() {
  return process.env.CLAUDE_PROJECT_DIR || path.resolve(__dirname, "..", "..");
}

function resolvePath(inputPath) {
  if (path.isAbsolute(inputPath)) {
    return inputPath;
  }
  return path.join(resolveProjectRoot(), inputPath);
}

function ensureDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function writeJsonFile(filePath, payload) {
  ensureDir(filePath);
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function appendJsonLine(filePath, payload) {
  ensureDir(filePath);
  fs.appendFileSync(filePath, `${JSON.stringify(payload)}\n`, "utf8");
}

function getByPath(target, fieldPath) {
  return fieldPath.split(".").reduce((acc, key) => {
    if (acc == null) {
      return undefined;
    }
    return acc[key];
  }, target);
}

function parseJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(resolvePath(filePath), "utf8"));
}

function nowIso() {
  return new Date().toISOString();
}

function defaultState() {
  return {
    schema_version: "1.1.0-draft",
    updated_at: nowIso(),
    gate_mode: "enforce",
    subject_pattern: SUBJECT_PATTERN.source,
    roots: {
      claims: "workspace/claims",
      evidence: "workspace/evidence",
      tickets: "workspace/tickets",
    },
    current_batch_id: null,
    tasks: [],
    batches: [],
  };
}

function loadState() {
  const statePath = resolvePath("workspace/planning/request-state.json");
  if (!fs.existsSync(statePath)) {
    const state = defaultState();
    writeJsonFile(statePath, state);
    return state;
  }

  const state = parseJsonFile(statePath);
  if (!state.schema_version) {
    state.schema_version = "1.1.0-draft";
  }
  if (!state.gate_mode) {
    state.gate_mode = "enforce";
  }
  if (!state.subject_pattern) {
    state.subject_pattern = SUBJECT_PATTERN.source;
  }
  if (!state.roots) {
    state.roots = defaultState().roots;
  }
  if (!Array.isArray(state.tasks)) {
    state.tasks = [];
  }
  if (!Array.isArray(state.batches)) {
    state.batches = [];
  }
  return state;
}

function saveState(state) {
  state.updated_at = nowIso();
  const statePath = resolvePath("workspace/planning/request-state.json");
  writeJsonFile(statePath, state);
}

function parseTaskSubject(subject) {
  const matched = SUBJECT_PATTERN.exec(subject || "");
  if (!matched) {
    return null;
  }

  return {
    batch_id: matched[1],
    item_id: matched[2],
    role: matched[3],
    summary: matched[4],
  };
}

function printJson(payload) {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

function checkFileExists(filePath) {
  return fs.existsSync(resolvePath(filePath));
}

function checkDirHasEntries(dirPath) {
  const fullPath = resolvePath(dirPath);
  if (!fs.existsSync(fullPath) || !fs.statSync(fullPath).isDirectory()) {
    return false;
  }
  return fs.readdirSync(fullPath).length > 0;
}

function checkFileContains(filePath, needle) {
  if (!checkFileExists(filePath)) {
    return false;
  }
  const content = fs.readFileSync(resolvePath(filePath), "utf8");
  return content.includes(needle);
}

function checkJsonFieldEquals(filePath, fieldPath, expected) {
  if (!checkFileExists(filePath)) {
    return false;
  }
  const target = parseJsonFile(filePath);
  return String(getByPath(target, fieldPath)) === String(expected);
}

function checkJsonFieldTruthy(filePath, fieldPath) {
  if (!checkFileExists(filePath)) {
    return false;
  }
  const target = parseJsonFile(filePath);
  return Boolean(getByPath(target, fieldPath));
}

function checkMtimeAfter(filePath, isoString) {
  if (!checkFileExists(filePath)) {
    return false;
  }
  const stat = fs.statSync(resolvePath(filePath));
  return stat.mtimeMs > Date.parse(isoString);
}

function loadChecklistDefinitions() {
  return parseJsonFile("workflow/checklists/task-gate-checklists.json");
}

function buildRoleState(roleName, required = true) {
  return {
    role: roleName,
    required,
    status: "todo",
    attempt: 0,
    checklist: [],
    claim_path: null,
    done_ticket: {
      status: "none",
      path: null,
      validated_at: null,
      validated_by: null,
    },
    skip_ticket: {
      status: "none",
      path: null,
      validated_at: null,
      validated_by: null,
    },
    predecessor_roles: DEFAULT_ROLE_ORDER.filter((role) => role !== roleName).slice(
      0,
      Math.max(DEFAULT_ROLE_ORDER.indexOf(roleName), 0)
    ),
    artifacts: [],
    missing_items: [],
    last_error: null,
    last_updated_at: nowIso(),
  };
}

function ensureBatch(state, batchId) {
  let batchIndex = state.batches.findIndex((entry) => entry.batch_id === batchId);
  if (batchIndex === -1) {
    state.batches.push({
      batch_id: batchId,
      created_at: nowIso(),
      items: [],
    });
    batchIndex = state.batches.length - 1;
  }
  return { batch: state.batches[batchIndex], batchIndex };
}

function ensureItem(batch, itemId, summary) {
  let itemIndex = batch.items.findIndex((entry) => entry.item_id === itemId);
  if (itemIndex === -1) {
    batch.items.push({
      item_id: itemId,
      title: summary || itemId,
      role_order: [...DEFAULT_ROLE_ORDER],
      retry_limit: 3,
      roles: DEFAULT_ROLE_ORDER.map((roleName) => buildRoleState(roleName, true)),
    });
    itemIndex = batch.items.length - 1;
  }
  return { item: batch.items[itemIndex], itemIndex };
}

function ensureRoleState(item, role) {
  let roleIndex = item.roles.findIndex((entry) => entry.role === role);
  if (roleIndex === -1) {
    item.roles.push(buildRoleState(role, true));
    roleIndex = item.roles.length - 1;
  }
  return { roleState: item.roles[roleIndex], roleIndex };
}

function getStateContext(state, meta) {
  const { batch, batchIndex } = ensureBatch(state, meta.batch_id);
  const { item, itemIndex } = ensureItem(batch, meta.item_id, meta.summary);
  const { roleState, roleIndex } = ensureRoleState(item, meta.role);

  state.current_batch_id = meta.batch_id;
  return {
    batch,
    batchIndex,
    item,
    itemIndex,
    roleState,
    roleIndex,
  };
}

function getTicketPath(state, meta, ticketKind) {
  return path.join(
    resolvePath(state.roots.tickets),
    meta.batch_id,
    meta.item_id,
    `${meta.role}.${ticketKind}.json`
  );
}

function getClaimPath(state, meta) {
  return path.join(
    resolvePath(state.roots.claims),
    meta.batch_id,
    meta.item_id,
    `${meta.role}.claim.json`
  );
}

function upsertTaskRegistry(state, payload, meta, lifecycle) {
  const taskId = payload.task_id || `${meta ? `${meta.batch_id}-${meta.item_id}-${meta.role}` : "unknown"}-${payload.hook_event_name || "event"}`;
  const index = state.tasks.findIndex((entry) => entry.task_id === taskId);
  const next = {
    task_id: taskId,
    task_subject: payload.task_subject || null,
    task_description: payload.task_description || null,
    teammate_name: payload.teammate_name || null,
    team_name: payload.team_name || null,
    batch_id: meta ? meta.batch_id : null,
    item_id: meta ? meta.item_id : null,
    role: meta ? meta.role : null,
    lifecycle,
    last_event_at: nowIso(),
  };

  if (index === -1) {
    state.tasks.push(next);
  } else {
    state.tasks[index] = {
      ...state.tasks[index],
      ...next,
    };
  }
}

function collectPredecessorFailures(item, currentRole) {
  const order = item.role_order || DEFAULT_ROLE_ORDER;
  const currentIndex = order.indexOf(currentRole);
  if (currentIndex <= 0) {
    return [];
  }

  return order
    .slice(0, currentIndex)
    .map((roleName) => item.roles.find((entry) => entry.role === roleName))
    .filter(Boolean)
    .filter((entry) => entry.required !== false)
    .filter(
      (entry) =>
        entry.done_ticket.status !== "issued" &&
        entry.skip_ticket.status !== "issued"
    )
    .map((entry) => `${entry.role} done/skip ticket missing`);
}

function substituteCommand(template, context) {
  return template
    .replace(/\{batch_id\}/g, context.batch_id)
    .replace(/\{item_id\}/g, context.item_id)
    .replace(/\{role\}/g, context.role)
    .replace(/\{batch_index\}/g, String(context.batch_index))
    .replace(/\{item_index\}/g, String(context.item_index))
    .replace(/\{role_index\}/g, String(context.role_index));
}

function runChecklist(state, context, checklistEntries) {
  return checklistEntries.map((entry) => {
    const command = substituteCommand(entry.command, context);
    const result = spawnSync(command, {
      cwd: resolveProjectRoot(),
      shell: true,
      encoding: "utf8",
    });

    return {
      id: entry.id,
      label: entry.label,
      command,
      status: result.status === 0 ? "pass" : "fail",
      evidence_paths: [],
      stdout: (result.stdout || "").trim(),
      stderr: (result.stderr || "").trim(),
    };
  });
}

function writeTicket(state, meta, ticketKind, payload) {
  const filePath = getTicketPath(state, meta, ticketKind);
  writeJsonFile(filePath, payload);
  return filePath;
}

function issueTicket(state, meta, roleState, ticketKind, payload) {
  const filePath = writeTicket(state, meta, ticketKind, payload);
  const target = ticketKind === "skip" ? roleState.skip_ticket : roleState.done_ticket;

  target.status = "issued";
  target.path = path.relative(resolveProjectRoot(), filePath);
  target.validated_at = payload.validated_at;
  target.validated_by = payload.validated_by;
  roleState.last_updated_at = payload.validated_at;
}

function rejectDoneTicket(state, meta, roleState, payload) {
  const filePath = writeTicket(state, meta, "rejected", payload);
  roleState.done_ticket.status = "rejected";
  roleState.done_ticket.path = path.relative(resolveProjectRoot(), filePath);
  roleState.done_ticket.validated_at = payload.validated_at;
  roleState.done_ticket.validated_by = payload.validated_by;
  roleState.last_updated_at = payload.validated_at;
}

function buildTicketPayload(state, meta, payload) {
  return {
    schema_version: state.schema_version,
    status: payload.status,
    ticket_kind: payload.ticket_kind,
    validated_at: payload.validated_at,
    validated_by: "validator.js",
    batch_id: meta.batch_id,
    item_id: meta.item_id,
    role: meta.role,
    task_subject: payload.task_subject,
    teammate_name: payload.teammate_name || null,
    checklist: payload.checklist,
    artifacts: payload.artifacts,
    predecessor_tickets: payload.predecessor_tickets,
    reason: payload.reason || null,
  };
}

function stderrBlock(message) {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

function stopTeammate(reason) {
  process.stdout.write(
    `${JSON.stringify({
      continue: false,
      stopReason: reason,
    })}\n`
  );
  process.exit(0);
}

async function readHookPayload() {
  const raw = await readStdin();
  if (!raw.trim()) {
    return null;
  }

  const parsed = JSON.parse(raw);
  const taskMeta = parsed.task_subject ? parseTaskSubject(parsed.task_subject) : null;
  appendJsonLine(resolvePath("workspace/reports/hook-events.jsonl"), {
    logged_at: nowIso(),
    hook_event_name: parsed.hook_event_name || "unknown",
    task_meta: taskMeta,
    payload: parsed,
  });
  return { payload: parsed, meta: taskMeta };
}

function summarizeFailures(failures) {
  return failures.join("; ");
}

async function handleTaskCreated() {
  const hookInput = await readHookPayload();
  if (!hookInput) {
    return;
  }

  const { payload, meta } = hookInput;
  const state = loadState();

  if (!meta) {
    saveState(state);
    if (state.gate_mode === "enforce") {
      stderrBlock(
        `Task subject must match ${SUBJECT_PATTERN.source}. Example: [Batch8][R17][tester] summary`
      );
    }
    return;
  }

  const context = getStateContext(state, meta);
  const retryLimit = context.item.retry_limit || 3;
  if (
    context.roleState.done_ticket.status !== "issued" &&
    context.roleState.skip_ticket.status !== "issued" &&
    context.roleState.attempt >= retryLimit
  ) {
    upsertTaskRegistry(state, payload, meta, "completion_blocked");
    saveState(state);
    stopTeammate(
      `Retry limit reached for ${meta.batch_id}/${meta.item_id}/${meta.role}. Escalate to user.`
    );
  }

  const predecessorFailures = collectPredecessorFailures(context.item, meta.role);
  context.roleState.claim_path = path.relative(resolveProjectRoot(), getClaimPath(state, meta));
  context.roleState.status = "in_progress";
  context.roleState.last_error = predecessorFailures.length
    ? summarizeFailures(predecessorFailures)
    : null;
  context.roleState.last_updated_at = nowIso();

  upsertTaskRegistry(state, payload, meta, "created");
  saveState(state);

  if (state.gate_mode === "enforce" && predecessorFailures.length > 0) {
    stderrBlock(
      `Blocked ${meta.role} task for ${meta.batch_id}/${meta.item_id}: ${summarizeFailures(predecessorFailures)}`
    );
  }
}

async function handleTaskCompleted() {
  const hookInput = await readHookPayload();
  if (!hookInput) {
    return;
  }

  const { payload, meta } = hookInput;
  const state = loadState();

  if (!meta) {
    saveState(state);
    if (state.gate_mode === "enforce") {
      stderrBlock(
        `Task completion blocked: task subject must match ${SUBJECT_PATTERN.source}`
      );
    }
    return;
  }

  const context = getStateContext(state, meta);
  const checklistDefinitions = loadChecklistDefinitions();
  const checks = checklistDefinitions.roles[meta.role] || [];
  const predecessorFailures = collectPredecessorFailures(context.item, meta.role);
  const retryLimit = context.item.retry_limit || 3;

  context.roleState.attempt += 1;
  context.roleState.claim_path = path.relative(resolveProjectRoot(), getClaimPath(state, meta));
  context.roleState.artifacts = context.roleState.artifacts || [];
  context.roleState.status = "done";
  context.roleState.last_updated_at = nowIso();
  saveState(state);

  const checklistContext = {
    batch_id: meta.batch_id,
    item_id: meta.item_id,
    role: meta.role,
    batch_index: context.batchIndex,
    item_index: context.itemIndex,
    role_index: context.roleIndex,
  };
  const results = runChecklist(state, checklistContext, checks);
  context.roleState.checklist = results.map((entry) => ({
    id: entry.id,
    label: entry.label,
    command: entry.command,
    status: entry.status,
    evidence_paths: entry.evidence_paths,
  }));

  const failedChecks = results.filter((entry) => entry.status !== "pass");
  const failures = [
    ...predecessorFailures,
    ...failedChecks.map((entry) => `${entry.id}: ${entry.label}`),
  ];

  upsertTaskRegistry(
    state,
    payload,
    meta,
    failures.length > 0 ? "completion_blocked" : "completed"
  );

  const predecessorTicketPaths = (context.item.roles || [])
    .filter(
      (entry) =>
        entry.role !== meta.role &&
        (entry.done_ticket.status === "issued" || entry.skip_ticket.status === "issued")
    )
    .map((entry) => entry.done_ticket.path || entry.skip_ticket.path)
    .filter(Boolean);

  if (failures.length > 0) {
    const validatedAt = nowIso();
    context.roleState.status = "blocked";
    context.roleState.missing_items = failures;
    context.roleState.last_error = summarizeFailures(failures);
    context.roleState.last_updated_at = validatedAt;

    rejectDoneTicket(
      state,
      meta,
      context.roleState,
      buildTicketPayload(state, meta, {
        status: "rejected",
        ticket_kind: "done",
        validated_at: validatedAt,
        task_subject: payload.task_subject || null,
        teammate_name: payload.teammate_name || null,
        checklist: context.roleState.checklist,
        artifacts: context.roleState.artifacts,
        predecessor_tickets: predecessorTicketPaths,
        reason: summarizeFailures(failures),
      })
    );
    saveState(state);

    if (context.roleState.attempt >= retryLimit) {
      stopTeammate(
        `Retry limit reached for ${meta.batch_id}/${meta.item_id}/${meta.role}. Missing: ${summarizeFailures(failures)}`
      );
    }

    if (state.gate_mode === "enforce") {
      stderrBlock(
        `Task completion blocked for ${meta.batch_id}/${meta.item_id}/${meta.role}: ${summarizeFailures(failures)}`
      );
    }
    return;
  }

  const validatedAt = nowIso();
  context.roleState.status = "done";
  context.roleState.missing_items = [];
  context.roleState.last_error = null;
  context.roleState.last_updated_at = validatedAt;

  issueTicket(
    state,
    meta,
    context.roleState,
    "done",
    buildTicketPayload(state, meta, {
      status: "issued",
      ticket_kind: "done",
      validated_at: validatedAt,
      task_subject: payload.task_subject || null,
      teammate_name: payload.teammate_name || null,
      checklist: context.roleState.checklist,
      artifacts: context.roleState.artifacts,
      predecessor_tickets: predecessorTicketPaths,
      reason: null,
    })
  );

  saveState(state);
}

async function handleTeammateIdle() {
  const hookInput = await readHookPayload();
  if (!hookInput) {
    return;
  }

  const { payload } = hookInput;
  const state = loadState();
  const activeTask = [...state.tasks]
    .reverse()
    .find(
      (entry) =>
        entry.teammate_name &&
        payload.teammate_name &&
        entry.teammate_name === payload.teammate_name &&
        entry.lifecycle !== "completed"
    );

  if (!activeTask || !activeTask.batch_id || !activeTask.item_id || !activeTask.role) {
    return;
  }

  const meta = {
    batch_id: activeTask.batch_id,
    item_id: activeTask.item_id,
    role: activeTask.role,
    summary: activeTask.task_subject || activeTask.item_id,
  };
  const context = getStateContext(state, meta);
  saveState(state);

  const retryLimit = context.item.retry_limit || 3;
  if (
    context.roleState.done_ticket.status !== "issued" &&
    context.roleState.skip_ticket.status !== "issued" &&
    context.roleState.attempt >= retryLimit
  ) {
    stopTeammate(
      `Retry limit reached for ${activeTask.batch_id}/${activeTask.item_id}/${activeTask.role}. Escalate to user.`
    );
  }

  if (
    state.gate_mode === "enforce" &&
    context.roleState.done_ticket.status !== "issued" &&
    context.roleState.skip_ticket.status !== "issued"
  ) {
    stderrBlock(
      `${activeTask.role} cannot go idle without a done/skip ticket for ${activeTask.batch_id}/${activeTask.item_id}`
    );
  }
}

function handleIssueSkip(args) {
  const [batchId, itemId, role, ...reasonParts] = args;
  const reason = reasonParts.join(" ").trim();
  if (!batchId || !itemId || !role || !reason) {
    printJson({
      ok: false,
      error: "usage: validator.js issue-skip BatchN RN role reason",
    });
    process.exit(1);
  }

  const state = loadState();
  const meta = {
    batch_id: batchId,
    item_id: itemId,
    role,
    summary: itemId,
  };
  const context = getStateContext(state, meta);
  const validatedAt = nowIso();

  context.roleState.status = "skipped";
  context.roleState.required = false;
  context.roleState.missing_items = [];
  context.roleState.last_error = reason;
  context.roleState.last_updated_at = validatedAt;

  issueTicket(
    state,
    meta,
    context.roleState,
    "skip",
    buildTicketPayload(state, meta, {
      status: "issued",
      ticket_kind: "skip",
      validated_at: validatedAt,
      task_subject: null,
      teammate_name: null,
      checklist: [],
      artifacts: [],
      predecessor_tickets: [],
      reason,
    })
  );

  saveState(state);
  printJson({
    ok: true,
    batch_id: batchId,
    item_id: itemId,
    role,
    skip_ticket: context.roleState.skip_ticket.path,
    reason,
  });
}

function handleParseSubject(subject) {
  const parsed = parseTaskSubject(subject);
  if (!parsed) {
    printJson({
      ok: false,
      subject,
      pattern: SUBJECT_PATTERN.source,
    });
    process.exit(1);
  }

  printJson({
    ok: true,
    subject,
    parsed,
    pattern: SUBJECT_PATTERN.source,
  });
}

function handleCheck(args) {
  const [type, ...rest] = args;
  let ok = false;

  switch (type) {
    case "file_exists":
      ok = checkFileExists(rest[0]);
      break;
    case "dir_has_entries":
      ok = checkDirHasEntries(rest[0]);
      break;
    case "file_contains":
      ok = checkFileContains(rest[0], rest.slice(1).join(" "));
      break;
    case "json_field_equals":
      ok = checkJsonFieldEquals(rest[0], rest[1], rest.slice(2).join(" "));
      break;
    case "json_field_truthy":
      ok = checkJsonFieldTruthy(rest[0], rest[1]);
      break;
    case "mtime_after":
      ok = checkMtimeAfter(rest[0], rest[1]);
      break;
    default:
      printJson({
        ok: false,
        error: `Unknown check type: ${type}`,
      });
      process.exit(1);
  }

  printJson({
    ok,
    check: type,
    args: rest,
  });
  process.exit(ok ? 0 : 1);
}

function handleInspectEvent(payloadPath) {
  const payload = parseJsonFile(payloadPath);
  const parsed = payload.task_subject ? parseTaskSubject(payload.task_subject) : null;
  const statePath = resolvePath("workspace/planning/request-state.json");

  printJson({
    hook_event_name: payload.hook_event_name,
    task_subject: payload.task_subject || null,
    parsed_subject: parsed,
    state_path: statePath,
    state_exists: fs.existsSync(statePath),
  });
}

function printUsage() {
  printJson({
    usage: [
      "validator.js task-created",
      "validator.js task-completed",
      "validator.js teammate-idle",
      "validator.js parse-subject \"[Batch8][R17][tester] summary\"",
      "validator.js inspect-event path/to/payload.json",
      "validator.js issue-skip Batch8 R17 designer \"No UI-visible change\"",
      "validator.js check file_exists path/to/file",
      "validator.js check dir_has_entries path/to/dir",
      "validator.js check file_contains path/to/file needle",
      "validator.js check json_field_equals path/to/file field.path expected",
      "validator.js check json_field_truthy path/to/file field.path",
      "validator.js check mtime_after path/to/file 2026-04-16T00:00:00.000Z"
    ],
    subject_pattern: SUBJECT_PATTERN.source,
  });
}

async function main() {
  const [mode, ...rest] = process.argv.slice(2);

  switch (mode) {
    case "task-created":
      await handleTaskCreated();
      return;
    case "task-completed":
      await handleTaskCompleted();
      return;
    case "teammate-idle":
      await handleTeammateIdle();
      return;
    case "parse-subject":
      handleParseSubject(rest.join(" "));
      return;
    case "check":
      handleCheck(rest);
      return;
    case "inspect-event":
      handleInspectEvent(rest[0]);
      return;
    case "issue-skip":
      handleIssueSkip(rest);
      return;
    default:
      printUsage();
      process.exit(1);
  }
}

main().catch((error) => {
  printJson({
    ok: false,
    error: error.message,
  });
  process.exit(1);
});
