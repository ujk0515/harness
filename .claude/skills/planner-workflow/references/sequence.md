# Planner Sequence

This file holds the detailed planner order for this repo.

## 1. 영향도 분석

### Step 1. 기존 화면 / Board 수집
1. `workspace/planning/project-config.md`를 읽고 프로젝트명과 대상 플랫폼을 파악한다.
2. 기존 기획 문서와 Penpot에서 `screen_id`, `wf_*`, `desc_*`, `design_*` 목록을 수집한다.
3. 수집 결과를 기준으로 이번 요청이 기존 화면 수정인지, 새 화면인지 판별할 준비를 한다.

### Step 1-1. 유사 흐름 / 관성 패턴 정보수집
1. `workspace/planning/A-benchmark.md`가 있으면 먼저 읽는다.
2. 현재 프로젝트 안에서 비슷한 흐름의 기존 화면을 찾는다.
3. 아래 네 묶음을 반드시 정리한다.
   - `reference_flows`
   - `expected_user_path`
   - `critical_states`
   - `avoid_patterns`
4. 이 네 묶음이 비면 바로 그리기로 넘어가지 않는다.

### Step 2. 요청 대상 화면 판별
- `UPDATE`: 기존 `screen_id` 수정
- `CREATE`: 새 `screen_id` 필요
- `UPDATE+CREATE`: 둘 다 필요
- `NO_CHANGE`: Penpot 영향 없음

기본값은 `UPDATE`다. 새 `screen_id`는 정말 필요할 때만 만든다.

### Step 3. 판별 결과별 경로
- `UPDATE`
  - 기존 기획서 수정
  - 기존 `wf_*` / `desc_*` 수정
- `CREATE`
  - 기획서에 새 화면 섹션 추가
  - 새 `wf_*` / `desc_*` 생성
- `UPDATE+CREATE`
  - 둘을 분리해서 각각 처리
- `NO_CHANGE`
  - Penpot 영향 없음 사유 명시

### Step 4. 디자이너 가이드 작성
반환에는 항상 아래를 포함한다.
- `action`
- `designer_required`
- `design_reason`
- `design_target_boards`
- `matched_screen_id`
- `matched_boards`
- `request_coverage`
- `covered_items`
- `missing_items`

## 2. plan: 최초 기획 작성
1. 작업 보드를 먼저 읽는다.
2. 위 영향도 분석 1~4를 순서대로 수행한다.
3. 요구사항에 있는 기능만 기획서에 쓴다.
4. 기획서에는 최소 아래를 포함한다.
   - 프로젝트 개요
   - 우선순위
   - 기능 명세
   - 비범위
   - 제약/의존성
   - 화면 목록
   - Mermaid 흐름도
   - API / DB 개요(있을 때)
5. 화면마다 `wf_*` + `desc_*` 쌍을 맞춘다.
6. `wf_*`는 구조, `desc_*`는 사용자 화면 설명만 쓴다.
7. `desc_*`는 큰 틀 -> 메타 텍스트 -> 번호 포함 텍스트 블록 순서로 작성한다.
8. `배경 > 넘버링 > 텍스트` 순서는 금지한다.
9. 각 텍스트 블록 생성 후 높이를 확인하고 다음 블록은 하단 + gap으로 배치한다.
10. `export_shape`로 겹침/누락을 확인한다.
11. 마지막에 gap check를 돌리고 claim/evidence를 남긴다.

## 3. revise: 루프 B 반영
1. 먼저 각 item의 review bundle만 읽는다.
   - `workspace/reviews/{batch_id}/{item_id}/developer-review.md`
   - `workspace/reviews/{batch_id}/{item_id}/qa-review.md`
2. 각 의견에 대해 `수긍`, `반박`, `보완`, `보류` 중 하나를 정한다.
3. 구조/동작/상태 정의가 바뀌면 기획서와 `wf_*` / `desc_*`를 같이 고친다.
4. 리뷰를 읽기만 하고 반영 여부를 비워두지 않는다.
5. planner 반영이 끝나면 designer가 `design_*`를 다시 맞출 수 있게 변경 근거를 넘긴다.

## 4. VOC / 업데이트
1. 작업 보드를 먼저 읽는다.
2. 영향도 분석 1~4를 같은 순서로 다시 수행한다.
3. 기존 흐름과 사용자 관성을 비교한 뒤 기획을 수정한다.
4. `UPDATE`, `CREATE`, `UPDATE+CREATE`, `NO_CHANGE`를 명시한다.
5. gap check 후 디자이너 가이드까지 포함해 반환한다.

## 5. Penpot 최소 규칙
- 플랫폼별 Penpot 페이지를 분리한다.
- 화면 하나당 `wf_*` + `desc_*` 쌍을 유지한다.
- `wf_*`는 구조만, `desc_*`는 설명만 담당한다.
- `desc_*`는 번호와 제목을 같은 텍스트 첫 줄에 쓴다.
- 구현 용어(API, DB, props 등)를 `desc_*`에 쓰지 않는다.
- 완료 전 `export_shape` 확인은 필수다.
