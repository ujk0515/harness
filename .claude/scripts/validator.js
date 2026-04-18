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

function defaultReviewGateState() {
  return {
    status: "idle",
    opened_at: null,
    resolved_at: null,
    developer_review: "todo",
    qa_review: "todo",
    planner_response: "todo",
    designer_response: "todo",
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
      action: "wait",
      response_allowed: false,
      reason: "open dispatch exists",
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
        ? "현재 백그라운드 에이전트가 동작 중일 수 있음. active_dispatch와 running_for를 확인."
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
    `- open_dispatch_count: ${payload.open_dispatch_count}`,
    `- hint: ${payload.hint}`,
    "",
    "## Active Dispatch",
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
    const matched = /^(plan|revise):\s+(.+)$/.exec(trimmed);
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
    return "Planner description must start with `plan:` or `revise:` after the role prefix.";
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
  return stat.mtimeMs > Date.parse(isoString);
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
  const beforeIds = beforeItems
    .map((entry) => (entry && typeof entry.id === "string" ? entry.id : null))
    .filter(Boolean);
  const afterIds = new Set(
    afterItems
      .map((entry) => (entry && typeof entry.id === "string" ? entry.id : null))
      .filter(Boolean)
  );

  if (beforeIds.length === 0) {
    return true;
  }

  return beforeIds.every((id) => afterIds.has(id));
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

function hasIssuedTicket(roleState) {
  return (
    (roleState.done_ticket && roleState.done_ticket.status === "issued") ||
    (roleState.skip_ticket && roleState.skip_ticket.status === "issued")
  );
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

function resetTicketState(ticketState) {
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

function ensureReviewGate(item) {
  if (!item.review_gate || typeof item.review_gate !== "object") {
    item.review_gate = defaultReviewGateState();
  }
  return item.review_gate;
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
    .replace(/\{dispatch_finished_at\}/g, context.dispatch_finished_at || "")
    .replace(/\{agent_transcript_path\}/g, context.agent_transcript_path || "");
}

function runChecklist(state, context, checklistEntries) {
  return checklistEntries
    .filter((entry) => !entry.when_mode || entry.when_mode === context.mode)
    .map((entry) => {
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
  context.roleState.failed_check_ids = [];
  context.roleState.retry_scope = [];
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

  if (meta.role === "planner" && reviewGate.status !== "idle") {
    reviewGate.planner_response = "done";
    reviewGate.status = "awaiting_design_sync";
    reviewGate.resolved_at = null;
  }

  if (meta.role === "designer" && reviewGate.status === "awaiting_design_sync") {
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
  printJson({
    ok: true,
    updated_at: nowIso(),
    current_batch_id: getCurrentBatch(state)?.batch_id || null,
    next_action: buildNextAction(state),
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
    case "json_array_nonempty":
      ok = checkJsonArrayNonEmpty(rest[0], rest[1]);
      break;
    case "json_array_empty":
      ok = checkJsonArrayEmpty(rest[0], rest[1]);
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
