#!/usr/bin/env node
// SessionStart hook: inject 시작 흐름 + 사전 검토 단계 context into Claude's system prompt
// so the harness always performs planning pre-review when the user submits a request.

const fs = require('fs');
const path = require('path');

const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const processPath = path.join(projectDir, 'workflow', 'process.md');

let content;
try {
  content = fs.readFileSync(processPath, 'utf8');
} catch (err) {
  process.stderr.write(`[session-start] cannot read process.md: ${err.message}\n`);
  process.exit(0);
}

// V38 대응: lessons-learned.md stub 자동 생성 (없을 때만)
try {
  const lessonsPath = path.join(projectDir, 'workspace', 'lessons-learned.md');
  if (!fs.existsSync(lessonsPath)) {
    fs.mkdirSync(path.dirname(lessonsPath), { recursive: true });
    fs.writeFileSync(
      lessonsPath,
      '# Lessons Learned\n\n신규 프로젝트 — 아직 누적된 교훈 없음. secretary 가 루프 종료 시 append 한다.\n'
    );
  }
} catch (e) {
  process.stderr.write(`[session-start] lessons-learned stub failed: ${e.message}\n`);
}

const lines = content.split('\n');

function sliceSection(startHeading, endHeadings) {
  const startIdx = lines.findIndex((l) => l.trim() === startHeading);
  if (startIdx === -1) return '';
  let endIdx = lines.length;
  for (let i = startIdx + 1; i < lines.length; i++) {
    if (endHeadings.some((h) => lines[i].trim() === h)) {
      endIdx = i;
      break;
    }
  }
  return lines.slice(startIdx, endIdx).join('\n').trim();
}

const projectStartRules = sliceSection('## 프로젝트 시작 규칙', ['## 산출물 포맷 규칙', '## 작업 보드 관리 규칙', '## Penpot 준비 가드', '# 하네스 동작 규칙']);

const reminder = [
  '# 하네스 세션 시작 규칙 (자동 주입)',
  '',
  '사용자가 자연어로 "무엇을 만들어줘" / 기획 내용을 전달하면, **에이전트를 호출하기 전에 반드시 아래 시작 흐름을 먼저 수행**한다.',
  '',
  '- 필수 항목(플랫폼, 기술 스택)이 빠졌으면 → 누락 항목만 물어보고 `hold-open missing_requirements`로 기록 후 멈춘다.',
  '- 필수 항목이 갖춰지면 → **사전 검토 단계**를 수행한다. (에이전트 호출 금지, 하네스가 직접 판단)',
  '  - 실현 가능성 / 모호한 부분 / 스코프 확인',
  '  - 기능 단위 난이도 표(S/M/H/X) 작성',
  '  - 구체적 해결책은 제시하지 않는다. 문제점 + "이건 어떻게 할 건지" 질문만 던진다.',
  '- 사전 검토 결과 분기:',
  '  - **질문할 거리가 있으면** → 난이도 표 + 질문을 전달하고, `hold-open planning_clarification` 기록 후 **사용자 답변이 올 때까지 멈춘다. 자동 진행 금지.**',
  '  - **질문할 거리가 없으면** → "특이사항 없음, 진행합니다"라고 한 줄 알리고 **사용자 확인 없이 바로 다음 단계로 자동 진행.** (`hold-open` 걸지 않음)',
  '- 사용자가 답하면(또는 자동 진행이면) → 요청 분해 + 작업 보드 생성 → 벤치마킹 → 루프 A 시작.',
  '',
  '이 단계를 생략하고 바로 에이전트를 호출하거나 작업 보드를 만들면 안 된다.',
  '',
  '---',
  '',
  '## 루프별 필수 단계 요약 (축약 금지, 단계 병합 금지)',
  '',
  '### 기획자 진입 직전까지',
  '1. 필수 항목 확인 (플랫폼 / 기술 스택)',
  '2. 사전 검토 단계 (실현 가능성 / 모호 / 스코프 / 난이도 표 → 질문 있음: hold-open, 없음: 자동 진행)',
  '3. 사용자 답변 반영 / hold 해제',
  '4. 요청 분해 + 작업 보드 생성 (Batch{N} 번호 + R1, R2... item 쪼개기 + 필수 컬럼 기록)',
  '5. 경쟁사 벤치마킹 (하네스가 직접 웹 검색 → workspace/planning/A-benchmark.md)',
  '6. 기획자 호출 (루프 A-1 진입)',
  '',
  '### 기획자(planner) 호출 시 dispatch prompt 필수 요소',
  '- description 형식: `[Batch{N}][R{M}][planner] plan:` 또는 `revise:`',
  '- prompt 에 반드시 포함:',
  '  - "시작 순서 고정" 문구 + 1)~6) 번호 순서',
  '  - "사용자 원문:" 헤더 뒤에 사용자가 최초로 입력한 자연어 요청 원문을 **삼중 백틱 fenced block** 으로 감싸서 삽입 (prompt injection 방지). 예: ```user_raw\\n<원문>\\n```',
  '  - "사전 검토 Q&A:" 헤더 뒤에 사전 검토 단계에서 나온 모든 질문과 사용자 답변을 `Q: ... / A: ...` 형식으로 나열 (질문 없었으면 "질문 없음")',
  '  - "boards-snapshot" — 영향도 분석 시 penpot.execute_code 로 Board 목록 수집 강제',
  '  - "action_rationale" — 판별 근거 기록 강제',
  '  - "planning-doc-sections.md" — 기획서 표준 헤딩 참조 강제',
  '  1) request-workboard.md + project-config.md + A-benchmark.md + lessons-learned.md + planning-doc-sections.md + sequence.md + planner-penpot-reference.md 읽기',
  '  2) 기존 screen_id / wf_* / desc_* / design_* 영향도 분석 + boards-snapshot.json 저장',
  '  3) reference_flows / expected_user_path / critical_states / avoid_patterns 4개 필드 각 최소 2개 채우기',
  '  4) UPDATE / CREATE / UPDATE+CREATE / NO_CHANGE 판별 + action_rationale 기록',
  '  5) 기획서(md, 표준 8개 섹션) 작성 + 사전 검토 답변 반영 → wf_* / desc_* 생성 → export_shape 확인',
  '  6) gap check + 디자이너 가이드 + claim(read_log/action_rationale/pre_review_applied/user_raw_request_quoted/planning_doc_sections 포함) + 자가점검',
  '- 위 단계 / 요소 중 하나라도 prompt 에서 누락되면 validator 가 차단한다.',
  '',
  '### 메인 하네스 자체 체크 (작업 보드 생성 직후, planner 호출 직전)',
  '- `node .claude/scripts/validator.js ensure-state-item Batch{N} R{M} "<title>"` 필수 실행. 누락 시 PreToolUse 훅이 planner 호출 차단.',
  '- 벤치마킹 파일(A-benchmark.md)은 최소 400바이트 + 섹션 2개 이상 + 각 섹션 본문 80자 이상 + 각 섹션에 장점/강점 키워드와 회피/단점 키워드 모두 포함. placeholder(TBD/TODO/lorem/추후 작성/미작성) 토큰 금지. 미달 시 차단.',
  '- 작업 보드 `요청 항목` 란에 사용자 원문의 핵심 문장을 **인용(직접 복붙)** 해 포함시킨다 (요약만 적지 말 것).',
  '- **Penpot 선검사 필수:** planner/designer apply dispatch 전에 `mcp__penpot__high_level_overview` 를 한 번 호출하고, 결과를 `workspace/planning/.penpot-status.json` 에 `{ "reachable": true, "checked_at": "<ISO>", "file_id": "<id>" }` 로 기록한다. 실패 시 `reachable: false` 기록 + `hold-open penpot_unavailable`. 상태 파일이 없거나 30분 초과 stale 이면 validator 가 dispatch 를 차단한다. `project-config.md` 에 `penpot: disabled` 가 있으면 선검사 건너뜀.',
  '- **메인 하네스 셀프 체크리스트 필독:** `workflow/checklists/main-harness-self-check.md` 를 읽고 Phase 0~6 을 순서대로 통과시킨다. 체크 실패 항목이 있으면 해당 Phase 로 되돌아가 보완한 뒤에만 다음 단계로 간다.',
  '',
  '### 루프 A (기획 + 디자인)',
  '- A-1: planner `plan:` → designer `review:` (UX 리뷰)',
  '- A-2: (리뷰 지적 있으면) planner `revise:` → designer `review:` 재리뷰, 통과까지 반복',
  '- A-3: designer `apply:` (실제 design_* 생성)',
  '',
  '### 루프 B (기획 리뷰 게이트)',
  '- developer `review:` → qa `review:` → planner `revise:` (수긍/반박/보완/보류 판단 반영) → designer `apply:` (재동기화)',
  '',
  '### 루프 C (구현 + 테스트케이스)',
  '- developer `implement:` + qa `tc:` 동시 진행',
  '',
  '### 루프 D (검증)',
  '- qa `verify:` + tester 호출 (둘 다 필수, tester 생략 금지)',
  '- 이슈 발견 시 [분류] 기준으로 자동 라우팅 (기획 문제 → planner, 화면 문제 → designer, 동작 오류 → developer)',
  '- 수정 후 재검증 반복',
  '',
  '### 루프 간 전환',
  '- 루프 전환 시 사용자 확인 금지. 즉시 다음 루프 시작.',
  '- 최종 완료 후 secretary 정리 → 사용자에게 1회 보고.',
  '',
  '### 루프 A-1 종료 후 전이 규칙 (planner plan: done 직후)',
  '- planner claim `designer_required = Y` → designer `review:` (루프 A-1 계속).',
  '- `designer_required = N` → 루프 A-1·A-2·A-3 전부 건너뛰고 루프 B 로 즉시 진입. `design_reason` 이 빈 문자열/한 단어면 planner 재호출.',
  '- designer `review:` done 이후 `workspace/design/A-uiux-review.md` 에 지적이 있으면 루프 A-2 (planner `revise:`), 지적 없음이 명시되면 바로 루프 A-3 (designer `apply:`).',
  '- 루프 A-3 done 이후에는 루프 A-1/A-2 로 되돌아가지 않는다 (재진입은 각 dispatch retry_limit 내에서만).',
  '',
  '### 루프 B revise 전이 규칙',
  '- `workspace/reviews/{batch}/{item}/developer-review.md` 와 `qa-review.md` 가 모두 존재할 때만 planner `revise:` dispatch 가능.',
  '- Loop B revise 통과 시 validator 가 `reviewGate.status = awaiting_design_sync` 로 전이 → designer `apply:` 재동기화 호출.',
  '',
  '### item 직렬 규칙 (Batch 안)',
  '- 하네스는 **item 단위 직렬** 만 허용. R1 의 모든 루프(A-1~A-3, B, C, D, E) 가 끝나기 전에 R2 의 planner dispatch 를 시작하지 않는다.',
  '- R{M} secretary done 티켓 발급 확인 → R{M+1} `ensure-state-item` 실행 → R{M+1} planner 호출 순서를 지킨다.',
  '- 여러 item 을 한 Batch 안에서 병렬 진행 금지, 한 dispatch 에 둘 이상 item_id 섞기 금지.',
  '',
  '---',
  '',
  '## process.md 원문 발췌 (프로젝트 시작 규칙)',
  '',
  projectStartRules,
].join('\n');

const payload = {
  hookSpecificOutput: {
    hookEventName: 'SessionStart',
    additionalContext: reminder,
  },
};

process.stdout.write(JSON.stringify(payload));
