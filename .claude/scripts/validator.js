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
const STALE_PENDING_WITHOUT_AGENT_MS = 30 * 1000;

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

function readJsonLines(filePath) {
  const fullPath = resolvePath(filePath);
  if (!fs.existsSync(fullPath)) {
    return [];
  }

  return fs
    .readFileSync(fullPath, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
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

function defaultTicketState() {
  return {
    status: "none",
    path: null,
    validated_at: null,
    validated_by: null,
  };
}

function normalizeTaskEntry(entry) {
  return {
    task_id: entry && entry.task_id ? entry.task_id : `unknown-${Date.now().toString(36)}`,
    task_subject: entry && "task_subject" in entry ? entry.task_subject : null,
    task_description: entry && "task_description" in entry ? entry.task_description : null,
    teammate_name: entry && "teammate_name" in entry ? entry.teammate_name : null,
    team_name: entry && "team_name" in entry ? entry.team_name : null,
    batch_id: entry && "batch_id" in entry ? entry.batch_id : null,
    item_id: entry && "item_id" in entry ? entry.item_id : null,
    role: entry && "role" in entry ? entry.role : null,
    lifecycle: entry && entry.lifecycle ? entry.lifecycle : "created",
    last_event_at: entry && entry.last_event_at ? entry.last_event_at : nowIso(),
  };
}

function normalizeRoleState(roleState, roleName) {
  const base = buildRoleState(roleName, true);
  const next = roleState && typeof roleState === "object" ? roleState : {};

  return {
    ...base,
    ...next,
    role: roleName,
    required: next.required !== false,
    status: next.status || base.status,
    attempt: Number.isInteger(next.attempt) ? next.attempt : 0,
    checklist: Array.isArray(next.checklist) ? next.checklist : [],
    claim_path: "claim_path" in next ? next.claim_path : null,
    done_ticket: {
      ...defaultTicketState(),
      ...(next.done_ticket && typeof next.done_ticket === "object" ? next.done_ticket : {}),
    },
    skip_ticket: {
      ...defaultTicketState(),
      ...(next.skip_ticket && typeof next.skip_ticket === "object" ? next.skip_ticket : {}),
    },
    predecessor_roles: Array.isArray(next.predecessor_roles)
      ? next.predecessor_roles
      : base.predecessor_roles,
    artifacts: Array.isArray(next.artifacts) ? next.artifacts : [],
    missing_items: Array.isArray(next.missing_items) ? next.missing_items : [],
    last_error: "last_error" in next ? next.last_error : null,
    last_updated_at: next.last_updated_at || nowIso(),
  };
}

function normalizeItem(item) {
  const next = item && typeof item === "object" ? item : {};
  const roleOrder = Array.isArray(next.role_order) && next.role_order.length > 0
    ? next.role_order.filter((role) => DEFAULT_ROLE_ORDER.includes(role))
    : [...DEFAULT_ROLE_ORDER];

  const existingRoles = new Map(
    Array.isArray(next.roles)
      ? next.roles
          .filter((entry) => entry && typeof entry === "object" && typeof entry.role === "string")
          .map((entry) => [entry.role, entry])
      : []
  );

  return {
    item_id: next.item_id || "R0",
    title: next.title || next.item_id || "Untitled",
    role_order: roleOrder,
    retry_limit: Number.isInteger(next.retry_limit) && next.retry_limit > 0 ? next.retry_limit : 3,
    roles: roleOrder.map((roleName) => normalizeRoleState(existingRoles.get(roleName), roleName)),
  };
}

function normalizeBatch(batch) {
  const next = batch && typeof batch === "object" ? batch : {};
  return {
    batch_id: next.batch_id || "Batch0",
    created_at: next.created_at || nowIso(),
    items: Array.isArray(next.items) ? next.items.map(normalizeItem) : [],
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
  state.schema_version = STATE_SCHEMA_VERSION;
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
  state.tasks = state.tasks.map(normalizeTaskEntry);
  state.batches = state.batches.map(normalizeBatch);
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
  dispatchState.schema_version = DISPATCH_SCHEMA_VERSION;

  // Legacy single-entry format migration:
  // {
  //   "batch_id": "...",
  //   "item_id": "...",
  //   "role": "...",
  //   "status": "open",
  //   "created_at": "..."
  // }
  if (!Array.isArray(dispatchState.entries)) {
    if (dispatchState.batch_id && dispatchState.item_id && dispatchState.role) {
      dispatchState.entries = [
        {
          tool_use_id: dispatchState.tool_use_id || `legacy:${dispatchState.batch_id}:${dispatchState.item_id}:${dispatchState.role}`,
          session_id: dispatchState.session_id || null,
          batch_id: dispatchState.batch_id,
          item_id: dispatchState.item_id,
          role: dispatchState.role,
          summary: dispatchState.summary || dispatchState.item_id,
          description: dispatchState.description || null,
          subagent_type: dispatchState.subagent_type || null,
          status: dispatchState.status === "open" ? "pending" : (dispatchState.status || "pending"),
          created_at: dispatchState.created_at || nowIso(),
          claimed_at: dispatchState.claimed_at || null,
          finished_at: dispatchState.finished_at || null,
          agent_id: dispatchState.agent_id || null,
          agent_type: dispatchState.agent_type || null,
          last_assistant_message: dispatchState.last_assistant_message || null,
          stop_reason: dispatchState.stop_reason || null,
        },
      ];
    } else {
      dispatchState.entries = [];
    }
  }

  dispatchState.entries = dispatchState.entries
    .filter((entry) => entry && typeof entry === "object")
    .map((entry) => ({
      tool_use_id: entry.tool_use_id || `dispatch:${Date.now().toString(36)}`,
      session_id: "session_id" in entry ? entry.session_id : null,
      batch_id: entry.batch_id || null,
      item_id: entry.item_id || null,
      role: entry.role || null,
      summary: "summary" in entry ? entry.summary : entry.item_id || null,
      description: "description" in entry ? entry.description : null,
      subagent_type: "subagent_type" in entry ? entry.subagent_type : null,
      status: entry.status || "pending",
      created_at: entry.created_at || nowIso(),
      claimed_at: "claimed_at" in entry ? entry.claimed_at : null,
      finished_at: "finished_at" in entry ? entry.finished_at : null,
      agent_id: "agent_id" in entry ? entry.agent_id : null,
      agent_type: "agent_type" in entry ? entry.agent_type : null,
      last_assistant_message: "last_assistant_message" in entry ? entry.last_assistant_message : null,
      stop_reason: "stop_reason" in entry ? entry.stop_reason : null,
    }));

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

function checkJsonFieldMatches(filePath, fieldPath, pattern) {
  if (!checkFileExists(filePath)) {
    return false;
  }
  const target = parseJsonFile(filePath);
  const value = getByPath(target, fieldPath);
  if (value == null) {
    return false;
  }

  const regex = new RegExp(pattern);
  return regex.test(String(value));
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
  return (dispatchState.entries || []).some(
    (entry) => entry && !DISPATCH_TERMINAL_STATUSES.has(entry.status || "pending")
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

function findLatestHookEvent(predicate) {
  const events = readJsonLines("workspace/reports/hook-events.jsonl");
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (predicate(events[index])) {
      return events[index];
    }
  }
  return null;
}

function findLatestSubagentStopEvent(agentId) {
  if (!agentId) {
    return null;
  }
  return findLatestHookEvent(
    (event) =>
      event &&
      event.hook_event_name === "SubagentStop" &&
      event.payload &&
      event.payload.agent_id === agentId
  );
}

function buildMetaFromDispatchEntry(entry) {
  return {
    batch_id: entry.batch_id,
    item_id: entry.item_id,
    role: entry.role,
    summary: entry.summary || entry.item_id,
  };
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
        (entry.done_ticket && entry.done_ticket.status) !== "issued" &&
        (entry.skip_ticket && entry.skip_ticket.status) !== "issued"
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

  const recoveredEntries = recoverOpenDispatches(state);
  if (recoveredEntries.length > 0) {
    appendJsonLine(resolvePath("workspace/reports/hook-events.jsonl"), {
      logged_at: nowIso(),
      hook_event_name: "DispatchRecovery",
      task_meta: meta,
      extra: {
        stage: "pretool-agent-recovery",
        recovered_entries: recoveredEntries,
      },
    });
  }

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
    blockedReason = `PreToolUse gate error: ${error.message}`;
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

function finalizeDispatchEntry(state, dispatchEntry, payload) {
  const meta = buildMetaFromDispatchEntry(dispatchEntry);
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
    dispatch_finished_at: dispatchEntry.finished_at || nowIso(),
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
      mtime: fs.existsSync(getEvidenceDirPath(state, meta))
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

    saveState(state);
    return {
      ok: false,
      retryLimit,
      failures,
      meta,
      status: context.roleState.attempt >= retryLimit ? "rejected" : "blocked",
      validatedAt,
    };
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

  saveState(state);
  return {
    ok: true,
    retryLimit,
    failures: [],
    meta,
    status: "completed",
    validatedAt,
  };
}

function recoverOpenDispatches(state) {
  const recoveredEntries = [];

  withDispatchLock((dispatchState) => {
    for (const entry of dispatchState.entries || []) {
      if (!entry || DISPATCH_TERMINAL_STATUSES.has(entry.status)) {
        continue;
      }

      const meta = buildMetaFromDispatchEntry(entry);
      if (!meta.batch_id || !meta.item_id || !meta.role) {
        entry.status = "rejected";
        entry.stop_reason = "invalid dispatch entry";
        entry.finished_at = nowIso();
        recoveredEntries.push({
          batch_id: entry.batch_id || null,
          item_id: entry.item_id || null,
          role: entry.role || null,
          resolution: "rejected_invalid_dispatch",
        });
        continue;
      }

      const context = getStateContext(state, meta);
      const roleState = context.roleState;

      if (roleState.done_ticket.status === "issued" || roleState.skip_ticket.status === "issued") {
        entry.status = "completed";
        entry.stop_reason = null;
        entry.finished_at =
          roleState.done_ticket.validated_at ||
          roleState.skip_ticket.validated_at ||
          nowIso();
        recoveredEntries.push({
          batch_id: meta.batch_id,
          item_id: meta.item_id,
          role: meta.role,
          resolution: "completed_from_ticket",
        });
        continue;
      }

      if (roleState.done_ticket.status === "rejected" || roleState.status === "blocked") {
        entry.status = "rejected";
        entry.stop_reason = roleState.last_error || "role blocked";
        entry.finished_at = roleState.last_updated_at || nowIso();
        recoveredEntries.push({
          batch_id: meta.batch_id,
          item_id: meta.item_id,
          role: meta.role,
          resolution: "rejected_from_state",
        });
        continue;
      }

      if (entry.agent_id) {
        const stopEvent = findLatestSubagentStopEvent(entry.agent_id);
        if (stopEvent && stopEvent.payload) {
          entry.finished_at = entry.finished_at || stopEvent.logged_at || nowIso();
          entry.last_assistant_message =
            stopEvent.payload.last_assistant_message || entry.last_assistant_message || null;
          const result = finalizeDispatchEntry(state, entry, stopEvent.payload);
          entry.status = result.status;
          entry.stop_reason = result.ok ? null : summarizeFailures(result.failures);
          entry.finished_at = result.validatedAt;
          recoveredEntries.push({
            batch_id: meta.batch_id,
            item_id: meta.item_id,
            role: meta.role,
            resolution: result.ok ? "completed_from_stop_event" : "rejected_from_stop_event",
          });
          continue;
        }
      }

      const createdAt = Date.parse(entry.created_at || "");
      const staleWithoutAgent =
        !entry.agent_id &&
        !Number.isNaN(createdAt) &&
        Date.now() - createdAt > STALE_PENDING_WITHOUT_AGENT_MS;

      if (staleWithoutAgent) {
        const reason = "stale dispatch without SubagentStart";
        entry.status = "rejected";
        entry.stop_reason = reason;
        entry.finished_at = nowIso();
        roleState.status = "blocked";
        roleState.last_error = reason;
        roleState.last_updated_at = nowIso();
        recoveredEntries.push({
          batch_id: meta.batch_id,
          item_id: meta.item_id,
          role: meta.role,
          resolution: "rejected_stale_pending_without_agent",
        });
      }
    }
  }, state);

  saveState(state);
  return recoveredEntries;
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
  const result = finalizeDispatchEntry(state, dispatchEntry, payload);

  withDispatchLock((dispatchState) => {
    const latest = findDispatchByAgentId(dispatchState, payload.agent_id || null);
    if (latest) {
      latest.status = result.status;
      latest.stop_reason = result.ok ? null : summarizeFailures(result.failures);
      latest.finished_at = result.validatedAt;
    }
  }, state);

  if (!result.ok && state.gate_mode === "enforce") {
    const prefix =
      result.status === "rejected"
        ? "Retry limit reached. Escalate to user."
        : "Subagent completion blocked.";
    stderrBlock(
      `${prefix} ${meta.batch_id}/${meta.item_id}/${meta.role}: ${summarizeFailures(result.failures)}`
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
    case "json_field_matches":
      ok = checkJsonFieldMatches(rest[0], rest[1], rest.slice(2).join(" "));
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
      "validator.js check json_field_matches path/to/file field.path '^wf_'",
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
