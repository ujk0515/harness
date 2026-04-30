# 하네스 동작 규칙

## 목적
- 이 저장소의 하네스는 최소한의 규칙과 프롬프트로 여러 역할을 순서대로 호출하는 오케스트레이터다.
- 별도 게이트 엔진, 외부 디자인 툴, 행정용 산출물 계층은 사용하지 않는다.
- 판단 근거는 주로 `request-workboard.md`, `project-config.md`, `A-benchmark.md`, 각 사이클의 계획 md, 그리고 실제 코드/리뷰/리포트 파일이다.

## 기본 원칙
- 요청이 명확하면 중간 확인 없이 계속 진행한다.
- 요청이 모호하거나 필수 정보가 비어 있으면 그때만 짧게 묻는다.
- 에이전트 호출 순서는 권장일 뿐 강제 게이트가 아니다.
- 작은 작업, 비UI 작업, 백엔드-only 작업은 일부 역할을 건너뛸 수 있다.
- 추가 서류와 상태 파일은 만들지 않는다.
- 에이전트는 자기 산출물만 남기고 끝낸다.

## 유지하는 핵심 파일
- `workspace/planning/project-config.md`
- `workspace/planning/request-workboard.md`
- `workspace/planning/A-benchmark.md`
- `workspace/cycles/{batch_id}_{YYYYMMDD-HHMM}.md` (사이클 통합 문서)
- `workspace/development/**`
- `workspace/testing/**`
- `workspace/reports/**`
- `workspace/lessons-learned.md`

## 사이클 통합 문서 규칙
- 한 batch = `workspace/cycles/{batch_id}_{YYYYMMDD-HHMM}.md` 파일 1개.
- 모든 에이전트(planner / developer / qa / tester / secretary)는 이 파일 안에 자기 전용 섹션을 갖는다.
- 자기 섹션은 in-place 수정 가능. **다른 에이전트 섹션은 읽기 전용**. 직접 수정 금지.
- 다른 에이전트 산출물에 대한 의견/딴지는 같은 파일 하단의 `## [코멘트/이슈]` 섹션에 `[보낸이→받는이]` 형식으로 추가한다.
- 코멘트를 받은 에이전트는 자기 섹션을 갱신한 뒤 해당 코멘트 줄의 상태를 `open → resolved` 로 바꾼다.
- 통합 문서 헤더(제목, batch_id, 생성일시, 참여 에이전트, 종료일시)는 `.claude/scripts/cycle-init.js` 가 강제 주입/갱신한다. 사람 손으로 형식을 바꾸지 않는다.
- 같은 batch에서 재호출/재기획이 일어나도 새 파일을 만들지 않고 같은 파일 안에서 자기 섹션을 갱신한다. **새 파일은 새 batch에서만 생성한다.**
- `workspace/cycles/` 폴더는 최대 **10개**까지만 유지한다. 11개째 파일이 생기면 `.claude/scripts/cycle-rotate.js` 가 가장 오래된 timestamp 파일을 자동 삭제한다.

## 통합 문서 섹션 순서
- `## [Planner]`
- `## [Developer]`
- `## [QA]`
- `## [Tester]`
- `## [Secretary]`
- `## [코멘트/이슈]`

## 시작 규칙
1. 사용자 요청에서 아래를 먼저 확인한다.
   - 플랫폼
   - 기술 스택
2. 둘 중 하나라도 없으면 그것만 묻고 멈춘다.
3. 둘 다 있으면 `workspace/planning/project-config.md`를 최신 요청에 맞게 정리한다.
   - 실행 가능한 프로젝트라면 실행 계약도 함께 적는다.
   - 최소 항목:
     - 프론트 실행 명령
     - 서버 실행 명령
     - 기본 URL
     - API URL
     - 기본 테스트 명령
     - smoke 테스트 명령
     - full 회귀 명령 (있을 때)
     - diag/debug 명령 (있을 때)
     - item 범위 테스트 명령 또는 target spec / grep
     - 스크린샷/리포트 저장 경로
   - 아직 확인되지 않은 값은 추측으로 늘리지 말고 `미정`으로 적는다.
4. 사전 검토 단계를 수행한다 (아래 `## 사전 검토 단계` 섹션). 질문이 남으면 **사용자 답변을 받기 전에는 다음 단계로 가지 않는다**.
5. 요청을 `BatchN / R1, R2...` 형태로 쪼개 `workspace/planning/request-workboard.md`에 적는다.
6. 화면/서비스 참고가 필요하면 `workspace/planning/A-benchmark.md`를 작성하거나 갱신한다.
7. 각 item은 기본적으로 하나씩 처리한다.

## 사전 검토 단계

- 플랫폼/기술 스택이 확인된 뒤, 작업 보드 생성과 planner 호출 **이전**에 하네스가 직접 요청을 읽고 구멍을 탐지한다.
- 이 단계에서 planner 나 다른 에이전트를 호출하지 않는다.

### 검토 관점
- 화면/기능 누락
- 상태 누락 (빈, 로딩, 오류, 성공 이후 등)
- 입출력 기준 불명확
- 예외 흐름 누락 (취소, 재시도, 중복 입력, 잘못된 입력, 권한 부족 등)
- 외부 의존성 누락 (API, 인증, 결제, 지도, 푸시, 업로드 등)

### 규칙
- 질문은 기본 3~10개 내외. 중요도 순으로 정렬한다.
- 사용자 원문에 이미 있는 내용을 다시 묻지 않는다.
- 구체적 해결책을 제시하지 않는다. 누락 지적과 빠진 항목 질문만 한다.
- "어떻게 할까요?", "원하시는 방향은?" 같은 두루뭉술 질문은 금지한다.
- 구멍이 없으면 "특이사항 없음, 진행합니다" 한 줄 알리고 바로 다음 단계로 자동 진행한다.

### 흐름
1. 질문이 있으면 질문을 던지고 **사용자 답변이 올 때까지 멈춘다. 자동 진행 금지.**
2. 사용자가 답하면 그 답변을 작업 보드와 planner 프롬프트에 반영한 뒤 본격 시작한다.

## 요청 작업 보드 규칙
- 한 행은 하나의 주요 변경만 담는다.
- 최소 컬럼:
  - `item_id`
  - `요청 항목`
  - `유형`
  - `플랫폼`
  - `우선순위`
  - `권장 역할`
  - `메모`
- 예시 유형:
  - 신규 화면
  - 기존 화면 수정
  - 문구 수정
  - 동작 수정
  - 백엔드/API
  - 테스트/검증

## 한 사이클 = 통합 문서 1개
- batch마다 `workspace/cycles/{batch_id}_{YYYYMMDD-HHMM}.md` 파일 1개를 만든다.
- planner / developer / qa / tester / secretary 가 이 파일 안에 자기 섹션을 채운다.
- 같은 batch 안에서는 새 파일을 만들지 않는다. 자기 섹션을 in-place 갱신한다.
- 새 batch가 시작될 때만 새 통합 문서를 생성한다.
- downstream 역할에는 항상 **현재 batch 통합 문서 경로를 프롬프트에 명시**해 전달한다.

### 통합 문서 생성/조회 절차 (메인 하네스 책임)
1. 새 batch 시작 시점에 메인 하네스가 한 번 실행:
   - `node .claude/scripts/cycle-init.js {batch_id} "{title}"`
   - stdout 으로 통합 문서 절대 경로가 출력된다. 같은 batch 재호출 시 같은 경로가 나온다.
2. 그 경로를 모든 에이전트 dispatch prompt 의 `통합 문서:` 헤더에 그대로 넣어 전달한다.
3. 마지막으로 secretary 호출이 끝나면 메인 하네스가 통합 문서 헤더의 `종료일시: (미정)` 줄을 실제 시각(YYYY-MM-DD HH:MM)으로 1회 갱신한다.
4. 폴더 한도(10개) 정리는 `cycle-init.js` 가 새 batch 통합 문서를 만들 때 자동으로 1회 호출한다. 일반 대화/응답 종료에는 hook 이 붙어 있지 않다 (의도적 — 하네스 동작 시점에만 정리되도록).

## 계획 md 필수 구조
- 표준은 `workflow/standards/planning-doc-sections.md`
- 템플릿은 `workflow/standards/planning-cycle-template.md`
- 최소 섹션:
  - 제목
  - 사용자 원문
  - 목표
  - 기능 명세
  - 화면/플로우 요약
  - ASCII 화면
  - 요소 디스크립션
  - 동작·상태
  - 실행·검증 메모 (실행 가능한 프로젝트일 때)
  - 완료 기준
  - 비범위

## ASCII 화면 규칙
- ASCII는 구조, 우선순위, 상태, 상호작용을 전달하기 위한 문서다.
- 픽셀 정밀도가 아니라 읽기 쉬운 구조 전달이 목적이다.
- 한 화면은 하나 이상의 fenced code block으로 정리한다.
- 권장 표기:
  - 버튼: `[저장]`
  - 입력: `[이메일 입력____________]`
  - 체크박스: `[x]`, `[ ]`
  - 라디오: `(o)`, `( )`
  - 탭: `[목록] [상세] [설정]`
  - 영역: `+----------------------+`
  - 모달/시트: 별도 박스로 분리
- 반드시 포함할 것:
  - 기본 화면
  - 빈 상태/로딩/오류 중 필요한 상태
  - 주요 CTA
  - 모달, 드로어, 토스트 등 핵심 인터랙션

## 권장 역할 순서
1. planner `plan:` 또는 `revise:`
2. developer `review:` (기술 리스크가 크면)
3. developer `implement:`
4. qa `review:` / `tc:` / `verify:`
5. tester `verify:` (실행 가능한 경우)
6. secretary

## 역할 생략 규칙
- 아래는 보통 planner를 생략하지 않는 편이 낫다.
  - 신규 화면
  - 상태 변화가 많은 UI 수정
  - 사용자 흐름 변경
  - 여러 화면에 걸친 복합 기능
- 단, 모두 권장일 뿐이다. 하네스가 이미 충분히 명확한 입력과 산출물을 갖고 있으면 바로 다음 역할로 갈 수 있다.

## 역할별 출력 원칙

### planner
- 최신 요청을 읽고 새 계획 md를 만든다.
- 계획 md 안에 기획 + ASCII 화면 + 요소 디스크립션을 통합한다.
- 실행 가능한 프로젝트라면 tester가 바로 쓸 수 있게 item 범위 실행 메모를 적는다.
- revise도 새 파일로 만든다.

### developer
- 최신 계획 md와 코드베이스를 기준으로 구현한다.
- `review:`는 기술 리스크와 구현 메모만 남긴다.
- `implement:`는 코드 수정이 본업이다.

### qa
- `review:`는 기획/구현의 누락과 모호함을 문서로 남긴다.
- `tc:`는 item 범위 핵심 테스트케이스를 문서화한다.
- `verify:`는 정적 검증 결과를 문서화한다.

### tester
- Playwright 같은 실제 실행 검증을 맡는다.
- 기본은 item 범위 spec / grep / route만 실행한다.
- full 회귀나 진단 spec 실행은 명시 요청 또는 높은 회귀 위험이 있을 때만 한다.
- 먼저 `project-config.md`와 계획 md에서 실행 계약을 확인한다.
- 실행 계약이 비어 있으면 포트를 반복 추측하지 말고 부족한 항목을 보고서에 남긴다.
- 절대 경로 대신 repo 상대 경로만 사용한다.
- Playwright를 쓰는 repo라면 기본 실행 구조는 `smoke` / `full` / `diag` 분리를 권장한다.
- Playwright `baseURL`과 `webServer` 또는 동등한 실행 스크립트가 repo 코드에 있어야 한다.
- spec 안에 특정 포트 URL을 하드코딩하지 않고 config/project 설정을 우선한다.
- 디버그/진단 spec은 기본 실행 범위 밖에 둔다.
- `waitForTimeout` 같은 고정 대기는 기본 수단이 아니다. selector / response / 상태 클래스 대기를 우선한다.
- 실행이 어려우면 그 사유와 시도 범위를 보고서에 남긴다.

### secretary
- 전체 산출물을 묶어 최종 요약 보고서를 작성한다.
- 필요하면 `workspace/lessons-learned.md`에 짧게 교훈을 누적한다.

## 리뷰/리포트 권장 경로
- developer review / qa review / planner 회신 등 모든 문서 형태의 의견은 사이클 통합 문서(`workspace/cycles/{batch_id}_{ts}.md`) 안의 자기 섹션 또는 `## [코멘트/이슈]` 영역에 적는다.
- 다음은 **통합 문서 외부에 별도 파일로 남기는 것을 허용**한다 (코드/실행 산출물 성격이라 본문에 다 박으면 가독성이 깨지기 때문):
  - qa testcase: `workspace/testing/testcases_{item_id}.md`
  - tester spec: `workspace/testing/playwright/{item_id}.spec.ts`
  - 실행 결과 JSON: `workspace/reports/playwright-results-{item_id}.json`
  - 실행 로그: `workspace/reports/playwright-run-{item_id}.log`
  - final report: `workspace/reports/final-report.md`
- 위 외부 파일을 만들었으면 통합 문서의 자기 섹션에 **경로만** 인용한다. 본문 복붙은 하지 않는다.

## planner 권장 절차
1. `request-workboard.md` 읽기
2. `project-config.md` 읽기
3. 필요 시 `A-benchmark.md` 읽기
4. `planning-doc-sections.md`와 템플릿 읽기
5. item별 새 계획 md 생성
6. 기능 명세 작성
7. ASCII 화면 작성
8. 요소 디스크립션 작성
9. 동작·상태 작성
10. 완료 기준과 비범위 정리

## developer 권장 절차
1. 최신 계획 md 읽기
2. `project-config.md` 읽기
3. 기존 코드 구조 파악
4. 구현
5. 필요한 경우 간단한 자체 확인

## QA / tester 권장 절차
- QA는 문서와 코드 기준으로
  - item 범위 누락 확인
  - item 범위 테스트케이스 작성
  - 정적 검증
- tester는 실제 실행 기준으로
  - 실행 계약 확인
  - Playwright config / scripts 구조 확인
  - item 범위 spec 작성 또는 보완
  - item 범위 시나리오 실행
  - 실패/회귀 기록

## secretary 권장 절차
1. 계획 md, 리뷰, 테스트, 리포트를 읽는다.
2. 최종 상태를 요약한다.
3. 남은 이슈가 있으면 숨기지 않는다.
4. `workspace/reports/final-report.md`에 기록한다.

## 중간에 멈추는 경우
- 필수 정보 부족
- 실행 환경 부족
- 외부 비밀값/API 키 부족
- 의존 서비스가 실제로 내려가 있음
- 사용자 판단이 꼭 필요한 범위 변경

## 코멘트/이슈 영역 규칙
- 형식: `- [{보낸이}→{받는이}] (open|resolved) {YYYY-MM-DD HH:MM} 내용`
- 예: `- [Developer→Planner] (open) 2026-04-28 14:30 로그인 화면 빈 상태 누락`
- 코멘트는 **추가만**. 다른 사람이 쓴 코멘트 본문을 고쳐 쓰지 않는다.
- 받는이가 자기 섹션을 갱신한 뒤 그 줄의 `(open)` 을 `(resolved)` 로 바꾼다.
- resolved 줄을 다시 open 으로 되돌리지 않는다. 재논의가 필요하면 새 코멘트 줄을 추가한다.

## 하지 않는 것
- 무거운 게이트 계층 재도입
- 외부 디자인 툴 재도입
- 행정 문서 중심 흐름 재도입
- 상태 JSON으로 흐름 강제
- 에이전트 산출물 외 별도 행정 문서 강제
- 통합 문서 안에서 다른 에이전트 섹션을 직접 수정
