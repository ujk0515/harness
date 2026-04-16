# 2026-04-16 Subagent Gate Rewire Summary

## 배경

기존 하네스 게이트는 `TaskCreated`, `TaskCompleted`, `TeammateIdle` 훅을 전제로 설계되어 있었다.  
실측 결과 현재 하네스의 실제 호출 방식은 `Agent + subagent_type`이며, 이 패턴에서는 `Task*` 훅이 발화하지 않고 `SubagentStart`, `SubagentStop`만 발화했다.

즉, 기존 설계는 방향은 맞았지만 **현재 런타임과 배선이 어긋난 상태**였다.

## 이번 변경의 목표

1. 실제 런타임에 맞는 훅으로 게이트 재배선
2. 선행 ticket 없는 다음 단계 진입 차단
3. Agent 병렬 호출 race 차단
4. 체크리스트를 `batch/item` 단위의 현재 시도 산출물 기준으로 강화
5. 반복되는 자가보고 지시를 줄이고 체크 정본을 단일 문서로 모으기

## 최종 게이트 구조

### 1. 입구 차단: `PreToolUse(Agent)`

- Agent 호출 직전 `tool_input.description`을 파싱한다.
- 형식은 반드시 `[BatchN][RN][role] subject` 여야 한다.
- 여기서 `batch_id`, `item_id`, `role`을 추출한다.
- 선행 역할의 `done ticket` 또는 `skip ticket`이 없으면 호출을 차단한다.
- 이미 열린 dispatch가 있으면 두 번째 Agent 호출도 차단한다.
- 다만 차단 전에 안전한 자동 복구를 먼저 시도한다.
  - `done/skip ticket`이 이미 있으면 open dispatch를 `completed`로 정리
  - `SubagentStop` 로그가 있는데 dispatch만 남아 있으면 validator가 종료 검증을 재실행
  - `agent_id`도 없는 오래된 pending dispatch는 stale로 보고 `rejected` 처리
- 통과하면 `.dispatch.json`에 pending dispatch를 기록한다.

### 2. 매핑 다리: `SubagentStart`

- 실제 subagent가 뜨면 `agent_id`를 받는다.
- 가장 최근 pending dispatch에 `agent_id`를 결합한다.
- role 상태를 `in_progress`로 올린다.

### 3. 출구 차단: `SubagentStop`

- 종료 시 `agent_id`로 dispatch를 역조회한다.
- 해당 `batch/item/role`의 체크리스트를 실행한다.
- 전부 통과하면 `done ticket` 발급
- 하나라도 실패하면 `rejected ticket` 기록 + 완료 차단
- retry limit 초과 시 에스컬레이션 메시지로 닫는다.

## dispatch 직렬화

기존 설계의 약점은 "한 메시지에서 Agent가 두 번 동시에 호출되면 race가 난다"는 점이었다.

이번에 아래 두 파일을 도입해 코드 레벨로 막았다.

- `workspace/planning/.dispatch.json`
- `workspace/planning/.dispatch.lock`

동작:

- `PreToolUse(Agent)`에서 lock을 잡고 dispatch를 검사
- open dispatch가 있으면 즉시 차단
- 없으면 pending dispatch 생성
- `SubagentStart` / `SubagentStop`도 같은 lock을 통해 dispatch를 읽고 갱신

즉, 현재 구조에서는 **한 번에 하나의 Agent만 in-flight** 할 수 있다.

## 체크리스트 강화

이전 체크는 `파일 존재` 중심이라 false positive 위험이 있었다.  
예전 보고서 파일이 남아 있어도 통과할 수 있었기 때문이다.

이번에는 체크 기준을 아래로 바꿨다.

- claim 파일이 **이번 시도 이후 갱신되었는지**
- evidence 디렉터리에 **이번 시도 산출물이 있는지**
- shared report가 **이번 시도 이후 갱신되었는지**
- claim 안의 `covered_items`, `developer_targets` 같은 필수 구조값이 현재 item과 맞는지
- `request-state.json`의 role status가 최종적으로 `done`인지

핵심 기준 시간은 dispatch 생성 시각(`dispatch_created_at`)이다.

## 수정한 파일

- `.claude/settings.json`
- `.claude/scripts/validator.js`
- `workflow/process.md`
- `workflow/request-state.schema.json`
- `workflow/checklists/task-gate-checklists.json`
- `workflow/checklists/task-gate-checklists.md`
- `.claude/agents/planner.md`
- `.claude/agents/designer.md`
- `.claude/agents/developer.md`
- `.claude/agents/qa.md`
- `.claude/agents/tester.md`
- `.claude/agents/secretary.md`

## 구현 상세

### `.claude/settings.json`

- `TaskCreated`, `TaskCompleted`, `TeammateIdle` 주 게이트 제거
- `PreToolUse` matcher `Agent` 추가
- `SubagentStart`, `SubagentStop`를 실제 validator 핸들러로 연결

### `.claude/scripts/validator.js`

추가/변경한 핵심 모드:

- `pretool-agent`
- `subagent-start`
- `subagent-stop`
- `hook-log`
- 기존 `check` 확장
  - `dir_has_entries_after`
  - `json_array_contains`

추가한 핵심 개념:

- `request-state.json` schema version `1.2.0-draft`
- dispatch state (`.dispatch.json`)
- dispatch lock (`.dispatch.lock`)
- open dispatch 차단
- dispatch 기반 attempt / ticket / rejected 처리

### `workflow/process.md`

- 게이트 설명을 `Task*` 기준에서 `PreToolUse(Agent) + SubagentStart + SubagentStop`으로 교체
- `description` 규칙을 공식화
- dispatch sidechannel / lock / 직렬화 규칙 추가

### `workflow/checklists/*`

- 역할별 체크를 `batch/item + 이번 시도 기준`으로 재작성
- 문서형 md와 실행형 json을 분리 유지

### `.claude/agents/*.md`

- 중복된 상세 체크 5줄씩 반복하던 자가 점검 문구를 줄였다.
- 각 역할 문서에는
  - claim / evidence / ticket 규칙
  - "이번 시도에서 갱신된 파일만 통과"
  - 체크 정본은 checklist 문서
만 남기고, 상세 항목은 checklist 문서 단일 정본으로 모았다.

## 검증한 내용

로컬 시뮬레이션으로 아래를 확인했다.

1. `PreToolUse(Agent)` 성공 후 `SubagentStart`, `SubagentStop`를 거치면 `planner.done.json`이 실제 발급된다.
2. 체크 산출물이 dispatch 생성 시각보다 오래되면 `SubagentStop`가 차단된다.
3. open dispatch가 있는 상태에서 두 번째 Agent를 호출하면 `Another Agent dispatch is already in flight`로 차단된다.
4. `validator.js` 문법 체크 통과
5. `settings.json`, checklist json, schema json 파싱 통과
6. 구버전 `request-state.json` / 구버전 단일 객체 `.dispatch.json`도 자동 보정된다.
7. `SubagentStop` 로그는 있는데 dispatch가 열린 채 남은 경우, 다음 `PreToolUse`에서 종료 검증을 재실행해 자동 복구된다.

## 아직 남은 운영 확인

코드/문서/시뮬레이션 기준 구현은 끝났다.  
다만 실제 Claude 세션에서 한 번은 더 봐야 한다.

남은 확인 1개:

- 실제 하네스 세션에서 `PreToolUse(Agent) -> SubagentStart -> SubagentStop`가 예상 순서대로 발화하는지

이건 로컬 시뮬레이션으로는 충분히 확인했지만, 실세션 1회 스모크 테스트는 별도로 보는 것이 안전하다.

## 결론

이번 변경으로 하네스 게이트는 더 이상 "문서상 권고"가 아니라, **현재 Agent 호출 런타임에 맞춘 실제 차단 구조**가 되었다.

정리하면:

- 배선 수정 완료
- race 차단 완료
- 체크 기준 강화 완료
- 매뉴얼 중복 정리 완료
- 남은 것은 실세션 스모크 테스트 1회뿐
