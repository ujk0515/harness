# Planner Penpot Reference

이 문서는 planner의 Penpot 세부 구현 참조다. 정본 계약과 게이트 규칙은 `/.claude/agents/planner.md`를 따른다.

## 페이지 규칙
- 플랫폼별 페이지를 분리한다.
- 페이지 이름은 `{프로젝트명} — {플랫폼}` 형식을 사용한다.
- 모바일/데스크톱/태블릿 보드를 같은 페이지에 섞지 않는다.

## Board 구조
- 화면 1개는 항상 2개 Board 쌍으로 만든다.
  - `wf_[screen_id]`
  - `desc_[screen_id]`
- 두 Board는 같은 y축에 두고 x축으로 나란히 배치한다.
- 모바일 기본 반복 단위는 `970px`를 사용한다.
- 데스크톱 기본 반복 단위는 `2100px`를 사용한다.

## `wf_*` 원칙
- 구조만 만든다. 디자인하지 않는다.
- 회색 계열만 사용한다.
- 실제 라벨/버튼명/placeholder를 쓴다.
- 나중에 디자이너가 그대로 참조할 수 있어야 한다.
- 기존 `wf_*` / `desc_*` 수정은 항상 in-place만 한다.
- 삭제 후 재생성 금지.
- 텍스트 변경은 `characters`, 위치/크기는 `.x`, `.y`, `.resize()`처럼 필요한 속성만 수정한다.
- `.remove()`, `removeShape(...)`, `deleteShape(...)`, `children 재할당/splice/filter 재구성`은 금지한다.

## `desc_*` 원칙
- 개발 메모가 아니라 사용자 화면 설명 보드다.
- `API`, `DB`, `payload`, `hook`, `props`, `className`, 파일 경로 같은 구현 용어를 금지한다.
- 큰 틀 Board 1개 + 메타 텍스트 + 번호 텍스트 블록으로만 구성한다.
- 번호는 별도 shape로 만들지 않는다.
- 순서는 항상 아래를 따른다.
  1. 큰 틀 Board 생성
  2. 메타 텍스트 작성
  3. 번호 포함 텍스트 블록 생성
  4. 텍스트 높이 확인
  5. `이전 블록 하단 + gap`으로 다음 블록 배치
- `배경 > 넘버링 > 텍스트` 방식은 금지한다.
- 표/셀/헤더 바/번호별 배경 rect는 금지한다.

## `desc_*` 텍스트 블록 형식
- 첫 줄: `1. 요소명 또는 블록명`
- 이후 줄: 들여쓰기된 불릿
- 권장 항목:
  - `• 역할/표시 정보`
  - `• 동작`
  - `• 상태`
  - `• 유효성/제한`
  - `• 조건부 노출`
- 상위 불릿 6개 초과, 전체 줄 수 10줄 초과 예상 시 다음 No 블록으로 분리한다.

## 텍스트 배치
- 텍스트는 `left align + auto-height`
- 높이를 고정하지 않는다.
- `resize(width, smallSeedHeight)`는 초기 씨드값일 뿐이고, 실제 높이로 간주하지 않는다.
- 다음 블록 위치는 **반드시 auto-height 적용 후의 실측 `descText.height`**를 읽어 계산한다.
- 실측 높이 확인 전에는 다음 번호 블록을 배치하지 않는다.
- 한글 줄 수가 늘어나면 블록 높이도 늘어난다고 가정한다.

```javascript
descText.resize(380, 8); // seed height only
descText.growType = "auto-height";
await new Promise((r) => setTimeout(r, 100));
const measuredHeight = descText.height;
const nextY = descText.y + measuredHeight + 16;
```

## 실행 분할
- 한 번의 `execute_code`에 shape 10개 이내.
- 한 dispatch 전체 기준 `execute_code`는 최대 5회, `export_shape`는 최대 2회까지만 사용한다.
- 보드 전체를 다시 그리려 하지 말고, 필요한 부분만 작은 수정으로 끝낸다.
- 권장 순서:
  1. `wf_*` Board 생성
  2. `wf_*` 상단 구조
  3. `wf_*` 중간/하단 구조
  4. `desc_*` Board 생성
  5. `desc_*` 메타 텍스트
  6. `desc_*` 번호 텍스트 블록

## 저장 키
- `storage.nextPairX`
- `storage.nextDesktopPairX`
- `storage.screens[screenId]`

## 검증
- `wf_*` / `desc_*` 생성 후 `export_shape`로 최종 확인한다.
- 아래가 보이면 미완료다.
  - 텍스트 겹침
  - Board 밖으로 넘친 텍스트
  - 번호 블록끼리 맞닿거나 겹침
  - 구현 용어가 `desc_*`에 노출됨
- `revise:`에서는 작업 시작 전/종료 후 `wf_*` / `desc_*` Board snapshot을 evidence로 남겨 기존 Board id가 유지되는지 확인한다.

## 반환 전 필수 evidence
- `planner.claim.json`
- `wf-export.json`
- `desc-export.json`
- `export_shape_summary`
