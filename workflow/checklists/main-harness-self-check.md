# 메인 하네스 셀프 체크리스트

사용자 요청을 받은 뒤 planner 첫 호출 **전**에 메인 하네스(Claude 본인)가
아래 항목을 하나씩 셀프 확인한다. 답이 "아니오"인 항목이 하나라도 있으면
해당 단계로 돌아가 보완한 후에만 다음으로 진행한다.

## Phase 0 — 입력 수집

- [ ] 사용자가 말한 플랫폼을 정확히 확인했는가? (모바일/웹/태블릿)
- [ ] 사용자가 말한 기술 스택을 정확히 확인했는가? (React/Vue/vanilla 등)
- [ ] 필수 항목이 빠졌다면 `hold-open missing_requirements` 기록했는가?

## Phase 1 — 사전 검토

- [ ] 난이도 표(S/M/H/X)를 **모든** 핵심 기능에 대해 작성했는가?
- [ ] 난이도 X 항목이 있으면 사용자에게 대안 질문을 던졌는가?
- [ ] 모호한 표현(예: "공유", "분석", "통계")을 그대로 넘기지 않고 질문 대상으로 식별했는가?
- [ ] 질문이 있었다면 `hold-open planning_clarification` 기록했는가?
- [ ] 질문이 없으면 "특이사항 없음, 진행합니다"라고 **명시적으로** 알렸는가? (암묵 진행 금지)
- [ ] 사용자 답변을 받은 뒤 `hold-resolve` 했는가?

## Phase 2 — 요청 분해

- [ ] Batch 번호를 새로 부여했는가? (이전 Batch 덮어쓰기 금지)
- [ ] 요청을 화면/기능 단위로 R1, R2... 로 쪼갰는가? (문장 단위 쪼개기 금지)
- [ ] 각 item 의 `요청 항목` 란에 사용자 원문 핵심 문장을 **인용** 형태로 포함시켰는가? (요약만 적지 말 것)
- [ ] `matched_screen_id` / `변경 유형` / `필수 에이전트` / `선행 조건` / `완료 조건` 컬럼을 모두 채웠는가?
- [ ] `developer` 가 필수인 항목은 `tester` 도 필수로 포함시켰는가? (tester 생략 금지)

## Phase 3 — State 초기화

- [ ] 각 item 마다 `node .claude/scripts/validator.js ensure-state-item Batch{N} R{M} "<title>"` 실행했는가?
- [ ] 초기화 없이 Agent 호출하지 않았는가? (PreToolUse 에서 차단됨)

## Phase 4 — 벤치마킹

- [ ] `workspace/planning/A-benchmark.md` 를 실제 웹 검색 결과로 채웠는가?
- [ ] 최소 2개 이상 경쟁 서비스를 섹션으로 분리했는가?
- [ ] 파일 크기 최소 400바이트 이상인가? (placeholder 금지)
- [ ] 각 섹션 본문이 80자 이상이고 **장점/강점** 키워드와 **회피/단점/주의/약점** 키워드를 둘 다 포함하는가?
- [ ] `TBD`, `TODO`, `lorem`, `placeholder`, `XXX`, `추후 작성`, `미작성` 토큰이 본문 어디에도 없는가?

## Phase 4.5 — Penpot 선검사

- [ ] `mcp__penpot__high_level_overview` 를 한 번 호출해 연결 가능 여부를 확인했는가?
- [ ] 결과를 `workspace/planning/.penpot-status.json` 에 `{ "reachable": true|false, "checked_at": "<ISO>", "file_id": "<id or null>" }` 로 기록했는가?
- [ ] `reachable = false` 인 경우 `hold-open penpot_unavailable` 로 기록하고 planner/designer dispatch 를 중단했는가?
- [ ] 상태 파일이 30분 이상 stale 이면 새로 ping 했는가? (validator 가 stale 차단)
- [ ] `project-config.md` 에 `penpot: disabled` 가 있으면 이 Phase 전체를 건너뛰어도 된다.

## Phase 5 — Planner 호출 직전

- [ ] dispatch description 이 `[Batch{N}][R{M}][planner] plan:` 또는 `revise:` 형식인가?
- [ ] prompt 에 "시작 순서 고정" + 1)~6) 번호 포함됐는가?
- [ ] prompt 에 "사용자 원문:" 헤더 + 사용자 최초 입력 자연어 원문 **그대로** 포함됐는가?
- [ ] prompt 에 "사전 검토 Q&A:" 헤더 + 모든 질문/답변 쌍 포함됐는가? (없으면 "질문 없음" 명시)
- [ ] prompt 에 "boards-snapshot", "action_rationale", "planning-doc-sections.md" 키워드 포함됐는가?
- [ ] 한 호출에 여러 item_id 를 섞지 않았는가? (한 호출 = 한 item_id)

## Phase 6 — 루프 전환 / 재호출

- [ ] planner 반환이 `completion_state = partial` 또는 `blocked` 면 다음 루프로 넘기지 않고 재호출했는가?
- [ ] `next-action` 이 `response_allowed = false` 인데 사용자에게 답하지 않았는가?
- [ ] 하드 스톱(planning_clarification / penpot_unavailable / retry_limit_exhausted) 외에는 사용자에게 중간 확인 묻지 않았는가?

### Phase 6.1 — 루프 A-1 종료 후 전이 결정

planner `plan:` done 티켓이 발급된 직후, 아래 분기를 순서대로 평가한다.

- [ ] planner claim 의 `designer_required` 를 읽었는가?
  - `Y` → 다음 단계는 **designer `review:` (루프 A-1 계속)**. `A-uiux-review.md` 를 작성하도록 designer 호출.
  - `N` → designer 우회. 루프 A-1·A-3 전부 건너뛰고 바로 **루프 B (developer/qa `review:`)** 로 진입. 이 경우 `design_reason` 이 claim 에 구체적으로 적혀 있어야 하며, 빈 문자열/한 단어면 planner 재호출.
- [ ] designer `review:` done 이후 `workspace/design/A-uiux-review.md` 파일이 존재하는가? 존재하고 비어 있지 않으면 **루프 A-2** (planner `revise:`) 로 재진입. 리뷰 지적 없음 명시만 있으면 **루프 A-3** (designer `apply:`) 로 바로 이동.
- [ ] 루프 A-3 designer `apply:` done 이후 **루프 B** 진입. 루프 A-1·A-2 를 되풀이 재진입 금지 (retry 는 각 dispatch 의 retry_limit 내에서만).

### Phase 6.2 — 루프 B revise 전이

- [ ] `workspace/reviews/{batch}/{item}/developer-review.md` 와 `qa-review.md` 가 **둘 다** 존재하는가? 하나라도 없으면 planner `revise:` dispatch 금지 (validator 가 차단하지만 셀프 차원에서 선확인).
- [ ] `reviewGate.status` 가 `open` 이고 `developer_review = done`, `qa_review = done` 인가? 아니면 이전 루프로 되돌아가 보완.
- [ ] Loop B revise 통과 후 `reviewGate.status = awaiting_design_sync` 로 전이됐으면 **designer `apply:` 재동기화** 호출.

### Phase 6.3 — item 간 진행 순서 (직렬 규칙)

- [ ] 현재 item(R{M}) 의 **모든 루프(A-1 ~ A-3 ~ B ~ C ~ D ~ E)** 가 끝나기 전에 다음 item(R{M+1}) 의 planner dispatch 를 시작하지 않았는가?
- [ ] 같은 Batch 안에서 item 들을 병렬로 돌리지 않았는가? (하네스는 **item 단위 직렬**만 허용 — Batch 단위 직렬 아님)
- [ ] R{M} 의 secretary done 티켓이 발급된 것을 확인한 뒤에야 R{M+1} 에 `ensure-state-item` 실행했는가?
- [ ] 한 dispatch 에 둘 이상의 `item_id` 를 섞지 않았는가? (이미 Phase 5 에서 검사했지만 전환 시점에도 재확인)

## 셀프 체크 실패 시

- 각 항목 "아니오"마다 아래를 수행:
  1. 어느 Phase 의 어느 항목에서 빠졌는지 짧게 명시
  2. 해당 Phase 로 되돌아가 보완
  3. 체크 통과 후에만 다음 Phase 로
- 반복 실패 시 `hold-open retry_limit_exhausted` 로 기록하고 사용자에게 상황 설명
