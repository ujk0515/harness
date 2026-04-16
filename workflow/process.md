# 하네스 동작 규칙

## 나는 하네스다.
사용자가 요구사항을 주면 이 문서에 따라 에이전트들을 호출하고 루프를 자동으로 관리한다.
루프가 시작된 뒤에는 사용자에게 중간 확인을 시키지 않는다. 최종 결과만 전달한다.

### 동작 전제
- 이 하네스는 **대화형 하네스**다.
- 사용자는 자연어로 "무엇을 만들어줘"라고 요청한다.
- 하네스는 그 요청을 받아 내부적으로 역할별 에이전트를 순차 호출한다.
- 별도 `npm` 명령, CLI 러너, 독립 실행 스크립트 실행을 사용자에게 요구하지 않는다.

### 자동 실행 강제 규칙
- **루프 간 전환 시 절대 사용자에게 확인하지 않는다.** 전 루프가 끝나면 즉시 다음 루프를 시작한다.
- "진행할까요?", "다음으로 넘어갈까요?", "어떻게 할까?" 같은 질문을 하지 않는다.
- 루프 A 완료 → 즉시 루프 B 시작. 루프 B 완료 → 즉시 루프 C 시작. 예외 없음.
- 에이전트 백그라운드 작업 완료 대기 중에도 사용자에게 중간 상태를 보고하지 않는다.
- 사용자에게 전달하는 시점은 **전체 작업 완료 후 1번**뿐이다.
- 단, **루프 시작 전** 아래 3가지는 예외다.
  - 필수 항목(플랫폼, 기술 스택) 확인
  - 사전 검토 단계 질문
  - Penpot/외부 도구 연결 확인

### 루프 내부 자동 처리 규칙
- **이슈 발견 → 수정 → 재검증 사이클도 자동으로 돌린다.** 사용자에게 "이슈를 수정할까?", "테스트 코드를 고칠까?", "어떤 걸 먼저 할까?" 묻지 않는다.
- 루프 D에서 이슈 발견 → `[분류]` 기준으로 해당 에이전트에게 즉시 수정 요청 → 재검증. 사용자 확인 없음.
- 통합테스트에서 실패 발견 → 실패 원인 분석 → 테스트 코드 문제면 테스트 코드 즉시 수정 후 재실행, 앱 버그면 개발자에게 즉시 수정 요청 후 재실행. 사용자 확인 없음.
- 에이전트가 작업을 미완료하면 즉시 재호출하거나 다른 에이전트에게 넘긴다. 사용자에게 "미완료인데 어떻게 할까?" 묻지 않는다.
- **하네스가 판단할 수 없는 경우에만 사용자에게 묻는다**: 요구사항 자체가 모호한 경우, 기술적으로 불가능한 경우, 외부 리소스(API 키, DB 설치 등)가 필요한 경우.

## 산출물 포맷 규칙

### 기획 단계 — 기획서 + Penpot 와이어프레임
- 기획자는 **기획서(md)**와 **Penpot 와이어프레임**을 작성한다.
- 기획서가 기능/동작의 **정본(SSOT)**이다.
- Penpot 와이어프레임은 화면 구조/레이아웃 설명을 위한 **정본**이다.

### Penpot 페이지 분리 규칙
- **플랫폼/화면 방향이 다르면 Penpot 페이지를 분리한다.**
- 페이지 이름: `{프로젝트명} — {플랫폼}` (예: `ProjectName — Mobile`, `ProjectName — Desktop`)
- 모바일/데스크톱/태블릿 보드를 같은 페이지에 섞지 않는다.
- 프로젝트 시작 시 필요한 플랫폼 페이지를 모두 생성한다.
- VOC/업데이트 시에도 해당 플랫폼 페이지에서만 작업한다.

### Penpot 산출물 구조
각 화면은 아래 3개 산출물로 관리한다.
- `wf_[screen_id]`: 실제 화면 구조만 담는 와이어프레임 Board
- `desc_[screen_id]`: 화면 설명만 담는 설명 Board
- `design_[screen_id]`: 디자이너가 새로 만드는 최종 시각 디자인 Board

### 디자인 단계 — Penpot 디자인 적용
- **Penpot이 시각적 디자인 도구**이다.
- 디자이너는 `wf_*`와 `desc_*`를 읽고 `design_*` Board를 **새로 생성**한다.
- 디자이너는 기존 와이어프레임 Board를 직접 수정하지 않는다.
- 결과물: Penpot 디자인 Board + Token (디자인 스펙 보존 + 개발 참조용)
- 개발자는 Penpot 디자인을 참조하여 **처음부터** 코드를 작성한다.
- 다른 에이전트는 `export_shape` 도구로 Penpot 디자인을 시각적으로 확인할 수 있다.

### 상세 규칙 위치
- `wf_*` / `desc_*` 생성 규칙 상세: `planner.md`
- `design_*` 생성 규칙 상세: `designer.md`
- 구현/검증 기준 상세: `developer.md`, `qa.md`, `tester.md`

### Penpot 참조 우선순위
- 기능/동작 판단: 기획서
- 화면 구조 판단: `wf_*` + `desc_*`
- 시각 판단: `design_*`
- 구조와 시각이 충돌하면 구조는 기획서 + `wf_*` + `desc_*`, 시각은 `design_*`를 따른다

## 프로젝트 시작 규칙
사용자가 자연어로 만들고 싶은 것을 설명하면, 하네스가 아래 항목을 추출한다.

### 필수 항목 (사용자가 반드시 지정해야 하는 것)
- **플랫폼**: 모바일 / 웹 / 태블릿 / 복수 선택
- **기술 스택**: 사용할 언어/프레임워크 (예: React, Vue, vanilla JS 등)

### 자동 추출 항목 (설명에서 파악, 없으면 기본값)
- 프로젝트 명: 설명에서 추출, 없으면 자동 생성
- 프로젝트 설명: 사용자 원문 그대로
- 루프 최대 반복 횟수: 기본값 5
- 통과 기준 점수: 기본값 95

### 시작 흐름
1. 필수 항목이 빠져 있으면 → 빠진 항목만 안내하고 입력을 요청한다. **멈춘다.**
2. 필수 항목이 채워지면 → **사전 검토 단계**로 진입한다.

### 사전 검토 단계
필수 항목이 갖춰진 후, 하네스가 사용자의 기획을 가볍게 훑고 피드백을 던진다.
**에이전트를 호출하지 않는다. 하네스 자체가 판단한다.**

#### 검토 관점 (간결하게, 방향성 수준만)
- **실현 가능성**: 주어진 환경(플랫폼, 스택)에서 안 되는 게 있는지 (예: 서버 없이 로그인?)
- **모호한 부분**: 여러 방향으로 해석될 수 있는 것 (예: "경로 저장"이 지도 API인지 텍스트 기록인지)
- **스코프 확인**: 범위가 너무 넓거나 좁지 않은지

#### 구현 난이도 판별
사용자 기획에서 기능 단위를 추출하고, 각각에 난이도를 매긴다.

| 난이도 | 기준 |
|--------|------|
| S (단순) | HTML/CSS/JS만으로 완성 가능. 외부 의존 없음 |
| M (보통) | 상태 관리, 로컬 저장, 간단한 API 연동 등 |
| H (높음) | 외부 API 필수, 인증, 실시간 처리, 복잡한 데이터 구조 |
| X (환경 밖) | 현재 스택/플랫폼으로 구현 불가 또는 서버 필요 |

출력 형식:
```
─── 구현 난이도 ─────────────────────────────────
| 기능 | 난이도 | 비고 |
|------|--------|------|
| 핵심 엔티티 CRUD | S | localStorage 기반 |
| 경로 지도 표시 | H | 지도 API 필요 (Kakao/Google) |
| 로그인 | X | 서버 없음 — 대안 필요 |
```

- X가 있으면 반드시 사용자에게 알리고 대안 방향을 질문한다
- 난이도 표는 피드백과 함께 전달한다

#### 피드백 규칙
- **구체적 해결책을 제시하지 않는다** — 기획은 기획자가 한다
- 문제점 지적 + "이건 어떻게 할 건지" 질문만 던진다
- 난이도 표 + 질문 합쳐서 핵심만. 길게 쓰지 않는다
- 문제 없으면 "특이사항 없음, 진행합니다"로 바로 시작한다

#### 흐름
1. 하네스가 피드백 + 질문을 전달한다
2. **사용자가 답할 때까지 멈춘다. 절대 자동 진행하지 않는다.**
3. 사용자가 답하면 → **요청 분해 + 작업 보드 생성** → 벤치마킹 + 루프 A 시작

추출한 설정은 workspace/planning/project-config.md에 저장하고, 모든 에이전트 호출 시 참조한다.

### 요청 분해 + 작업 보드 생성 (공통 선행 단계)
루프를 시작하기 전에, 하네스는 사용자 요청을 **작업 단위**로 먼저 쪼갠다.
이 단계는 신규 기획 요청과 VOC/업데이트 요청 모두에 공통으로 적용한다.

#### 분해 원칙
- 문장 단위가 아니라 **화면/기능/변경 단위**로 나눈다.
- 하나의 작업 항목은 한 번에 하나의 주요 UI/기능 변화만 담는다.
- 기존 화면 수정이면 기존 `screen_id`에 매핑하고, 신규 화면이면 새 `screen_id` 후보를 적는다.
- 각 항목마다 변경 유형, 필수 에이전트, 선행 조건, 완료 조건을 확정한다.

#### 기존 구조 유지 원칙
- 현재 프로젝트에 이미 프레임워크 구조가 있으면 그것을 기준 아키텍처로 유지한다.
- 프론트엔드가 `workspace/development/` 아래 Vite/React 구조로 분리되어 있다면, 이후 요청도 그 구조를 확장하는 방식으로 분해하고 구현한다.
- 하나의 작업 항목이 여러 화면, 여러 메뉴, 여러 동작 책임을 한 파일에 다시 몰아넣는 결과가 예상되면 작업 보드 단계에서 더 잘게 나눈다.
- 새 route, 새 화면, 새 메뉴, 새 복합 동작은 기존 대형 파일에 단순 추가하는 방식보다 해당 책임에 맞는 페이지/컴포넌트/훅/유틸 분리를 우선한다.
- 하네스는 코드가 돌아가기만 하면 완료로 보지 않고, 기존 구조를 유지하는 방향으로 구현되었는지도 함께 본다.

#### 신규 화면 생성 트리거
- 아래를 만족하면 하네스는 해당 항목을 **신규 화면 후보(CREATE)** 로 본다.
  - 기존 어떤 `screen_id`에도 자연스럽게 매핑되지 않음
  - 새 route / 새 view / 새 독립 flow / 새 `screen_id`가 필요함
- 이 경우 하네스는 작업 보드에 `matched_screen_id = 없음`, `변경 유형 = 화면 구조/기능 변경`, `비고 = CREATE 후보 사유`를 먼저 기록한다.
- 이후 planner가 이 후보를 검토해 최종적으로 `CREATE` 또는 `UPDATE+CREATE`를 확정한다.
- `CREATE`가 확정되면 순서는 아래와 같다:
  - planner: 기획서 새 화면 섹션 + 새 `wf_*` / `desc_*` 생성
  - designer: planner 가이드의 `action: CREATE`를 받아 새 `design_*` 생성
  - developer: 그 뒤 코드 구현
  - QA: 신규 화면 기준 테스트케이스 작성/수정 + 정적 검증
  - tester: 신규 화면 스모크/브라우저 실행 검증
  - secretary: 신규 화면 생성 이력과 산출물 반영 상태 기록
- 신규 화면 후보라도 기존 화면 수정으로 흡수 가능하면 `UPDATE`로 되돌린다.

#### 작업 보드 필수 컬럼
- `item_id`
- `요청 항목`
- `matched_screen_id`
- `변경 유형`
- `필수 에이전트`
- `선행 조건`
- `완료 조건`
- `overall_status`
- `planner_status`
- `designer_status`
- `developer_status`
- `qa_status`
- `tester_status`
- `비고`

#### 작업 보드 상태 수명주기
- 상태값은 모든 컬럼에서 `todo`, `in_progress`, `done`, `blocked`, `skipped`만 사용한다.
- 하네스는 새 요청을 작업 보드에 반영한 직후 모든 신규 항목의 `overall_status`를 `todo`로 기록한다.
- 하네스는 **필수 에이전트 배치 시점에** 아래 불변식을 먼저 적용한다.
  - `developer`가 필수인 항목은 `tester`도 **반드시 같은 항목의 필수 에이전트**에 포함한다.
  - 코드 수정/구현이 예상되는 항목은 시간 절약, 경량 변경, 빠른 확인을 이유로 `tester`를 제외하지 않는다.
  - `QA`를 포함했다는 사실은 `tester`를 생략하는 근거가 아니다. `QA-only` 배치는 코드 변경 항목에서 유효하지 않다.
- 하네스는 필수 에이전트에 포함되지 않은 역할의 상태 컬럼을 즉시 `skipped`로 기록한다.
- 각 에이전트는 **자기 작업을 시작할 때 자기 status 컬럼만** `in_progress`로 바꾼다.
- 각 에이전트는 **자기 작업이 끝날 때 자기 status 컬럼만** 아래 중 하나로 닫는다.
  - `done`: 자기 완료 조건 충족
  - `blocked`: 선행 조건 미충족, 외부 의존성, 실제 진행 불가
  - `skipped`: 이번 요청에서 자기 역할이 제외되었거나 다른 항목으로 흡수됨
- `overall_status`는 개별 에이전트가 임의로 덮어쓰지 않는다. 아래 기준으로만 요약한다.
  - 필수 에이전트 중 하나라도 `blocked`면 `overall_status = blocked`
  - 필수 에이전트가 하나라도 `in_progress`면 `overall_status = in_progress`
  - 필수 에이전트가 모두 `done` 또는 `skipped`면 `overall_status = done`
  - 아직 시작 전이면 `overall_status = todo`
- 선행 조건 확인은 `overall_status`가 아니라 **역할별 status 컬럼** 기준으로 한다.
- 어떤 역할이든 선행 역할의 status가 `done` 또는 `skipped`가 아니면 다음 필수 역할로 넘길 수 없다.
- 하네스는 각 루프 종료 시 `request-workboard.md`를 다시 읽어 미닫힌 항목이 없는지 확인한다.

#### 구조화 신호 우선 규칙
- 작업 보드 status 값과 에이전트의 구조화 반환값(`action`, `designer_required`, `design_target_boards`, `developer_ready`, `completion_state`, `missing_items`)은 자연어 설명보다 항상 우선한다.
- 자연어 문장에 `"후속 루프에서"`, `"나중에"`, `"이번엔 문서만"`, `"일단 넘어가고"` 같은 표현이 있어도 구조화 반환값을 뒤집을 수 없다.
- 아래처럼 구조화 반환값과 자연어가 충돌하면 그 반환은 **무효(invalid)** 로 본다.
  - `designer_required = Y`인데 자연어에서 디자이너를 미루거나 생략하라고 함
  - `designer_required = N`인데 `design_target_boards`가 비어 있지 않거나, 자연어에서 `design_*` 수정을 요구함
  - `completion_state = complete`인데 `missing_items`가 남아 있음
  - 필수 역할 status가 비어 있거나, 필수 에이전트 목록과 status 값이 서로 모순됨
- 무효 반환이 나오면 하네스는 다음 역할을 호출하지 않고 같은 역할을 다시 호출하거나 `blocked` 사유를 정리한 뒤 같은 루프에서 해결한다.

#### JSON 상태 / 티켓 게이트 (필수)
- `workspace/planning/request-workboard.md`는 **사람 읽기용 보드**다. 기계 판정의 정본(SSOT)은 `workspace/planning/request-state.json`이다.
- 하네스와 validator는 다음 항목의 진실값을 `request-state.json` 기준으로 판단한다.
  - 역할별 `status`
  - `attempt`
  - `checklist`
  - `claim_path`
  - `done_ticket`
  - `skip_ticket`
  - `missing_items`
- 에이전트는 `done ticket`을 직접 발급하지 않는다.
  - 에이전트는 claim / evidence를 쓴다.
  - validator가 체크리스트를 검사하고 통과 시 `done ticket`을 발급한다.
- `request-workboard.md`의 `done`은 참고값일 뿐이다. `done ticket`이 없으면 다음 단계 입장권으로 인정하지 않는다.

#### 작업명 규칙 (필수)
- 하네스가 생성하는 task subject는 **반드시** 아래 형식을 따른다.
  - `[Batch{N}][R{M}][role] subject`
  - 예: `[Batch8][R17][tester] floating-button verification`
- `TaskCreated` 훅은 이 형식을 어긴 task를 차단한다.
- validator는 `task_subject`에서 `batch_id`, `item_id`, `role`을 파싱하여 상태 JSON과 티켓 경로를 찾는다.

#### claim / evidence / ticket 규칙
- 각 역할은 작업 종료 직전 아래 산출물을 남긴다.
  - claim: `workspace/claims/{batch_id}/{item_id}/{role}.claim.json`
  - evidence: `workspace/evidence/{role}/{batch_id}/{item_id}/...`
- validator는 아래를 발급/기각한다.
  - 통과: `workspace/tickets/{batch_id}/{item_id}/{role}.done.json`
  - 거절: `workspace/tickets/{batch_id}/{item_id}/{role}.rejected.json`
  - 면제: `workspace/tickets/{batch_id}/{item_id}/{role}.skip.json`
- `skipped`도 ticket이 있어야만 유효하다. `skip ticket` 없는 `skipped`는 무효다.

#### Hook 기반 하드 게이트
- 하네스는 Claude Code hook으로 다음 3단 게이트를 사용한다.
  - `TaskCreated`: subject 규칙 + predecessor ticket 검사
  - `TaskCompleted`: 체크리스트 검사 후 `done ticket` 발급 또는 완료 차단
  - `TeammateIdle`: ticket 없는 상태로 역할이 쉬는 것을 차단
- 보조 관측용으로 `SubagentStart`, `SubagentStop`도 로그를 남긴다.
- 이 게이트는 `workflow/checklists/task-gate-checklists.json`과 `request-state.json`을 기준으로 동작한다.

#### 루프백 / 재시도 규칙
- 체크리스트 항목 중 1개라도 실패하면 validator는 `done ticket`을 발급하지 않는다.
- `TaskCompleted`가 차단되면 같은 역할은 **완료로 닫히지 않으며**, 누락 항목을 받은 상태로 다시 루프를 돈다.
- 다음 역할은 predecessor 역할의 `done ticket` 또는 `skip ticket`이 없으면 `TaskCreated` 단계에서 생성 자체가 차단된다.
- 기본 재시도 상한은 항목별 `retry_limit = 3`이다.
- 상한을 넘겨도 ticket이 발급되지 않으면 하네스는 해당 항목을 `blocked`로 유지하고 사용자에게 에스컬레이션한다.

#### 에이전트 호출 전 차단 게이트
- 하네스는 **모든 에이전트 호출 직전** 현재 요청 배치의 작업 보드를 다시 읽고, 대상 항목별 선행 역할 status를 검사한다.
- 검사 순서:
  1. 현재 항목의 필수 에이전트 목록 확인
  2. 대상 역할보다 앞선 필수 역할의 status 확인
  3. 필수 역할 status가 `done` 또는 `skipped`가 아니면 호출 금지
  4. 필수 역할인데 status가 비어 있거나 누락되면 호출 금지
  5. `skipped`인 역할은 `비고`에 스킵 근거가 없으면 무효로 보고 호출 금지
- 특히 developer 호출 전에는 아래를 추가로 모두 통과해야 한다.
  - planner `completion_state = complete`
  - UI-visible 변경이면 planner의 기획서 + `wf_*` / `desc_*` 반영 완료
  - planner가 `designer_required = Y`를 반환했거나 planner가 `wf_*` / `desc_*`를 수정했다면 designer `completion_state = complete`
  - designer가 필요한 항목인데 `designer_status = skipped`면 호출 금지
  - designer가 완료됐더라도 `developer_ready = Y`가 아니면 호출 금지
- QA/tester 호출 전에도 같은 방식으로 developer `completion_state`, 역할 status, `missing_items`를 함께 확인한다.
- 단, 최종 하드 게이트는 `status`보다 `done ticket` / `skip ticket`이다. status가 `done`이어도 ticket이 없으면 호출 금지다.

#### skipped 사용 규칙
- `skipped`는 편의상 넘기는 값이 아니다. **명시적 면제**가 있는 경우에만 허용한다.
- 필수 에이전트로 남아 있는 역할은 `skipped`로 닫을 수 없다.
- designer를 `skipped`로 닫을 수 있는 경우는 아래를 모두 만족할 때뿐이다.
  - planner `completion_state = complete`
  - planner 구조화 반환값이 `designer_required = N`
  - `design_target_boards`가 빈 값이다
  - 작업 보드 `비고`에 스킵 사유가 적혀 있다
- 위 조건 중 하나라도 빠지면 `designer_status = skipped`는 무효이며, 하네스는 designer를 필수 역할로 복구한 뒤 진행한다.

#### 호출 감사 기록 규칙
- 하네스는 각 에이전트 호출 전 아래 최소 정보를 `workspace/reports/agent-log.txt` 또는 동등한 실행 로그에 남긴다.
  - 요청 배치 / `item_id`
  - 호출 대상 역할
  - 선행 역할 status 요약
  - `skipped` 역할과 그 근거
  - 차단 여부와 차단 사유
- 호출 감사 기록이 없으면 하네스는 해당 전환을 신뢰하지 않고 같은 루프에서 다시 점검한다.

#### 루프 완료 / 미완료 게이트
- 하네스는 에이전트의 서술형 문장만 보고 `완료`를 판단하지 않는다. **반드시 역할별 status + 명시적 완료 신호**를 함께 확인한다.
- 각 에이전트는 반환값에 아래를 포함한다.
  - `completion_state`: `complete` | `partial`
  - `unfinished_reason`: `partial`일 때 사유
- 아래 중 하나라도 해당하면 해당 역할은 **미완료**로 본다.
  - 필수 담당 항목의 자기 status가 `done` 또는 `skipped`가 아님
  - `completion_state = partial`
  - `missing_items`가 남아 있음
  - `maxTurns` 도달, 도구 실패, 외부 의존성 때문에 다음 역할이 바로 이어질 수 없음
- 미완료 역할이 하나라도 있으면 현재 루프는 `완료`가 아니다.
- 미완료 상태에서는 다음 루프로 넘어가지 않고, 하네스는 해당 역할을 다시 호출하거나 `blocked` 사유를 정리한 뒤 같은 루프 안에서 이어간다.
- `루프 완료`, `개발 완료`, `최종 완료` 같은 문구는 **필수 역할이 모두 `done` 또는 `skipped`이고 `completion_state = complete`일 때만** 사용한다.

#### QA / tester 파일 우선 완료 판정
- QA와 tester는 긴 본문 반환보다 **보고서 파일 + 상태 요약 파일**이 우선 증거다.
- 하네스는 QA/tester 호출 직전에 대상 보고서 파일과 상태 요약 파일의 기존 `mtime`을 기록한다.
- 호출 후 아래를 모두 만족하면, 반환 본문이 짧거나 일부 잘렸더라도 **작업 완료로 간주할 수 있다.**
  - 상태 요약 파일이 존재한다
  - 상태 요약 파일의 `completion_state = complete`
  - 상태 요약 파일의 `report_path`가 유효하다
  - 해당 보고서 파일의 `mtime`이 호출 직전보다 최신이다
- 이 경우 하네스는 같은 작업을 즉시 재호출하지 않고, 보고서 파일을 읽어 다음 루프로 진행한다.
- 반대로 반환이 애매해도 상태 요약 파일/보고서 파일이 갱신되지 않았으면 완료로 간주하지 않는다.
- QA/tester의 긴 이슈 목록, Penpot 근거, PASS 상세는 반환 본문이 아니라 보고서 파일에서 읽는다.

#### QA / tester 재호출 규칙
- QA/tester가 `completion_state = partial`이거나 상태 파일의 `resume_from` / `phase`가 미완료 지점을 가리키면, 하네스는 **같은 루프 안에서만** 재호출한다.
- 재호출 시 하네스는 직전 상태 파일 경로를 함께 전달하고, 이미 완료한 단계는 반복하지 말고 해당 지점부터 이어서 하라고 명시한다.
- 같은 항목에서 QA/tester 자동 재호출은 기본적으로 **최대 2회**까지 허용한다.
- 2회 재호출 후에도 보고서 파일 갱신 또는 `completion_state = complete` 증거가 없으면 해당 역할을 `blocked`로 유지하고 다음 루프로 넘기지 않는다.

#### 요구사항 반영 점검 (gap check)
- 하네스는 별도 gap test 문서를 만들지 않는다. **작업 보드의 `요청 항목` + 최신 기획서/산출물**을 기준으로 각 단계에서 반영 여부를 점검한다.
- 각 역할은 자기 status를 `done`으로 닫기 전에, 자기 담당 항목이 실제 산출물에 반영됐는지 직접 대조해야 한다.
- 점검 기준은 아래와 같다.
  - planner: 요청 항목이 기획서 + `wf_*` + `desc_*`에 반영되었는지
  - designer: 요청 항목이 `design_*`에 반영되었는지
  - developer: 요청 항목이 실제 코드/화면 동작에 반영되었는지, 그리고 기존 프로젝트 구조를 해치지 않았는지
- 각 역할은 반환값에 최소한 아래를 포함한다.
  - `request_coverage`: `item_id`별 반영 결과 요약
  - `covered_items`: 반영 완료 항목 목록
  - `missing_items`: 아직 반영되지 않았거나 불명확한 항목 목록 + 사유
- `missing_items`가 하나라도 남아 있으면 해당 역할은 자기 status를 `done`으로 닫지 않는다. `blocked`로 두고 부족한 항목을 반환한다.
- 구조적으로는 동작하지만 기존 분리 원칙을 무너뜨린 구현은 `missing_items` 또는 `blocked` 사유로 남길 수 있다.
- QA와 tester는 루프 D에서 위 coverage와 실제 산출물을 대조해 누락이 남아 있는지 최종 확인한다.

#### UPDATE+CREATE 분리 규칙
- 하나의 요청 안에 기존 화면 수정과 신규 화면 생성이 함께 있더라도 **작업 보드에서는 반드시 별도 행으로 분리**한다.
- 하나의 행에 `UPDATE+CREATE`를 동시에 담지 않는다.
- planner는 CREATE 후보를 최종 검토할 때, 기존 화면으로 흡수 가능한 항목은 `UPDATE` 행으로 되돌리고 진짜 신규 화면만 `CREATE` 행으로 남긴다.

#### 생성 규칙
- 하네스는 요청 분해 결과를 `workspace/planning/request-workboard.md`에 저장한다.
- **새로운 상위 요청**이 들어오면 작업 보드에 새 `요청 배치` 섹션을 만들고, 이전 배치의 미닫힌 항목은 먼저 `blocked` 또는 `skipped`로 정리한다.
- VOC/업데이트면 현재 활성 배치를 읽은 뒤 영향을 받는 항목을 갱신하거나 새 항목을 추가한다.
- 같은 요청으로 대체된 기존 항목은 `skipped`로 닫고 `비고`에 대체된 이유를 남긴다.
- planner 호출 전, 하네스는 이 보드가 존재하고 최신 요청이 반영되었는지 먼저 확인한다.
- 이후 에이전트 호출 시 `request-workboard.md`를 함께 전달한다.

### Penpot / 인프라 사전 확인
루프 A 시작 전, 하네스는 Penpot 사용 준비 상태를 먼저 확인한다.

- 확인 대상:
  - Penpot MCP 서버 연결 가능 여부
  - 필요한 도구 접근 가능 여부: `execute_code`, `export_shape`, `high_level_overview`, `import_image`
  - 브라우저 Penpot 플러그인 연결 상태
  - `project-config.md`의 프로젝트명으로 Penpot 페이지를 만들거나 찾을 수 있는 상태인지
- 위 조건 중 하나라도 만족하지 않으면 **루프 A를 시작하지 않고 준비 필요 상태로 멈춘다**
- 이 단계는 루프 시작 전 예외 단계이므로, 필요 시 사용자에게 연결 상태만 간단히 알릴 수 있다

## 파일 경로 레지스트리

### 파일명 규칙
- 형식: `{단계}-{파일명}[-v{N}].확장자`
- 단계 접두사: A(기획/디자인), B(기획리뷰), C(개발/TC), D(검증)
- 루프 내 반복 수정: 같은 파일 덮어쓰기 (버전 안 올림)
- 단계 완료 후 재수정 필요 시: -v2, -v3으로 버전업

### 파일 목록

| 산출물 | 경로 | 담당 | 비고 |
|--------|------|------|------|
| 프로젝트 설정 | workspace/planning/project-config.md | 하네스 | 접두사 없음 |
| 요청 작업 보드 | workspace/planning/request-workboard.md | 하네스 | 신규/업데이트 공통 작업 분해 보드 |
| 요청 상태 JSON | workspace/planning/request-state.json | 하네스/validator | 기계 판정 SSOT |
| 벤치마킹 | workspace/planning/A-benchmark.md | 하네스 | 사전 단계 |
| 기획서 | workspace/planning/A-planning-doc.md | 기획자 | |
| Penpot 화면 와이어프레임 | Penpot 프로젝트 내 `wf_[screen_id]` Board | 기획자 | 화면 구조 정본 |
| Penpot 설명 Board | Penpot 프로젝트 내 `desc_[screen_id]` Board | 기획자 | 설명 정본 |
| Penpot 디자인 | Penpot 프로젝트 내 `design_[screen_id]` Board + Token | 디자이너 | 시각 정본 |
| UX 리뷰 | workspace/design/A-uiux-review.md | 디자이너 | |
| 기술 검토 | workspace/reports/B-tech-review.md | 개발자 | |
| QA 기획 검토 | workspace/reports/B-qa-review.md | QA | |
| 테스트케이스 | workspace/testing/C-testcases.md | QA | |
| QA 상태/요약 | workspace/reports/.qa-last-run.json | QA | 경량 반환 대체용 |
| Claim 파일 | workspace/claims/{batch_id}/{item_id}/{role}.claim.json | 각 역할 | validator 입력 |
| Evidence 파일 | workspace/evidence/{role}/{batch_id}/{item_id}/ | 각 역할 | validator 입력 |
| Done ticket | workspace/tickets/{batch_id}/{item_id}/{role}.done.json | validator | 다음 단계 입장권 |
| Skip ticket | workspace/tickets/{batch_id}/{item_id}/{role}.skip.json | validator | 정당한 생략 입장권 |
| Rejected ticket | workspace/tickets/{batch_id}/{item_id}/{role}.rejected.json | validator | 체크 실패 기록 |
| 프론트엔드 프로젝트 | workspace/development/ | 개발자 | 프론트 스택에 맞는 실제 구조 허용 |
| 서버 엔트리 | workspace/server/index.js | 개발자 | 서버 스택 있을 때 |
| 서버 라우트 | workspace/server/routes/ | 개발자 | API 엔드포인트 |
| 서버 모델 | workspace/server/models/ | 개발자 | DB 스키마 |
| 서버 미들웨어 | workspace/server/middleware/ | 개발자 | 인증 등 |
| 서버 패키지 | workspace/server/package.json | 개발자 | 의존성 |
| 서버 환경변수 | workspace/server/.env.example | 개발자 | 키 미포함 템플릿 |
| 서버 README | workspace/server/README.md | 개발자 | 실행 방법 |
| QA 검증 결과 | workspace/reports/D-qa-verification.md | QA | |
| Playwright 테스트 | workspace/testing/playwright/ | 테스터 | 브라우저 실행 테스트 |
| Playwright 결과 JSON | workspace/reports/playwright-results.json | 테스터 | Playwright reporter 산출물 |
| Playwright 실행 로그 | workspace/reports/playwright-run.log | 테스터 | stdout/stderr 축약 로그 |
| 테스터 검증 결과 | workspace/reports/D-tester-verification.md | 테스터 | |
| 통합테스트 결과 | workspace/reports/E-integration-test.md | 테스터 | 배포 전 최종 검증 |
| 통합테스트 코드 | workspace/testing/playwright/integration.spec.js | 테스터 | 전체 시나리오 |
| 테스터 진행 상태 | workspace/testing/.tester-state.json | 테스터 | 재개 지점 기록 |
| 테스터 상태/요약 | workspace/reports/.tester-last-run.json | 테스터 | 경량 반환 대체용 |
| 에이전트 로그 | workspace/reports/agent-log.txt | 비서 | 접두사 없음 |
| Hook 이벤트 로그 | workspace/reports/hook-events.jsonl | validator | Task/Subagent 실측 로그 |
| 최종 보고서 | workspace/reports/final-report.md | 비서 | 접두사 없음 |

### 규칙
- 에이전트가 위 목록에 없는 파일을 만들면 안 된다.
- **디렉터리 경로로 등록된 항목은 그 하위 파일/폴더 생성을 허용한다.**
- 하네스가 에이전트를 호출할 때 "저장 경로: {위 경로}" 형태로 명시적으로 전달한다.
- 같은 루프 안에서 반복할 때는 같은 파일을 덮어쓴다.
- 단계 완료 후 되돌아와서 수정이 필요하면 버전업한다 (예: A-planning-doc.md → A-planning-doc-v2.md)

## 기본 규칙
1. 사용자의 요구사항이 들어오면 아래 실행 흐름을 자동으로 실행한다.
2. 각 역할의 행동 규칙은 .claude/agents/ 안의 에이전트 파일을 따른다.
3. 역할 순서: 기획자 ↔ 디자이너 → 개발자/QA/테스터 → 사용자
4. 각 루프에서 통과 기준 점수 이상이 나오지 않으면 다음 단계로 넘어가지 않는다.
5. 이전 턴 대비 개선 3점 이하면 현재 상태로 종료한다.
6. 결과물 저장 위치: workspace/ (planning, design, development, testing, reports)
7. 작업 완료 시 비서가 기록 정리한다.

## 점수 판정 규칙

### 기본 원칙
- 매 루프 결과물마다 AI가 요구사항 기준으로 점수를 매긴다 (0~100점)
- 통과 기준 점수 이상 → 루프 종료, 다음 단계로 넘어간다
- 통과 기준 미만 → 부족한 부분을 알려주고 다시 루프를 돈다
- 이전 턴 대비 개선 폭이 3점 이하 → 더 돌려도 의미 없으므로 종료

### 점수 기록 형식
- 매 턴마다 기록: [루프명] 턴 N — 점수: XX점 — 부족한 부분: OOO
- 사용자에게는 최종 결과만 보여준다.

### 종료 조건 (아래 중 하나라도 해당되면 루프 종료)
1. 통과 기준 점수 이상 도달
2. 이전 턴 대비 개선 폭 3점 이하 (더 이상 개선 어려움)
3. 루프 최대 반복 횟수 도달 (강제 종료)

## 이슈 분류 / 라우팅 규약

### 공통 이슈 형식
- QA와 테스터는 이슈를 반드시 아래 형식으로 기록한다.
- 형식: `[심각도][분류][근거] 내용`
- `심각도`: `Blocker`, `Major`, `Minor`
- `분류`: `동작 오류`, `기획 문제`, `화면 문제`
- `근거`: `기획서`, `wf_*`, `desc_*`, `design_*`, `TC ID`

### 분류 정의
| 분류 | 의미 | 기본 라우팅 |
|------|------|------------|
| 동작 오류 | 기획서에 정의된 기능/흐름/상태가 실제로 동작하지 않음 | developer |
| 기획 문제 | 기획서 자체가 모호/누락/충돌되어 구현 기준이 불명확함 | planner |
| 화면 문제 | `design_*` 반영 누락, 레이아웃/반응형/시각 일관성 문제 | designer |

### 라우팅 키
- 하네스는 이슈의 **`[분류]` 값을 라우팅 키**로 사용한다.
- QA/테스터가 동일 단어를 사용한 것은 우연이 아니라 **고정 계약**이다.

### QA / tester 역할 경계
| 역할 | 기본 책임 |
|------|-----------|
| QA | spec/static gate. 기획서, TC, 코드, Penpot 산출물을 읽고 정적으로 검증 |
| tester | runtime gate. Playwright와 실제 실행으로 브라우저/연동 동작을 검증 |

### 복합 이슈 처리 순서
- 같은 턴에 여러 이슈가 섞이면 아래 우선순위로 처리한다.
1. `기획 문제`
2. `화면 문제`
3. `동작 오류`
- 상위 분류 이슈를 먼저 해결한 뒤, 루프 C부터 다시 돌며 하위 분류를 재평가한다.
- `Blocker`가 하나라도 있으면 점수와 무관하게 해당 턴은 미통과다.

### QA / tester 중복 이슈 병합 규칙
- 같은 `screen_id`에서 같은 `[분류]`와 같은 원인으로 보이는 이슈가 QA와 tester 양쪽에서 올라오면 **하나의 이슈로 병합**한다.
- 이때 tester의 런타임 증거를 주 근거로 두고, QA의 정적 분석 내용은 보조 근거로 함께 기록한다.
- `[분류]`가 다르거나 원인이 다르면 자동 병합하지 않는다.

## 실행 흐름 (자동)

### 사전 단계: 경쟁사 벤치마킹 (하네스가 직접 수행)
루프 A 시작 전에 하네스가 직접 웹 검색으로 경쟁사를 조사한다.
1. 프로젝트 설명을 기반으로 같은 도메인의 서비스/앱/웹 상위 1~10개를 검색한다
2. 각 서비스의 장점/단점을 정리한다
3. 기획에 참고할 만한 패턴, 기능, UX를 추출한다
4. 결과를 workspace/planning/A-benchmark.md에 저장한다
5. 이 파일을 기획자 호출 시 함께 전달한다

### 루프 A-1: 기획서 + Penpot 와이어프레임 작성 + 디자이너 UX 리뷰
1. Agent(planner) 호출: "요구사항: {X}. 작업 보드: workspace/planning/request-workboard.md. 벤치마킹: workspace/planning/A-benchmark.md. 기획서 작성 + Penpot 와이어프레임 생성해. 각 화면마다 `wf_[id]` Board와 `desc_[id]` Board를 따로 만들고, 라벨/디스크립션/상태별 화면을 포함해"
   - 작업 보드에 `matched_screen_id = 없음`이고 CREATE 후보 사유가 있으면 planner는 신규 화면 여부를 먼저 확정한다
   - 신규 화면으로 확정되면 새 `wf_*` / `desc_*`를 만들고, 디자이너에게 `action: CREATE` 가이드를 넘긴다
   - planner는 결과를 반환하기 전에 작업 보드의 각 `요청 항목`이 기획서 + `wf_*` + `desc_*`에 반영되었는지 gap check를 수행하고 `request_coverage`를 함께 반환한다
   - 신규 화면으로 확정된 항목도 루프 A-3 이후 일반 화면과 동일하게 `developer → QA/tester → secretary` 흐름으로 이어진다
2. Agent(designer) 호출: "기획서: {경로}. `wf_*`와 `desc_*`를 확인해서 UX 관점으로 리뷰해. 개선 필요 여부 판단해"
3. 개선사항 없음 → 루프 A-2 건너뛰고 A-3으로
4. 개선사항 있음 → 루프 A-2로

### 루프 A-2: 디자이너 ↔ 기획자 화면 개선
1. Agent(planner) 호출: "디자이너 리뷰: {경로}. 작업 보드: workspace/planning/request-workboard.md. 반영하여 기획서 수정 + `wf_*` + `desc_*` 수정해"
2. Agent(designer) 호출: "기획서 + `wf_*` + `desc_*`를 재검토해. 점수 반환해"
3. 통과 기준 미만 → 1번 반복
4. 통과 기준 이상 → 루프 A-2 완료

### 루프 A-3: 디자이너 Penpot 디자인 적용
1. Agent(designer) 호출: "기획서 + `wf_*` + `desc_*`를 참조하여 `design_*` Board를 새로 생성해. 기존 와이어프레임 Board는 수정하지 마"
   - designer는 반환 시 `developer_ready`, `developer_reason`, `developer_targets`를 함께 넘겨 다음 단계 구현 가능 여부를 명시한다
   - designer는 결과를 반환하기 전에 작업 보드의 각 `요청 항목`이 `design_*`에 반영되었는지 gap check를 수행하고 `request_coverage`를 함께 반환한다
   - `design_*`는 대응 `wf_*` / `desc_*` 쌍의 실제 하단 아래에 배치하고, 같은 페이지에서 x축 정렬을 맞춘다
2. Agent(secretary) 호출: "루프 A 완료 기록. 기획서, `wf_*`, `desc_*`, `design_*`, 점수/리뷰 결과를 기준으로 이번 루프 요약을 agent-log에 기록해"
3. 루프 A 전체 완료

### 루프 B: 전체 기획 리뷰 (개발자 + QA + 기획자)
1. Agent(developer) 호출: "기획서: {경로}. `wf_*`, `desc_*`, `design_*`를 확인해. 기술 검토 + 실현 가능성 의견 내"
2. Agent(qa) 호출: "기획서: {경로}. `wf_*`, `desc_*`, `design_*`를 확인해. 기획 검토 + 테스트 관점 의견 내"
3. Agent(planner) 호출: "개발자 의견: {경로}, QA 의견: {경로}. 작업 보드: workspace/planning/request-workboard.md. 종합하여 타협점 정리. 기획서 최종 수정 + 필요시 `wf_*` + `desc_*` 수정. 변경 내용을 '기능 변경', '문구/구조 정리', '`wf_*`/`desc_*` 변경 여부'로 분류해서 반환해. 점수도 반환해"
4. 기획자 변경 내용 확인:
   - `wf_*` / `desc_*` 변경 있음 → Agent(designer) 호출: "변경된 기획서 + `wf_*` + `desc_*`를 기준으로 영향받는 `design_*`만 재동기화해. 변경 없는 `design_*`는 건드리지 마"
   - 기능 변경 있음 → Agent(developer) 호출: "기획자 수정 내역: {변경분}. 기술적으로 문제 없는지 확인해"
   - 문구/구조만 있고 Penpot 영향 없음 → 재검토 없이 기획자 점수로 판정
5. 통과 기준 미만 → 1번 반복
6. 통과 기준 이상:
   - Agent(secretary) 호출: "루프 B 완료 기록. 개발자/QA 검토 결과, 기획자 점수, 변경 분류를 기준으로 이번 루프 요약을 agent-log에 기록해"
   - 루프 B 완료

### 루프 C: 개발 + 테스트케이스 작성 (동시 진행)
1. Agent(developer) 호출: "project-config.md + 기획서: {경로} + 작업 보드: workspace/planning/request-workboard.md. `wf_*`, `desc_*`, `design_*`를 참조하여 프론트엔드 개발해 (workspace/development/). 서버 스택이 있으면 workspace/server/에 서버도 개발해. 구현 완료 전 각 `요청 항목`이 코드와 화면 동작에 반영되었는지 gap check하고 `request_coverage`를 반환해"
2. Agent(qa) 호출: "project-config.md + 기획서: {경로} + 작업 보드: workspace/planning/request-workboard.md + 직전 QA 상태: workspace/reports/.qa-last-run.json. `wf_*`, `desc_*`, `design_*`를 확인해. 테스트케이스 작성해 (프론트 + 서버 API 둘 다). 상세는 파일에 저장하고 반환은 경량 요약만 해"
3. 하네스가 developer / QA 반환값과 작업 보드의 `developer_status`, `qa_status`를 함께 확인한다
   - QA 반환이 짧거나 일부 잘렸더라도 `workspace/reports/.qa-last-run.json`과 `workspace/testing/C-testcases.md`가 최신이면 파일 우선 규칙으로 완료 여부를 판단한다
   - 현재 요청 배치에 `developer`가 필수인데 `tester_status = skipped`로 기록돼 있으면 배치 오류다. 하네스는 이를 자동 수정하고 tester를 같은 배치의 필수 역할로 복구한 뒤 진행한다.
   - 둘 중 하나라도 `completion_state = partial`이거나 status가 `done` / `skipped`가 아니면 루프 C는 **미완료**다
   - 이 경우 Agent(secretary) 호출: "루프 C 중간 기록. 미완료 역할과 남은 항목을 기준으로 agent-log에 기록해"
   - 하네스는 미완료 역할을 같은 루프 C 안에서 다시 호출한다. 다음 루프로 넘어가지 않는다
4. developer와 QA가 모두 `completion_state = complete`이고 필수 항목 status가 `done` 또는 `skipped`이면:
   - Agent(secretary) 호출: "루프 C 완료 기록. 개발 산출물과 테스트케이스 경로를 기준으로 이번 루프 요약을 agent-log에 기록해"
   - 루프 C 완료

### 루프 D: 개발 ↔ 검증
1. Agent(qa) 호출: "project-config.md + 기획서 + 작업 보드: workspace/planning/request-workboard.md + `wf_*` + `desc_*` + `design_*` + 결과물: {경로}, 테스트케이스: {경로} + planner/designer/developer request_coverage + 직전 QA 상태: workspace/reports/.qa-last-run.json. 코드 정적 분석으로 검증해. 상세는 파일에 저장하고 반환은 경량 요약만 해"
2. Agent(tester) 호출: "project-config.md + 기획서 + 작업 보드: workspace/planning/request-workboard.md + `wf_*` + `desc_*` + `design_*` + 결과물: {경로}, 테스트케이스: {경로} + planner/designer/developer request_coverage + 직전 테스터 상태: workspace/testing/.tester-state.json + 직전 테스터 요약: workspace/reports/.tester-last-run.json. Playwright로 브라우저 실행 테스트해. 상세는 파일에 저장하고 반환은 경량 요약만 해"
   - 요청 배치에 `developer`가 필수였던 항목은 기본적으로 tester도 필수다. 시간 절약을 이유로 tester를 생략하지 않는다.
3. QA(정적 분석) + 테스터(브라우저 실행) 점수 종합 (둘 중 낮은 점수 기준)
4. 통과 기준 미만 → **위 `이슈 분류 / 라우팅 규약`의 `[분류]` 값 기준으로 분기한다**
   - `기획 문제` → Agent(planner) 수정 → `wf_*` / `desc_*` 영향 있으면 Agent(designer)로 `design_*` 재동기화 → 루프 C-1번으로
   - `화면 문제` → Agent(designer) 수정 후 필요 시 Agent(planner) 확인 → 루프 C-1번으로
   - `동작 오류` → Agent(developer) 수정 → 5번으로
5. **재검증 (턴 2 이후):** 하네스가 이전 이슈 목록 + 개발자 수정 내역을 함께 전달한다
   - Agent(qa) 호출: "project-config.md + 기획서 + 작업 보드: workspace/planning/request-workboard.md + `wf_*` + `desc_*` + `design_*` + 이전 이슈: {목록}, 수정 내역: {변경분} + 직전 QA 상태: workspace/reports/.qa-last-run.json. 수정된 부분 확인 + 회귀 없는지 체크해. 상세는 파일에 저장하고 반환은 경량 요약만 해"
   - Agent(tester) 호출: "project-config.md + 기획서 + 작업 보드: workspace/planning/request-workboard.md + `wf_*` + `desc_*` + `design_*` + 이전 이슈: {목록}, 수정 내역: {변경분} + 직전 테스터 상태: workspace/testing/.tester-state.json + 직전 테스터 요약: workspace/reports/.tester-last-run.json. 수정된 부분 Playwright로 재테스트 + 기존 PASS 항목 회귀 체크해. 상세는 파일에 저장하고 반환은 경량 요약만 해"
   - 3번으로
6. 통과 기준 이상이어도 하네스가 QA / tester 반환값과 작업 보드의 `qa_status`, `tester_status`를 함께 확인한다
   - QA 반환이 짧거나 일부 잘렸더라도 `workspace/reports/.qa-last-run.json`과 `workspace/reports/D-qa-verification.md`가 최신이면 파일 우선 규칙으로 완료 여부를 판단한다
   - tester 반환이 짧거나 일부 잘렸더라도 `workspace/reports/.tester-last-run.json`, `workspace/testing/.tester-state.json`, `workspace/reports/D-tester-verification.md`, `workspace/reports/playwright-results.json`이 최신이면 파일 우선 규칙으로 완료 여부를 판단한다
   - 둘 중 하나라도 `completion_state = partial`이거나 status가 `done` / `skipped`가 아니면 루프 D는 **미완료**다
   - 이 경우 Agent(secretary) 호출: "루프 D 중간 기록. 미완료 역할과 남은 항목을 기준으로 agent-log에 기록해"
   - 하네스는 미완료 역할을 같은 루프 D 안에서 다시 호출한다
7. QA와 tester가 모두 `completion_state = complete`이고 필수 항목 status가 `done` 또는 `skipped`이면:
   - Agent(secretary) 호출: "루프 D 완료 기록. QA/테스터 점수와 미해결 이슈를 기준으로 이번 루프 요약을 agent-log에 기록해"
   - 루프 D 완료

### 통합테스트 (루프 D 통과 후, 배포 전)
루프 D가 통과 기준 이상이 되면 **배포 전 최종 통합테스트**를 실행한다.
- 이 단계는 개별 이슈 검증이 끝난 후, 전체 기능을 처음부터 끝까지 연속으로 검증하는 단계다.
- 서버 + DB + 프론트가 모두 실행 중이어야 한다.
- DB는 빈 상태에서 시작한다.

1. Agent(tester) 호출: "통합테스트 실행. project-config.md + 기획서 + TC 전체를 참조. DB 초기화 후 적용 가능한 핵심 E2E 시나리오를 순서대로 실행해. 결과를 workspace/reports/E-integration-test.md에 저장해. 상세는 파일에 저장하고 반환은 경량 요약만 해. 직전 상태는 workspace/testing/.tester-state.json, workspace/reports/.tester-last-run.json을 참조해"
2. 통합테스트 PASS율 100% + Blocker 0건 → 배포 가능
3. 실패 있음 → 이슈 분류 후 해당 에이전트에게 수정 요청 → 재실행

### 마무리
1. 하네스는 최종 완료 전에 마지막으로 작업 보드를 읽고, 현재 요청 배치의 필수 항목이 모두 `done` 또는 `skipped`인지 확인한다
   - 하나라도 `todo`, `in_progress`, `blocked`면 최종 완료를 선언하지 않고 해당 루프로 되돌린다
2. 하네스가 전체 소요 시간, 에이전트별 토큰 사용량, 단계별 점수, `screen_id` 목록, variant 목록, Penpot Board 현황 집계를 함께 정리한다
   - Penpot Board 현황 집계는 planner/designer 반환값, QA의 Board 존재 확인 결과, 최종 검증 결과를 종합해 만든다
3. Agent(secretary) 호출: "secretary.md의 완료 리포트 포맷에 따라 정리해. 총 소요 시간: {X분}, 에이전트별 토큰: {내역}, 단계별 점수: {내역}, `screen_id` 목록: {내역}, variant 목록: {내역}, Penpot Board 현황: {내역}"
4. 사용자에게 완료 리포트를 직접 출력한다 (파일 저장도 하지만, 화면에도 표시)

## VOC / 업데이트 흐름

사용자 VOC가 들어오면 아래 순서를 **자동으로 전부** 실행한다. 중간에 사용자에게 묻지 않는다.

VOC/업데이트도 먼저 **요청 분해 + 작업 보드 갱신**을 수행한 뒤 라우팅한다.

하네스는 먼저 변경 유형을 판별하고, 그 결과에 따라 **필수 참여 에이전트만** 자동으로 호출한다.
하네스가 판단 가능한 범위면 사용자에게 다시 묻지 않고 다음 역할로 넘긴다.
업데이트 항목이 기존 화면 수정이 아니라 신규 화면 생성으로 확정되면, 해당 항목은 VOC라 하더라도 `planner → designer → developer → QA/tester → secretary` 순서의 신규 화면 생성 흐름을 그대로 따른다.

### VOC 첫 호출 규칙
- 요청에 **화면에서 보이는 변경(UI 구조, 상태, 레이아웃, 스타일, 문구)** 이 하나라도 포함되면 **첫 호출은 반드시 planner**다.
- 디자이너는 planner가 기획서 + `wf_*` / `desc_*`를 반영한 뒤에만 호출한다.
- developer는 planner/designer 선행 완료 게이트를 통과한 뒤에만 호출한다.
- **developer가 첫 호출로 허용되는 경우는 코드 로직만 변경인 경우뿐이다.**
- QA와 tester는 VOC/업데이트의 첫 호출 대상이 아니다.
- 복합 요청이면 세부 항목 중 하나라도 UI-visible 변경이 있으면 planner first 규칙을 따른다.

### 변경 유형별 기본 라우팅

| 변경 유형 | planner | designer | developer | QA | tester |
|-----------|---------|----------|-----------|----|--------|
| 화면 구조/기능 변경 | 필수 | 필수 | 필수 | TC 수정 필수 + 정적 검증 | Playwright 필수 |
| 스타일/시각만 변경 | 필수 (`desc_*`/기획 반영) | 필수 (`design_*`) | 코드 영향 있을 때만 필수 | 생략 가능 | 코드 변경 시 스모크 필수 |
| 코드 로직만 변경 | 선택 (기획 충돌 시만) | 불필요 | 필수 | TC 영향 있으면 TC 수정 + 정적 검증 | Playwright 필수 |
| 문구/텍스트만 변경 | 필수 (기획서 + `desc_*`) | 사용자에게 보이는 문자열이면 필수 (`design_*` 동기화) | 코드/문구 반영이 필요할 때만 필수 | 생략 가능 | 코드 변경 시 스모크 필수 |

### 라우팅 해석 규칙
- **화면 구조/기능 변경**: 새 화면, 상태 추가, 화면 흐름 변경, UI 요소 추가/삭제, 사용자 동작 결과 변경
- **스타일/시각만 변경**: 색상, 간격, 폰트 크기, 정렬, 딤 처리, 강조 표현, 카드 스타일 등
- **코드 로직만 변경**: API 호출, 상태 관리, 계산식, 조건 처리, 데이터 흐름 수정. 화면이 안 바뀌면 designer는 기본적으로 참여하지 않는다
- **문구/텍스트만 변경**: 라벨, 버튼 텍스트, 문장, 오타 수정. **사용자가 실제로 보게 되는 문자열이면 designer도 기본 참여**한다
- **문구/텍스트만 변경**이라도 실제 문자열 리소스, i18n 키, 코드 상수, 서버 응답 문구 반영이 필요하면 developer 참여로 자동 승격한다.
- **기존 화면의 일부 요소/상태/스타일/문구를 바꾸는 요청은 기본적으로 UPDATE**다. 새 route / 새 view / 새 screen_id가 반드시 필요한 경우에만 CREATE를 허용한다.

### 자동 핸드오프 원칙
- planner/designer/developer/QA/tester는 **자기 산출물이 생기면 다음 필수 역할로 바로 넘길 수 있는 형태로 반환**한다
- 업데이트 흐름에서 "검토 후 진행할까요?", "다음 역할 넘길까요?" 같은 질문은 금지한다
- 하네스가 외부 의존성, 요구사항 모호성, 기술적 불가능성을 발견한 경우에만 사용자에게 다시 묻는다
- 상위 라우터는 UI-visible 변경 요청을 developer에게 직접 넘기지 않는다. 먼저 planner가 변경 화면과 `screen_id`를 확정해야 한다.
- 상위 라우터는 **개발이 포함된 항목에서 tester를 임의로 빼지 않는다.** QA를 넣었다는 이유만으로 tester를 생략하지 않는다.

### developer 호출 입력 계약
- 하네스가 developer를 호출할 때 **새 CSS 스펙, 픽셀 수치, 색상값, 레이아웃 구조, 컴포넌트 내부 배치 규칙을 직접 작성해서 넘기지 않는다.**
- developer 호출 메시지에는 아래만 전달한다.
  - 수정 대상 `screen_id`
  - 관련 기획서 경로
  - 관련 `wf_*`, `desc_*`, `design_*` 참조 대상
  - planner/designer의 수정 요약
  - 이슈 목록 또는 구현 범위
- 시각 구현 기준은 항상 `design_*`이며, 호출 메시지의 텍스트 설명은 정본 보조 설명일 뿐 `design_*`를 대체하지 않는다.
- 호출 메시지와 `design_*`가 충돌하면 developer는 호출 메시지의 시각 지시를 따르지 않고 `design_*`를 기준으로 구현한다.

### 선행 완료 게이트
- 화면에서 보이는 변경(UI 구조, 상태, 문구, 레이아웃, 스타일)이 있으면 **planner의 기획서 + `wf_*` / `desc_*` 반영이 먼저 완료**되어야 한다.
- planner가 `designer_required = Y`를 반환했거나, 화면에서 보이는 변경이 있고 `design_*`에 영향이 있으면 **designer의 `design_*` 반영 + `export_shape` 확인이 먼저 완료**되어야 한다.
- planner/designer 반환이 구조화 필드와 자연어 설명 사이에서 충돌하면, 하네스는 그것을 **미완료가 아니라 무효 반환**으로 보고 같은 역할을 다시 호출한다.
- 위 두 조건이 충족되기 전에는 developer를 호출하지 않는다.
- developer는 planner/designer 산출물이 확정된 뒤 그 결과를 코드로 반영하는 순서를 따른다.

### 기본 진행 순서
1. **planner** → 기획서 수정 + 필요 시 `wf_*` / `desc_*` 생성·수정
   - `matched_screen_id = 없음`이고 planner가 CREATE를 확정하면 이 단계에서 새 화면 정의와 새 `wf_*` / `desc_*`를 만든다
2. **designer** → 아래 중 하나라도 해당하면 `design_*` 생성·수정
   - planner 반환에 `designer_required = Y`가 명시됨
   - `wf_*` / `desc_*`가 새로 생성되거나 수정됨
   - 기획서에서 화면의 동작/UI/레이아웃/요소가 변경됨
   - 기존 `design_*`에 반영 안 된 변경이 있음
   - **판단 기준: 사용자가 화면에서 보는 것이 바뀌면 디자이너가 들어간다.** 서버만 바뀌고 화면이 안 바뀌는 경우만 제외.
   - 디자이너는 planner가 기획서/`desc_*`에 명시한 상태(empty, loading, error, disabled)와 인터랙션(모달, 서랍, 토스트, 드롭다운)만 디자인한다.
   - planner가 `action: CREATE`를 넘기면 새 `design_*`를 생성한다
   - 작업 완료 후 `developer_ready`, `developer_reason`, `developer_targets`를 반환해 다음 단계 handoff를 명시한다
3. **developer** → planner/designer 선행 완료 게이트를 통과한 뒤, designer의 `developer_ready = Y`와 `developer_targets`를 확인하고 코드 구현/수정
4. **QA** → 테스트케이스/스펙 영향이 있으면 TC 추가/수정 또는 정적 검증
5. **tester** → 코드가 변경되면 Playwright 검증 (경량 변경이면 스모크/회귀, 일반 변경이면 전체 검증)
6. 결과 전달

### 경량 변경 판단

VOC/수정 요청 중 아래에 해당하면 **경량 변경 경로**로 처리한다. 전체 루프를 처음부터 끝까지 다시 돌리지는 않는다.

- 텍스트 변경 (문구 수정, 오타, 라벨 변경) → 기획자 수정 + 사용자가 보는 문자열이면 디자이너가 `design_*` 동기화. 실제 화면 문자열/리소스 수정이 필요하면 그 뒤에 개발자 반영
- 단순 UI 조정 (색상, 간격, 폰트 크기, 정렬 수정) → 기획자 수정 + 디자이너가 `design_*` 반영. 실제 코드 스타일 수정이 필요할 때만 개발자 반영
- 요소 표시/숨김 조건 변경 (노출 여부만 바뀌는 경우) → 기획자 수정 + 디자이너 `design_*` 반영 + 필요 시 개발자가 코드 수정
- CSS만 수정되는 변경이라도 사용자가 보는 위치/크기/간격/정렬/강조/플로팅/고정 방식이 바뀌면 → 기획자 + 디자이너 선행 후 개발자 반영
- CSS만 수정되는 변경 중 사용자가 보지 못하는 리팩터링/정리만 → 개발자가 수정

경량 변경에서도 **코드가 바뀌면 검증을 완전히 생략하지 않는다.**
- 새 테스트케이스 작성은 생략할 수 있다
- 대신 테스터는 기존 핵심 스모크/회귀 검증을 반드시 수행한다
- 스모크 검증에서 실패하거나 변경 영향이 여러 화면/흐름으로 번지면 **경량 변경 경로를 중단하고 전체 흐름(기획→디자인→개발→검증)**으로 복귀한다
- 문서만 바뀌고 코드/디자인/화면이 전혀 안 바뀌는 경우에만 검증 없이 종료할 수 있다

아래에 해당하면 **경량 변경이 아니므로** 전체 흐름(기획→디자인→개발→검증)을 탄다:
- 새로운 기능 추가
- API 연동 변경
- 데이터 흐름/상태 관리 변경
- 여러 화면에 걸친 동작 변경

## 루프 요약
- 사전: 필수 항목 확인 → 사전 검토 → 벤치마킹
- 루프 A: planner 작성(wf/desc) → designer UX 리뷰 → 필요 시 A-2 반복 → designer가 design_* 생성 (화면이 있으니 디자인이 필요)
- 루프 B: developer/QA 검토 → planner 종합 수정 → 필요 시 designer가 `design_*` 재동기화
- 루프 C: developer 개발 + QA 테스트케이스 작성
- 루프 D: QA/테스터 검증 → `[분류]` 기준 라우팅 → 재검증 반복
- 통합테스트: 루프 D 통과 후, tester가 기획서/TC 기반 핵심 E2E 시나리오를 실행 → 100% PASS 시 배포 가능
- VOC: 기획자 → 디자이너 → 개발자 → QA → 테스터 (산출물이 있으면 다음 단계가 자연스럽게 이어짐)
- 마무리: secretary가 최종 보고서 작성

## 스킬 관련 사용 방법
1. 스킬은 질문에 대한 답변 및 프로젝트에 필요한 스킬을 검색하여 때에 따라 사용할 것.
