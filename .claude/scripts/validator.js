#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const os = require("os");
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
const STATE_SCHEMA_VERSION = "1.4.0-draft";
const DISPATCH_SCHEMA_VERSION = "1.0.0-draft";
const DISPATCH_TERMINAL_STATUSES = new Set(["completed", "blocked", "rejected"]);
const STALE_PENDING_WITHOUT_AGENT_MS = 30 * 1000;
const STALE_CLAIMED_WITHOUT_STOP_MS = 3 * 1000;

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
  const fullPath = resolvePath(filePath);
  const tmpPath = `${fullPath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  try {
    fs.renameSync(tmpPath, fullPath);
  } catch (e) {
    try { fs.unlinkSync(tmpPath); } catch (_) {}
    throw e;
  }
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
    holds: [],
    tasks: [],
    batches: [],
  };
}

function defaultHoldState(code = "unknown", reason = null) {
  return {
    code,
    status: "open",
    reason,
    source: "harness",
    details: {},
    opened_at: nowIso(),
    resolved_at: null,
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

const REVIEW_GATE_SCHEMA_VERSION = "2.0.0";

function defaultReviewGateState() {
  return {
    schema_version: REVIEW_GATE_SCHEMA_VERSION,
    batch_id: null,
    item_id: null,
    scope: "item",
    status: "idle",
    opened_at: null,
    resolved_at: null,
    developer_review: "todo",
    qa_review: "todo",
    planner_response: "todo",
    designer_response: "todo",
    planner_response_history: [],
    designer_response_history: [],
  };
}

function buildReviewBundlePath(role, batchId, itemId) {
  if (role === "developer") {
    return `workspace/reviews/${batchId}/${itemId}/developer-review.md`;
  }

  if (role === "qa") {
    return `workspace/reviews/${batchId}/${itemId}/qa-review.md`;
  }

  return null;
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

function normalizeHoldEntry(entry) {
  const next = entry && typeof entry === "object" ? entry : {};
  return {
    ...defaultHoldState(next.code || "unknown", "reason" in next ? next.reason : null),
    ...next,
    code: next.code || "unknown",
    status: next.status === "resolved" ? "resolved" : "open",
    reason: "reason" in next ? next.reason : null,
    source: next.source || "harness",
    details: next.details && typeof next.details === "object" ? next.details : {},
    opened_at: next.opened_at || nowIso(),
    resolved_at: next.status === "resolved" ? next.resolved_at || nowIso() : null,
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
    failed_check_ids: Array.isArray(next.failed_check_ids) ? next.failed_check_ids : [],
    retry_scope: Array.isArray(next.retry_scope) ? next.retry_scope : [],
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
    review_gate: {
      ...defaultReviewGateState(),
      ...(next.review_gate && typeof next.review_gate === "object" ? next.review_gate : {}),
    },
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
    const fingerprintPath = resolvePath("workspace/planning/.request-state.fingerprint");
    if (fs.existsSync(fingerprintPath)) {
      process.stderr.write(
        `[validator] request-state.json missing but fingerprint exists — state may have been deleted. Refusing to auto-reset.\n`
      );
      process.exit(2);
    }
    const state = defaultState();
    writeJsonFile(statePath, state);
    writeJsonFile(fingerprintPath, { created_at: nowIso() });
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
  if (!Array.isArray(state.holds)) {
    state.holds = [];
  }
  if (!Array.isArray(state.batches)) {
    state.batches = [];
  }
  state.holds = state.holds.map(normalizeHoldEntry);
  state.tasks = state.tasks.map(normalizeTaskEntry);
  state.batches = state.batches.map(normalizeBatch);
  return state;
}

function saveState(state) {
  state.updated_at = nowIso();
  const statePath = resolvePath("workspace/planning/request-state.json");
  writeJsonFile(statePath, state);
  writeLiveStatus(state);
}

function defaultDispatchState() {
  return {
    schema_version: DISPATCH_SCHEMA_VERSION,
    updated_at: nowIso(),
    entries: [],
  };
}

function elapsedLabel(fromIso) {
  const value = Date.parse(fromIso || "");
  if (Number.isNaN(value)) {
    return null;
  }

  const seconds = Math.max(0, Math.floor((Date.now() - value) / 1000));
  if (seconds < 60) {
    return `${seconds}s`;
  }

  const minutes = Math.floor(seconds / 60);
  const remainSeconds = seconds % 60;
  return `${minutes}m ${remainSeconds}s`;
}

function summarizeOpenDispatches(dispatchState) {
  return (dispatchState.entries || [])
    .filter((entry) => entry && !DISPATCH_TERMINAL_STATUSES.has(entry.status))
    .map((entry) => ({
      batch_id: entry.batch_id || null,
      item_id: entry.item_id || null,
      role: entry.role || null,
      mode: entry.mode || null,
      status: entry.status || null,
      description: entry.description || null,
      agent_id: entry.agent_id || null,
      created_at: entry.created_at || null,
      claimed_at: entry.claimed_at || null,
      finished_at: entry.finished_at || null,
      running_for: elapsedLabel(entry.claimed_at || entry.created_at || null),
      stop_reason: entry.stop_reason || null,
    }));
}

function summarizeBlockedItems(state) {
  const results = [];

  for (const batch of state.batches || []) {
    for (const item of batch.items || []) {
      for (const roleState of item.roles || []) {
        if (roleState.status !== "blocked") {
          continue;
        }

        results.push({
          batch_id: batch.batch_id,
          item_id: item.item_id,
          role: roleState.role,
          failed_check_ids: Array.isArray(roleState.failed_check_ids)
            ? roleState.failed_check_ids
            : [],
          retry_scope: Array.isArray(roleState.retry_scope) ? roleState.retry_scope : [],
          last_error: roleState.last_error || null,
          last_updated_at: roleState.last_updated_at || null,
        });
      }
    }
  }

  return results;
}

function summarizeReviewGates(state) {
  const results = [];

  for (const batch of state.batches || []) {
    for (const item of batch.items || []) {
      if (!item.review_gate || item.review_gate.status === "idle") {
        continue;
      }

      results.push({
        batch_id: batch.batch_id,
        item_id: item.item_id,
        status: item.review_gate.status,
        developer_review: item.review_gate.developer_review,
        qa_review: item.review_gate.qa_review,
        planner_response: item.review_gate.planner_response,
        designer_response: item.review_gate.designer_response,
        opened_at: item.review_gate.opened_at || null,
        resolved_at: item.review_gate.resolved_at || null,
      });
    }
  }

  return results;
}

function summarizeRecentTasks(state) {
  return [...(state.tasks || [])]
    .sort((a, b) => Date.parse(b.last_event_at || "") - Date.parse(a.last_event_at || ""))
    .slice(0, 8)
    .map((entry) => ({
      task_id: entry.task_id,
      batch_id: entry.batch_id || null,
      item_id: entry.item_id || null,
      role: entry.role || null,
      lifecycle: entry.lifecycle || null,
      last_event_at: entry.last_event_at || null,
      age: elapsedLabel(entry.last_event_at || null),
      task_subject: entry.task_subject || null,
    }));
}

function isRoleSatisfied(roleState) {
  if (!roleState || roleState.required === false) {
    return true;
  }
  return hasIssuedTicket(roleState);
}

function getCurrentBatch(state) {
  const batches = Array.isArray(state.batches) ? state.batches : [];
  if (batches.length === 0) {
    return null;
  }

  if (state.current_batch_id) {
    const matched = batches.find((entry) => entry.batch_id === state.current_batch_id);
    if (matched) {
      return matched;
    }
  }

  const unresolved = [...batches]
    .reverse()
    .find((batch) =>
      (batch.items || []).some((item) => {
        const gate = ensureReviewGate(item);
        return (
          (item.roles || []).some((roleState) => !isRoleSatisfied(roleState)) ||
          (gate.status !== "idle" && gate.status !== "resolved")
        );
      })
    );

  return unresolved || batches[batches.length - 1] || null;
}

function findLatestDispatchEntry(state, batchId, itemId, role) {
  const dispatchState = loadDispatchState(state);
  return (
    [...(dispatchState.entries || [])]
      .reverse()
      .find(
        (entry) =>
          entry &&
          entry.batch_id === batchId &&
          entry.item_id === itemId &&
          entry.role === role
      ) || null
  );
}

function inferRetryMode(state, batchId, item, roleName, fallbackMode) {
  const latestDispatch = findLatestDispatchEntry(state, batchId, item.item_id, roleName);
  return (latestDispatch && latestDispatch.mode) || fallbackMode || null;
}

function buildSuggestedDescription(batchId, itemId, role, mode, title) {
  const summary = (title || itemId || "work item").trim();
  if (mode) {
    return `[${batchId}][${itemId}][${role}] ${mode}: ${summary}`;
  }
  return `[${batchId}][${itemId}][${role}] ${summary}`;
}

function summarizePendingItem(item) {
  const reviewGate = ensureReviewGate(item);
  const unresolvedRoles = (item.roles || [])
    .filter((roleState) => !isRoleSatisfied(roleState))
    .map((roleState) => ({
      role: roleState.role,
      status: roleState.status,
      failed_check_ids: roleState.failed_check_ids || [],
      retry_scope: roleState.retry_scope || [],
      last_error: roleState.last_error || null,
    }));

  return {
    item_id: item.item_id,
    title: item.title,
    unresolved_roles: unresolvedRoles,
    review_gate: {
      status: reviewGate.status,
      developer_review: reviewGate.developer_review,
      qa_review: reviewGate.qa_review,
      planner_response: reviewGate.planner_response,
      designer_response: reviewGate.designer_response,
    },
  };
}

function chooseNextActionForItem(state, batch, item) {
  const title = item.title || item.item_id;
  const reviewGate = ensureReviewGate(item);
  const roleMap = new Map((item.roles || []).map((entry) => [entry.role, entry]));
  const planner = roleMap.get("planner") || buildRoleState("planner", true);
  const designer = roleMap.get("designer") || buildRoleState("designer", true);
  const developer = roleMap.get("developer") || buildRoleState("developer", true);
  const qa = roleMap.get("qa") || buildRoleState("qa", true);
  const tester = roleMap.get("tester") || buildRoleState("tester", true);
  const secretary = roleMap.get("secretary") || buildRoleState("secretary", true);

  const retryRole = (item.roles || []).find(
    (roleState) =>
      roleState.required !== false &&
      roleState.status === "blocked" &&
      ((roleState.failed_check_ids && roleState.failed_check_ids.length > 0) ||
        (roleState.retry_scope && roleState.retry_scope.length > 0))
  );

  if (retryRole) {
    const fallbackMode =
      retryRole.role === "planner"
        ? retryRole.attempt > 0
          ? "revise"
          : "plan"
        : retryRole.role === "designer"
          ? "apply"
          : retryRole.role === "developer"
            ? "implement"
            : retryRole.role === "qa"
              ? "verify"
              : null;
    const mode = inferRetryMode(state, batch.batch_id, item, retryRole.role, fallbackMode);
    return {
      action: "dispatch",
      reason: `blocked retry for ${retryRole.role}`,
      batch_id: batch.batch_id,
      item_id: item.item_id,
      role: retryRole.role,
      mode,
      description: buildSuggestedDescription(batch.batch_id, item.item_id, retryRole.role, mode, title),
      retry_scope: retryRole.retry_scope || [],
      failed_check_ids: retryRole.failed_check_ids || [],
    };
  }

  if (!isRoleSatisfied(planner)) {
    const mode = planner.attempt > 0 ? "revise" : "plan";
    return {
      action: "dispatch",
      reason: "planner ticket missing",
      batch_id: batch.batch_id,
      item_id: item.item_id,
      role: "planner",
      mode,
      description: buildSuggestedDescription(batch.batch_id, item.item_id, "planner", mode, title),
    };
  }

  if (!isRoleSatisfied(designer)) {
    if (designer.status === "in_progress") {
      return {
        action: "branch_review_decision",
        reason: "designer review returned; inspect review result and choose planner revise or designer apply",
        batch_id: batch.batch_id,
        item_id: item.item_id,
        title,
      };
    }

    const mode = designer.attempt > 0 ? "apply" : "review";
    return {
      action: "dispatch",
      reason: mode === "review" ? "designer review pending" : "designer apply pending",
      batch_id: batch.batch_id,
      item_id: item.item_id,
      role: "designer",
      mode,
      description: buildSuggestedDescription(batch.batch_id, item.item_id, "designer", mode, title),
    };
  }

  if (reviewGate.status === "idle" || reviewGate.developer_review !== "done") {
    return {
      action: "dispatch",
      reason: "developer planning review pending",
      batch_id: batch.batch_id,
      item_id: item.item_id,
      role: "developer",
      mode: "review",
      description: buildSuggestedDescription(batch.batch_id, item.item_id, "developer", "review", title),
    };
  }

  if (reviewGate.qa_review !== "done") {
    return {
      action: "dispatch",
      reason: "qa planning review pending",
      batch_id: batch.batch_id,
      item_id: item.item_id,
      role: "qa",
      mode: "review",
      description: buildSuggestedDescription(batch.batch_id, item.item_id, "qa", "review", title),
    };
  }

  if (reviewGate.status === "open" && reviewGate.planner_response !== "done") {
    return {
      action: "dispatch",
      reason: "planner revise pending after review loop",
      batch_id: batch.batch_id,
      item_id: item.item_id,
      role: "planner",
      mode: "revise",
      description: buildSuggestedDescription(batch.batch_id, item.item_id, "planner", "revise", title),
    };
  }

  if (reviewGate.status === "awaiting_design_sync" && reviewGate.designer_response !== "done") {
    return {
      action: "dispatch",
      reason: "designer review sync pending",
      batch_id: batch.batch_id,
      item_id: item.item_id,
      role: "designer",
      mode: "apply",
      description: buildSuggestedDescription(batch.batch_id, item.item_id, "designer", "apply", title),
    };
  }

  if (!isRoleSatisfied(developer)) {
    return {
      action: "dispatch",
      reason: "developer implement pending",
      batch_id: batch.batch_id,
      item_id: item.item_id,
      role: "developer",
      mode: "implement",
      description: buildSuggestedDescription(batch.batch_id, item.item_id, "developer", "implement", title),
    };
  }

  if (!isRoleSatisfied(qa)) {
    const mode = developer.done_ticket.status === "issued" ? "verify" : "tc";
    return {
      action: "dispatch",
      reason: mode === "tc" ? "qa testcase pending" : "qa verify pending",
      batch_id: batch.batch_id,
      item_id: item.item_id,
      role: "qa",
      mode,
      description: buildSuggestedDescription(batch.batch_id, item.item_id, "qa", mode, title),
    };
  }

  if (!isRoleSatisfied(tester)) {
    return {
      action: "dispatch",
      reason: "tester execution pending",
      batch_id: batch.batch_id,
      item_id: item.item_id,
      role: "tester",
      mode: null,
      description: buildSuggestedDescription(batch.batch_id, item.item_id, "tester", null, `integration test ${title}`),
    };
  }

  if (!isRoleSatisfied(secretary)) {
    return {
      action: "dispatch",
      reason: "secretary finalization pending",
      batch_id: batch.batch_id,
      item_id: item.item_id,
      role: "secretary",
      mode: null,
      description: buildSuggestedDescription(batch.batch_id, item.item_id, "secretary", null, title),
    };
  }

  return null;
}

function buildNextAction(state) {
  const openHolds = getOpenHolds(state);
  if (openHolds.length > 0) {
    const hold = openHolds[0];
    return {
      action: "halt",
      response_allowed: true,
      reason: hold.reason || hold.code,
      hold,
    };
  }

  const dispatchState = loadDispatchState(state);
  const openDispatches = summarizeOpenDispatches(dispatchState);
  if (openDispatches.length > 0) {
    return {
      action: "active_agent",
      response_allowed: false,
      reason: "foreground agent step still in progress",
      active_dispatch: openDispatches[0],
    };
  }

  const batch = getCurrentBatch(state);
  if (!batch) {
    return {
      action: "idle",
      response_allowed: true,
      reason: "no batch found",
    };
  }

  for (const item of batch.items || []) {
    const suggested = chooseNextActionForItem(state, batch, item);
    if (suggested) {
      return {
        ...suggested,
        response_allowed: false,
      };
    }
  }

  return {
    action: "finalize",
    response_allowed: true,
    batch_id: batch.batch_id,
    reason: "all required roles are done/skip and no open dispatch remains",
  };
}

function buildLiveStatus(state) {
  const dispatchState = loadDispatchState(state);
  const openDispatches = summarizeOpenDispatches(dispatchState);
  const activeDispatch = openDispatches[0] || null;
  const nextAction = buildNextAction(state);
  const currentBatch = getCurrentBatch(state);
  const pendingItems = currentBatch ? (currentBatch.items || []).map(summarizePendingItem) : [];

  return {
    updated_at: nowIso(),
    gate_mode: state.gate_mode || "enforce",
    execution_mode: "foreground",
    active_dispatch: activeDispatch,
    open_dispatch_count: openDispatches.length,
    open_dispatches: openDispatches,
    open_holds: getOpenHolds(state),
    review_gates: summarizeReviewGates(state),
    blocked_items: summarizeBlockedItems(state),
    recent_tasks: summarizeRecentTasks(state),
    current_batch_id: currentBatch ? currentBatch.batch_id : null,
    pending_items: pendingItems,
    next_action: nextAction,
    hint:
      openDispatches.length > 0
        ? "현재 포그라운드 단계의 Agent가 진행 중이거나 종료 정리 중이다. active_dispatch와 running_for를 확인."
        : nextAction.response_allowed
          ? "열린 dispatch 없음. 전체 완료 응답 가능."
          : "열린 dispatch는 없지만 다음 단계가 남아 있음. next_action을 따라 내부 루프를 계속 진행해야 함.",
  };
}

function writeLiveStatus(state) {
  const payload = buildLiveStatus(state);
  const jsonPath = resolvePath("workspace/reports/live-status.json");
  const mdPath = resolvePath("workspace/reports/live-status.md");

  writeJsonFile(jsonPath, payload);

  const lines = [
    "# Live Status",
    "",
    `- updated_at: ${payload.updated_at}`,
    `- gate_mode: ${payload.gate_mode}`,
    `- execution_mode: ${payload.execution_mode}`,
    `- open_dispatch_count: ${payload.open_dispatch_count}`,
    `- hint: ${payload.hint}`,
    "",
    "## Active Agent Step",
  ];

  if (payload.active_dispatch) {
    lines.push(`- batch/item: ${payload.active_dispatch.batch_id}/${payload.active_dispatch.item_id}`);
    lines.push(`- role/mode: ${payload.active_dispatch.role} / ${payload.active_dispatch.mode || "-"}`);
    lines.push(`- status: ${payload.active_dispatch.status}`);
    lines.push(`- running_for: ${payload.active_dispatch.running_for || "-"}`);
    lines.push(`- description: ${payload.active_dispatch.description || "-"}`);
    lines.push(`- agent_id: ${payload.active_dispatch.agent_id || "-"}`);
  } else {
    lines.push("- none");
  }

  lines.push("", "## Hard Stops");
  if (payload.open_holds.length === 0) {
    lines.push("- none");
  } else {
    for (const hold of payload.open_holds) {
      lines.push(`- ${hold.code}: ${hold.reason || "-"}`);
    }
  }

  lines.push("", "## Review Gates");
  if (payload.review_gates.length === 0) {
    lines.push("- none");
  } else {
    for (const gate of payload.review_gates) {
      lines.push(
        `- ${gate.batch_id}/${gate.item_id}: ${gate.status} (dev=${gate.developer_review}, qa=${gate.qa_review}, planner=${gate.planner_response}, designer=${gate.designer_response})`
      );
    }
  }

  lines.push("", "## Blocked Items");
  if (payload.blocked_items.length === 0) {
    lines.push("- none");
  } else {
    for (const item of payload.blocked_items) {
      lines.push(
        `- ${item.batch_id}/${item.item_id}/${item.role}: ${item.last_error || "blocked"}`
      );
      if (item.retry_scope.length > 0) {
        lines.push(`  retry_scope: ${item.retry_scope.join(" | ")}`);
      }
    }
  }

  lines.push("", "## Next Action");
  lines.push(`- action: ${payload.next_action.action}`);
  lines.push(`- response_allowed: ${payload.next_action.response_allowed}`);
  lines.push(`- reason: ${payload.next_action.reason || "-"}`);
  if (payload.next_action.description) {
    lines.push(`- description: ${payload.next_action.description}`);
  }

  lines.push("", "## Pending Items");
  if (payload.pending_items.length === 0) {
    lines.push("- none");
  } else {
    for (const item of payload.pending_items) {
      const unresolved = item.unresolved_roles
        .map((entry) => `${entry.role}:${entry.status}`)
        .join(", ");
      lines.push(
        `- ${item.item_id} (${item.title || "-"}) / unresolved=${unresolved || "none"} / review_gate=${item.review_gate.status}`
      );
    }
  }

  lines.push("", "## Recent Tasks");
  if (payload.recent_tasks.length === 0) {
    lines.push("- none");
  } else {
    for (const task of payload.recent_tasks) {
      lines.push(
        `- ${task.batch_id || "-"}/${task.item_id || "-"}/${task.role || "-"}: ${task.lifecycle || "-"} (${task.age || "-"})`
      );
    }
  }

  ensureDir(mdPath);
  fs.writeFileSync(mdPath, `${lines.join("\n")}\n`, "utf8");
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
          mode: dispatchState.mode || (dispatchState.description ? parseTaskSubject(dispatchState.description)?.mode || null : null),
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
      mode:
        "mode" in entry
          ? entry.mode
          : ("description" in entry && entry.description
              ? parseTaskSubject(entry.description)?.mode || null
              : null),
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

  const rawSummary = (matched[4] || "").trim();
  const role = matched[3];
  const modeInfo = extractRoleMode(role, rawSummary);

  return {
    batch_id: matched[1],
    item_id: matched[2],
    role,
    summary: rawSummary,
    mode: modeInfo.mode,
    mode_summary: modeInfo.summary,
  };
}

function extractRoleMode(role, summary) {
  const trimmed = String(summary || "").trim();
  if (role === "planner") {
    const matched = /^(plan|revise|review):\s+(.+)$/.exec(trimmed);
    return {
      mode: matched ? matched[1] : null,
      summary: matched ? matched[2].trim() : trimmed,
    };
  }

  if (role === "designer") {
    const matched = /^(review|apply):\s+(.+)$/.exec(trimmed);
    return {
      mode: matched ? matched[1] : null,
      summary: matched ? matched[2].trim() : trimmed,
    };
  }

  if (role === "developer") {
    const matched = /^(review|implement):\s+(.+)$/.exec(trimmed);
    return {
      mode: matched ? matched[1] : null,
      summary: matched ? matched[2].trim() : trimmed,
    };
  }

  if (role === "qa") {
    const matched = /^(review|tc|verify):\s+(.+)$/.exec(trimmed);
    return {
      mode: matched ? matched[1] : null,
      summary: matched ? matched[2].trim() : trimmed,
    };
  }

  return {
    mode: null,
    summary: trimmed,
  };
}

function validateRoleMode(meta) {
  if (!meta) {
    return null;
  }

  if (meta.role === "planner" && !meta.mode) {
    return "Planner description must start with `plan:`, `revise:`, or `review:` after the role prefix.";
  }

  if (meta.role === "designer" && !meta.mode) {
    return "Designer description must start with `review:` or `apply:` after the role prefix.";
  }

  if (meta.role === "developer" && !meta.mode) {
    return "Developer description must start with `review:` or `implement:` after the role prefix.";
  }

  if (meta.role === "qa" && !meta.mode) {
    return "QA description must start with `review:`, `tc:` or `verify:` after the role prefix.";
  }

  return null;
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

function checkJsonArrayNonEmpty(filePath, fieldPath) {
  if (!checkFileExists(filePath)) {
    return false;
  }
  const target = parseJsonFile(filePath);
  const value = getByPath(target, fieldPath);
  return Array.isArray(value) && value.length > 0;
}

function checkJsonArrayMinSize(filePath, fieldPath, minSize) {
  if (!checkFileExists(filePath)) return false;
  const target = parseJsonFile(filePath);
  const value = getByPath(target, fieldPath);
  return Array.isArray(value) && value.length >= minSize;
}

function checkJsonObjectHasKeys(filePath, fieldPath, requiredKeys) {
  if (!checkFileExists(filePath)) return false;
  const target = parseJsonFile(filePath);
  const value = getByPath(target, fieldPath);
  if (!value || typeof value !== "object") return false;
  return requiredKeys.every((k) => Object.prototype.hasOwnProperty.call(value, k));
}

const PLANNING_DOC_REQUIRED_SECTIONS = [
  "## 프로젝트 개요",
  "## 우선순위",
  "## 기능 명세",
  "## 비범위",
  "## 제약/의존성",
  "## 화면 목록",
  "## 흐름도",
  "## API / DB 개요",
];

function checkJsonArrayItemMinLength(filePath, fieldPath, minLen) {
  if (!checkFileExists(filePath)) return false;
  const target = parseJsonFile(filePath);
  const value = getByPath(target, fieldPath);
  if (!Array.isArray(value) || value.length === 0) return false;
  return value.every((v) => typeof v === "string" && v.trim().length >= minLen);
}

function checkJsonArrayNoDuplicates(filePath, fieldPath) {
  if (!checkFileExists(filePath)) return false;
  const target = parseJsonFile(filePath);
  const value = getByPath(target, fieldPath);
  if (!Array.isArray(value)) return false;
  const normalized = value.map((v) => String(v).trim().toLowerCase());
  return new Set(normalized).size === normalized.length;
}

function checkWorkboardItemHasQuote(filePath, itemId) {
  if (!checkFileExists(filePath)) return false;
  const content = fs.readFileSync(resolvePath(filePath), "utf8");
  const lines = content.split("\n");
  const rowRegex = new RegExp(`\\|\\s*${itemId}\\s*\\|`);
  const row = lines.find((l) => rowRegex.test(l));
  if (!row) return false;
  const cells = row.split("|").map((c) => c.trim());
  const requestCell = cells[2] || "";
  if (requestCell.length < 20) return false;
  return /["'『「]/.test(requestCell) || requestCell.includes("원문:");
}

// checkHashRecordAndCompare — 최초 실행과 재시도에서 다르게 작동한다:
//   1) 최초 실행 (log 파일 없음 or 해당 key 없음): prevHash=undefined, 현재 해시를 기록하고 true(pass) 반환.
//      → 첫 시도는 "비교 대상 없음"이므로 pass. 대신 이후 비교용 해시가 확실히 남는다.
//   2) 재시도 (이전 해시 존재):
//      - 파일 내용이 바뀌었으면 prevHash !== currentHash → true(pass). 로그 갱신.
//      - 파일 내용이 그대로면 prevHash === currentHash → false(fail). touch 우회 방지.
// side effect: 항상 최신 해시를 로그에 기록 (pass/fail 모두 기록).
// 재시도인데 정말 내용이 같으면 fail — "재시도는 내용을 바꿔야 한다"는 의도된 동작.
function checkHashRecordAndCompare(targetFilePath, hashLogPath) {
  if (!checkFileExists(targetFilePath)) return false;
  const fullTarget = resolvePath(targetFilePath);
  const fullLog = resolvePath(hashLogPath);
  const crypto = require("crypto");
  const content = fs.readFileSync(fullTarget);
  const currentHash = crypto.createHash("sha256").update(content).digest("hex");
  let log = {};
  if (fs.existsSync(fullLog)) {
    try {
      log = JSON.parse(fs.readFileSync(fullLog, "utf8"));
    } catch (e) {
      log = {};
    }
  }
  const prevHash = log[targetFilePath];
  log[targetFilePath] = currentHash;
  log.last_updated = new Date().toISOString();
  fs.mkdirSync(path.dirname(fullLog), { recursive: true });
  fs.writeFileSync(fullLog, JSON.stringify(log, null, 2));
  return prevHash !== currentHash;
}

function checkWfDescPairMatch(claimPath) {
  if (!checkFileExists(claimPath)) return false;
  const claim = parseJsonFile(claimPath);
  const wf = Array.isArray(claim.wf_boards) ? claim.wf_boards : [];
  const desc = Array.isArray(claim.desc_boards) ? claim.desc_boards : [];
  const action = String(claim.action || "").toUpperCase();
  if (action === "NO_CHANGE") return true;
  const wfIds = wf.map((s) => String(s).replace(/^wf_/, "")).sort();
  const descIds = desc.map((s) => String(s).replace(/^desc_/, "")).sort();
  if (wfIds.length === 0 || descIds.length === 0) return false;
  if (wfIds.length !== descIds.length) return false;
  return wfIds.every((id, i) => id === descIds[i]);
}

function checkBoardNameMatchesItem(claimPath, itemId) {
  if (!checkFileExists(claimPath)) return false;
  const claim = parseJsonFile(claimPath);
  const action = String(claim.action || "").toUpperCase();
  if (action === "NO_CHANGE") return true;
  const wf = Array.isArray(claim.wf_boards) ? claim.wf_boards : [];
  if (wf.length === 0) return false;
  const normalizedItem = String(itemId).toLowerCase();
  return wf.every((name) => {
    const n = String(name).toLowerCase();
    if (!n.startsWith("wf_")) return false;
    return n.length > 3;
  });
}

function checkDescNoForbiddenTerms(evidencePath) {
  if (!checkFileExists(evidencePath)) return false;
  const evidence = parseJsonFile(evidencePath);
  const texts = Array.isArray(evidence.texts) ? evidence.texts : [];
  const forbidden = [
    /\bAPI\b/i,
    /\bDB\b/i,
    /payload/i,
    /\bhook\b/i,
    /\bprops\b/i,
    /className/i,
    /endpoint/i,
    /SELECT\s/i,
    /fetch\(/i,
    /axios/i,
  ];
  for (const t of texts) {
    const s = String(t);
    if (forbidden.some((re) => re.test(s))) return false;
  }
  return true;
}

function checkMultiScreenEvidenceExists(claimPath, evidenceDir) {
  if (!checkFileExists(claimPath)) return false;
  const claim = parseJsonFile(claimPath);
  const action = String(claim.action || "").toUpperCase();
  if (action === "NO_CHANGE") return true;
  const wf = Array.isArray(claim.wf_boards) ? claim.wf_boards : [];
  if (wf.length === 0) return false;
  const screens = wf.map((n) => String(n).replace(/^wf_/, ""));
  const fullDir = resolvePath(evidenceDir);
  if (screens.length === 1) {
    const singleWf = path.join(fullDir, "wf-export.json");
    const perScreenWf = path.join(fullDir, `wf-export-${screens[0]}.json`);
    const singleDesc = path.join(fullDir, "desc-export.json");
    const perScreenDesc = path.join(fullDir, `desc-export-${screens[0]}.json`);
    return (
      (fs.existsSync(singleWf) || fs.existsSync(perScreenWf)) &&
      (fs.existsSync(singleDesc) || fs.existsSync(perScreenDesc))
    );
  }
  return screens.every((sid) => {
    const wfFile = path.join(fullDir, `wf-export-${sid}.json`);
    const descFile = path.join(fullDir, `desc-export-${sid}.json`);
    return fs.existsSync(wfFile) && fs.existsSync(descFile);
  });
}

function extractScreenIdsFromPlanningDoc(docPath) {
  if (!checkFileExists(docPath)) return [];
  const content = fs.readFileSync(resolvePath(docPath), "utf8");
  const lines = content.split("\n");
  const startIdx = lines.findIndex((l) => l.trim() === "## 화면 목록");
  if (startIdx === -1) return [];
  let endIdx = lines.length;
  for (let i = startIdx + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i])) {
      endIdx = i;
      break;
    }
  }
  const body = lines.slice(startIdx + 1, endIdx);
  const ids = new Set();
  for (const line of body) {
    const tokens = line.split(/[\s|,`]+/);
    for (const t of tokens) {
      const clean = t.trim();
      if (!clean) continue;
      if (/^[a-z][a-z0-9_-]{2,}$/.test(clean) && !/^(table|screen_id|이름|screen|id|목록)$/i.test(clean)) {
        ids.add(clean);
      }
    }
  }
  return [...ids];
}

function checkWfBoardsMatchPlanningDoc(claimPath, docPath) {
  if (!checkFileExists(claimPath)) return false;
  const claim = parseJsonFile(claimPath);
  const action = String(claim.action || "").toUpperCase();
  if (action === "NO_CHANGE") return true;
  const wf = Array.isArray(claim.wf_boards) ? claim.wf_boards : [];
  if (wf.length === 0) return false;
  const docIds = new Set(extractScreenIdsFromPlanningDoc(docPath));
  if (docIds.size === 0) return false;
  return wf.every((name) => {
    const sid = String(name).replace(/^wf_/, "").split("__")[0];
    return docIds.has(sid);
  });
}

function checkRetryPreservesBoardIds(evidenceDir) {
  const fullDir = resolvePath(evidenceDir);
  if (!fs.existsSync(fullDir)) return false;
  const afterPath = path.join(fullDir, "wf-desc-snapshot-after.json");
  if (!fs.existsSync(afterPath)) return true;
  const archiveDir = path.join(fullDir, "archive");
  if (!fs.existsSync(archiveDir)) return true;
  const attempts = fs.readdirSync(archiveDir).filter((d) => /^attempt-\d+$/.test(d));
  if (attempts.length === 0) return true;
  attempts.sort((a, b) => parseInt(b.split("-")[1], 10) - parseInt(a.split("-")[1], 10));
  const prevAfter = path.join(archiveDir, attempts[0], "wf-desc-snapshot-after.json");
  if (!fs.existsSync(prevAfter)) return true;
  let prev, curr;
  try {
    prev = JSON.parse(fs.readFileSync(prevAfter, "utf8"));
    curr = JSON.parse(fs.readFileSync(afterPath, "utf8"));
  } catch (e) {
    return false;
  }
  const prevIds = (Array.isArray(prev) ? prev : [])
    .map((e) => e && e.id)
    .filter(Boolean);
  const currIds = new Set(
    (Array.isArray(curr) ? curr : [])
      .map((e) => e && e.id)
      .filter(Boolean)
  );
  return prevIds.every((id) => currIds.has(id));
}

function checkRequestCoverageValid(claimPath) {
  if (!checkFileExists(claimPath)) return false;
  const claim = parseJsonFile(claimPath);
  const rc = claim.request_coverage;
  if (rc === undefined || rc === null) return false;
  if (typeof rc === "number") return rc >= 0 && rc <= 1;
  if (typeof rc === "string") {
    const m = rc.match(/^(\d+(?:\.\d+)?)\s*%?$/);
    if (!m) return false;
    const n = parseFloat(m[1]);
    return n >= 0 && n <= 100;
  }
  if (typeof rc === "object") {
    return typeof rc.covered === "number" && typeof rc.total === "number" && rc.total > 0 && rc.covered <= rc.total;
  }
  return false;
}

function checkNoDeferralPhrases(claimPath) {
  if (!checkFileExists(claimPath)) return false;
  const text = fs.readFileSync(resolvePath(claimPath), "utf8");
  const forbidden = [
    /후속\s*루프에서\s*처리/,
    /이번엔\s*문서만\s*반영/,
    /디자인은\s*나중에/,
    /일단\s*개발\s*먼저/,
    /나중에\s*처리/,
    /추후\s*반영/,
  ];
  return !forbidden.some((re) => re.test(text));
}

function normalizeRawText(value) {
  if (value === undefined || value === null) return "";
  return String(value)
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n+/g, "\n")
    .trim();
}

function sha256Hex(value) {
  const crypto = require("crypto");
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function getPreReviewPath(batchId, itemId) {
  return `workspace/planning/.pre-review/${batchId}/${itemId}.json`;
}

function parseUserRawBlock(prompt) {
  if (typeof prompt !== "string" || !prompt) return null;
  const fence = prompt.match(/```user_raw\s*\n([\s\S]*?)\n```/);
  if (fence) return fence[1].trim();
  const header = prompt.match(/사용자 원문:\s*\n([\s\S]*?)(?:\n\s*사전 검토|\n\s*boards-snapshot|\n\s*action_rationale|$)/);
  if (header) return header[1].trim();
  return null;
}

function parsePreReviewQA(prompt) {
  if (typeof prompt !== "string" || !prompt) return [];
  const block = prompt.match(/사전 검토 Q&A:\s*\n([\s\S]*?)(?:\n\s*boards-snapshot|\n\s*action_rationale|\n\s*planning-doc-sections|$)/);
  if (!block) return [];
  if (/질문\s*없음/.test(block[1])) return [];
  const pairs = [];
  const re = /Q\s*:\s*([^\n]+)\s*\n\s*A\s*:\s*([^\n]+)/g;
  let m;
  while ((m = re.exec(block[1])) !== null) {
    pairs.push({ q: m[1].trim(), a: m[2].trim() });
  }
  return pairs;
}

function capturePreReviewFromPrompt(meta, prompt) {
  if (!meta || meta.role !== "planner" || meta.mode !== "plan") return;
  if (!meta.batch_id || !meta.item_id) return;
  const userRaw = parseUserRawBlock(prompt);
  if (!userRaw) return;
  const normalized = normalizeRawText(userRaw);
  const qa = parsePreReviewQA(prompt);
  const target = resolvePath(getPreReviewPath(meta.batch_id, meta.item_id));
  const payload = {
    batch_id: meta.batch_id,
    item_id: meta.item_id,
    user_raw: userRaw,
    user_raw_normalized: normalized,
    user_raw_hash: sha256Hex(normalized),
    qa_pairs: qa,
    captured_at: nowIso(),
  };
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, JSON.stringify(payload, null, 2));
  } catch (e) {
    process.stderr.write(`[capturePreReview] write failed: ${e.message}\n`);
  }
}

function checkUserRawRequestMatch(claimPath, preReviewPath) {
  if (!checkFileExists(claimPath)) return false;
  if (!checkFileExists(preReviewPath)) return false;
  const claim = parseJsonFile(claimPath);
  const pre = parseJsonFile(preReviewPath);
  const quoted = claim && claim.user_raw_request_quoted;
  const origin = pre && (pre.user_raw_normalized || pre.user_raw);
  if (!quoted || !origin) return false;
  const nq = normalizeRawText(quoted);
  const no = normalizeRawText(origin);
  if (!nq || !no) return false;
  if (nq === no) return true;
  if (no.includes(nq) && nq.length >= Math.max(8, Math.floor(no.length * 0.5))) return true;
  return false;
}

function checkPreReviewQaApplied(claimPath, preReviewPath) {
  if (!checkFileExists(claimPath)) return false;
  if (!checkFileExists(preReviewPath)) return false;
  const claim = parseJsonFile(claimPath);
  const pre = parseJsonFile(preReviewPath);
  const expected = Array.isArray(pre && pre.qa_pairs) ? pre.qa_pairs : [];
  if (expected.length === 0) return true;
  const applied = claim && claim.pre_review_applied;
  if (!applied) return false;
  const haystack = typeof applied === "string" ? applied : JSON.stringify(applied);
  const hay = normalizeRawText(haystack);
  for (const { q, a } of expected) {
    const qToken = normalizeRawText(q).slice(0, 12);
    const aToken = normalizeRawText(a).slice(0, 12);
    if (!qToken || !aToken) continue;
    if (!hay.includes(qToken) || !hay.includes(aToken)) return false;
  }
  return true;
}

const PENPOT_STATUS_PATH = "workspace/planning/.penpot-status.json";
const PENPOT_STATUS_MAX_AGE_MS = 30 * 60 * 1000;

function checkPenpotReachability() {
  const cfgPath = resolvePath("workspace/planning/project-config.md");
  if (fs.existsSync(cfgPath)) {
    try {
      const cfg = fs.readFileSync(cfgPath, "utf8");
      if (/penpot\s*:\s*(disabled|off|none)/i.test(cfg)) return null;
    } catch (e) {
      // ignore config read error
    }
  }
  const full = resolvePath(PENPOT_STATUS_PATH);
  if (!fs.existsSync(full)) {
    return `Penpot 선검사 누락: ${PENPOT_STATUS_PATH} 파일 없음. planner dispatch 전에 mcp__penpot__high_level_overview 또는 동급 ping 을 한 번 실행하고 결과를 이 파일에 { reachable: true, checked_at, file_id } 로 기록하라. 접근 실패면 hold-open penpot_unavailable.`;
  }
  let status;
  try {
    status = JSON.parse(fs.readFileSync(full, "utf8"));
  } catch (e) {
    return `Penpot 상태 파일 파싱 실패: ${e.message}. ${PENPOT_STATUS_PATH} 를 다시 기록하라.`;
  }
  const checkedAt = status && status.checked_at;
  const ageMs = checkedAt ? Date.now() - Date.parse(checkedAt) : Infinity;
  if (!Number.isFinite(ageMs) || ageMs > PENPOT_STATUS_MAX_AGE_MS) {
    return `Penpot 상태 파일이 30분 초과 stale (checked_at=${checkedAt || "미기재"}). 새로 ping 후 갱신하라.`;
  }
  if (status.reachable !== true) {
    return `Penpot unreachable (${PENPOT_STATUS_PATH} reachable=${status.reachable}). hold-open penpot_unavailable 기록 후 접근성 회복 전까지 planner dispatch 금지.`;
  }
  return null;
}

const REQUEST_COVERAGE_STOPWORDS = new Set([
  "그리고", "그러면", "그러나", "하지만", "또는", "해서", "하여", "해줘", "해주세요", "주세요",
  "만들어", "만들어줘", "만들어주세요", "만들기", "만든다", "만들자",
  "있는", "없는", "있다", "없다", "이다", "입니다", "하다", "한다", "했다",
  "것을", "것이", "것도", "것은", "것", "수", "때", "곳", "안", "밖", "위", "아래",
  "바", "듯", "점", "등", "및", "내", "외", "속", "쪽",
  "으로", "까지", "부터", "에서", "에게", "한테", "께서", "으로서", "로서", "으로써", "로써",
  "앱", "서비스", "프로젝트", "기능", "화면",
  "사용자", "유저",
  "웹", "모바일", "태블릿",
]);

function tokenizeRequestText(text) {
  if (typeof text !== "string" || !text) return [];
  const cleaned = text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`]*`/g, " ")
    .replace(/[>\-*#|"'`\[\](){}.,!?;:/\\]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return [];
  const raw = cleaned.split(/\s+/);
  const tokens = new Set();
  for (const w of raw) {
    const stripped = w.replace(/(을|를|이|가|은|는|에|의|과|와|도|만|뿐|으로|로|에서|에게|부터|까지)$/u, "");
    const token = stripped.length >= 2 ? stripped : w;
    if (token.length < 2) continue;
    if (REQUEST_COVERAGE_STOPWORDS.has(token)) continue;
    if (/^\d+$/.test(token)) continue;
    tokens.add(token);
  }
  return Array.from(tokens);
}

function extractWorkboardRequestText(workboardPath, itemId) {
  if (!checkFileExists(workboardPath)) return null;
  const content = fs.readFileSync(resolvePath(workboardPath), "utf8");
  const lines = content.split("\n");
  const rowRegex = new RegExp(`\\|\\s*${itemId}\\s*\\|`);
  const row = lines.find((l) => rowRegex.test(l));
  if (!row) return null;
  const cells = row.split("|").map((c) => c.trim());
  return cells[2] || "";
}

function extractPlanningDocFeatureSection(docPath) {
  if (!checkFileExists(docPath)) return "";
  const content = fs.readFileSync(resolvePath(docPath), "utf8");
  const lines = content.split("\n");
  const startIdx = lines.findIndex((l) => /^##\s*기능\s*명세/.test(l));
  if (startIdx === -1) return "";
  let endIdx = lines.length;
  for (let i = startIdx + 1; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i])) {
      endIdx = i;
      break;
    }
  }
  return lines.slice(startIdx, endIdx).join("\n");
}

function checkRequestCoverageCrossCheck(workboardPath, itemId, docPath) {
  const requestText = extractWorkboardRequestText(workboardPath, itemId);
  if (!requestText) return false;
  const featureText = extractPlanningDocFeatureSection(docPath);
  if (!featureText) return false;
  const tokens = tokenizeRequestText(requestText);
  if (tokens.length === 0) return true;
  const hay = featureText.replace(/\s+/g, " ");
  const missing = tokens.filter((t) => !hay.includes(t));
  const covered = tokens.length - missing.length;
  const ratio = covered / tokens.length;
  if (ratio < 0.8) {
    const logPath = resolvePath(`workspace/evidence/planner/_coverage/${itemId}.json`);
    try {
      fs.mkdirSync(path.dirname(logPath), { recursive: true });
      fs.writeFileSync(
        logPath,
        JSON.stringify(
          {
            item_id: itemId,
            tokens,
            missing,
            covered,
            ratio,
            threshold: 0.8,
            checked_at: nowIso(),
          },
          null,
          2
        )
      );
    } catch (e) {
      // ignore log write failure
    }
    return false;
  }
  return true;
}

const FIELD_QUALITY_FORBIDDEN = [
  /\bTBD\b/i,
  /\bTODO\b/i,
  /\blorem\b/i,
  /\bplaceholder\b/i,
  /\bN\/A\b/i,
  /예시\s*\d*/,
  /샘플/,
  /미정/,
  /추후\s*(반영|작성|보강|정리)/,
  /나중에/,
  /좋은\s*UX/,
  /사용자\s*친화적/,
  /적절한/,
  /알아서/,
];

function checkJsonArrayItemQuality(filePath, fieldPath) {
  if (!checkFileExists(filePath)) return false;
  const obj = parseJsonFile(filePath);
  const arr = getByPath(obj, fieldPath);
  if (!Array.isArray(arr)) return false;
  if (arr.length === 0) return false;
  const prefixes = new Set();
  for (const item of arr) {
    if (typeof item !== "string") return false;
    const trimmed = item.trim();
    if (!trimmed) return false;
    for (const re of FIELD_QUALITY_FORBIDDEN) {
      if (re.test(trimmed)) return false;
    }
    const words = trimmed
      .split(/[\s,./:;()\[\]{}"'`]+/)
      .filter((w) => w.length >= 2);
    const unique = new Set(words);
    if (unique.size < 3) return false;
    const prefix = trimmed.slice(0, 6);
    if (prefixes.has(prefix)) return false;
    prefixes.add(prefix);
  }
  return true;
}

const LOOP_B_REVIEW_FILES = [
  "planner-review.md",
  "designer-review.md",
  "developer-review.md",
  "qa-review.md",
];

const LOOP_B_REVIEW_REQUIRED_SECTIONS = [
  /(?:^|\n)##\s*UIUX\s*보완점/,
  /(?:^|\n)##\s*디스크립션\s*\(desc_\*?\)\s*보완점/,
  /(?:^|\n)##\s*기획서\s*보완점/,
];

const PENPOT_BOARDS_SNAPSHOT_PATH = "workspace/planning/.penpot-boards.json";
const PENPOT_BOARDS_MAX_AGE_MS = 30 * 60 * 1000;

function checkPenpotBoardsPresent(claimPath, role) {
  if (!checkFileExists(claimPath)) return false;
  const claim = parseJsonFile(claimPath);
  const snapPath = resolvePath(PENPOT_BOARDS_SNAPSHOT_PATH);
  if (!fs.existsSync(snapPath)) return false;
  let snap;
  try {
    snap = JSON.parse(fs.readFileSync(snapPath, "utf8"));
  } catch (e) {
    return false;
  }
  const checkedAt = snap && snap.checked_at;
  const ageMs = checkedAt ? Date.now() - Date.parse(checkedAt) : Infinity;
  if (!Number.isFinite(ageMs) || ageMs > PENPOT_BOARDS_MAX_AGE_MS) return false;
  const liveNames = new Set();
  const liveIds = new Set();
  if (Array.isArray(snap.boards)) {
    for (const b of snap.boards) {
      if (typeof b === "string") {
        liveNames.add(b);
      } else if (b && typeof b === "object") {
        if (typeof b.board_name === "string") liveNames.add(b.board_name);
        if (typeof b.board_id === "string") liveIds.add(b.board_id);
      }
    }
  }
  if (liveNames.size === 0 && liveIds.size === 0) return false;
  const key = role === "planner" ? ["wf_boards", "desc_boards"] : role === "designer" ? ["design_boards"] : [];
  for (const k of key) {
    const arr = Array.isArray(claim[k]) ? claim[k] : [];
    for (const b of arr) {
      if (typeof b === "string") {
        if (!liveNames.has(b) && !liveIds.has(b)) return false;
        continue;
      }
      if (!b || typeof b !== "object") continue;
      const hasName = typeof b.board_name === "string" && b.board_name.length > 0;
      const hasId = typeof b.board_id === "string" && b.board_id.length > 0;
      if (!hasName && !hasId) continue;
      const nameMatch = hasName && liveNames.has(b.board_name);
      const idMatch = hasId && liveIds.has(b.board_id);
      if (!nameMatch && !idMatch) return false;
    }
  }
  return true;
}

function readExportShapeFile(filePath) {
  if (!checkFileExists(filePath)) return null;
  try {
    return parseJsonFile(filePath);
  } catch (e) {
    return null;
  }
}

function extractBoardRect(shape) {
  if (!shape || typeof shape !== "object") return null;
  const sel = shape.selrect || shape.sel_rect || null;
  let x, y, w, h;
  if (sel && typeof sel === "object") {
    const x1 = typeof sel.x1 === "number" ? sel.x1 : (typeof sel.x === "number" ? sel.x : null);
    const y1 = typeof sel.y1 === "number" ? sel.y1 : (typeof sel.y === "number" ? sel.y : null);
    const x2 = typeof sel.x2 === "number" ? sel.x2 : (x1 != null && typeof sel.width === "number" ? x1 + sel.width : null);
    const y2 = typeof sel.y2 === "number" ? sel.y2 : (y1 != null && typeof sel.height === "number" ? y1 + sel.height : null);
    if ([x1, y1, x2, y2].every((v) => typeof v === "number")) {
      x = x1; y = y1; w = x2 - x1; h = y2 - y1;
    }
  }
  if (x == null) x = typeof shape.x === "number" ? shape.x : shape.bounds && shape.bounds.x;
  if (y == null) y = typeof shape.y === "number" ? shape.y : shape.bounds && shape.bounds.y;
  if (w == null) w = typeof shape.width === "number" ? shape.width : shape.bounds && shape.bounds.width;
  if (h == null) h = typeof shape.height === "number" ? shape.height : shape.bounds && shape.bounds.height;
  const page = shape.page_id || shape.page || shape.parent_page || (shape.parent && shape.parent.page_id) || null;
  if (![x, y, w, h].every((v) => typeof v === "number")) return null;
  return { x, y, w, h, bottom: y + h, right: x + w, page };
}

function checkDesignBelowWfDesc(evidenceDir) {
  const resolved = resolvePath(evidenceDir);
  if (!fs.existsSync(resolved)) return false;
  const wfPath = path.join(resolved, "wf-export.json");
  const descPath = path.join(resolved, "desc-export.json");
  const designPath = path.join(resolved, "design-export.json");
  const wf = readExportShapeFile(wfPath);
  const desc = readExportShapeFile(descPath);
  const design = readExportShapeFile(designPath);
  if (!design) return false;
  if (!wf && !desc) return true;
  const dr = extractBoardRect(design);
  if (!dr) return false;
  const candidates = [wf, desc].filter(Boolean).map(extractBoardRect).filter(Boolean);
  if (candidates.length === 0) return true;
  const maxBottom = Math.max(...candidates.map((r) => r.bottom));
  if (dr.y < maxBottom + 120) return false;
  for (const r of candidates) {
    const xOverlap = !(dr.right <= r.x || dr.x >= r.right);
    const yOverlap = !(dr.bottom <= r.y || dr.y >= r.bottom);
    if (xOverlap && yOverlap) return false;
  }
  const pages = new Set(candidates.map((r) => r.page).filter(Boolean));
  if (pages.size > 0 && dr.page && !pages.has(dr.page)) return false;
  return true;
}

function parseReviewScore(content) {
  if (typeof content !== "string" || !content) return null;
  const patterns = [
    /(?:^|\n)\s*(?:##\s*)?(?:종합\s*)?점수\s*[:：]?\s*(\d{1,3})/,
    /(?:^|\n)\s*(?:##\s*)?총점\s*[:：]?\s*(\d{1,3})/,
    /(?:^|\n)\s*(?:##\s*)?score\s*[:：]?\s*(\d{1,3})/i,
    /(\d{1,3})\s*\/\s*100/,
    /(\d{1,3})\s*점/,
  ];
  for (const re of patterns) {
    const m = content.match(re);
    if (m) {
      const n = parseInt(m[1], 10);
      if (Number.isFinite(n) && n >= 0 && n <= 100) return n;
    }
  }
  return null;
}

function checkDesignerReviewScoreGate(reviewMdPath, claimPath, minScore) {
  if (!checkFileExists(reviewMdPath)) return false;
  const content = fs.readFileSync(resolvePath(reviewMdPath), "utf8");
  const min = Number.isFinite(parseInt(minScore, 10)) ? parseInt(minScore, 10) : 80;
  let score = parseReviewScore(content);
  if (claimPath && checkFileExists(claimPath)) {
    const claim = parseJsonFile(claimPath);
    if (typeof claim.review_score === "number") {
      score = claim.review_score;
    }
    const approval = String(claim.review_approval || "").toUpperCase();
    if (approval === "N") return false;
  }
  if (score === null) return false;
  return score >= min;
}

const PRIOR_REVIEW_STOPWORDS = new Set([
  "그리고", "그러나", "하지만", "또는", "경우", "이를", "있는", "없는", "필요", "추가", "수정",
  "관련", "예를", "들어", "해서", "하여", "하는", "되는", "같은", "다른", "때문", "위해",
  "대해", "통해", "에서", "부터", "까지", "으로", "이다", "하다", "있다", "없다",
  "것이", "것은", "것을", "것도", "것", "수", "때", "곳", "등", "및", "중",
  "우리", "여기", "거기", "저기", "이것", "그것", "저것", "이런", "그런", "저런",
]);

function extractKeywordsFromMd(text) {
  if (typeof text !== "string" || !text) return [];
  const cleaned = text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`]*`/g, " ")
    .replace(/[#>*\-|\[\](){}.,!?;:/\\"'`]+/g, " ")
    .replace(/\s+/g, " ");
  const out = new Set();
  for (const w of cleaned.split(/\s+/)) {
    if (!w) continue;
    const stripped = w.replace(/(을|를|이|가|은|는|에|의|과|와|도|만|뿐|으로|로|에서|에게|부터|까지)$/u, "");
    const tok = stripped.length >= 2 ? stripped : w;
    if (tok.length < 2) continue;
    if (/^\d+$/.test(tok)) continue;
    if (PRIOR_REVIEW_STOPWORDS.has(tok)) continue;
    out.add(tok);
  }
  return Array.from(out);
}

function checkPriorReviewAddressed(uiuxReviewPath, planningDocPath, claimPath) {
  if (!checkFileExists(uiuxReviewPath)) return true;
  if (!checkFileExists(planningDocPath)) return false;
  const review = fs.readFileSync(resolvePath(uiuxReviewPath), "utf8");
  const issuesBlock = review.match(/(?:^|\n)##?\s*개선\s*사항[\s\S]*?(?=\n##\s|$)/);
  if (!issuesBlock) return true;
  const tokens = extractKeywordsFromMd(issuesBlock[0]).slice(0, 40);
  if (tokens.length === 0) return true;
  const doc = fs.readFileSync(resolvePath(planningDocPath), "utf8");
  let claimText = "";
  if (claimPath && checkFileExists(claimPath)) {
    const claim = parseJsonFile(claimPath);
    claimText = JSON.stringify(claim.review_response_decisions || claim.review_response || claim.pre_review_applied || "");
  }
  const hay = `${doc}\n${claimText}`;
  const covered = tokens.filter((t) => hay.includes(t));
  return covered.length / tokens.length >= 0.7;
}

function checkReviewClaimComplete(claimPath) {
  if (!checkFileExists(claimPath)) return false;
  const claim = parseJsonFile(claimPath);
  if (String(claim.mode || "") !== "review") return false;
  if (typeof claim.review_score !== "number") return false;
  if (!/^(Y|N)$/.test(String(claim.review_approval || "").toUpperCase())) return false;
  const issues = Array.isArray(claim.review_issues) ? claim.review_issues : null;
  if (!issues) return false;
  if (claim.review_approval === "N" && issues.length === 0) return false;
  if (typeof claim.review_summary !== "string" || claim.review_summary.trim().length < 20) return false;
  return true;
}

function checkDeveloperHandoffGate(state, meta) {
  if (meta.role !== "developer") return null;
  if (meta.mode !== "review" && meta.mode !== "implement") return null;

  const batch = (state.batches || []).find((b) => b && b.batch_id === meta.batch_id);
  const item = batch && (batch.items || []).find((i) => i && i.item_id === meta.item_id);
  if (!item) return null;

  const plannerState = (item.roles || []).find((r) => r.role === "planner");
  if (!plannerState || !plannerState.done_ticket || plannerState.done_ticket.status !== "issued") {
    return `Developer ${meta.mode} blocked for ${meta.batch_id}/${meta.item_id}: planner done ticket missing. planner plan: 완료 전에 developer 진입 금지.`;
  }
  const plannerClaimPath = resolvePath(`workspace/claims/${meta.batch_id}/${meta.item_id}/planner.claim.json`);
  if (!fs.existsSync(plannerClaimPath)) {
    return `Developer ${meta.mode} blocked: planner.claim.json 부재. planner plan: 재실행 필요.`;
  }
  let plannerClaim;
  try {
    plannerClaim = JSON.parse(fs.readFileSync(plannerClaimPath, "utf8"));
  } catch (e) {
    return `Developer ${meta.mode} blocked: planner.claim.json 파싱 실패 (${e.message}).`;
  }

  const hasUserRaw = typeof plannerClaim.user_raw_request_quoted === "string" && plannerClaim.user_raw_request_quoted.trim().length > 0;
  const hasReadLog = Array.isArray(plannerClaim.read_log) && plannerClaim.read_log.length >= 4;
  const hasActionRationale = typeof plannerClaim.action_rationale === "string" && plannerClaim.action_rationale.trim().length > 0;
  if (!hasUserRaw || !hasReadLog || !hasActionRationale) {
    return `Developer ${meta.mode} blocked: planner.claim 에 plan 모드 필수 필드(user_raw_request_quoted/read_log≥4/action_rationale) 없음. planner plan: 을 먼저 돌려야 함 (revise 만 있는 비정상 상태).`;
  }

  const designerState = (item.roles || []).find((r) => r.role === "designer");
  const designerRequired = String(plannerClaim.designer_required || "").toUpperCase();
  const designerSkipIssued =
    designerState && designerState.skip_ticket && designerState.skip_ticket.status === "issued";

  if (designerSkipIssued) {
    if (designerRequired !== "N") {
      return `Developer ${meta.mode} blocked: designer skip_ticket 발급되어 있으나 planner.claim.designer_required=${designerRequired || "미정"}. skip 이 유효하려면 planner 가 N 을 명시해야 함.`;
    }
    const reason = typeof plannerClaim.design_reason === "string" ? plannerClaim.design_reason.trim() : "";
    if (reason.length < 30) {
      return `Developer ${meta.mode} blocked: designer skip 은 planner.claim.design_reason 30자 이상 사유 필요 (현재 ${reason.length}자).`;
    }
    return null;
  }

  if (designerRequired === "N") {
    return null;
  }

  if (!designerState || !designerState.done_ticket || designerState.done_ticket.status !== "issued") {
    return `Developer ${meta.mode} blocked: designer done ticket missing. designer apply: 완료 전에 developer 진입 금지.`;
  }

  const designerClaimPath = resolvePath(`workspace/claims/${meta.batch_id}/${meta.item_id}/designer.claim.json`);
  if (!fs.existsSync(designerClaimPath)) {
    return `Developer ${meta.mode} blocked: designer.claim.json 부재. designer apply: 재실행 필요.`;
  }
  let designerClaim;
  try {
    designerClaim = JSON.parse(fs.readFileSync(designerClaimPath, "utf8"));
  } catch (e) {
    return `Developer ${meta.mode} blocked: designer.claim.json 파싱 실패 (${e.message}).`;
  }

  const designerMode = String(designerClaim.mode || "").toLowerCase();
  if (designerMode === "review") {
    return `Developer ${meta.mode} blocked: designer 의 최신 claim 이 mode=review 다. design_* 생성은 아직 안 됐다. designer apply: 를 먼저 호출해야 함.`;
  }

  const designBoards = Array.isArray(designerClaim.design_boards) ? designerClaim.design_boards : [];
  const action = String(designerClaim.action || "").toUpperCase();
  if (action !== "NO_CHANGE" && designBoards.length === 0) {
    return `Developer ${meta.mode} blocked: designer.claim.design_boards 비어 있음. design_* Board 없이 developer 진입 금지.`;
  }

  const devReady = String(designerClaim.developer_ready || "").toUpperCase();
  if (devReady !== "Y") {
    return `Developer ${meta.mode} blocked: designer.claim.developer_ready=${devReady || "미정"} (Y 필요).`;
  }

  if (meta.mode === "review") {
    const designExportPath = resolvePath(`workspace/evidence/designer/${meta.batch_id}/${meta.item_id}/design-export.json`);
    if (action !== "NO_CHANGE" && !fs.existsSync(designExportPath)) {
      return `Developer review blocked: design-export.json 부재. designer apply 의 export_shape 시각 확인 증거 없음.`;
    }
  }

  if (action !== "NO_CHANGE") {
    if (!checkPenpotBoardsPresent(designerClaimPath, "designer")) {
      return `Developer ${meta.mode} blocked: design_* Board 가 .penpot-boards.json 스냅샷에 없거나 30분 초과 stale. designer apply 후 Penpot Board 존재 스냅샷을 갱신해야 함.`;
    }
  }

  return null;
}

function checkDesignerSkipValid(plannerClaimPath, workboardPath, itemId) {
  if (!checkFileExists(plannerClaimPath)) return false;
  const claim = parseJsonFile(plannerClaimPath);
  const required = String(claim.designer_required || "").toUpperCase();
  if (required !== "N") return true;
  const reason = typeof claim.design_reason === "string" ? claim.design_reason.trim() : "";
  if (reason.length < 30) return false;
  const uiVisibleHints = [
    /화면/, /레이아웃/, /버튼/, /입력/, /폼/, /리스트/, /목록/, /모달/, /드로어/,
    /토스트/, /아이콘/, /색상/, /타이포/, /텍스트/, /배지/, /카드/, /배너/,
  ];
  const reqText = extractWorkboardRequestText(workboardPath, itemId) || "";
  const combined = `${reqText}\n${typeof claim.planning_doc_sections === "string" ? claim.planning_doc_sections : ""}`;
  if (uiVisibleHints.some((re) => re.test(reqText))) {
    return false;
  }
  const action = String(claim.action || "").toUpperCase();
  if (action !== "NO_CHANGE" && !/(서버|API|내부 로직|비UI|스키마|마이그레이션|환경설정)/.test(reason)) {
    return false;
  }
  return true;
}

function checkDesignerCoversPlannerTargets(designerClaimPath, plannerClaimPath) {
  if (!checkFileExists(designerClaimPath)) return false;
  if (!checkFileExists(plannerClaimPath)) return false;
  const dc = parseJsonFile(designerClaimPath);
  const pc = parseJsonFile(plannerClaimPath);
  const targets = Array.isArray(pc.design_target_boards) ? pc.design_target_boards : [];
  const made = Array.isArray(dc.design_boards) ? dc.design_boards : [];
  const targetNames = new Set(
    targets
      .map((t) => (typeof t === "string" ? t : t && t.board_name))
      .filter(Boolean)
  );
  if (targetNames.size === 0) return true;
  const madeNames = new Set(
    made
      .map((t) => (typeof t === "string" ? t : t && t.board_name))
      .filter(Boolean)
  );
  for (const n of targetNames) {
    if (!madeNames.has(n)) return false;
  }
  return true;
}

function checkDesignBoardsMatchWfBoards(designerClaimPath, plannerClaimPath) {
  if (!checkFileExists(designerClaimPath)) return false;
  if (!checkFileExists(plannerClaimPath)) return false;
  const dc = parseJsonFile(designerClaimPath);
  const pc = parseJsonFile(plannerClaimPath);
  const wf = Array.isArray(pc.wf_boards) ? pc.wf_boards : [];
  const design = Array.isArray(dc.design_boards) ? dc.design_boards : [];
  if (wf.length === 0) return true;
  const wfScreens = new Set(
    wf
      .map((b) => {
        if (typeof b === "string") return b.replace(/^wf_/, "");
        return b && (b.screen_id || (typeof b.board_name === "string" ? b.board_name.replace(/^wf_/, "") : null));
      })
      .filter(Boolean)
  );
  const designScreens = new Set(
    design
      .map((b) => {
        if (typeof b === "string") return b.replace(/^design_/, "");
        return b && (b.screen_id || (typeof b.board_name === "string" ? b.board_name.replace(/^design_/, "") : null));
      })
      .filter(Boolean)
  );
  for (const s of wfScreens) {
    if (!designScreens.has(s)) return false;
  }
  return true;
}

function checkDeveloperReadyCrossCheck(designerClaimPath, plannerClaimPath) {
  if (!checkFileExists(designerClaimPath)) return false;
  const dc = parseJsonFile(designerClaimPath);
  const devReady = String(dc.developer_ready || "").toUpperCase();
  if (devReady !== "Y") return true;
  const missing = Array.isArray(dc.missing_items) ? dc.missing_items : [];
  if (missing.length > 0) return false;
  if (!checkDesignerCoversPlannerTargets(designerClaimPath, plannerClaimPath)) return false;
  if (!checkDesignBoardsMatchWfBoards(designerClaimPath, plannerClaimPath)) return false;
  return true;
}

function checkLoopBReviewBundleComplete(batchId, itemId) {
  const dir = `workspace/reviews/${batchId}/${itemId}`;
  const assign = resolvePath(`${dir}/assignments.json`);
  const anyExists = LOOP_B_REVIEW_FILES.some((n) => fs.existsSync(resolvePath(`${dir}/${n}`)));
  if (!fs.existsSync(assign) && !anyExists) return true;
  for (const name of LOOP_B_REVIEW_FILES) {
    const p = resolvePath(`${dir}/${name}`);
    if (!fs.existsSync(p)) return false;
    const content = fs.readFileSync(p, "utf8");
    if (content.trim().length < 120) return false;
    for (const re of LOOP_B_REVIEW_REQUIRED_SECTIONS) {
      if (!re.test(content)) return false;
    }
  }
  return true;
}

const ASSIGNMENT_PLANNER_KEYWORDS = [
  "기획", "스펙", "요구사항", "스코프", "흐름", "시나리오", "상태", "엣지", "예외",
  "API", "권한", "데이터", "정의", "정책", "규칙", "문구", "문언", "라벨",
  "screen_id", "비범위", "화면 목록", "동작", "로직",
];
const ASSIGNMENT_DESIGNER_KEYWORDS = [
  "시각", "레이아웃", "정렬", "간격", "색상", "컬러", "타이포", "폰트", "그림자",
  "아이콘", "일러스트", "여백", "패딩", "마진", "radius", "둥근", "배경", "오버레이",
  "애니메이션", "트랜지션", "호버", "인터랙션", "반응형", "breakpoint",
  "design_", "wf_", "desc_",
];

function classifyAssignmentTask(task) {
  const text = `${task.summary || ""}`;
  const plannerHits = ASSIGNMENT_PLANNER_KEYWORDS.filter((k) => text.includes(k)).length;
  const designerHits = ASSIGNMENT_DESIGNER_KEYWORDS.filter((k) => text.includes(k)).length;
  if (plannerHits > designerHits) return "planner";
  if (designerHits > plannerHits) return "designer";
  return "ambiguous";
}

function checkAssignmentsClassification(batchId, itemId) {
  const p = resolvePath(`workspace/reviews/${batchId}/${itemId}/assignments.json`);
  if (!fs.existsSync(p)) return true;
  let obj;
  try { obj = JSON.parse(fs.readFileSync(p, "utf8")); } catch (e) { return false; }
  const pl = Array.isArray(obj.planner_tasks) ? obj.planner_tasks : [];
  const de = Array.isArray(obj.designer_tasks) ? obj.designer_tasks : [];
  for (const t of pl) {
    const c = classifyAssignmentTask(t);
    if (c === "designer") return false;
  }
  for (const t of de) {
    const c = classifyAssignmentTask(t);
    if (c === "planner") return false;
  }
  return true;
}

function checkLoopBAssignmentsValid(batchId, itemId) {
  const p = resolvePath(`workspace/reviews/${batchId}/${itemId}/assignments.json`);
  if (!fs.existsSync(p)) return true;
  let obj;
  try {
    obj = JSON.parse(fs.readFileSync(p, "utf8"));
  } catch (e) {
    return false;
  }
  const pl = Array.isArray(obj.planner_tasks) ? obj.planner_tasks : null;
  const de = Array.isArray(obj.designer_tasks) ? obj.designer_tasks : null;
  const rationale = typeof obj.rationale === "string" ? obj.rationale.trim() : "";
  if (!pl || !de) return false;
  if (pl.length + de.length === 0) return false;
  if (rationale.length < 20) return false;
  const validOne = (task) =>
    task &&
    typeof task.id === "string" && task.id.length >= 2 &&
    typeof task.source === "string" && /^(planner|designer|developer|qa)$/.test(task.source) &&
    typeof task.summary === "string" && task.summary.trim().length >= 10;
  return pl.every(validOne) && de.every(validOne);
}

function checkClaimProcessedAssignedTasks(claimPath, assignmentsPath, role) {
  if (!checkFileExists(claimPath)) return false;
  if (!checkFileExists(assignmentsPath)) return true;
  const claim = parseJsonFile(claimPath);
  const assign = parseJsonFile(assignmentsPath);
  const key = role === "planner" ? "planner_tasks" : role === "designer" ? "designer_tasks" : null;
  if (!key) return false;
  const expected = Array.isArray(assign[key]) ? assign[key] : [];
  const processed = Array.isArray(claim.assigned_task_ids) ? claim.assigned_task_ids : null;
  if (!processed) return false;
  const expectedIds = new Set(expected.map((t) => t && t.id).filter(Boolean));
  for (const id of expectedIds) {
    if (!processed.includes(id)) return false;
  }
  return true;
}

function checkLessonsLearnedAppendIfApplied(claimPath, lessonsPath, dispatchCreatedAt) {
  if (!checkFileExists(claimPath)) return false;
  const claim = parseJsonFile(claimPath);
  const applied = String(claim.lessons_learned_applied || "").toUpperCase();
  if (!["Y", "N"].includes(applied)) return false;
  if (applied === "N") return true;
  if (!checkFileExists(lessonsPath)) return false;
  if (!checkMtimeAfter(lessonsPath, dispatchCreatedAt)) return false;
  const full = resolvePath(lessonsPath);
  const txt = fs.readFileSync(full, "utf8");
  if (!/###\s*\[Batch\d+\]\[R\d+\]/.test(txt)) return false;
  return true;
}

function checkTesterRequiredConsistency(claimPath) {
  if (!checkFileExists(claimPath)) return false;
  const claim = parseJsonFile(claimPath);
  const devReady = String(claim.developer_ready || "").toUpperCase();
  const testerReq = String(claim.tester_required || "").toUpperCase();
  if (!["Y", "N"].includes(testerReq)) return false;
  if (devReady === "Y" && testerReq !== "Y") return false;
  const reason = claim.tester_reason;
  if (typeof reason !== "string" || reason.trim().length < 10) return false;
  return true;
}

function checkActionConsistency(claimPath) {
  if (!checkFileExists(claimPath)) return false;
  const claim = parseJsonFile(claimPath);
  const action = String(claim.action || "").toUpperCase();
  const wf = Array.isArray(claim.wf_boards) ? claim.wf_boards : [];
  const desc = Array.isArray(claim.desc_boards) ? claim.desc_boards : [];
  if (!["CREATE", "UPDATE", "UPDATE+CREATE", "NO_CHANGE"].includes(action)) return false;
  if (action === "NO_CHANGE") {
    return wf.length === 0 && desc.length === 0;
  }
  return wf.length > 0 && desc.length > 0;
}

function checkTranscriptNoForbiddenWrites(transcriptPath, forbiddenPatterns) {
  if (!checkFileExists(transcriptPath)) return false;
  const fullPath = resolvePath(transcriptPath);
  const content = fs.readFileSync(fullPath, "utf8");
  const lines = content.split("\n");
  const writeToolRe = /"(?:Write|Edit|NotebookEdit|MultiEdit)"/;
  const filePathRe = /"file_path"\s*:\s*"([^"]+)"/;
  for (const line of lines) {
    if (!writeToolRe.test(line)) continue;
    const m = line.match(filePathRe);
    if (!m) continue;
    const fp = m[1];
    for (const pattern of forbiddenPatterns) {
      const regex = new RegExp(pattern);
      if (regex.test(fp)) return false;
    }
  }
  return true;
}

function checkTranscriptStepOrder(transcriptPath) {
  if (!checkFileExists(transcriptPath)) return false;
  const fullPath = resolvePath(transcriptPath);
  const content = fs.readFileSync(fullPath, "utf8");
  const lines = content.split("\n").filter((l) => l.trim());
  const markers = {
    read_workboard: /request-workboard\.md/,
    read_sequence: /planner-workflow\/references\/sequence\.md/,
    boards_snapshot: /boards-snapshot\.json/,
    write_planning_doc: /A-planning-doc\.md/,
    write_wf_evidence: /wf-export\.json/,
    write_claim: /planner\.claim\.json/,
  };
  const firstSeen = {};
  for (let i = 0; i < lines.length; i++) {
    for (const [key, re] of Object.entries(markers)) {
      if (firstSeen[key] === undefined && re.test(lines[i])) {
        firstSeen[key] = i;
      }
    }
  }
  const order = ["read_workboard", "read_sequence", "boards_snapshot", "write_planning_doc", "write_wf_evidence", "write_claim"];
  let last = -1;
  for (const key of order) {
    const idx = firstSeen[key];
    if (idx === undefined) return false;
    if (idx < last) return false;
    last = idx;
  }
  return true;
}

function checkPlanningDocSections(filePath) {
  if (!checkFileExists(filePath)) return false;
  const content = fs.readFileSync(resolvePath(filePath), "utf8");
  const lines = content.split("\n");
  for (const heading of PLANNING_DOC_REQUIRED_SECTIONS) {
    const idx = lines.findIndex((l) => l.trim() === heading);
    if (idx === -1) return false;
    let nextHeadingIdx = lines.length;
    for (let i = idx + 1; i < lines.length; i++) {
      if (/^##\s/.test(lines[i])) {
        nextHeadingIdx = i;
        break;
      }
    }
    const body = lines.slice(idx + 1, nextHeadingIdx).join("\n").trim();
    if (body.length < 4) return false;
  }
  return true;
}

function checkJsonArrayEmpty(filePath, fieldPath) {
  if (!checkFileExists(filePath)) {
    return false;
  }
  const target = parseJsonFile(filePath);
  const value = getByPath(target, fieldPath);
  return Array.isArray(value) && value.length === 0;
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
  const threshold = Date.parse(isoString);
  if (Number.isNaN(threshold)) return false;
  const MARGIN_MS = 2000;
  return stat.mtimeMs + MARGIN_MS > threshold;
}

function buildClaudeProjectSlug() {
  return resolveProjectRoot().replace(/\//g, "-");
}

function inferAgentTranscriptPath(sessionId, agentId) {
  if (!sessionId || !agentId) {
    return null;
  }

  return path.join(
    os.homedir(),
    ".claude",
    "projects",
    buildClaudeProjectSlug(),
    String(sessionId),
    "subagents",
    `agent-${agentId}.jsonl`
  );
}

function normalizeComparablePath(filePath) {
  if (!filePath || typeof filePath !== "string") {
    return null;
  }

  return path.resolve(path.isAbsolute(filePath) ? filePath : resolvePath(filePath));
}

function readTranscriptToolUses(transcriptPath) {
  const fullPath = normalizeComparablePath(transcriptPath);
  if (!fullPath || !fs.existsSync(fullPath)) {
    return [];
  }

  const results = [];
  let index = 0;

  for (const line of fs.readFileSync(fullPath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    let entry;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      continue;
    }

    if (entry.type !== "assistant" || !entry.message || !Array.isArray(entry.message.content)) {
      continue;
    }

    for (const content of entry.message.content) {
      if (!content || content.type !== "tool_use") {
        continue;
      }

      results.push({
        index: index++,
        name: content.name || null,
        input: content.input || {},
        timestamp: entry.timestamp || null,
      });
    }
  }

  return results;
}

function getTranscriptToolFilePaths(toolUse) {
  const input = toolUse && toolUse.input ? toolUse.input : {};
  const candidates = [];
  if (typeof input.file_path === "string") {
    candidates.push(input.file_path);
  }
  if (typeof input.path === "string") {
    candidates.push(input.path);
  }
  return candidates
    .map((entry) => normalizeComparablePath(entry))
    .filter(Boolean);
}

function hasTranscriptRead(transcriptPath, targetPath) {
  const target = normalizeComparablePath(targetPath);
  if (!target) {
    return false;
  }

  return readTranscriptToolUses(transcriptPath).some(
    (toolUse) =>
      toolUse.name === "Read" &&
      getTranscriptToolFilePaths(toolUse).some((candidate) => candidate === target)
  );
}

function hasTranscriptReadIfExists(transcriptPath, targetPath) {
  if (!checkFileExists(targetPath)) {
    return true;
  }
  return hasTranscriptRead(transcriptPath, targetPath);
}

function hasTranscriptTouch(transcriptPath, targetPath) {
  const target = normalizeComparablePath(targetPath);
  if (!target) {
    return false;
  }

  const mutationTools = new Set(["Write", "Edit", "MultiEdit"]);
  return readTranscriptToolUses(transcriptPath).some(
    (toolUse) =>
      mutationTools.has(toolUse.name) &&
      getTranscriptToolFilePaths(toolUse).some((candidate) => candidate === target)
  );
}

function hasTranscriptTouchAfter(transcriptPath, beforePath, afterPath) {
  const beforeTarget = normalizeComparablePath(beforePath);
  const afterTarget = normalizeComparablePath(afterPath);
  if (!beforeTarget || !afterTarget) {
    return false;
  }

  const mutationTools = new Set(["Write", "Edit", "MultiEdit"]);
  const toolUses = readTranscriptToolUses(transcriptPath).filter((toolUse) =>
    mutationTools.has(toolUse.name)
  );

  const beforeIndices = toolUses
    .filter((toolUse) => getTranscriptToolFilePaths(toolUse).some((candidate) => candidate === beforeTarget))
    .map((toolUse) => toolUse.index);
  const afterIndices = toolUses
    .filter((toolUse) => getTranscriptToolFilePaths(toolUse).some((candidate) => candidate === afterTarget))
    .map((toolUse) => toolUse.index);

  if (beforeIndices.length === 0 || afterIndices.length === 0) {
    return false;
  }

  return afterIndices.some((afterIndex) => beforeIndices.some((beforeIndex) => afterIndex > beforeIndex));
}

function getTranscriptExecuteCodeBlocks(transcriptPath) {
  return readTranscriptToolUses(transcriptPath)
    .filter(
      (toolUse) =>
        typeof toolUse.name === "string" &&
        toolUse.name.includes("execute_code") &&
        toolUse.input &&
        typeof toolUse.input.code === "string"
    )
    .map((toolUse) => toolUse.input.code);
}

function hasTranscriptWfDescRemoval(transcriptPath) {
  const dangerPatterns = [
    /\.remove\s*\(/,
    /removeShape\s*\(/,
    /deleteShape\s*\(/,
    /\.children\s*=\s*\[/,
    /\.children\.splice\s*\(/,
    /\.children\s*=\s*.*\.filter\s*\(/s,
  ];

  return getTranscriptExecuteCodeBlocks(transcriptPath).some((code) => {
    if (!/(wf_|desc_)/.test(code)) {
      return false;
    }

    return dangerPatterns.some((pattern) => pattern.test(code));
  });
}

function checkTranscriptNoWfDescRemoval(transcriptPath) {
  return !hasTranscriptWfDescRemoval(transcriptPath);
}

function checkSnapshotPreservesIds(beforePath, afterPath) {
  const beforeFullPath = resolvePath(beforePath);
  const afterFullPath = resolvePath(afterPath);

  if (!fs.existsSync(beforeFullPath) || !fs.existsSync(afterFullPath)) {
    return false;
  }

  const beforePayload = parseJsonFile(beforePath);
  const afterPayload = parseJsonFile(afterPath);
  const beforeItems = Array.isArray(beforePayload) ? beforePayload : [];
  const afterItems = Array.isArray(afterPayload) ? afterPayload : [];
  const indexAfter = new Map();
  for (const entry of afterItems) {
    if (entry && typeof entry.id === "string") indexAfter.set(entry.id, entry);
  }

  if (beforeItems.length === 0) {
    return true;
  }

  for (const be of beforeItems) {
    if (!be || typeof be.id !== "string") continue;
    const af = indexAfter.get(be.id);
    if (!af) return false;
    if (typeof be.name === "string" && typeof af.name === "string" && be.name !== af.name) return false;
    if (typeof be.content_hash === "string" && typeof af.content_hash === "string" && be.content_hash !== af.content_hash) return false;
    if (Number.isFinite(be.elements_count) && Number.isFinite(af.elements_count) && be.elements_count !== af.elements_count) return false;
    if (Array.isArray(be.elements) && Array.isArray(af.elements)) {
      const beIds = new Set(be.elements.map((e) => e && e.id).filter(Boolean));
      for (const id of beIds) {
        if (!af.elements.some((e) => e && e.id === id)) return false;
      }
    }
  }
  return true;
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
    failed_check_ids: [],
    retry_scope: [],
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
      review_gate: defaultReviewGateState(),
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

function getTicketPath(state, meta, ticketKind, suffix) {
  const leaf = suffix
    ? `${meta.role}.${ticketKind}.${suffix}.json`
    : `${meta.role}.${ticketKind}.json`;
  return path.join(
    resolvePath(state.roots.tickets),
    meta.batch_id,
    meta.item_id,
    leaf
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

function hasIssuedTicket(roleState) {
  const doneOk =
    roleState.done_ticket &&
    roleState.done_ticket.status === "issued" &&
    ticketFileIntact(roleState.done_ticket) &&
    !isTicketStale(roleState.done_ticket);
  const skipOk =
    roleState.skip_ticket &&
    roleState.skip_ticket.status === "issued" &&
    ticketFileIntact(roleState.skip_ticket);
  return Boolean(doneOk || skipOk);
}

function ticketFileIntact(ticketState) {
  if (!ticketState || !ticketState.path) return false;
  const full = resolvePath(ticketState.path);
  if (!fs.existsSync(full)) return false;
  if (ticketState.content_sha256) {
    try {
      const crypto = require("crypto");
      const buf = fs.readFileSync(full);
      const actual = crypto.createHash("sha256").update(buf).digest("hex");
      if (actual !== ticketState.content_sha256) return false;
    } catch (e) {
      return false;
    }
  }
  return true;
}

function isTicketStale(ticketState) {
  if (!ticketState || !ticketState.validated_at) return false;
  const ticketAt = Date.parse(ticketState.validated_at);
  if (Number.isNaN(ticketAt)) return false;
  const planDoc = resolvePath("workspace/planning/A-planning-doc.md");
  if (!fs.existsSync(planDoc)) return false;
  try {
    const mtime = fs.statSync(planDoc).mtimeMs;
    if (mtime > ticketAt + 2000) return true;
  } catch (e) {}
  return false;
}

function hasDownstreamIssuedTicket(item, currentRole) {
  const order = item.role_order || DEFAULT_ROLE_ORDER;
  const currentIndex = order.indexOf(currentRole);
  if (currentIndex === -1) {
    return false;
  }

  return order
    .slice(currentIndex + 1)
    .map((roleName) => item.roles.find((entry) => entry.role === roleName))
    .filter(Boolean)
    .some((roleState) => hasIssuedTicket(roleState));
}

function archiveTicketFile(ticketState) {
  if (!ticketState || !ticketState.path) return;
  try {
    const full = resolvePath(ticketState.path);
    if (!fs.existsSync(full)) return;
    const ts = Date.now();
    const archiveDir = path.join(path.dirname(full), "archive");
    fs.mkdirSync(archiveDir, { recursive: true });
    const archived = path.join(archiveDir, `${path.basename(full)}.${ts}`);
    fs.renameSync(full, archived);
  } catch (e) {}
}

function resetTicketState(ticketState) {
  archiveTicketFile(ticketState);
  ticketState.status = "none";
  ticketState.path = null;
  ticketState.validated_at = null;
  ticketState.validated_by = null;
}

function reopenRoleState(roleState, reason = null) {
  resetTicketState(roleState.done_ticket);
  resetTicketState(roleState.skip_ticket);
  roleState.status = "todo";
  roleState.checklist = [];
  roleState.claim_path = null;
  roleState.artifacts = [];
  roleState.missing_items = [];
  roleState.failed_check_ids = [];
  roleState.retry_scope = [];
  roleState.last_error = reason;
  roleState.last_updated_at = nowIso();
}

function getOpenHolds(state) {
  return (state.holds || []).filter((entry) => entry.status !== "resolved");
}

function upsertHold(state, code, reason, details = {}, source = "harness") {
  const holds = Array.isArray(state.holds) ? state.holds : [];
  const existing = holds.find((entry) => entry.code === code && entry.status !== "resolved");
  if (existing) {
    existing.reason = reason;
    existing.details = details && typeof details === "object" ? details : {};
    existing.source = source;
    existing.opened_at = existing.opened_at || nowIso();
    existing.resolved_at = null;
    return existing;
  }

  const next = defaultHoldState(code, reason);
  next.details = details && typeof details === "object" ? details : {};
  next.source = source;
  holds.push(next);
  state.holds = holds;
  return next;
}

function resolveHold(state, code) {
  const holds = Array.isArray(state.holds) ? state.holds : [];
  for (const entry of holds) {
    if (entry.code === code && entry.status !== "resolved") {
      entry.status = "resolved";
      entry.resolved_at = nowIso();
    }
  }
}

function buildRetryScope(failedChecks) {
  return failedChecks.map((entry) => `retry ${entry.id}: ${entry.label}`);
}

function ensureReviewGate(item, batchId) {
  if (!item.review_gate || typeof item.review_gate !== "object") {
    item.review_gate = defaultReviewGateState();
  }
  const g = item.review_gate;
  if (g.schema_version !== REVIEW_GATE_SCHEMA_VERSION) {
    g.schema_version = REVIEW_GATE_SCHEMA_VERSION;
    if (!Array.isArray(g.planner_response_history)) g.planner_response_history = [];
    if (!Array.isArray(g.designer_response_history)) g.designer_response_history = [];
    if (!g.scope) g.scope = "item";
  }
  if (!g.item_id && item.item_id) g.item_id = item.item_id;
  if (!g.batch_id && batchId) g.batch_id = batchId;
  return g;
}

function openReviewGate(item) {
  const gate = ensureReviewGate(item);
  if (gate.status === "idle") {
    item.review_gate = {
      ...defaultReviewGateState(),
      status: "open",
      opened_at: nowIso(),
    };
    return item.review_gate;
  }
  return gate;
}

function isReviewGateResolved(item) {
  const gate = ensureReviewGate(item);
  return gate.status === "resolved";
}

function setReviewGateStep(item, key, value) {
  const gate = ensureReviewGate(item);
  gate[key] = value;
  return gate;
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
    mode: entry.mode || null,
  };
}

function parseAgentToolInput(payload) {
  const toolInput = (payload && payload.tool_input) || {};
  const description =
    typeof toolInput.description === "string"
      ? toolInput.description.trim()
      : "";
  const prompt =
    typeof toolInput.prompt === "string" ? toolInput.prompt : "";

  return {
    tool_use_id: payload && payload.tool_use_id ? String(payload.tool_use_id) : null,
    subagent_type:
      typeof toolInput.subagent_type === "string" ? toolInput.subagent_type : null,
    description,
    prompt,
    meta: parseTaskSubject(description),
  };
}

const DISPATCH_PROMPT_REQUIREMENTS = {
  "planner:plan": {
    must_include: [
      "시작 순서 고정",
      "request-workboard.md",
      "project-config.md",
      "A-benchmark.md",
      "영향도",
      "reference_flows",
      "expected_user_path",
      "critical_states",
      "avoid_patterns",
      "UPDATE",
      "CREATE",
      "wf_",
      "desc_",
      "export_shape",
      "gap check",
      "claim",
      "evidence",
      "사용자 원문",
      "사전 검토",
      "boards-snapshot",
      "action_rationale",
      "planning-doc-sections.md",
      "lessons-learned.md",
    ],
    must_match: [/1\)/, /2\)/, /3\)/, /4\)/, /5\)/, /6\)/],
  },
  "planner:review": {
    must_include: [
      "시작 순서 고정",
      "A-planning-doc.md",
      "wf_",
      "desc_",
      "design_",
      "planner-review.md",
      "UIUX 보완점",
      "디스크립션",
      "기획서 보완점",
    ],
    must_match: [/1\)/, /2\)/, /3\)/],
  },
  "planner:revise": {
    must_include: [
      "시작 순서 고정",
      "developer-review.md",
      "qa-review.md",
      "planner-review.md",
      "designer-review.md",
      "assignments.json",
      "assigned_task_ids",
      "수긍",
      "반박",
      "wf-desc-snapshot-before",
      "wf-desc-snapshot-after",
      "export_shape",
      "gap check",
      "claim",
      "evidence",
    ],
    must_match: [/1\)/, /2\)/, /3\)/, /4\)/, /5\)/, /6\)/],
  },
  "designer:review": {
    must_include: [
      "시작 순서 고정",
      "request-workboard.md",
      "wf_",
      "desc_",
      "UIUX",
    ],
    must_match: [/1\)/, /2\)/, /3\)/, /A-uiux-review\.md|designer-review\.md/],
  },
  "designer:apply": {
    must_include: [
      "시작 순서 고정",
      "wf-desc-snapshot-before",
      "wf-desc-snapshot-after",
      "design_",
      "export_shape",
      "claim",
      "evidence",
      "assignments.json",
      "assigned_task_ids",
    ],
    must_match: [/1\)/, /2\)/, /3\)/, /4\)/, /5\)/],
  },
  "developer:review": {
    must_include: [
      "시작 순서 고정",
      "request-workboard.md",
      "wf_",
      "desc_",
      "design_",
      "developer-review.md",
      "UIUX 보완점",
      "디스크립션",
      "기획서 보완점",
    ],
    must_match: [/1\)/, /2\)/, /3\)/],
  },
  "developer:implement": {
    must_include: [
      "시작 순서 고정",
      "request-workboard.md",
      "project-config.md",
      "wf_",
      "desc_",
      "design_",
      "workspace/development",
      "gap check",
      "claim",
      "evidence",
    ],
    must_match: [/1\)/, /2\)/, /3\)/],
  },
  "qa:review": {
    must_include: [
      "시작 순서 고정",
      "request-workboard.md",
      "wf_",
      "desc_",
      "design_",
      "qa-review.md",
      "UIUX 보완점",
      "디스크립션",
      "기획서 보완점",
    ],
    must_match: [/1\)/, /2\)/, /3\)/],
  },
  "qa:tc": {
    must_include: [
      "시작 순서 고정",
      "C-testcases.md",
      ".qa-last-run.json",
      "claim",
      "evidence",
    ],
    must_match: [/1\)/, /2\)/, /3\)/],
  },
  "qa:verify": {
    must_include: [
      "시작 순서 고정",
      "D-qa-verification.md",
      ".qa-last-run.json",
      "claim",
      "evidence",
    ],
    must_match: [/1\)/, /2\)/, /3\)/],
  },
  "tester": {
    must_include: [
      "시작 순서 고정",
      "Playwright",
      ".tester-state.json",
      ".tester-last-run.json",
      "claim",
      "evidence",
    ],
    must_match: [/1\)/, /2\)/, /3\)/],
  },
};

function checkReviseBundleAvailability(state, meta) {
  const batch = (state.batches || []).find((b) => b && b.batch_id === meta.batch_id);
  const item = batch && (batch.items || []).find((i) => i && i.item_id === meta.item_id);
  if (!item) return null;
  const gate = ensureReviewGate(item, meta.batch_id);
  const reviewDir = `workspace/reviews/${meta.batch_id}/${meta.item_id}`;

  const inLoopB =
    gate.status === "open" &&
    gate.developer_review === "done" &&
    gate.qa_review === "done";

  if (meta.role === "planner" && meta.mode === "revise") {
    if (inLoopB) {
      const missing = [];
      for (const name of LOOP_B_REVIEW_FILES) {
        if (!fs.existsSync(resolvePath(`${reviewDir}/${name}`))) {
          missing.push(`${reviewDir}/${name}`);
        }
      }
      if (missing.length) {
        return `Loop B planner revise blocked for ${meta.batch_id}/${meta.item_id}: 4-person review bundle incomplete — missing ${missing.join(", ")}. 모든 4인(planner/designer/developer/qa) review가 있어야 revise 가능.`;
      }
      if (!checkLoopBReviewBundleComplete(meta.batch_id, meta.item_id)) {
        return `Loop B planner revise blocked: 4-person review bundle exists but missing required sections (UIUX 보완점 / 디스크립션(desc_*) 보완점 / 기획서 보완점) or bodies are < 120 chars.`;
      }
      const assignmentsPath = resolvePath(`${reviewDir}/assignments.json`);
      if (!fs.existsSync(assignmentsPath)) {
        return `Loop B planner revise blocked: ${reviewDir}/assignments.json missing. 메인 하네스가 4인 리뷰 내용을 planner_tasks / designer_tasks 로 분배해 기록해야 한다.`;
      }
      if (!checkLoopBAssignmentsValid(meta.batch_id, meta.item_id)) {
        return `Loop B planner revise blocked: assignments.json 형식 오류. { planner_tasks:[{id,source,summary}], designer_tasks:[...], rationale }. summary ≥10자, rationale ≥20자, 최소 1개 task 필요.`;
      }
    } else if (gate.status === "idle" || gate.status === "resolved") {
      const uxReview = resolvePath("workspace/design/A-uiux-review.md");
      if (!fs.existsSync(uxReview)) {
        return `Loop A-2 planner revise blocked: workspace/design/A-uiux-review.md missing — designer review must precede planner revise.`;
      }
    }
    return null;
  }

  if (meta.role === "designer" && meta.mode === "apply" && inLoopB) {
    const assignmentsPath = resolvePath(`${reviewDir}/assignments.json`);
    if (!fs.existsSync(assignmentsPath)) {
      return `Loop B designer apply (sync) blocked: ${reviewDir}/assignments.json missing.`;
    }
    if (!checkLoopBAssignmentsValid(meta.batch_id, meta.item_id)) {
      return `Loop B designer apply (sync) blocked: assignments.json invalid.`;
    }
  }

  return null;
}

function runIntegrityGuards(state, meta) {
  // T28: CLAUDE_PROJECT_DIR env 검증
  if (process.env.CLAUDE_PROJECT_DIR && !fs.existsSync(process.env.CLAUDE_PROJECT_DIR)) {
    return `CLAUDE_PROJECT_DIR points to non-existent path: ${process.env.CLAUDE_PROJECT_DIR}`;
  }

  // T10: 체크리스트 JSON 존재/비empty 검증
  const checklistPath = resolvePath("workflow/checklists/task-gate-checklists.json");
  if (!fs.existsSync(checklistPath)) {
    return "Checklist file missing: workflow/checklists/task-gate-checklists.json. Refusing dispatch.";
  }
  try {
    const cl = JSON.parse(fs.readFileSync(checklistPath, "utf8"));
    const entries = (cl && cl.roles && cl.roles[meta.role]) || [];
    const minRequired = { planner: 20, designer: 5, developer: 5, qa: 3, tester: 3, secretary: 1 }[meta.role] || 1;
    if (!Array.isArray(entries) || entries.length < minRequired) {
      return `Checklist for role=${meta.role} has ${entries.length} entries (min ${minRequired}). Refusing dispatch — zero-check bypass blocked.`;
    }
  } catch (e) {
    return `Checklist JSON parse error: ${e.message}. Refusing dispatch.`;
  }

  // T23: role_order 순서 검증
  if (Array.isArray(state.batches)) {
    const batch = state.batches.find((b) => b && b.batch_id === meta.batch_id);
    const item = batch && (batch.items || []).find((i) => i && i.item_id === meta.item_id);
    if (item && Array.isArray(item.role_order)) {
      const expected = DEFAULT_ROLE_ORDER.filter((r) => item.role_order.includes(r));
      const got = item.role_order.filter((r) => DEFAULT_ROLE_ORDER.includes(r));
      if (got.join(",") !== expected.join(",")) {
        return `Invalid role_order for ${meta.batch_id}/${meta.item_id}: ${got.join(",")} (expected: ${expected.join(",")}).`;
      }
    }
  }

  // T12: settings.json 해시 기록 + 변조 감지
  const settingsPath = resolvePath(".claude/settings.json");
  const fpPath = resolvePath("workspace/planning/.settings-fingerprint.json");
  if (fs.existsSync(settingsPath)) {
    const currentHash = computeFileHash(settingsPath);
    let fp = {};
    if (fs.existsSync(fpPath)) {
      try {
        fp = JSON.parse(fs.readFileSync(fpPath, "utf8"));
      } catch (e) {
        fp = {};
      }
    }
    if (fp.settings_sha256 && fp.settings_sha256 !== currentHash) {
      if (!fp.acknowledged_at) {
        return `.claude/settings.json changed since last run (hash mismatch). Run: node .claude/scripts/validator.js ack-settings to acknowledge.`;
      }
    }
    if (!fp.settings_sha256) {
      fs.writeFileSync(fpPath, JSON.stringify({ settings_sha256: currentHash, recorded_at: nowIso() }, null, 2));
    }
  }

  return null;
}

function checkStateItemInitialized(state, meta) {
  if (!meta || !meta.batch_id || !meta.item_id) return null;
  const batch = (state.batches || []).find((b) => b && b.batch_id === meta.batch_id);
  if (!batch) {
    return `State not initialized for ${meta.batch_id}. Run: node .claude/scripts/validator.js ensure-state-item ${meta.batch_id} ${meta.item_id} "<title>" before dispatching an Agent.`;
  }
  const item = (batch.items || []).find((i) => i && i.item_id === meta.item_id);
  if (!item) {
    return `State not initialized for ${meta.batch_id}/${meta.item_id}. Run ensure-state-item before dispatching.`;
  }
  if (!Array.isArray(item.roles) || item.roles.length === 0) {
    return `Role slots not initialized for ${meta.batch_id}/${meta.item_id}. Re-run ensure-state-item.`;
  }
  return null;
}

function checkBenchmarkQuality() {
  const benchPath = resolvePath("workspace/planning/A-benchmark.md");
  if (!fs.existsSync(benchPath)) {
    return "Benchmark file missing: workspace/planning/A-benchmark.md. Run benchmarking step before dispatching planner.";
  }
  const raw = fs.readFileSync(benchPath, "utf8");
  const content = raw.trim();
  if (content.length < 400) {
    return `Benchmark file too short (${content.length} bytes). Needs at least 400 chars with multiple services and extracted patterns.`;
  }
  const placeholderTokens = [
    /\bTBD\b/i,
    /\bTODO\b/i,
    /\blorem\b/i,
    /\bplaceholder\b/i,
    /XXX{2,}/,
    /채워\s*넣/,
    /추후\s*작성/,
    /미작성/,
  ];
  for (const re of placeholderTokens) {
    if (re.test(content)) {
      return `Benchmark file contains placeholder token (${re.source}). Replace with real competitor research before dispatch.`;
    }
  }
  const sectionMatches = [...content.matchAll(/^(#{2,3})\s+(.+)$/gm)];
  if (sectionMatches.length < 2) {
    return `Benchmark needs at least 2 comparison sections (## or ### headings). Found ${sectionMatches.length}.`;
  }
  const lines = content.split("\n");
  const sectionBodies = [];
  for (let i = 0; i < sectionMatches.length; i++) {
    const head = sectionMatches[i];
    const headLine = lines.findIndex((l, idx) => idx >= 0 && l === head[0]);
    if (headLine === -1) continue;
    let end = lines.length;
    for (let j = headLine + 1; j < lines.length; j++) {
      if (/^#{2,3}\s+/.test(lines[j])) {
        end = j;
        break;
      }
    }
    const body = lines.slice(headLine + 1, end).join("\n").trim();
    sectionBodies.push({ title: head[2].trim(), body });
  }
  const requiredKeywords = [
    { any: ["장점", "강점", "좋은 점"] },
    { any: ["회피", "단점", "주의", "약점"] },
  ];
  for (const { title, body } of sectionBodies) {
    if (body.length < 80) {
      return `Benchmark section "${title}" too short (${body.length} chars). Need at least 80 chars of substantive description.`;
    }
    for (const group of requiredKeywords) {
      if (!group.any.some((kw) => body.includes(kw))) {
        return `Benchmark section "${title}" missing required keyword group (${group.any.join("/")}). Each section needs both 장점/강점 line and 회피/단점 line.`;
      }
    }
  }
  return null;
}

function validateDispatchPrompt(meta, prompt) {
  if (!meta || !meta.role) return null;
  const key = meta.mode ? `${meta.role}:${meta.mode}` : meta.role;
  const rule = DISPATCH_PROMPT_REQUIREMENTS[key] || DISPATCH_PROMPT_REQUIREMENTS[meta.role];
  if (!rule) return null;

  const missingIncludes = (rule.must_include || []).filter(
    (needle) => !prompt.includes(needle)
  );
  const missingMatches = (rule.must_match || []).filter(
    (re) => !re.test(prompt)
  );

  if (missingIncludes.length === 0 && missingMatches.length === 0) return null;

  const parts = [];
  if (missingIncludes.length > 0) {
    parts.push(`missing required phrases: ${missingIncludes.map((s) => JSON.stringify(s)).join(", ")}`);
  }
  if (missingMatches.length > 0) {
    parts.push(`missing required step markers: ${missingMatches.map((re) => re.source).join(", ")}`);
  }
  return `Dispatch prompt for ${key} is incomplete — ${parts.join("; ")}. Include the full 시작 순서 고정 step list from process.md before calling the Agent.`;
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
    mode: parsed.meta.mode || null,
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

function collectModeAwarePredecessorFailures(item, currentRole, currentMode) {
  if (currentRole === "qa" && currentMode === "review") {
    return ["planner", "designer"]
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

  return collectPredecessorFailures(item, currentRole);
}

function shellEscape(value) {
  if (value === undefined || value === null) return "";
  const s = String(value);
  if (s === "") return "";
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, "'\\''")}'`;
}

function substituteCommand(template, context) {
  return template
    .replace(/\{batch_id\}/g, shellEscape(context.batch_id))
    .replace(/\{item_id\}/g, shellEscape(context.item_id))
    .replace(/\{role\}/g, shellEscape(context.role))
    .replace(/\{batch_index\}/g, String(context.batch_index))
    .replace(/\{item_index\}/g, String(context.item_index))
    .replace(/\{role_index\}/g, String(context.role_index))
    .replace(/\{dispatch_created_at\}/g, shellEscape(context.dispatch_created_at || ""))
    .replace(/\{dispatch_claimed_at\}/g, shellEscape(context.dispatch_claimed_at || ""))
    .replace(/\{dispatch_finished_at\}/g, shellEscape(context.dispatch_finished_at || ""))
    .replace(/\{agent_transcript_path\}/g, shellEscape(context.agent_transcript_path || ""));
}

function readClaimAction(context) {
  try {
    const claimRel = `workspace/claims/${context.batch_id}/${context.item_id}/${context.role}.claim.json`;
    const full = resolvePath(claimRel);
    if (!fs.existsSync(full)) return null;
    const claim = JSON.parse(fs.readFileSync(full, "utf8"));
    return claim && claim.action ? String(claim.action).toUpperCase() : null;
  } catch (e) {
    return null;
  }
}

function validateTranscriptPath(ctx) {
  if (!ctx.agent_transcript_path) return ctx;
  const p = String(ctx.agent_transcript_path);
  const allowed = /^(workspace\/|\.claude\/projects\/|\/Users\/[^/]+\/\.claude\/projects\/)/.test(p);
  if (!allowed) {
    return { ...ctx, agent_transcript_path: "", transcript_rejected_reason: `disallowed path: ${p}` };
  }
  return ctx;
}

function runChecklist(state, context, checklistEntries) {
  const safeContext = validateTranscriptPath(context);
  const currentAction = readClaimAction(safeContext);
  const filteredOut = [];
  const kept = checklistEntries
    .filter((entry) => {
      if (entry.when_mode) {
        const ok = entry.when_mode === safeContext.mode;
        if (!ok) filteredOut.push({ id: entry.id, reason: `when_mode ${entry.when_mode}` });
        return ok;
      }
      if (safeContext.mode === "review") {
        filteredOut.push({ id: entry.id, reason: `${safeContext.role}:review skips checks without explicit when_mode=review` });
        return false;
      }
      return true;
    })
    .filter((entry) => {
      if (!entry.when_action_not) return true;
      const blocked = Array.isArray(entry.when_action_not)
        ? entry.when_action_not.map((a) => String(a).toUpperCase())
        : [String(entry.when_action_not).toUpperCase()];
      const ok = !blocked.includes(currentAction);
      if (!ok) filteredOut.push({ id: entry.id, reason: `action=${currentAction}` });
      return ok;
    })
    .filter((entry) => {
      if (!entry.when_action) return true;
      const allowed = Array.isArray(entry.when_action)
        ? entry.when_action.map((a) => String(a).toUpperCase())
        : [String(entry.when_action).toUpperCase()];
      const ok = allowed.includes(currentAction);
      if (!ok) filteredOut.push({ id: entry.id, reason: `action=${currentAction} not in ${allowed}` });
      return ok;
    });

  try {
    appendJsonLine(resolvePath("workspace/reports/hook-events.jsonl"), {
      logged_at: nowIso(),
      hook_event_name: "ChecklistFilter",
      task_meta: { batch_id: safeContext.batch_id, item_id: safeContext.item_id, role: safeContext.role },
      extra: { filtered_out: filteredOut, kept_count: kept.length, total: checklistEntries.length },
    });
  } catch (e) {}

  return kept.map((entry) => {
    const command = substituteCommand(entry.command, safeContext);
    const result = spawnSync(command, {
      cwd: resolveProjectRoot(),
      shell: true,
      encoding: "utf8",
      timeout: 30000,
    });

    const stderr = (result.stderr || "").trim();
    const stdout = (result.stdout || "").trim();
    let status = "fail";
    if (result.status === 0 && !result.error && !result.signal) {
      try {
        const parsed = stdout ? JSON.parse(stdout) : {};
        status = parsed.ok === true ? "pass" : "fail";
      } catch (e) {
        status = "fail";
      }
    }

    return {
      id: entry.id,
      label: entry.label,
      command,
      status,
      evidence_paths: [],
      stdout,
      stderr,
    };
  });
}

function writeTicket(state, meta, ticketKind, payload, suffix) {
  const filePath = getTicketPath(state, meta, ticketKind, suffix);
  writeJsonFile(filePath, payload);
  return filePath;
}

function computeFileHash(filePath) {
  try {
    const crypto = require("crypto");
    const buf = fs.readFileSync(filePath);
    return crypto.createHash("sha256").update(buf).digest("hex");
  } catch (e) {
    return null;
  }
}

function issueTicket(state, meta, roleState, ticketKind, payload) {
  const filePath = writeTicket(state, meta, ticketKind, payload);
  const target = ticketKind === "skip" ? roleState.skip_ticket : roleState.done_ticket;

  if (!fs.existsSync(filePath)) {
    throw new Error(`Ticket write failed: ${filePath} missing after writeTicket`);
  }
  const hash = computeFileHash(filePath);
  target.status = "issued";
  target.path = path.relative(resolveProjectRoot(), filePath);
  target.validated_at = payload.validated_at;
  target.validated_by = payload.validated_by;
  target.content_sha256 = hash;
  roleState.last_updated_at = payload.validated_at;
}

function rejectDoneTicket(state, meta, roleState, payload) {
  if (!Array.isArray(roleState.rejection_history)) {
    roleState.rejection_history = [];
  }
  roleState.rejection_history.push({
    validated_at: payload.validated_at,
    failures: Array.isArray(payload.checklist)
      ? payload.checklist.filter((c) => c.status !== "pass").map((c) => c.id)
      : [],
    reason: payload.reason || null,
  });
  const attempt = (roleState.rejection_history || []).length;
  const filePath = writeTicket(state, meta, "rejected", payload, `attempt-${attempt}`);
  const hash = computeFileHash(filePath);
  roleState.done_ticket.status = "rejected";
  roleState.done_ticket.path = path.relative(resolveProjectRoot(), filePath);
  roleState.done_ticket.validated_at = payload.validated_at;
  roleState.done_ticket.validated_by = payload.validated_by;
  roleState.done_ticket.content_sha256 = hash;
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
    upsertHold(
      state,
      "retry_limit_exhausted",
      `Retry limit reached for ${meta.batch_id}/${meta.item_id}/${meta.role}.`,
      {
        batch_id: meta.batch_id,
        item_id: meta.item_id,
        role: meta.role,
      },
      "validator"
    );
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
  context.roleState.failed_check_ids = [];
  context.roleState.retry_scope = [];
  context.roleState.last_updated_at = nowIso();
  saveState(state);

  const checklistContext = {
    batch_id: meta.batch_id,
    item_id: meta.item_id,
    role: meta.role,
    mode: dispatchEntry.mode || "",
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
    const failedCheckIds = failedChecks.map((entry) => entry.id);
    const retryScope = buildRetryScope(failedChecks);
    context.roleState.status = "blocked";
    context.roleState.missing_items = failures;
    context.roleState.failed_check_ids = failedCheckIds;
    context.roleState.retry_scope = retryScope;
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
      upsertHold(
        state,
        "retry_limit_exhausted",
        `Retry limit reached for ${meta.batch_id}/${meta.item_id}/${meta.role}.`,
        {
          batch_id: meta.batch_id,
          item_id: meta.item_id,
          role: meta.role,
          failures,
        },
        "validator"
      );
      saveState(state);
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
  context.roleState.failed_check_ids = [];
  context.roleState.retry_scope = [];
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
    upsertHold(
      state,
      "retry_limit_exhausted",
      `Retry limit reached for ${activeTask.batch_id}/${activeTask.item_id}/${activeTask.role}.`,
      {
        batch_id: activeTask.batch_id,
        item_id: activeTask.item_id,
        role: activeTask.role,
      },
      "validator"
    );
    saveState(state);
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
  const modeError = validateRoleMode(meta);
  if (modeError) {
    saveState(state);
    if (state.gate_mode === "enforce") {
      stderrBlock(modeError);
    }
    return;
  }

  const promptError = validateDispatchPrompt(meta, parsed.prompt || "");
  if (promptError) {
    saveState(state);
    if (state.gate_mode === "enforce") {
      stderrBlock(promptError);
    }
    return;
  }

  const integrityError = runIntegrityGuards(state, meta);
  if (integrityError) {
    saveState(state);
    if (state.gate_mode === "enforce") {
      stderrBlock(integrityError);
    }
    return;
  }

  const reviseGateError = checkReviseBundleAvailability(state, meta);
  if (reviseGateError) {
    saveState(state);
    if (state.gate_mode === "enforce") {
      stderrBlock(reviseGateError);
    }
    return;
  }

  const stateInitError = checkStateItemInitialized(state, meta);
  if (stateInitError) {
    saveState(state);
    if (state.gate_mode === "enforce") {
      stderrBlock(stateInitError);
    }
    return;
  }

  if (meta.role === "planner") {
    const benchError = checkBenchmarkQuality();
    if (benchError) {
      saveState(state);
      if (state.gate_mode === "enforce") {
        stderrBlock(benchError);
      }
      return;
    }
    const penpotError = checkPenpotReachability();
    if (penpotError) {
      saveState(state);
      if (state.gate_mode === "enforce") {
        stderrBlock(penpotError);
      }
      return;
    }
    capturePreReviewFromPrompt(meta, parsed.prompt || "");
  }

  if (meta.role === "designer" && meta.mode === "apply") {
    const penpotError = checkPenpotReachability();
    if (penpotError) {
      saveState(state);
      if (state.gate_mode === "enforce") {
        stderrBlock(penpotError);
      }
      return;
    }
    const uxReviewPath = "workspace/design/A-uiux-review.md";
    const gateOk = checkDesignerReviewScoreGate(uxReviewPath, null, 80);
    const uxExists = fs.existsSync(resolvePath(uxReviewPath));
    if (uxExists && !gateOk) {
      saveState(state);
      if (state.gate_mode === "enforce") {
        stderrBlock(
          `Loop A-3 designer apply blocked: ${uxReviewPath} 점수 80점 미만 또는 미기재. planner revise 후 designer review 재실행으로 80+ 받은 뒤 apply 가능.`
        );
      }
      return;
    }
  }

  const context = getStateContext(state, meta);
  const retryLimit = context.item.retry_limit || 3;
  const predecessorFailures = collectModeAwarePredecessorFailures(
    context.item,
    meta.role,
    meta.mode
  );
  const plannerReopen = meta.role === "planner" && meta.mode === "revise";
  const reviewGate = ensureReviewGate(context.item);
  const developerReview = meta.role === "developer" && meta.mode === "review";
  const developerImplement = meta.role === "developer" && meta.mode === "implement";
  const qaReview = meta.role === "qa" && meta.mode === "review";
  const designerReviewSync =
    meta.role === "designer" &&
    meta.mode === "apply" &&
    reviewGate.status === "awaiting_design_sync";
  const designerRoleState = context.item.roles.find((entry) => entry.role === "designer");
  const reviewGateRequired = Boolean(designerRoleState && hasIssuedTicket(designerRoleState));

  if ((developerReview || qaReview) && reviewGate.status === "idle") {
    openReviewGate(context.item);
  }

  if (plannerReopen && hasDownstreamIssuedTicket(context.item, meta.role)) {
    saveState(state);
    if (state.gate_mode === "enforce") {
      stderrBlock(
        `Planner revise blocked for ${meta.batch_id}/${meta.item_id}: downstream role already has a done/skip ticket.`
      );
    }
    return;
  }

  if (plannerReopen && context.roleState.skip_ticket.status === "issued") {
    saveState(state);
    if (state.gate_mode === "enforce") {
      stderrBlock(
        `Planner revise blocked for ${meta.batch_id}/${meta.item_id}: planner skip ticket is already issued.`
      );
    }
    return;
  }

  if (
    plannerReopen &&
    reviewGate.status !== "idle" &&
    (reviewGate.developer_review !== "done" || reviewGate.qa_review !== "done")
  ) {
    saveState(state);
    if (state.gate_mode === "enforce") {
      stderrBlock(
        `Planner revise blocked for ${meta.batch_id}/${meta.item_id}: developer/qa review is not complete.`
      );
    }
    return;
  }

  if (plannerReopen && context.roleState.skip_ticket.status !== "issued") {
    reopenRoleState(
      context.roleState,
      `planner reopened by revise mode for ${meta.batch_id}/${meta.item_id}`
    );
  }

  if (designerReviewSync) {
    if (hasDownstreamIssuedTicket(context.item, meta.role)) {
      saveState(state);
      if (state.gate_mode === "enforce") {
        stderrBlock(
          `Designer sync blocked for ${meta.batch_id}/${meta.item_id}: downstream role already has a done/skip ticket.`
        );
      }
      return;
    }

    if (reviewGate.planner_response !== "done") {
      saveState(state);
      if (state.gate_mode === "enforce") {
        stderrBlock(
          `Designer sync blocked for ${meta.batch_id}/${meta.item_id}: planner response is not complete.`
        );
      }
      return;
    }

    reopenRoleState(
      context.roleState,
      `designer reopened by review gate sync for ${meta.batch_id}/${meta.item_id}`
    );
  }

  if (developerImplement && reviewGateRequired && !isReviewGateResolved(context.item)) {
    saveState(state);
    if (state.gate_mode === "enforce") {
      stderrBlock(
        `Developer implement blocked for ${meta.batch_id}/${meta.item_id}: planning review gate is not resolved.`
      );
    }
    return;
  }

  if (developerReview || developerImplement) {
    const handoffError = checkDeveloperHandoffGate(state, meta);
    if (handoffError) {
      saveState(state);
      if (state.gate_mode === "enforce") {
        stderrBlock(handoffError);
      }
      return;
    }
  }

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
        !plannerReopen &&
        !designerReviewSync &&
        (context.roleState.done_ticket.status === "issued" ||
          context.roleState.skip_ticket.status === "issued")
      ) {
        blockedReason = `${meta.role} already has a done/skip ticket for ${meta.batch_id}/${meta.item_id}.`;
        return;
      }

      if (context.roleState.attempt >= retryLimit) {
        upsertHold(
          state,
          "retry_limit_exhausted",
          `Retry limit reached for ${meta.batch_id}/${meta.item_id}/${meta.role}.`,
          {
            batch_id: meta.batch_id,
            item_id: meta.item_id,
            role: meta.role,
          },
          "validator"
        );
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
  const reviewGate = ensureReviewGate(context.item);

  if (meta.role === "developer" && dispatchEntry.mode === "review") {
    const validatedAt = nowIso();
    const reviewBundlePath = buildReviewBundlePath("developer", meta.batch_id, meta.item_id);
    const ok = checkMtimeAfter(reviewBundlePath, dispatchEntry.created_at);
    reviewGate.status = reviewGate.status === "idle" ? "open" : reviewGate.status;
    reviewGate.developer_review = ok ? "done" : "blocked";
    context.roleState.status = "todo";
    context.roleState.failed_check_ids = [];
    context.roleState.retry_scope = ok
      ? []
      : [`retry review bundle: ${reviewBundlePath} 작성 또는 갱신`];
    context.roleState.last_error = ok
      ? null
      : "developer review bundle missing or not updated after dispatch";
    context.roleState.last_updated_at = validatedAt;
    saveState(state);
    return {
      ok,
      retryLimit: context.item.retry_limit || 3,
      failures: ok ? [] : ["developer review bundle missing or stale"],
      meta,
      status: ok ? "completed" : "blocked",
      validatedAt,
    };
  }

  if (meta.role === "qa" && dispatchEntry.mode === "review") {
    const validatedAt = nowIso();
    const reviewBundlePath = buildReviewBundlePath("qa", meta.batch_id, meta.item_id);
    const ok = checkMtimeAfter(reviewBundlePath, dispatchEntry.created_at);
    reviewGate.status = reviewGate.status === "idle" ? "open" : reviewGate.status;
    reviewGate.qa_review = ok ? "done" : "blocked";
    context.roleState.status = "todo";
    context.roleState.failed_check_ids = [];
    context.roleState.retry_scope = ok
      ? []
      : [`retry review bundle: ${reviewBundlePath} 작성 또는 갱신`];
    context.roleState.last_error = ok ? null : "qa review bundle missing or not updated after dispatch";
    context.roleState.last_updated_at = validatedAt;
    saveState(state);
    return {
      ok,
      retryLimit: context.item.retry_limit || 3,
      failures: ok ? [] : ["qa review bundle missing or stale"],
      meta,
      status: ok ? "completed" : "blocked",
      validatedAt,
    };
  }

  if (meta.role === "designer" && dispatchEntry.mode === "review") {
    const validatedAt = nowIso();
    context.roleState.status = "in_progress";
    context.roleState.failed_check_ids = [];
    context.roleState.retry_scope = [];
    context.roleState.last_error = null;
    context.roleState.last_updated_at = validatedAt;
    saveState(state);
    return {
      ok: true,
      retryLimit: context.item.retry_limit || 3,
      failures: [],
      meta,
      status: "completed",
      validatedAt,
    };
  }

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
    agent_transcript_path: payload.agent_transcript_path || "",
  };

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
  if (!context.roleState.attempts_by_mode || typeof context.roleState.attempts_by_mode !== "object") {
    context.roleState.attempts_by_mode = {};
  }
  const modeKey = meta.mode || "default";
  context.roleState.attempts_by_mode[modeKey] = (context.roleState.attempts_by_mode[modeKey] || 0) + 1;
  saveState(state);

  const results = runChecklist(state, checklistContext, checks);
  context.roleState.attempt = (context.roleState.attempts_by_mode[modeKey] || 1);
  context.roleState.failed_check_ids = [];
  context.roleState.retry_scope = [];
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
    const failedCheckIds = failedChecks.map((entry) => entry.id);
    const retryScope = buildRetryScope(failedChecks);
    if (meta.role === "planner" && reviewGate.status !== "idle") {
      reviewGate.planner_response = "blocked";
    }
    if (meta.role === "designer" && reviewGate.status === "awaiting_design_sync") {
      reviewGate.designer_response = "blocked";
    }
    context.roleState.status = "blocked";
    context.roleState.missing_items = failures;
    context.roleState.failed_check_ids = failedCheckIds;
    context.roleState.retry_scope = retryScope;
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
  context.roleState.failed_check_ids = [];
  context.roleState.retry_scope = [];
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

  if (!Array.isArray(reviewGate.planner_response_history)) {
    reviewGate.planner_response_history = [];
  }
  if (!Array.isArray(reviewGate.designer_response_history)) {
    reviewGate.designer_response_history = [];
  }
  if (!Number.isFinite(reviewGate.a2_iteration_count)) {
    reviewGate.a2_iteration_count = 0;
  }

  const isLoopBRevise =
    meta.role === "planner" &&
    meta.mode === "revise" &&
    reviewGate.status === "open" &&
    reviewGate.developer_review === "done" &&
    reviewGate.qa_review === "done";

  if (isLoopBRevise) {
    reviewGate.planner_response_history.push({
      at: validatedAt,
      mode: meta.mode,
      result: "done",
    });
    reviewGate.planner_response = "done";
    if (reviewGate.status !== "awaiting_design_sync") {
      reviewGate.status = "awaiting_design_sync";
      reviewGate.resolved_at = null;
    }
  } else if (
    meta.role === "planner" &&
    meta.mode === "revise" &&
    (reviewGate.status === "idle" || reviewGate.status === "resolved")
  ) {
    reviewGate.a2_iteration_count = (reviewGate.a2_iteration_count || 0) + 1;
  } else if (
    meta.role === "designer" &&
    meta.mode === "review" &&
    (reviewGate.status === "idle" || reviewGate.status === "resolved")
  ) {
    reviewGate.a2_iteration_count = (reviewGate.a2_iteration_count || 0) + 1;
  }

  const isLoopBDesignerSync =
    meta.role === "designer" &&
    meta.mode === "apply" &&
    reviewGate.status === "awaiting_design_sync";

  if (isLoopBDesignerSync) {
    reviewGate.designer_response_history.push({
      at: validatedAt,
      mode: meta.mode,
      result: "done",
    });
    reviewGate.designer_response = "done";
    reviewGate.status = "resolved";
    reviewGate.resolved_at = validatedAt;
  }

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

        const claimedAt = Date.parse(entry.claimed_at || entry.created_at || "");
        const staleClaimedWithoutStop =
          entry.status === "claimed" &&
          !Number.isNaN(claimedAt) &&
          Date.now() - claimedAt > STALE_CLAIMED_WITHOUT_STOP_MS;

        if (staleClaimedWithoutStop) {
          const inferredTranscriptPath = inferAgentTranscriptPath(entry.session_id, entry.agent_id);
          const transcriptExists = inferredTranscriptPath && fs.existsSync(inferredTranscriptPath);
          if (transcriptExists) {
            const syntheticPayload = {
              agent_id: entry.agent_id,
              agent_type: entry.agent_type || null,
              agent_transcript_path: inferredTranscriptPath,
              last_assistant_message: entry.last_assistant_message || null,
            };
            const result = finalizeDispatchEntry(state, entry, syntheticPayload);
            entry.status = result.status;
            entry.stop_reason = result.ok ? null : summarizeFailures(result.failures);
            entry.finished_at = result.validatedAt;
            recoveredEntries.push({
              batch_id: meta.batch_id,
              item_id: meta.item_id,
              role: meta.role,
              resolution: result.ok ? "completed_from_inferred_transcript" : "rejected_from_inferred_transcript",
            });
            continue;
          }

          recoveredEntries.push({
            batch_id: meta.batch_id,
            item_id: meta.item_id,
            role: meta.role,
            resolution: "claimed_without_stop_event_pending",
          });
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

  appendJsonLine(resolvePath("workspace/reports/hook-events.jsonl"), {
    logged_at: nowIso(),
    hook_event_name: "SubagentStopResult",
    task_meta: meta,
    extra: {
      stage: "subagent-stop-result",
      ok: result.ok,
      status: result.status,
      failures: result.failures,
      retry_limit: result.retryLimit,
    },
    payload: {
      agent_id: payload.agent_id || null,
      agent_transcript_path: payload.agent_transcript_path || null,
    },
  });

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

function handleEnsureStateItem(args) {
  const [batchId, itemId, ...titleParts] = args;
  const title = titleParts.join(" ").trim();
  if (!batchId || !itemId) {
    printJson({
      ok: false,
      error: "usage: validator.js ensure-state-item BatchN RN [title]",
    });
    process.exit(1);
  }

  const state = loadState();
  const { batch, batchIndex } = ensureBatch(state, batchId);
  const { item, itemIndex } = ensureItem(batch, itemId, title || itemId);
  if (title) {
    item.title = title;
  }
  item.role_order =
    Array.isArray(item.role_order) && item.role_order.length > 0
      ? item.role_order
      : [...DEFAULT_ROLE_ORDER];
  item.retry_limit =
    Number.isInteger(item.retry_limit) && item.retry_limit > 0 ? item.retry_limit : 3;
  item.roles = item.role_order.map((roleName) => {
    const existing =
      Array.isArray(item.roles) &&
      item.roles.find((entry) => entry && entry.role === roleName);
    return normalizeRoleState(existing, roleName);
  });
  state.current_batch_id = batchId;
  saveState(state);

  printJson({
    ok: true,
    batch_id: batchId,
    item_id: itemId,
    title: item.title,
    batch_index: batchIndex,
    item_index: itemIndex,
    roles: item.role_order,
  });
}

function handleRefreshLiveStatus() {
  const state = loadState();
  writeLiveStatus(state);
  printJson({
    ok: true,
    live_status_json: "workspace/reports/live-status.json",
    live_status_md: "workspace/reports/live-status.md",
    updated_at: nowIso(),
  });
}

function handleHoldOpen(args) {
  const [code, reason, ...detailParts] = args;
  if (!code || !reason) {
    printJson({
      ok: false,
      error: "usage: validator.js hold-open code reason [details_json]",
    });
    process.exit(1);
  }

  let details = {};
  if (detailParts.length > 0) {
    const raw = detailParts.join(" ").trim();
    if (raw) {
      try {
        details = JSON.parse(raw);
      } catch (error) {
        printJson({
          ok: false,
          error: `invalid details_json: ${error.message}`,
        });
        process.exit(1);
      }
    }
  }

  const state = loadState();
  const hold = upsertHold(state, code, reason, details, "harness");
  saveState(state);
  printJson({
    ok: true,
    hold,
  });
}

function handleHoldResolve(args) {
  const [code] = args;
  if (!code) {
    printJson({
      ok: false,
      error: "usage: validator.js hold-resolve code",
    });
    process.exit(1);
  }

  const state = loadState();
  resolveHold(state, code);
  saveState(state);
  printJson({
    ok: true,
    code,
    open_holds: getOpenHolds(state),
  });
}

function handleNextAction() {
  const state = loadState();
  autoHoldStuckReviewGates(state);
  saveState(state);
  printJson({
    ok: true,
    updated_at: nowIso(),
    current_batch_id: getCurrentBatch(state)?.batch_id || null,
    next_action: buildNextAction(state),
  });
}

const REVIEW_GATE_SYNC_TIMEOUT_MS = 30 * 60 * 1000;
const LOOP_A2_REVISE_MAX = 5;
const LOOP_B_REVISE_MAX = 3;

function autoHoldStuckReviewGates(state) {
  const now = Date.now();
  for (const batch of state.batches || []) {
    for (const item of batch.items || []) {
      const gate = item.review_gate;
      if (!gate) continue;

      if (gate.status === "awaiting_design_sync" && gate.opened_at) {
        const openedAt = Date.parse(gate.opened_at);
        if (!Number.isNaN(openedAt) && now - openedAt > REVIEW_GATE_SYNC_TIMEOUT_MS) {
          upsertHold(
            state,
            "review_gate_sync_timeout",
            `Review gate stuck in awaiting_design_sync for >${REVIEW_GATE_SYNC_TIMEOUT_MS / 60000}m: ${batch.batch_id}/${item.item_id}`,
            { batch_id: batch.batch_id, item_id: item.item_id },
            "validator"
          );
        }
      }

      const loopBAttempts = Array.isArray(gate.planner_response_history)
        ? gate.planner_response_history.length
        : 0;
      if (loopBAttempts >= LOOP_B_REVISE_MAX) {
        upsertHold(
          state,
          "loop_b_revise_exhausted",
          `Loop B planner revise exceeded ${LOOP_B_REVISE_MAX} iterations: ${batch.batch_id}/${item.item_id}`,
          { batch_id: batch.batch_id, item_id: item.item_id, iterations: loopBAttempts },
          "validator"
        );
      }

      const a2Iterations = Number.isFinite(gate.a2_iteration_count) ? gate.a2_iteration_count : 0;
      if (a2Iterations >= LOOP_A2_REVISE_MAX) {
        upsertHold(
          state,
          "loop_a2_revise_exhausted",
          `Loop A-2 iteration exceeded ${LOOP_A2_REVISE_MAX} (planner revise + designer review 합산): ${batch.batch_id}/${item.item_id}`,
          { batch_id: batch.batch_id, item_id: item.item_id, iterations: a2Iterations },
          "validator"
        );
      }
    }
  }
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

// ── Planner composite checks (92→29 consolidation) ──────────────────────────

function checkPlannerProcessReadsAll(transcriptPath) {
  if (!hasTranscriptRead(transcriptPath, "workspace/planning/request-workboard.md")) return false;
  if (!hasTranscriptRead(transcriptPath, "workspace/planning/project-config.md")) return false;
  if (!hasTranscriptReadIfExists(transcriptPath, "workspace/planning/A-benchmark.md")) return false;
  return true;
}

function checkPlannerProcessEvidenceAll(transcriptPath, batchId, itemId) {
  const wfPath = `workspace/evidence/planner/${batchId}/${itemId}/wf-export.json`;
  const descPath = `workspace/evidence/planner/${batchId}/${itemId}/desc-export.json`;
  if (!hasTranscriptTouch(transcriptPath, wfPath)) return false;
  if (!hasTranscriptTouch(transcriptPath, descPath)) return false;
  return true;
}

function checkPlannerClaimFieldsAll(claimPath) {
  if (!checkJsonFieldTruthy(claimPath, "export_shape_summary")) return false;
  if (!checkJsonArrayMinSize(claimPath, "read_log", 4)) return false;
  if (!checkJsonFieldTruthy(claimPath, "action_rationale")) return false;
  if (!checkJsonArrayNonEmpty(claimPath, "planning_doc_sections")) return false;
  if (!checkJsonFieldMatches(claimPath, "designer_required", "^(Y|N)$")) return false;
  if (!checkJsonFieldTruthy(claimPath, "design_reason")) return false;
  if (!checkJsonFieldMatches(claimPath, "developer_ready", "^(Y|N)$")) return false;
  if (!checkJsonFieldMatches(claimPath, "tester_required", "^(Y|N)$")) return false;
  if (!checkJsonFieldTruthy(claimPath, "tester_reason")) return false;
  if (!checkJsonFieldTruthy(claimPath, "user_raw_request_quoted")) return false;
  if (!checkJsonFieldTruthy(claimPath, "pre_review_applied")) return false;
  return true;
}

function checkPlannerClaimArraysAll(claimPath) {
  if (!checkJsonArrayMinSize(claimPath, "reference_flows", 2)) return false;
  if (!checkJsonArrayItemMinLength(claimPath, "reference_flows", 15)) return false;
  if (!checkJsonArrayNoDuplicates(claimPath, "reference_flows")) return false;
  if (!checkJsonArrayItemQuality(claimPath, "reference_flows")) return false;
  if (!checkJsonArrayMinSize(claimPath, "expected_user_path", 2)) return false;
  if (!checkJsonArrayItemMinLength(claimPath, "expected_user_path", 10)) return false;
  if (!checkJsonArrayItemQuality(claimPath, "expected_user_path")) return false;
  if (!checkJsonArrayMinSize(claimPath, "critical_states", 2)) return false;
  if (!checkJsonArrayItemMinLength(claimPath, "critical_states", 10)) return false;
  if (!checkJsonArrayItemQuality(claimPath, "critical_states")) return false;
  if (!checkJsonArrayMinSize(claimPath, "avoid_patterns", 2)) return false;
  if (!checkJsonArrayItemMinLength(claimPath, "avoid_patterns", 15)) return false;
  if (!checkJsonArrayNoDuplicates(claimPath, "avoid_patterns")) return false;
  if (!checkJsonArrayItemQuality(claimPath, "avoid_patterns")) return false;
  return true;
}

function checkPlannerWfExportValid(evidencePath, dispatchCreatedAt) {
  if (!checkMtimeAfter(evidencePath, dispatchCreatedAt)) return false;
  if (!checkJsonFieldEquals(evidencePath, "type", "wf_export")) return false;
  if (!checkJsonFieldTruthy(evidencePath, "board_id")) return false;
  if (!checkJsonFieldMatches(evidencePath, "board_name", "^wf_")) return false;
  return true;
}

function checkPlannerDescExportValid(evidencePath, dispatchCreatedAt) {
  if (!checkMtimeAfter(evidencePath, dispatchCreatedAt)) return false;
  if (!checkJsonFieldEquals(evidencePath, "type", "desc_export")) return false;
  if (!checkJsonFieldTruthy(evidencePath, "board_id")) return false;
  if (!checkJsonFieldMatches(evidencePath, "board_name", "^desc_")) return false;
  return true;
}

function checkPlannerBoardsValid(claimPath, docPath, evidenceDir, itemId) {
  if (!checkWfDescPairMatch(claimPath)) return false;
  if (!checkBoardNameMatchesItem(claimPath, itemId)) return false;
  if (!checkActionConsistency(claimPath)) return false;
  try {
    const claim = parseJsonFile(claimPath);
    if (claim.action !== "NO_CHANGE") {
      if (!checkWfBoardsMatchPlanningDoc(claimPath, docPath)) return false;
      if (!checkMultiScreenEvidenceExists(claimPath, evidenceDir)) return false;
      if (!checkRetryPreservesBoardIds(evidenceDir)) return false;
    }
  } catch {
    return false;
  }
  return true;
}

function checkPlannerPlanningDocValid(docPath, hashLogPath) {
  if (!checkPlanningDocSections(docPath)) return false;
  if (!checkHashRecordAndCompare(docPath, hashLogPath)) return false;
  return true;
}

function checkPlannerRoutingValid(claimPath, workboardPath, itemId) {
  if (!checkDesignerSkipValid(claimPath, workboardPath, itemId)) return false;
  if (!checkTesterRequiredConsistency(claimPath)) return false;
  return true;
}

function checkPlannerRequestCoverageAll(claimPath, workboardPath, itemId, docPath) {
  if (!checkRequestCoverageValid(claimPath)) return false;
  try {
    const claim = parseJsonFile(claimPath);
    if (claim.action !== "NO_CHANGE") {
      if (!checkRequestCoverageCrossCheck(workboardPath, itemId, docPath)) return false;
    }
  } catch {
    return false;
  }
  return true;
}

function checkPlannerPreReviewBundle(claimPath, preReviewPath) {
  if (!checkUserRawRequestMatch(claimPath, preReviewPath)) return false;
  if (!checkPreReviewQaApplied(claimPath, preReviewPath)) return false;
  return true;
}

function checkPlannerReviseBundle(transcriptPath, claimPath, uiuxReviewPath, planningDocPath, reviewsDir) {
  if (!hasTranscriptReadIfExists(transcriptPath, uiuxReviewPath)) return false;
  if (!hasTranscriptReadIfExists(transcriptPath, `${reviewsDir}/developer-review.md`)) return false;
  if (!hasTranscriptReadIfExists(transcriptPath, `${reviewsDir}/qa-review.md`)) return false;
  if (!checkPriorReviewAddressed(uiuxReviewPath, planningDocPath, claimPath)) return false;
  if (!checkJsonArrayNonEmpty(claimPath, "review_response_decisions")) return false;
  if (!checkJsonFieldTruthy(claimPath, "review_source")) return false;
  return true;
}

function checkPlannerLoopBReviseBundle(batchId, itemId, claimPath) {
  if (!checkLoopBReviewBundleComplete(batchId, itemId)) return false;
  if (!checkLoopBAssignmentsValid(batchId, itemId)) return false;
  if (!checkAssignmentsClassification(batchId, itemId)) return false;
  const assignmentsPath = `workspace/reviews/${batchId}/${itemId}/assignments.json`;
  if (!checkClaimProcessedAssignedTasks(claimPath, assignmentsPath, "planner")) return false;
  return true;
}

function checkPlannerReviewBundle(reviewFilePath, dispatchCreatedAt) {
  if (!checkFileExists(reviewFilePath)) return false;
  if (!checkFileContains(reviewFilePath, "UIUX 보완점")) return false;
  if (!checkFileContains(reviewFilePath, "디스크립션")) return false;
  if (!checkFileContains(reviewFilePath, "기획서 보완점")) return false;
  if (!checkMtimeAfter(reviewFilePath, dispatchCreatedAt)) return false;
  return true;
}

// ── Designer composite checks (32→19 consolidation) ─────────────────────────

function checkDesignerProcessCommonReads(transcriptPath) {
  if (!hasTranscriptRead(transcriptPath, "workspace/planning/request-workboard.md")) return false;
  if (!hasTranscriptRead(transcriptPath, "workspace/planning/A-planning-doc.md")) return false;
  return true;
}

function checkDesignerProcessApplyWrites(transcriptPath, batchId, itemId) {
  const exportPath = `workspace/evidence/designer/${batchId}/${itemId}/design-export.json`;
  const boardsPath = `workspace/evidence/designer/${batchId}/${itemId}/boards.json`;
  const claimPath = `workspace/claims/${batchId}/${itemId}/designer.claim.json`;
  if (!hasTranscriptTouch(transcriptPath, exportPath)) return false;
  if (!hasTranscriptTouch(transcriptPath, boardsPath)) return false;
  if (!hasTranscriptTouchAfter(transcriptPath, exportPath, claimPath)) return false;
  return true;
}

function checkDesignerApplyClaimFields(claimPath) {
  if (!checkJsonFieldEquals(claimPath, "developer_ready", "Y")) return false;
  if (!checkJsonArrayNonEmpty(claimPath, "developer_targets")) return false;
  if (!checkJsonArrayNonEmpty(claimPath, "design_boards")) return false;
  if (!checkJsonArrayEmpty(claimPath, "missing_items")) return false;
  return true;
}

function checkDesignerDesignExportValid(evidencePath, dispatchCreatedAt) {
  if (!checkMtimeAfter(evidencePath, dispatchCreatedAt)) return false;
  if (!checkJsonFieldEquals(evidencePath, "type", "design_export")) return false;
  if (!checkJsonFieldTruthy(evidencePath, "board_id")) return false;
  if (!checkJsonFieldMatches(evidencePath, "board_name", "^design_")) return false;
  return true;
}

function checkDesignerBoardsManifestValid(boardsPath, dispatchCreatedAt) {
  if (!checkMtimeAfter(boardsPath, dispatchCreatedAt)) return false;
  if (!checkJsonArrayNonEmpty(boardsPath, "design_boards")) return false;
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────

function handleCheck(args) {
  const [type, ...rest] = args;

  try {
    return handleCheckInner(type, rest);
  } catch (err) {
    printJson({
      ok: false,
      check: type,
      args: rest,
      error: err && err.message ? err.message : String(err),
    });
    process.exit(1);
  }
}

function handleCheckInner(type, rest) {
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
    case "json_array_nonempty":
      ok = checkJsonArrayNonEmpty(rest[0], rest[1]);
      break;
    case "json_array_empty":
      ok = checkJsonArrayEmpty(rest[0], rest[1]);
      break;
    case "json_array_min_size":
      ok = checkJsonArrayMinSize(rest[0], rest[1], parseInt(rest[2], 10) || 1);
      break;
    case "json_object_has_keys":
      ok = checkJsonObjectHasKeys(rest[0], rest[1], rest.slice(2));
      break;
    case "planning_doc_sections":
      ok = checkPlanningDocSections(rest[0]);
      break;
    case "json_array_item_min_length":
      ok = checkJsonArrayItemMinLength(rest[0], rest[1], parseInt(rest[2], 10) || 10);
      break;
    case "json_array_no_duplicates":
      ok = checkJsonArrayNoDuplicates(rest[0], rest[1]);
      break;
    case "workboard_item_has_quote":
      ok = checkWorkboardItemHasQuote(rest[0], rest[1]);
      break;
    case "hash_record_and_compare":
      ok = checkHashRecordAndCompare(rest[0], rest[1]);
      break;
    case "transcript_step_order":
      ok = checkTranscriptStepOrder(rest[0]);
      break;
    case "transcript_no_forbidden_writes":
      ok = checkTranscriptNoForbiddenWrites(rest[0], rest.slice(1));
      break;
    case "wf_desc_pair_match":
      ok = checkWfDescPairMatch(rest[0]);
      break;
    case "board_name_matches_item":
      ok = checkBoardNameMatchesItem(rest[0], rest[1]);
      break;
    case "desc_no_forbidden_terms":
      ok = checkDescNoForbiddenTerms(rest[0]);
      break;
    case "action_consistency":
      ok = checkActionConsistency(rest[0]);
      break;
    case "multi_screen_evidence_exists":
      ok = checkMultiScreenEvidenceExists(rest[0], rest[1]);
      break;
    case "wf_boards_match_planning_doc":
      ok = checkWfBoardsMatchPlanningDoc(rest[0], rest[1]);
      break;
    case "retry_preserves_board_ids":
      ok = checkRetryPreservesBoardIds(rest[0]);
      break;
    case "request_coverage_valid":
      ok = checkRequestCoverageValid(rest[0]);
      break;
    case "no_deferral_phrases":
      ok = checkNoDeferralPhrases(rest[0]);
      break;
    case "json_field_matches":
      ok = checkJsonFieldMatches(rest[0], rest[1], rest.slice(2).join(" "));
      break;
    case "mtime_after":
      ok = checkMtimeAfter(rest[0], rest[1]);
      break;
    case "transcript_read":
      ok = hasTranscriptRead(rest[0], rest[1]);
      break;
    case "transcript_read_if_exists":
      ok = hasTranscriptReadIfExists(rest[0], rest[1]);
      break;
    case "transcript_touch":
      ok = hasTranscriptTouch(rest[0], rest[1]);
      break;
    case "transcript_touch_after":
      ok = hasTranscriptTouchAfter(rest[0], rest[1], rest[2]);
      break;
    case "transcript_no_wf_desc_removal":
      ok = checkTranscriptNoWfDescRemoval(rest[0]);
      break;
    case "snapshot_preserves_ids":
      ok = checkSnapshotPreservesIds(rest[0], rest[1]);
      break;
    case "user_raw_request_match":
      ok = checkUserRawRequestMatch(rest[0], rest[1]);
      break;
    case "pre_review_qa_applied":
      ok = checkPreReviewQaApplied(rest[0], rest[1]);
      break;
    case "tester_required_consistency":
      ok = checkTesterRequiredConsistency(rest[0]);
      break;
    case "lessons_learned_append_if_applied":
      ok = checkLessonsLearnedAppendIfApplied(rest[0], rest[1], rest[2]);
      break;
    case "request_coverage_cross_check":
      ok = checkRequestCoverageCrossCheck(rest[0], rest[1], rest[2]);
      break;
    case "json_array_item_quality":
      ok = checkJsonArrayItemQuality(rest[0], rest[1]);
      break;
    case "loop_b_review_bundle_complete":
      ok = checkLoopBReviewBundleComplete(rest[0], rest[1]);
      break;
    case "loop_b_assignments_valid":
      ok = checkLoopBAssignmentsValid(rest[0], rest[1]);
      break;
    case "claim_processed_assigned_tasks":
      ok = checkClaimProcessedAssignedTasks(rest[0], rest[1], rest[2]);
      break;
    case "assignments_classification":
      ok = checkAssignmentsClassification(rest[0], rest[1]);
      break;
    case "designer_skip_valid":
      ok = checkDesignerSkipValid(rest[0], rest[1], rest[2]);
      break;
    case "designer_covers_planner_targets":
      ok = checkDesignerCoversPlannerTargets(rest[0], rest[1]);
      break;
    case "design_boards_match_wf_boards":
      ok = checkDesignBoardsMatchWfBoards(rest[0], rest[1]);
      break;
    case "developer_ready_cross_check":
      ok = checkDeveloperReadyCrossCheck(rest[0], rest[1]);
      break;
    case "designer_review_score_gate":
      ok = checkDesignerReviewScoreGate(rest[0], rest[1], rest[2]);
      break;
    case "review_claim_complete":
      ok = checkReviewClaimComplete(rest[0]);
      break;
    case "design_below_wf_desc":
      ok = checkDesignBelowWfDesc(rest[0]);
      break;
    case "penpot_boards_present":
      ok = checkPenpotBoardsPresent(rest[0], rest[1]);
      break;
    case "prior_review_addressed":
      ok = checkPriorReviewAddressed(rest[0], rest[1], rest[2]);
      break;
    case "planner_process_reads_all":
      ok = checkPlannerProcessReadsAll(rest[0]);
      break;
    case "planner_process_evidence_all":
      ok = checkPlannerProcessEvidenceAll(rest[0], rest[1], rest[2]);
      break;
    case "planner_claim_fields_all":
      ok = checkPlannerClaimFieldsAll(rest[0]);
      break;
    case "planner_claim_arrays_all":
      ok = checkPlannerClaimArraysAll(rest[0]);
      break;
    case "planner_wf_export_valid":
      ok = checkPlannerWfExportValid(rest[0], rest[1]);
      break;
    case "planner_desc_export_valid":
      ok = checkPlannerDescExportValid(rest[0], rest[1]);
      break;
    case "planner_boards_valid":
      ok = checkPlannerBoardsValid(rest[0], rest[1], rest[2], rest[3]);
      break;
    case "planner_planning_doc_valid":
      ok = checkPlannerPlanningDocValid(rest[0], rest[1]);
      break;
    case "planner_routing_valid":
      ok = checkPlannerRoutingValid(rest[0], rest[1], rest[2]);
      break;
    case "planner_request_coverage_all":
      ok = checkPlannerRequestCoverageAll(rest[0], rest[1], rest[2], rest[3]);
      break;
    case "planner_pre_review_bundle":
      ok = checkPlannerPreReviewBundle(rest[0], rest[1]);
      break;
    case "planner_revise_bundle":
      ok = checkPlannerReviseBundle(rest[0], rest[1], rest[2], rest[3], rest[4]);
      break;
    case "planner_loop_b_revise_bundle":
      ok = checkPlannerLoopBReviseBundle(rest[0], rest[1], rest[2]);
      break;
    case "planner_review_bundle":
      ok = checkPlannerReviewBundle(rest[0], rest[1]);
      break;
    case "designer_process_common_reads":
      ok = checkDesignerProcessCommonReads(rest[0]);
      break;
    case "designer_process_apply_writes":
      ok = checkDesignerProcessApplyWrites(rest[0], rest[1], rest[2]);
      break;
    case "designer_apply_claim_fields":
      ok = checkDesignerApplyClaimFields(rest[0]);
      break;
    case "designer_design_export_valid":
      ok = checkDesignerDesignExportValid(rest[0], rest[1]);
      break;
    case "designer_boards_manifest_valid":
      ok = checkDesignerBoardsManifestValid(rest[0], rest[1]);
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
      "validator.js parse-subject \"[Batch8][R17][planner] plan: short summary\"",
      "validator.js parse-subject \"[Batch8][R17][designer] review: short summary\"",
      "validator.js parse-subject \"[Batch8][R17][developer] review: short summary\"",
      "validator.js parse-subject \"[Batch8][R17][developer] implement: short summary\"",
      "validator.js parse-subject \"[Batch8][R17][qa] review: short summary\"",
      "validator.js inspect-event path/to/payload.json",
      "validator.js issue-skip Batch8 R17 designer \"No UI-visible change\"",
      "validator.js refresh-live-status",
      "validator.js hold-open planning_clarification \"Need more requirements\" '{\"questions\":[\"로그인 방식?\"]}'",
      "validator.js hold-resolve planning_clarification",
      "validator.js next-action",
      "validator.js check file_exists path/to/file",
      "validator.js check dir_has_entries path/to/dir",
      "validator.js check dir_has_entries_after path/to/dir 2026-04-16T00:00:00.000Z",
      "validator.js check file_contains path/to/file needle",
      "validator.js check json_field_equals path/to/file field.path expected",
      "validator.js check json_field_truthy path/to/file field.path",
      "validator.js check json_array_contains path/to/file field.path expected",
      "validator.js check json_array_nonempty path/to/file field.path",
      "validator.js check json_array_empty path/to/file field.path",
      "validator.js check json_field_matches path/to/file field.path '^wf_'",
      "validator.js check mtime_after path/to/file 2026-04-16T00:00:00.000Z",
      "validator.js check transcript_read path/to/transcript.jsonl workspace/planning/request-workboard.md",
      "validator.js check transcript_touch path/to/transcript.jsonl workspace/claims/Batch8/R17/planner.claim.json",
      "validator.js check transcript_touch_after path/to/transcript.jsonl workspace/planning/A-planning-doc.md workspace/claims/Batch8/R17/planner.claim.json",
      "validator.js ensure-state-item Batch8 R17 \"Short title\""
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
    case "ensure-state-item":
      handleEnsureStateItem(rest);
      return;
    case "refresh-live-status":
      handleRefreshLiveStatus();
      return;
    case "hold-open":
      handleHoldOpen(rest);
      return;
    case "hold-resolve":
      handleHoldResolve(rest);
      return;
    case "next-action":
      handleNextAction();
      return;
    case "ack-settings":
      handleAckSettings();
      return;
    default:
      printUsage();
      process.exit(1);
  }
}

function handleAckSettings() {
  const settingsPath = resolvePath(".claude/settings.json");
  const fpPath = resolvePath("workspace/planning/.settings-fingerprint.json");
  if (!fs.existsSync(settingsPath)) {
    printJson({ ok: false, error: ".claude/settings.json missing" });
    process.exit(1);
  }
  const hash = computeFileHash(settingsPath);
  const payload = { settings_sha256: hash, recorded_at: nowIso(), acknowledged_at: nowIso() };
  fs.writeFileSync(fpPath, JSON.stringify(payload, null, 2));
  printJson({ ok: true, fingerprint_path: path.relative(resolveProjectRoot(), fpPath), settings_sha256: hash });
}

main().catch((error) => {
  printJson({
    ok: false,
    error: error.message,
  });
  process.exit(1);
});
