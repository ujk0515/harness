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
const STATE_SCHEMA_VERSION = "1.2.0-draft";
const DISPATCH_SCHEMA_VERSION = "1.0.0-draft";
const DISPATCH_TERMINAL_STATUSES = new Set(["completed", "blocked", "rejected"]);

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
    schema_version: STATE_SCHEMA_VERSION,
    updated_at: nowIso(),
    gate_mode: "enforce",
    subject_pattern: SUBJECT_PATTERN.source,
    roots: {
      claims: "workspace/claims",
      evidence: "workspace/evidence",
      tickets: "workspace/tickets",
      dispatch: "workspace/planning/.dispatch.json",
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
    state.schema_version = STATE_SCHEMA_VERSION;
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
  if (!state.roots.dispatch) {
    state.roots.dispatch = defaultState().roots.dispatch;
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

function defaultDispatchState() {
  return {
    schema_version: DISPATCH_SCHEMA_VERSION,
    updated_at: nowIso(),
    entries: [],
  };
}

function getDispatchPath(state = null) {
  const roots = state && state.roots ? state.roots : defaultState().roots;
  return resolvePath(roots.dispatch || "workspace/planning/.dispatch.json");
}

function loadDispatchState(state = null) {
  const dispatchPath = getDispatchPath(state);
  if (!fs.existsSync(dispatchPath)) {
    const next = defaultDispatchState();
    writeJsonFile(dispatchPath, next);
    return next;
  }

  const dispatchState = JSON.parse(fs.readFileSync(dispatchPath, "utf8"));
  if (!dispatchState.schema_version) {
    dispatchState.schema_version = DISPATCH_SCHEMA_VERSION;
  }
  if (!Array.isArray(dispatchState.entries)) {
    dispatchState.entries = [];
  }
  return dispatchState;
}

function saveDispatchState(dispatchState, state = null) {
  dispatchState.updated_at = nowIso();
  writeJsonFile(getDispatchPath(state), dispatchState);
}

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function withDispatchLock(callback, state = null) {
  const lockPath = resolvePath("workspace/planning/.dispatch.lock");
  const waitUntil = Date.now() + 2000;

  while (true) {
    try {
      fs.mkdirSync(lockPath);
      break;
    } catch (error) {
      if (error.code !== "EEXIST") {
        throw error;
      }

      if (Date.now() > waitUntil) {
        throw new Error("Dispatch lock is busy");
      }
      sleepMs(50);
    }
  }

  try {
    const dispatchState = loadDispatchState(state);
    const result = callback(dispatchState);
    saveDispatchState(dispatchState, state);
    return result;
  } finally {
    fs.rmSync(lockPath, { recursive: true, force: true });
  }
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

function checkDirHasEntriesAfter(dirPath, isoString) {
  const fullPath = resolvePath(dirPath);
  if (!fs.existsSync(fullPath) || !fs.statSync(fullPath).isDirectory()) {
    return false;
  }

  const threshold = Date.parse(isoString);
  if (Number.isNaN(threshold)) {
    return false;
  }

  const stack = [fullPath];
  while (stack.length > 0) {
    const current = stack.pop();
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const nextPath = path.join(current, entry.name);
      const stat = fs.statSync(nextPath);
      if (stat.mtimeMs > threshold) {
        return true;
      }
      if (entry.isDirectory()) {
        stack.push(nextPath);
      }
    }
  }

  return false;
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

function checkJsonArrayContains(filePath, fieldPath, expected) {
  if (!checkFileExists(filePath)) {
    return false;
  }
  const target = parseJsonFile(filePath);
  const value = getByPath(target, fieldPath);
  if (!Array.isArray(value)) {
    return false;
  }
  return value.map((entry) => String(entry)).includes(String(expected));
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

function logHookEvent(payload, extra = {}) {
  const description =
    payload && payload.tool_input && typeof payload.tool_input.description === "string"
      ? payload.tool_input.description
      : null;
  const taskMeta =
    payload && payload.task_subject
      ? parseTaskSubject(payload.task_subject)
      : description
        ? parseTaskSubject(description)
        : null;

  appendJsonLine(resolvePath("workspace/reports/hook-events.jsonl"), {
    logged_at: nowIso(),
    hook_event_name: (payload && payload.hook_event_name) || "unknown",
    task_meta: taskMeta,
    extra,
    payload,
  });

  return taskMeta;
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

function getEvidenceDirPath(state, meta) {
  return path.join(
    resolvePath(state.roots.evidence),
    meta.role,
    meta.batch_id,
    meta.item_id
  );
}

function hasOpenDispatch(dispatchState) {
  return dispatchState.entries.some(
    (entry) => !DISPATCH_TERMINAL_STATUSES.has(entry.status)
  );
}

function findDispatchByAgentId(dispatchState, agentId) {
  if (!agentId) {
    return null;
  }
  return (
    [...dispatchState.entries]
      .reverse()
      .find((entry) => entry.agent_id && entry.agent_id === agentId) || null
  );
}

function parseAgentToolInput(payload) {
  const toolInput = (payload && payload.tool_input) || {};
  const description =
    typeof toolInput.description === "string"
      ? toolInput.description.trim()
      : "";

  return {
    tool_use_id: payload && payload.tool_use_id ? String(payload.tool_use_id) : null,
    subagent_type:
      typeof toolInput.subagent_type === "string" ? toolInput.subagent_type : null,
    description,
    meta: parseTaskSubject(description),
  };
}

function buildDispatchEntry(payload, parsed) {
  return {
    tool_use_id:
      parsed.tool_use_id ||
      `${payload.session_id || "session"}:${Date.now().toString(36)}`,
    session_id: payload.session_id || null,
    batch_id: parsed.meta.batch_id,
    item_id: parsed.meta.item_id,
    role: parsed.meta.role,
    summary: parsed.meta.summary,
    description: parsed.description,
    subagent_type: parsed.subagent_type,
    status: "pending",
    created_at: nowIso(),
    claimed_at: null,
    finished_at: null,
    agent_id: null,
    agent_type: null,
    last_assistant_message: null,
    stop_reason: null,
  };
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
    .replace(/\{role_index\}/g, String(context.role_index))
    .replace(/\{dispatch_created_at\}/g, context.dispatch_created_at || "")
    .replace(/\{dispatch_claimed_at\}/g, context.dispatch_claimed_at || "")
    .replace(/\{dispatch_finished_at\}/g, context.dispatch_finished_at || "");
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
  const taskMeta = logHookEvent(parsed);
  return { payload: parsed, meta: taskMeta };
}

async function handleHookLog() {
  const raw = await readStdin();
  if (!raw.trim()) {
    return;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    appendJsonLine(resolvePath("workspace/reports/hook-events.jsonl"), {
      logged_at: nowIso(),
      hook_event_name: "parse_error",
      task_meta: null,
      payload: {
        parse_error: error.message,
        raw,
      },
    });
    return;
  }

  logHookEvent(parsed);
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

async function handlePreToolUseAgent() {
  const raw = await readStdin();
  if (!raw.trim()) {
    return;
  }

  const payload = JSON.parse(raw);
  const parsed = parseAgentToolInput(payload);
  logHookEvent(payload, {
    stage: "pretool-agent",
    parsed_tool_meta: parsed.meta,
    subagent_type: parsed.subagent_type,
    tool_use_id: parsed.tool_use_id,
  });

  const state = loadState();
  if (!parsed.meta) {
    saveState(state);
    if (state.gate_mode === "enforce") {
      stderrBlock(
        `Agent description must match ${SUBJECT_PATTERN.source}. Example: [Batch8][R17][tester] summary`
      );
    }
    return;
  }

  const meta = parsed.meta;
  const context = getStateContext(state, meta);
  const retryLimit = context.item.retry_limit || 3;
  const predecessorFailures = collectPredecessorFailures(context.item, meta.role);

  let blockedReason = null;
  let dispatchEntry = null;

  try {
    withDispatchLock((dispatchState) => {
      if (hasOpenDispatch(dispatchState)) {
        blockedReason = "Another Agent dispatch is already in flight. Wait for it to finish before spawning the next Agent.";
        return;
      }

      if (
        context.roleState.done_ticket.status === "issued" ||
        context.roleState.skip_ticket.status === "issued"
      ) {
        blockedReason = `${meta.role} already has a done/skip ticket for ${meta.batch_id}/${meta.item_id}.`;
        return;
      }

      if (context.roleState.attempt >= retryLimit) {
        blockedReason = `Retry limit reached for ${meta.batch_id}/${meta.item_id}/${meta.role}. Escalate to user.`;
        return;
      }

      if (predecessorFailures.length > 0) {
        blockedReason = `Blocked ${meta.role} task for ${meta.batch_id}/${meta.item_id}: ${summarizeFailures(predecessorFailures)}`;
        return;
      }

      dispatchEntry = buildDispatchEntry(payload, parsed);
      dispatchState.entries.push(dispatchEntry);
    }, state);
  } catch (error) {
    blockedReason = `Dispatch lock error: ${error.message}`;
  }

  context.roleState.claim_path = path.relative(resolveProjectRoot(), getClaimPath(state, meta));
  context.roleState.status = dispatchEntry ? "claimed" : "blocked";
  context.roleState.last_error = blockedReason;
  context.roleState.last_updated_at = nowIso();

  upsertTaskRegistry(
    state,
    {
      task_id: parsed.tool_use_id || null,
      task_subject: parsed.description,
      task_description: parsed.description,
      teammate_name: null,
      team_name: null,
    },
    meta,
    dispatchEntry ? "created" : "completion_blocked"
  );
  saveState(state);

  if (blockedReason && state.gate_mode === "enforce") {
    stderrBlock(blockedReason);
  }
}

async function handleSubagentStart() {
  const raw = await readStdin();
  if (!raw.trim()) {
    return;
  }

  const payload = JSON.parse(raw);
  logHookEvent(payload, {
    stage: "subagent-start",
  });

  const state = loadState();
  let matchedDispatch = null;

  try {
    withDispatchLock((dispatchState) => {
      if (payload.tool_use_id) {
        matchedDispatch = dispatchState.entries.find(
          (entry) =>
            entry.status === "pending" &&
            entry.tool_use_id === String(payload.tool_use_id)
        );
      }

      if (!matchedDispatch) {
        matchedDispatch = dispatchState.entries.find((entry) => entry.status === "pending") || null;
      }

      if (!matchedDispatch) {
        return;
      }

      matchedDispatch.status = "claimed";
      matchedDispatch.agent_id = payload.agent_id || null;
      matchedDispatch.agent_type = payload.agent_type || null;
      matchedDispatch.claimed_at = nowIso();
    }, state);
  } catch (error) {
    logHookEvent(payload, {
      stage: "subagent-start-error",
      error: error.message,
    });
    return;
  }

  if (!matchedDispatch) {
    return;
  }

  const meta = {
    batch_id: matchedDispatch.batch_id,
    item_id: matchedDispatch.item_id,
    role: matchedDispatch.role,
    summary: matchedDispatch.summary,
  };
  const context = getStateContext(state, meta);
  context.roleState.status = "in_progress";
  context.roleState.last_error = null;
  context.roleState.last_updated_at = nowIso();

  upsertTaskRegistry(
    state,
    {
      task_id: matchedDispatch.tool_use_id,
      task_subject: matchedDispatch.description,
      task_description: matchedDispatch.description,
      teammate_name: payload.agent_id || null,
      team_name: null,
    },
    meta,
    "created"
  );
  saveState(state);
}

async function handleSubagentStop() {
  const raw = await readStdin();
  if (!raw.trim()) {
    return;
  }

  const payload = JSON.parse(raw);
  logHookEvent(payload, {
    stage: "subagent-stop",
  });

  const state = loadState();
  let dispatchEntry = null;

  try {
    withDispatchLock((dispatchState) => {
      dispatchEntry = findDispatchByAgentId(dispatchState, payload.agent_id || null);
      if (!dispatchEntry) {
        return;
      }

      dispatchEntry.finished_at = nowIso();
      dispatchEntry.last_assistant_message = payload.last_assistant_message || null;
    }, state);
  } catch (error) {
    if (state.gate_mode === "enforce") {
      stderrBlock(`Dispatch lock error during SubagentStop: ${error.message}`);
    }
    return;
  }

  if (!dispatchEntry) {
    if (state.gate_mode === "enforce") {
      stderrBlock(
        `SubagentStop could not be mapped to a pending dispatch for agent_id=${payload.agent_id || "unknown"}`
      );
    }
    return;
  }

  const meta = {
    batch_id: dispatchEntry.batch_id,
    item_id: dispatchEntry.item_id,
    role: dispatchEntry.role,
    summary: dispatchEntry.summary,
  };
  const context = getStateContext(state, meta);
  const checklistDefinitions = loadChecklistDefinitions();
  const checks = checklistDefinitions.roles[meta.role] || [];
  const predecessorFailures = collectPredecessorFailures(context.item, meta.role);
  const retryLimit = context.item.retry_limit || 3;
  const checklistContext = {
    batch_id: meta.batch_id,
    item_id: meta.item_id,
    role: meta.role,
    batch_index: context.batchIndex,
    item_index: context.itemIndex,
    role_index: context.roleIndex,
    dispatch_created_at: dispatchEntry.created_at,
    dispatch_claimed_at: dispatchEntry.claimed_at,
    dispatch_finished_at: dispatchEntry.finished_at,
  };

  context.roleState.attempt += 1;
  context.roleState.claim_path = path.relative(resolveProjectRoot(), getClaimPath(state, meta));
  context.roleState.artifacts = [
    {
      kind: "claim",
      path: path.relative(resolveProjectRoot(), getClaimPath(state, meta)),
      mtime: checkFileExists(path.relative(resolveProjectRoot(), getClaimPath(state, meta)))
        ? new Date(fs.statSync(getClaimPath(state, meta)).mtimeMs).toISOString()
        : dispatchEntry.created_at,
    },
    {
      kind: "evidence_dir",
      path: path.relative(resolveProjectRoot(), getEvidenceDirPath(state, meta)),
      mtime: checkFileExists(path.relative(resolveProjectRoot(), getEvidenceDirPath(state, meta)))
        ? new Date(fs.statSync(getEvidenceDirPath(state, meta)).mtimeMs).toISOString()
        : dispatchEntry.created_at,
    },
  ];
  context.roleState.status = "done";
  context.roleState.last_updated_at = nowIso();
  saveState(state);

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
        task_subject: dispatchEntry.description,
        teammate_name: payload.agent_id || null,
        checklist: context.roleState.checklist,
        artifacts: context.roleState.artifacts,
        predecessor_tickets: predecessorTicketPaths,
        reason: summarizeFailures(failures),
      })
    );

    withDispatchLock((dispatchState) => {
      const latest = findDispatchByAgentId(dispatchState, payload.agent_id || null);
      if (latest) {
        latest.status = context.roleState.attempt >= retryLimit ? "rejected" : "blocked";
        latest.stop_reason = summarizeFailures(failures);
        latest.finished_at = validatedAt;
      }
    }, state);

    saveState(state);

    if (state.gate_mode === "enforce") {
      const prefix =
        context.roleState.attempt >= retryLimit
          ? "Retry limit reached. Escalate to user."
          : "Subagent completion blocked.";
      stderrBlock(
        `${prefix} ${meta.batch_id}/${meta.item_id}/${meta.role}: ${summarizeFailures(failures)}`
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
      task_subject: dispatchEntry.description,
      teammate_name: payload.agent_id || null,
      checklist: context.roleState.checklist,
      artifacts: context.roleState.artifacts,
      predecessor_tickets: predecessorTicketPaths,
      reason: null,
    })
  );

  withDispatchLock((dispatchState) => {
    const latest = findDispatchByAgentId(dispatchState, payload.agent_id || null);
    if (latest) {
      latest.status = "completed";
      latest.stop_reason = null;
      latest.finished_at = validatedAt;
    }
  }, state);

  saveState(state);
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
    case "dir_has_entries_after":
      ok = checkDirHasEntriesAfter(rest[0], rest[1]);
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
    case "json_array_contains":
      ok = checkJsonArrayContains(rest[0], rest[1], rest.slice(2).join(" "));
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
      "validator.js hook-log",
      "validator.js pretool-agent",
      "validator.js subagent-start",
      "validator.js subagent-stop",
      "validator.js task-created",
      "validator.js task-completed",
      "validator.js teammate-idle",
      "validator.js parse-subject \"[Batch8][R17][tester] summary\"",
      "validator.js inspect-event path/to/payload.json",
      "validator.js issue-skip Batch8 R17 designer \"No UI-visible change\"",
      "validator.js check file_exists path/to/file",
      "validator.js check dir_has_entries path/to/dir",
      "validator.js check dir_has_entries_after path/to/dir 2026-04-16T00:00:00.000Z",
      "validator.js check file_contains path/to/file needle",
      "validator.js check json_field_equals path/to/file field.path expected",
      "validator.js check json_field_truthy path/to/file field.path",
      "validator.js check json_array_contains path/to/file field.path expected",
      "validator.js check mtime_after path/to/file 2026-04-16T00:00:00.000Z"
    ],
    subject_pattern: SUBJECT_PATTERN.source,
  });
}

async function main() {
  const [mode, ...rest] = process.argv.slice(2);

  switch (mode) {
    case "hook-log":
      await handleHookLog();
      return;
    case "pretool-agent":
      await handlePreToolUseAgent();
      return;
    case "subagent-start":
      await handleSubagentStart();
      return;
    case "subagent-stop":
      await handleSubagentStop();
      return;
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
