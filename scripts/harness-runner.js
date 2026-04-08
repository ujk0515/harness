#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = process.cwd();
const WORKSPACE = path.join(ROOT, 'workspace');
const PATHS = {
  planning: path.join(WORKSPACE, 'planning'),
  design: path.join(WORKSPACE, 'design'),
  development: path.join(WORKSPACE, 'development'),
  server: path.join(WORKSPACE, 'server'),
  testing: path.join(WORKSPACE, 'testing'),
  playwright: path.join(WORKSPACE, 'testing', 'playwright'),
  screenshots: path.join(WORKSPACE, 'testing', 'playwright', 'screenshots'),
  reports: path.join(WORKSPACE, 'reports'),
  projectConfig: path.join(WORKSPACE, 'planning', 'project-config.md'),
  benchmark: path.join(WORKSPACE, 'planning', 'A-benchmark.md'),
  planningDoc: path.join(WORKSPACE, 'planning', 'A-planning-doc.md'),
  designerReview: path.join(WORKSPACE, 'design', 'A-uiux-review.md'),
  techReview: path.join(WORKSPACE, 'reports', 'B-tech-review.md'),
  qaReview: path.join(WORKSPACE, 'reports', 'B-qa-review.md'),
  testcases: path.join(WORKSPACE, 'testing', 'C-testcases.md'),
  qaVerification: path.join(WORKSPACE, 'reports', 'D-qa-verification.md'),
  testerVerification: path.join(WORKSPACE, 'reports', 'D-tester-verification.md'),
  finalReport: path.join(WORKSPACE, 'reports', 'final-report.md'),
  agentLog: path.join(WORKSPACE, 'reports', 'agent-log.txt'),
  playwrightResults: path.join(WORKSPACE, 'reports', 'playwright-results.json'),
  processDoc: path.join(ROOT, 'workflow', 'process.md'),
  localSettings: path.join(ROOT, '.claude', 'settings.local.json'),
};

const REQUIRED_AGENTS = ['planner', 'designer', 'developer', 'qa', 'tester', 'secretary'];
const REQUIRED_PENPOT_TOOLS = [
  'mcp__penpot__execute_code',
  'mcp__penpot__export_shape',
  'mcp__penpot__high_level_overview',
  'mcp__penpot__import_image',
];

const ISSUE_SCHEMA = {
  type: 'object',
  properties: {
    severity: { type: 'string' },
    category: { type: 'string' },
    source: { type: 'string' },
    message: { type: 'string' },
  },
  required: ['severity', 'category', 'source', 'message'],
  additionalProperties: false,
};

function printUsage() {
  console.log(`Usage:
  node scripts/harness-runner.js preflight [--skip-llm-ping]
  node scripts/harness-runner.js simulate --request "..."
  node scripts/harness-runner.js run --request "..." [--dangerously-skip-permissions]

Options:
  --request "..."                  User request to run through the harness
  --request-file path              Read user request from a file
  --platform value                 Bootstrap project-config when missing
  --stack value                    Bootstrap project-config when missing
  --name value                     Bootstrap project name when missing
  --max-loops number               Override max loop count from project-config
  --pass-score number              Override pass score from project-config
  --skip-llm-ping                  Skip Claude API ping during preflight
  --dangerously-skip-permissions   Pass through to claude CLI for fully unattended runs
`);
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) {
      args._.push(token);
      continue;
    }
    const key = token.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      args[key] = true;
      continue;
    }
    args[key] = next;
    i += 1;
  }
  return args;
}

function ensureWorkspaceDirs() {
  [
    PATHS.planning,
    PATHS.design,
    PATHS.development,
    PATHS.server,
    PATHS.testing,
    PATHS.playwright,
    PATHS.screenshots,
    PATHS.reports,
  ].forEach((dir) => fs.mkdirSync(dir, { recursive: true }));
}

function fileExists(filePath) {
  try {
    fs.accessSync(filePath, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function parseProjectConfig(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  const config = {
    name: matchSingle(content, /\*\*프로젝트명\*\*:\s*(.+)/),
    platform: matchSingle(content, /\*\*플랫폼\*\*:\s*(.+)/),
    stack: matchSingle(content, /\*\*기술 스택\*\*:\s*(.+)/),
    maxLoops: toInt(matchSingle(content, /\*\*루프 최대 반복 횟수\*\*:\s*(\d+)/), 5),
    passScore: toInt(matchSingle(content, /\*\*통과 기준 점수\*\*:\s*(\d+)/), 95),
  };
  return config;
}

function bootstrapProjectConfig(args, request) {
  if (fileExists(PATHS.projectConfig)) {
    return parseProjectConfig(PATHS.projectConfig);
  }

  if (!args.platform || !args.stack) {
    throw new Error(
      `project-config.md가 없고 --platform / --stack도 없습니다. ${PATHS.projectConfig}를 만들거나 인자를 넘겨야 합니다.`,
    );
  }

  const config = {
    name: args.name || 'Harness Project',
    platform: args.platform,
    stack: args.stack,
    maxLoops: toInt(args['max-loops'], 5),
    passScore: toInt(args['pass-score'], 95),
  };

  const content = `# 프로젝트 설정

- **프로젝트명**: ${config.name}
- **플랫폼**: ${config.platform}
- **기술 스택**: ${config.stack}
- **루프 최대 반복 횟수**: ${config.maxLoops}
- **통과 기준 점수**: ${config.passScore}

## 원본 요청

${request}
`;
  fs.writeFileSync(PATHS.projectConfig, content, 'utf8');
  return config;
}

function matchSingle(content, regex) {
  const match = content.match(regex);
  return match ? match[1].trim() : '';
}

function toInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseDelimitedList(lines, startLabel) {
  const items = [];
  let active = false;
  lines.forEach((line) => {
    if (line.startsWith(startLabel)) {
      active = true;
      return;
    }
    if (active) {
      if (!line.trim()) {
        active = false;
        return;
      }
      items.push(line.trim());
    }
  });
  return items;
}

function parseAgentsList(text) {
  return parseDelimitedList(text.split(/\r?\n/), 'Project agents:').map((line) => {
    const [name] = line.split('·').map((part) => part.trim());
    return name;
  });
}

function readRequest(args) {
  if (args.request) {
    return String(args.request).trim();
  }
  if (args['request-file']) {
    return fs.readFileSync(path.resolve(ROOT, args['request-file']), 'utf8').trim();
  }
  throw new Error('--request 또는 --request-file이 필요합니다.');
}

function parseJsonLoose(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) {
    return null;
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start >= 0 && end > start) {
      return JSON.parse(trimmed.slice(start, end + 1));
    }
    return null;
  }
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd || ROOT,
      env: { ...process.env, ...(options.env || {}) },
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('close', (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}

async function invokeClaude({ prompt, schema, agent, permissionMode, dangerouslySkipPermissions = false }) {
  const args = [
    '-p',
    '--output-format',
    'json',
    '--setting-sources',
    'user,project,local',
    '--permission-mode',
    permissionMode || 'acceptEdits',
  ];

  if (agent) {
    args.push('--agent', agent);
  }
  if (schema) {
    args.push('--json-schema', JSON.stringify(schema));
  }
  if (dangerouslySkipPermissions) {
    args.push('--dangerously-skip-permissions');
  }

  args.push(prompt);

  const startedAt = Date.now();
  const result = await runCommand('claude', args);
  const durationMs = Date.now() - startedAt;

  const parsed = parseJsonLoose(result.stdout);
  if (!parsed) {
    throw new Error(`Claude CLI 출력 파싱 실패\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  }

  if (parsed.is_error || result.code !== 0) {
    throw new Error(parsed.result || parsed.error || result.stderr || 'Claude CLI 호출 실패');
  }

  let data = parsed.result;
  if (typeof data === 'string') {
    const parsedResult = parseJsonLoose(data);
    data = parsedResult || { text: data };
  }

  return {
    data,
    envelope: parsed,
    durationMs,
  };
}

function accumulateAgentStats(stats, agentName, envelope) {
  if (!stats[agentName]) {
    stats[agentName] = { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };
  }
  const usage = envelope.usage || {};
  stats[agentName].calls += 1;
  stats[agentName].inputTokens += usage.input_tokens || 0;
  stats[agentName].outputTokens += usage.output_tokens || 0;
  stats[agentName].costUsd += envelope.total_cost_usd || 0;
}

async function runPreflight({ skipLlmPing = false }) {
  ensureWorkspaceDirs();

  const report = {
    ok: true,
    checks: [],
  };

  const record = (name, ok, detail, critical = false) => {
    report.checks.push({ name, ok, detail, critical });
    if (critical && !ok) {
      report.ok = false;
    }
  };

  const claudePath = await runCommand('which', ['claude']);
  record('claude_cli', claudePath.code === 0, claudePath.stdout.trim() || claudePath.stderr.trim(), true);

  const agents = await runCommand('claude', ['agents']);
  if (agents.code === 0) {
    const agentNames = parseAgentsList(agents.stdout);
    const missingAgents = REQUIRED_AGENTS.filter((name) => !agentNames.includes(name));
    record(
      'project_agents',
      missingAgents.length === 0,
      missingAgents.length === 0 ? `OK: ${agentNames.join(', ')}` : `누락: ${missingAgents.join(', ')}`,
      true,
    );
  } else {
    record('project_agents', false, agents.stderr.trim() || 'claude agents 실행 실패', true);
  }

  const authStatus = await runCommand('claude', ['auth', 'status']);
  if (authStatus.code === 0) {
    const parsed = parseJsonLoose(authStatus.stdout) || {};
    record(
      'claude_auth_status',
      Boolean(parsed.loggedIn),
      parsed.loggedIn ? `${parsed.email || 'unknown'} / ${parsed.orgName || 'unknown'}` : '로그인 안 됨',
      true,
    );
  } else {
    record('claude_auth_status', false, authStatus.stderr.trim() || 'auth status 실패', true);
  }

  if (!skipLlmPing) {
    try {
      const ping = await invokeClaude({
        prompt: "Return ok=true and message='pong'.",
        schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            message: { type: 'string' },
          },
          required: ['ok', 'message'],
          additionalProperties: false,
        },
        permissionMode: 'default',
      });
      record('claude_llm_ping', ping.data.ok === true, ping.data.message || 'pong', true);
    } catch (error) {
      record('claude_llm_ping', false, error.message, true);
    }
  } else {
    record('claude_llm_ping', true, 'skipLlmPing=true', false);
  }

  const penpotPorts = await runCommand('lsof', ['-nP', '-iTCP:4400-4403', '-sTCP:LISTEN']);
  record(
    'penpot_ports',
    penpotPorts.code === 0 && penpotPorts.stdout.includes('4401') && penpotPorts.stdout.includes('4400'),
    penpotPorts.stdout.trim() || '리스닝 포트 없음',
    true,
  );

  if (fileExists(PATHS.localSettings)) {
    const settings = readJson(PATHS.localSettings);
    const allowList = (((settings.permissions || {}).allow) || []).slice();
    const missingPerms = REQUIRED_PENPOT_TOOLS.filter((toolName) => !allowList.includes(toolName));
    record(
      'penpot_permissions',
      missingPerms.length === 0,
      missingPerms.length === 0 ? allowList.join(', ') : `누락: ${missingPerms.join(', ')}`,
      true,
    );
  } else {
    record('penpot_permissions', false, '.claude/settings.local.json 없음', true);
  }

  record('process_doc', fileExists(PATHS.processDoc), PATHS.processDoc, true);
  record('project_config', fileExists(PATHS.projectConfig), PATHS.projectConfig, false);

  return report;
}

function printPreflight(report) {
  report.checks.forEach((check) => {
    const mark = check.ok ? 'PASS' : check.critical ? 'FAIL' : 'WARN';
    console.log(`[${mark}] ${check.name}: ${check.detail}`);
  });
  console.log('');
  console.log(report.ok ? 'Preflight OK' : 'Preflight FAILED');
}

function buildRunState(request, config) {
  return {
    request,
    config,
    startedAt: new Date().toISOString(),
    benchmarkPath: PATHS.benchmark,
    stage: {
      aTurns: 0,
      bTurns: 0,
      dTurns: 0,
      scores: {},
    },
    penpot: {
      screenIds: new Set(),
      wfDescScreens: new Set(),
      designScreens: new Set(),
    },
    artifacts: {
      planningDoc: PATHS.planningDoc,
      benchmark: PATHS.benchmark,
      designerReview: PATHS.designerReview,
      techReview: PATHS.techReview,
      qaReview: PATHS.qaReview,
      testcases: PATHS.testcases,
      qaVerification: PATHS.qaVerification,
      testerVerification: PATHS.testerVerification,
      finalReport: PATHS.finalReport,
    },
    issues: [],
    agentStats: {},
  };
}

function mergeScreenIds(state, ids, type) {
  (ids || []).forEach((id) => {
    if (!id) return;
    state.penpot.screenIds.add(id);
    if (type === 'wfdesc') state.penpot.wfDescScreens.add(id);
    if (type === 'design') state.penpot.designScreens.add(id);
  });
}

function normalizeIssues(issues) {
  return (issues || []).map((issue) => ({
    severity: issue.severity || 'Major',
    category: issue.category || '동작 오류',
    source: issue.source || 'unknown',
    message: issue.message || '',
  }));
}

function collectIssueCategories(...issueLists) {
  const categories = new Set();
  issueLists.flat().forEach((issue) => {
    if (issue && issue.category) {
      categories.add(issue.category);
    }
  });
  return categories;
}

function sumTokens(stats) {
  return Object.values(stats).reduce(
    (acc, item) => {
      acc.calls += item.calls;
      acc.inputTokens += item.inputTokens;
      acc.outputTokens += item.outputTokens;
      acc.costUsd += item.costUsd;
      return acc;
    },
    { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 },
  );
}

async function callHarnessModel(prompt, schema, state, options = {}) {
  const result = await invokeClaude({
    prompt,
    schema,
    permissionMode: options.permissionMode || 'acceptEdits',
    dangerouslySkipPermissions: options.dangerouslySkipPermissions,
  });
  accumulateAgentStats(state.agentStats, 'harness', result.envelope);
  return result.data;
}

async function callAgent(agent, prompt, schema, state, options = {}) {
  const result = await invokeClaude({
    agent,
    prompt,
    schema,
    permissionMode: options.permissionMode || 'acceptEdits',
    dangerouslySkipPermissions: options.dangerouslySkipPermissions,
  });
  accumulateAgentStats(state.agentStats, agent, result.envelope);
  return result.data;
}

function benchmarkSchema() {
  return {
    type: 'object',
    properties: {
      ok: { type: 'boolean' },
      summary: { type: 'string' },
      benchmark_path: { type: 'string' },
    },
    required: ['ok', 'summary', 'benchmark_path'],
    additionalProperties: false,
  };
}

function plannerDraftSchema() {
  return {
    type: 'object',
    properties: {
      ok: { type: 'boolean' },
      summary: { type: 'string' },
      planning_doc_path: { type: 'string' },
      screen_ids: { type: 'array', items: { type: 'string' } },
      wf_desc_updated: { type: 'boolean' },
      skipped_screens: { type: 'array', items: { type: 'string' } },
    },
    required: ['ok', 'summary', 'planning_doc_path', 'screen_ids', 'wf_desc_updated', 'skipped_screens'],
    additionalProperties: false,
  };
}

function plannerReviewSchema() {
  return {
    type: 'object',
    properties: {
      ok: { type: 'boolean' },
      summary: { type: 'string' },
      score: { type: 'number' },
      functional_change: { type: 'boolean' },
      wf_desc_changed: { type: 'boolean' },
      changed_screen_ids: { type: 'array', items: { type: 'string' } },
    },
    required: ['ok', 'summary', 'score', 'functional_change', 'wf_desc_changed', 'changed_screen_ids'],
    additionalProperties: false,
  };
}

function designerReviewSchema() {
  return {
    type: 'object',
    properties: {
      ok: { type: 'boolean' },
      summary: { type: 'string' },
      improvement_needed: { type: 'boolean' },
      font_feedback_requested: { type: 'boolean' },
      issues: { type: 'array', items: { type: 'string' } },
    },
    required: ['ok', 'summary', 'improvement_needed', 'font_feedback_requested', 'issues'],
    additionalProperties: false,
  };
}

function designerScoreSchema() {
  return {
    type: 'object',
    properties: {
      ok: { type: 'boolean' },
      summary: { type: 'string' },
      score: { type: 'number' },
      remaining_issues: { type: 'array', items: { type: 'string' } },
    },
    required: ['ok', 'summary', 'score', 'remaining_issues'],
    additionalProperties: false,
  };
}

function designerBuildSchema() {
  return {
    type: 'object',
    properties: {
      ok: { type: 'boolean' },
      summary: { type: 'string' },
      design_screen_ids: { type: 'array', items: { type: 'string' } },
      synced_screen_ids: { type: 'array', items: { type: 'string' } },
    },
    required: ['ok', 'summary', 'design_screen_ids', 'synced_screen_ids'],
    additionalProperties: false,
  };
}

function reviewSchema() {
  return {
    type: 'object',
    properties: {
      ok: { type: 'boolean' },
      summary: { type: 'string' },
      feasible: { type: 'boolean' },
      issues: { type: 'array', items: ISSUE_SCHEMA },
    },
    required: ['ok', 'summary', 'feasible', 'issues'],
    additionalProperties: false,
  };
}

function developerBuildSchema() {
  return {
    type: 'object',
    properties: {
      ok: { type: 'boolean' },
      summary: { type: 'string' },
      changed_paths: { type: 'array', items: { type: 'string' } },
      frontend_path: { type: 'string' },
      server_path: { type: 'string' },
    },
    required: ['ok', 'summary', 'changed_paths', 'frontend_path', 'server_path'],
    additionalProperties: false,
  };
}

function qaTestcaseSchema() {
  return {
    type: 'object',
    properties: {
      ok: { type: 'boolean' },
      summary: { type: 'string' },
      front_tc_count: { type: 'number' },
      api_tc_count: { type: 'number' },
      tc_path: { type: 'string' },
    },
    required: ['ok', 'summary', 'front_tc_count', 'api_tc_count', 'tc_path'],
    additionalProperties: false,
  };
}

function verificationSchema() {
  return {
    type: 'object',
    properties: {
      ok: { type: 'boolean' },
      summary: { type: 'string' },
      score: { type: 'number' },
      issues: { type: 'array', items: ISSUE_SCHEMA },
      report_path: { type: 'string' },
    },
    required: ['ok', 'summary', 'score', 'issues', 'report_path'],
    additionalProperties: false,
  };
}

function secretarySchema() {
  return {
    type: 'object',
    properties: {
      ok: { type: 'boolean' },
      summary: { type: 'string' },
      final_report_path: { type: 'string' },
    },
    required: ['ok', 'summary', 'final_report_path'],
    additionalProperties: false,
  };
}

function buildBenchmarkPrompt(state) {
  return `너는 하네스의 사전 벤치마킹 단계다.

사용자 요청:
${state.request}

프로젝트 설정:
- 프로젝트명: ${state.config.name}
- 플랫폼: ${state.config.platform}
- 기술 스택: ${state.config.stack}

작업:
1. 같은 도메인의 경쟁 서비스/앱 패턴을 짧게 정리한다.
2. 장점/단점/참고할 UX 패턴을 간단히 정리한다.
3. 결과를 ${PATHS.benchmark} 에 저장한다.
4. 웹 실측이 불가능하면 문서에 "웹 실측 없음"을 명시하고 일반 패턴 기준으로 작성한다.

반드시 파일 저장까지 수행하고, 스키마에 맞춰 결과만 반환해.`;
}

function buildPlannerDraftPrompt(state) {
  return `요구사항:
${state.request}

참고 파일:
- project-config: ${PATHS.projectConfig}
- benchmark: ${PATHS.benchmark}
- planning doc 저장 경로: ${PATHS.planningDoc}

루프 A-1 작업:
- 기획서 작성
- Penpot에 wf_* / desc_* 생성
- 각 화면 상태와 variant 반영

반드시 planner 역할 규칙을 따르고, 파일/Board 생성 후 스키마에 맞춰 결과만 반환해.`;
}

function buildDesignerReviewPrompt(state) {
  return `루프 A-1 UX 리뷰다.

참고:
- project-config: ${PATHS.projectConfig}
- planning doc: ${PATHS.planningDoc}
- review 저장 경로: ${PATHS.designerReview}

wf_* / desc_*를 보고 UX 리뷰를 수행해.
개선 필요 여부를 판단하고 파일 저장 후 스키마대로만 응답해.`;
}

function buildPlannerRevisionPrompt(state, issues, loopName) {
  return `${loopName} 수정 요청이다.

참고:
- project-config: ${PATHS.projectConfig}
- planning doc: ${PATHS.planningDoc}
- issues:
${JSON.stringify(issues, null, 2)}

기획서와 필요 시 wf_* / desc_*를 수정하고 결과를 스키마에 맞춰 반환해.`;
}

function buildDesignerRescorePrompt(state) {
  return `루프 A-2 재검토다.

참고:
- project-config: ${PATHS.projectConfig}
- planning doc: ${PATHS.planningDoc}
- review file: ${PATHS.designerReview}

수정된 기획서 + wf_* + desc_*를 재검토하고 점수와 남은 이슈를 스키마에 맞춰 반환해.`;
}

function buildDesignerDesignPrompt(state, reasonText) {
  return `${reasonText}

참고:
- project-config: ${PATHS.projectConfig}
- planning doc: ${PATHS.planningDoc}

wf_* / desc_*를 기준으로 design_*를 생성하거나 재동기화해.
필요 없는 Board는 건드리지 말고, 영향을 받은 design_*만 처리한 뒤 스키마에 맞춰 결과를 반환해.`;
}

function buildDeveloperReviewPrompt(state) {
  return `루프 B 기술 검토다.

참고:
- project-config: ${PATHS.projectConfig}
- planning doc: ${PATHS.planningDoc}
- 결과 저장 경로: ${PATHS.techReview}

기획서 + wf_* + desc_* + design_*를 확인하고 기술 검토 결과를 파일에 저장한 뒤 스키마에 맞춰 반환해.`;
}

function buildQaReviewPrompt(state) {
  return `루프 B QA 기획 검토다.

참고:
- project-config: ${PATHS.projectConfig}
- planning doc: ${PATHS.planningDoc}
- 결과 저장 경로: ${PATHS.qaReview}

기획서 + wf_* + desc_* + design_*를 확인하고 QA 관점 기획 검토 결과를 파일에 저장한 뒤 스키마에 맞춰 반환해.`;
}

function buildPlannerSynthesisPrompt(state) {
  return `루프 B 종합 정리다.

참고:
- project-config: ${PATHS.projectConfig}
- planning doc: ${PATHS.planningDoc}
- developer review: ${PATHS.techReview}
- qa review: ${PATHS.qaReview}

개발자와 QA 의견을 종합해 기획서를 최종 수정하고, 필요 시 wf_* / desc_*를 수정해.
반드시 아래 정보를 판단해서 스키마에 맞춰 반환해:
- score
- functional_change
- wf_desc_changed
- changed_screen_ids`;
}

function buildDeveloperBuildPrompt(state, contextLabel, issues) {
  return `${contextLabel}

참고:
- project-config: ${PATHS.projectConfig}
- planning doc: ${PATHS.planningDoc}
- frontend 저장 경로: ${PATHS.development}
- server 저장 경로: ${PATHS.server}
${issues ? `- issues:\n${JSON.stringify(issues, null, 2)}` : ''}

wf_* + desc_* + design_*를 참조하여 개발을 수행하고 스키마에 맞춰 결과를 반환해.`;
}

function buildQaTcPrompt(state) {
  return `루프 C 테스트케이스 작성이다.

참고:
- project-config: ${PATHS.projectConfig}
- planning doc: ${PATHS.planningDoc}
- testcase 저장 경로: ${PATHS.testcases}

wf_* + desc_* + design_*를 확인해 프론트/API 테스트케이스를 작성하고 스키마에 맞춰 반환해.`;
}

function buildQaVerificationPrompt(state, issues, turn) {
  return `루프 D QA 검증 턴 ${turn}이다.

참고:
- project-config: ${PATHS.projectConfig}
- planning doc: ${PATHS.planningDoc}
- testcase: ${PATHS.testcases}
- 결과물 경로: ${PATHS.development}, ${PATHS.server}
- 결과 저장 경로: ${PATHS.qaVerification}
${issues ? `- 이전 이슈:\n${JSON.stringify(issues, null, 2)}` : ''}

기획서 + wf_* + desc_* + design_* + 결과물을 기준으로 QA 검증을 수행하고 스키마에 맞춰 반환해.`;
}

function buildTesterVerificationPrompt(state, issues, turn) {
  return `루프 D 테스터 검증 턴 ${turn}이다.

참고:
- project-config: ${PATHS.projectConfig}
- planning doc: ${PATHS.planningDoc}
- testcase: ${PATHS.testcases}
- 결과물 경로: ${PATHS.development}, ${PATHS.server}
- 결과 저장 경로: ${PATHS.testerVerification}
${issues ? `- 이전 이슈:\n${JSON.stringify(issues, null, 2)}` : ''}

기획서 + wf_* + desc_* + design_*를 기준으로 Playwright 검증을 수행하고 스키마에 맞춰 반환해.`;
}

function buildDesignerFixPrompt(state, issues) {
  return `루프 D 화면 문제 수정이다.

참고:
- project-config: ${PATHS.projectConfig}
- planning doc: ${PATHS.planningDoc}
- 이슈:
${JSON.stringify(issues, null, 2)}

디자인 관련 화면 문제를 Penpot design_*에 반영하고 스키마에 맞춰 결과를 반환해.`;
}

function buildSecretaryPrompt(state, totalDurationMs) {
  const tokenTotals = sumTokens(state.agentStats);
  const payload = {
    request: state.request,
    config: state.config,
    durationMinutes: Number((totalDurationMs / 60000).toFixed(2)),
    stage: state.stage,
    artifacts: state.artifacts,
    screenIds: Array.from(state.penpot.screenIds),
    wfDescScreens: Array.from(state.penpot.wfDescScreens),
    designScreens: Array.from(state.penpot.designScreens),
    issues: state.issues,
    agentStats: state.agentStats,
    tokenTotals,
  };

  return `작업 완료 정리 요청이다.

최종 보고서는 ${PATHS.finalReport} 에 저장한다.
아래 JSON 데이터를 기반으로 secretary 규칙에 따라 보고서를 작성하고, 스키마에 맞춰 결과를 반환해.

${JSON.stringify(payload, null, 2)}`;
}

function routeVerificationIssues(qaIssues, testerIssues) {
  const all = normalizeIssues([...qaIssues, ...testerIssues]);
  const categories = collectIssueCategories(all);
  if (categories.has('기획 문제')) {
    return { action: 'planner', issues: all };
  }
  if (categories.has('화면 문제')) {
    return { action: 'designer', issues: all };
  }
  return { action: 'developer', issues: all };
}

async function runHarness(args) {
  ensureWorkspaceDirs();
  const request = readRequest(args);
  const config = bootstrapProjectConfig(args, request);
  if (args['max-loops']) config.maxLoops = toInt(args['max-loops'], config.maxLoops);
  if (args['pass-score']) config.passScore = toInt(args['pass-score'], config.passScore);

  const preflight = await runPreflight({ skipLlmPing: false });
  printPreflight(preflight);
  if (!preflight.ok) {
    throw new Error('Preflight 실패로 하네스 실행을 중단합니다.');
  }

  const state = buildRunState(request, config);
  const dangerous = Boolean(args['dangerously-skip-permissions']);

  console.log('\n[A] Benchmark');
  await callHarnessModel(buildBenchmarkPrompt(state), benchmarkSchema(), state, {
    permissionMode: 'acceptEdits',
    dangerouslySkipPermissions: dangerous,
  });

  console.log('[A] Planner draft');
  const draft = await callAgent('planner', buildPlannerDraftPrompt(state), plannerDraftSchema(), state, {
    dangerouslySkipPermissions: dangerous,
  });
  mergeScreenIds(state, draft.screen_ids, 'wfdesc');

  console.log('[A] Designer UX review');
  let review = await callAgent('designer', buildDesignerReviewPrompt(state), designerReviewSchema(), state, {
    dangerouslySkipPermissions: dangerous,
  });

  let aTurn = 1;
  while (review.improvement_needed && aTurn <= config.maxLoops) {
    console.log(`[A-2] Revision turn ${aTurn}`);
    await callAgent(
      'planner',
      buildPlannerRevisionPrompt(state, review.issues, '[루프 A-2]'),
      plannerDraftSchema(),
      state,
      { dangerouslySkipPermissions: dangerous },
    );
    review = await callAgent('designer', buildDesignerRescorePrompt(state), designerScoreSchema(), state, {
      dangerouslySkipPermissions: dangerous,
    });
    state.stage.aTurns = aTurn;
    state.stage.scores.a2 = review.score;
    if (review.score >= config.passScore) {
      break;
    }
    aTurn += 1;
  }

  console.log('[A-3] Designer design build');
  const design = await callAgent(
    'designer',
    buildDesignerDesignPrompt(state, '루프 A-3 디자인 생성이다.'),
    designerBuildSchema(),
    state,
    { dangerouslySkipPermissions: dangerous },
  );
  mergeScreenIds(state, design.design_screen_ids, 'design');

  let bTurn = 1;
  let bSummary = null;
  while (bTurn <= config.maxLoops) {
    console.log(`[B] Review turn ${bTurn}`);
    await callAgent('developer', buildDeveloperReviewPrompt(state), reviewSchema(), state, {
      dangerouslySkipPermissions: dangerous,
    });
    await callAgent('qa', buildQaReviewPrompt(state), reviewSchema(), state, {
      dangerouslySkipPermissions: dangerous,
    });
    bSummary = await callAgent('planner', buildPlannerSynthesisPrompt(state), plannerReviewSchema(), state, {
      dangerouslySkipPermissions: dangerous,
    });
    state.stage.bTurns = bTurn;
    state.stage.scores.b = bSummary.score;
    mergeScreenIds(state, bSummary.changed_screen_ids, 'wfdesc');

    if (bSummary.wf_desc_changed) {
      const sync = await callAgent(
        'designer',
        buildDesignerDesignPrompt(state, '루프 B 변경 반영으로 design_* 재동기화다.'),
        designerBuildSchema(),
        state,
        { dangerouslySkipPermissions: dangerous },
      );
      mergeScreenIds(state, sync.design_screen_ids, 'design');
      mergeScreenIds(state, sync.synced_screen_ids, 'design');
    }

    if (bSummary.functional_change) {
      await callAgent(
        'developer',
        '루프 B 기획 기능 변경 재확인이다. 변경된 기획이 기술적으로 문제 없는지 확인하고 스키마에 맞춰 반환해.',
        reviewSchema(),
        state,
        { dangerouslySkipPermissions: dangerous },
      );
    }

    if (bSummary.score >= config.passScore) {
      break;
    }
    bTurn += 1;
  }

  console.log('[C] Development + testcase generation');
  await callAgent(
    'developer',
    buildDeveloperBuildPrompt(state, '루프 C 개발 요청이다.', null),
    developerBuildSchema(),
    state,
    { dangerouslySkipPermissions: dangerous },
  );
  await callAgent('qa', buildQaTcPrompt(state), qaTestcaseSchema(), state, {
    dangerouslySkipPermissions: dangerous,
  });

  let dTurn = 1;
  let lastQa = null;
  let lastTester = null;
  let previousIssues = [];

  while (dTurn <= config.maxLoops) {
    console.log(`[D] Verification turn ${dTurn}`);
    lastQa = await callAgent('qa', buildQaVerificationPrompt(state, previousIssues, dTurn), verificationSchema(), state, {
      dangerouslySkipPermissions: dangerous,
    });
    lastTester = await callAgent(
      'tester',
      buildTesterVerificationPrompt(state, previousIssues, dTurn),
      verificationSchema(),
      state,
      { dangerouslySkipPermissions: dangerous },
    );

    state.stage.dTurns = dTurn;
    state.stage.scores.dQa = lastQa.score;
    state.stage.scores.dTester = lastTester.score;
    state.issues = normalizeIssues([...lastQa.issues, ...lastTester.issues]);

    const gateScore = Math.min(lastQa.score, lastTester.score);
    if (gateScore >= config.passScore) {
      break;
    }

    const routed = routeVerificationIssues(lastQa.issues, lastTester.issues);
    previousIssues = routed.issues;

    if (routed.action === 'planner') {
      const plannerFix = await callAgent(
        'planner',
        buildPlannerRevisionPrompt(state, routed.issues, '[루프 D] 기획 문제 수정'),
        plannerReviewSchema(),
        state,
        { dangerouslySkipPermissions: dangerous },
      );
      mergeScreenIds(state, plannerFix.changed_screen_ids, 'wfdesc');
      if (plannerFix.wf_desc_changed) {
        const sync = await callAgent(
          'designer',
          buildDesignerDesignPrompt(state, '루프 D 기획 변경 반영으로 design_* 재동기화다.'),
          designerBuildSchema(),
          state,
          { dangerouslySkipPermissions: dangerous },
        );
        mergeScreenIds(state, sync.design_screen_ids, 'design');
      }
      await callAgent(
        'developer',
        buildDeveloperBuildPrompt(state, '루프 D 기획 문제 반영 후 재개발이다.', routed.issues),
        developerBuildSchema(),
        state,
        { dangerouslySkipPermissions: dangerous },
      );
      await callAgent('qa', buildQaTcPrompt(state), qaTestcaseSchema(), state, {
        dangerouslySkipPermissions: dangerous,
      });
    } else if (routed.action === 'designer') {
      const screenFix = await callAgent('designer', buildDesignerFixPrompt(state, routed.issues), designerBuildSchema(), state, {
        dangerouslySkipPermissions: dangerous,
      });
      mergeScreenIds(state, screenFix.design_screen_ids, 'design');
      await callAgent(
        'planner',
        '루프 D 화면 문제 수정 확인이다. design_* 수정이 기획 구조와 충돌하는지 짧게 확인하고 스키마에 맞춰 반환해.',
        plannerReviewSchema(),
        state,
        { dangerouslySkipPermissions: dangerous },
      );
      await callAgent(
        'developer',
        buildDeveloperBuildPrompt(state, '루프 D 화면 문제 반영 후 재개발이다.', routed.issues),
        developerBuildSchema(),
        state,
        { dangerouslySkipPermissions: dangerous },
      );
    } else {
      await callAgent(
        'developer',
        buildDeveloperBuildPrompt(state, '루프 D 동작 오류 수정이다.', routed.issues),
        developerBuildSchema(),
        state,
        { dangerouslySkipPermissions: dangerous },
      );
    }

    dTurn += 1;
  }

  console.log('[Final] Secretary report');
  const totalDurationMs = Date.now() - new Date(state.startedAt).getTime();
  const finalReport = await callAgent(
    'secretary',
    buildSecretaryPrompt(state, totalDurationMs),
    secretarySchema(),
    state,
    { dangerouslySkipPermissions: dangerous },
  );

  return {
    ok: true,
    summary: finalReport.summary,
    finalReportPath: finalReport.final_report_path,
    state,
  };
}

function printSimulation(args, request, config) {
  console.log('Simulation');
  console.log(`- request: ${request}`);
  console.log(`- project: ${config.name}`);
  console.log(`- platform: ${config.platform}`);
  console.log(`- stack: ${config.stack}`);
  console.log(`- max loops: ${config.maxLoops}`);
  console.log(`- pass score: ${config.passScore}`);
  console.log('');
  console.log('Planned stages:');
  console.log('1. Preflight (claude auth, agents, Penpot ports, permissions)');
  console.log('2. Benchmark -> workspace/planning/A-benchmark.md');
  console.log('3. Loop A: planner draft -> designer UX review -> planner/designer iteration -> designer design');
  console.log('4. Loop B: developer review + qa review -> planner synthesis -> conditional design resync');
  console.log('5. Loop C: developer build + qa testcase generation');
  console.log('6. Loop D: qa verification + tester verification -> conditional fix routing');
  console.log('7. Secretary final report -> workspace/reports/final-report.md');
  console.log('');
  console.log(`dangerously skip permissions: ${Boolean(args['dangerously-skip-permissions'])}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0];

  if (!command || ['-h', '--help', 'help'].includes(command)) {
    printUsage();
    return;
  }

  try {
    if (command === 'preflight') {
      const report = await runPreflight({ skipLlmPing: Boolean(args['skip-llm-ping']) });
      printPreflight(report);
      process.exitCode = report.ok ? 0 : 1;
      return;
    }

    const request = readRequest(args);
    const config = bootstrapProjectConfig(args, request);
    if (args['max-loops']) config.maxLoops = toInt(args['max-loops'], config.maxLoops);
    if (args['pass-score']) config.passScore = toInt(args['pass-score'], config.passScore);

    if (command === 'simulate') {
      printSimulation(args, request, config);
      return;
    }

    if (command === 'run') {
      const result = await runHarness(args);
      console.log('');
      console.log('Harness run completed');
      console.log(`- final report: ${result.finalReportPath}`);
      console.log(`- summary: ${result.summary}`);
      return;
    }

    throw new Error(`알 수 없는 명령: ${command}`);
  } catch (error) {
    console.error(error.message || String(error));
    process.exitCode = 1;
  }
}

main();
