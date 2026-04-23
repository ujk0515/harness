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
- `workspace/planning/plan_{item_id}_{short_title}.md`
- `workspace/development/**`
- `workspace/reviews/**`
- `workspace/testing/**`
- `workspace/reports/**`
- `workspace/lessons-learned.md`

## 시작 규칙
1. 사용자 요청에서 아래를 먼저 확인한다.
   - 플랫폼
   - 기술 스택
2. 둘 중 하나라도 없으면 그것만 묻고 멈춘다.
3. 둘 다 있으면 `workspace/planning/project-config.md`를 최신 요청에 맞게 정리한다.
4. 요청을 `BatchN / R1, R2...` 형태로 쪼개 `workspace/planning/request-workboard.md`에 적는다.
5. 화면/서비스 참고가 필요하면 `workspace/planning/A-benchmark.md`를 작성하거나 갱신한다.
6. 각 item은 기본적으로 하나씩 처리한다.

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

## 한 사이클 = 계획 md 1개
- planner는 item마다 새 계획 파일을 만든다.
- 기본 파일명:
  - `workspace/planning/plan_{item_id}_{short_title}.md`
- 같은 item을 다시 계획하면 새 파일을 만든다.
  - 예: `plan_R3_checkout.md`
  - 예: `plan_R3_checkout_r2.md`
- 이전 파일을 덮어쓰지 않는다.
- downstream 역할에는 항상 **최신 계획 파일 경로를 프롬프트에 명시**해 전달한다.

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
2. designer `review:` 또는 `apply:` (UI 작업일 때)
3. developer `review:` (기술 리스크가 크면)
4. developer `implement:`
5. qa `review:` / `tc:` / `verify:`
6. tester `verify:` (실행 가능한 경우)
7. secretary

## 역할 생략 규칙
- 아래는 보통 designer를 생략해도 된다.
  - 백엔드-only
  - 내부 로직 정리
  - 테스트만 수정
  - 사용자에게 보이는 UI 변화가 전혀 없는 경우
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
- revise도 새 파일로 만든다.

### designer
- 외부 디자인 도구 없이 문서 안에서 ASCII와 UI 메모를 다룬다.
- `review:`는 검토 메모를 남기고
- `apply:`는 최신 계획 md의 ASCII/설명 섹션을 다듬는다.

### developer
- 최신 계획 md와 코드베이스를 기준으로 구현한다.
- `review:`는 기술 리스크와 구현 메모만 남긴다.
- `implement:`는 코드 수정이 본업이다.

### qa
- `review:`는 기획/구현의 누락과 모호함을 문서로 남긴다.
- `tc:`는 테스트케이스를 문서화한다.
- `verify:`는 정적 검증 결과를 문서화한다.

### tester
- Playwright 같은 실제 실행 검증을 맡는다.
- 실행이 어려우면 그 사유와 시도 범위를 보고서에 남긴다.

### secretary
- 전체 산출물을 묶어 최종 요약 보고서를 작성한다.
- 필요하면 `workspace/lessons-learned.md`에 짧게 교훈을 누적한다.

## 리뷰/리포트 권장 경로
- developer review:
  - `workspace/reviews/{batch_id}/{item_id}/developer-review.md`
- qa review:
  - `workspace/reviews/{batch_id}/{item_id}/qa-review.md`
- qa testcase:
  - `workspace/testing/testcases_{item_id}.md`
- qa verify:
  - `workspace/reports/qa-verify_{item_id}.md`
- tester verify:
  - `workspace/reports/tester-verify_{item_id}.md`
- final report:
  - `workspace/reports/final-report.md`

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

## designer 권장 절차
1. 최신 계획 md 읽기
2. 화면 구조와 인터랙션을 검토
3. 혼란, 누락, 상태 부족을 정리
4. 필요하면 최신 계획 md의 ASCII/설명 섹션 보강

## developer 권장 절차
1. 최신 계획 md 읽기
2. `project-config.md` 읽기
3. 기존 코드 구조 파악
4. 구현
5. 필요한 경우 간단한 자체 확인

## QA / tester 권장 절차
- QA는 문서와 코드 기준으로
  - 누락 확인
  - 테스트케이스 작성
  - 정적 검증
- tester는 실제 실행 기준으로
  - 실행 환경 준비
  - 시나리오 실행
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

## 하지 않는 것
- 무거운 게이트 계층 재도입
- 외부 디자인 툴 재도입
- 행정 문서 중심 흐름 재도입
- 상태 JSON으로 흐름 강제
- 에이전트 산출물 외 별도 행정 문서 강제
