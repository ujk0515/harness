# Designer Reference

이 문서는 designer의 상세 디자인/토큰/구현 참조다. 정본 계약과 게이트 규칙은 `/.claude/agents/designer.md`를 따른다.

## 모드
- `review:` 모드
  - 기획서 + `wf_*` + `desc_*` 리뷰
  - `design_*` 생성/수정 금지
  - 결과는 `workspace/design/A-uiux-review.md`
- `apply:` 모드
  - `design_*` 생성/수정
  - claim/evidence 작성
  - 이 모드만 `designer.done` 대상

## 폰트
- `project-config.md`에 지정이 있으면 그 폰트를 사용한다.
- 미지정이면 기본값은 `Pretendard`.

## spacing
- 4px 배수, 8px 중심.
- 자주 쓰는 값:
  - `8`, `12`, `16`, `24`, `32`, `48`

## typography
- `Display`: `28/700`
- `H1`: `22/700`
- `H2`: `18/600`
- `Body`: `15/400`
- `Label`: `13/500`
- `Caption`: `11/400`

## 정렬
- 가운데 정렬은 필요한 곳에만 쓴다.
- 헤더 제목, 버튼 라벨, 빈 상태 안내는 center를 우선 검토한다.
- 카드 내용, 입력 placeholder, 에러 문구는 left를 우선 검토한다.
- 가격/숫자 정보는 right를 우선 검토한다.

## 컴포넌트 기본값
- 버튼: `radius 12`
- 입력: `radius 10`, `stroke 1.5 #E2E8F0`
- 카드: `radius 16`
- 모달/바텀시트: 상단 `radius 20`
- pill은 작은 태그/칩/원형 아이콘 버튼에만 허용

## 색/표면
- Primary: `#2563EB`
- 진한 헤더/탭바: `#1E3A5F`
- 페이지 배경: `#F8FAFC`
- 카드 배경: `#FFFFFF`
- 구분선: `#E2E8F0`

## apply 모드 핵심
- `design_*`만 수정한다. `wf_*` / `desc_*`는 건드리지 않는다.
- 대응 `wf_*`와 같은 페이지, 같은 x축을 사용한다.
- y좌표는 `max(wf.bottom, desc.bottom) + 120`.
- `placeholder` 대신 실제 예시 데이터를 쓴다.
- 상태/오버레이/인터랙션은 기획에 명시된 범위만 만든다.
- `wf_*` / `desc_*`는 읽기 전용이다.
- `findShape`로 찾아 좌표/크기/구조를 읽는 것까지만 허용한다.
- `.remove()`, `removeShape(...)`, `deleteShape(...)`, `children 재할당/splice/filter 재구성`은 금지한다.
- 작업 시작 전/종료 후 `wf_*` / `desc_*` Board snapshot을 evidence로 남겨 기존 Board id가 유지되는지 확인한다.

## update/create 분기
- 기존 대응 `design_*`가 있으면 UPDATE 우선.
- 새 Board는 아래를 모두 만족할 때만 CREATE.
  - `matched_screen_id` 없음
  - 기존 `design_*` 없음
  - planner가 CREATE 사유를 넘김

## Penpot 패턴
- 새 `design_*` 만들기 전에 같은 페이지의 기존 `design_*`를 먼저 본다.
- `Flex Layout`은 쓰지 않는다. 절대 좌표로 배치한다.
- 텍스트는 항상 `resize + auto-height`.

```javascript
const text = penpot.createText("제목");
text.resize(300, 20);
text.growType = "auto-height";
```

## 금지
- `wf_*`를 색만 바꿔 재사용
- 빈 도형만 놓고 아이콘 자리 처리
- 의미 없는 placeholder 텍스트
- 무조건 center 정렬

## 검증
- `export_shape`로 최종 확인한다.
- Board 밖 overflow, 좌우 패딩 붕괴, 요소 미노출이 있으면 미완료다.

## 반환 전 필수 evidence
- `designer.claim.json`
- `design-export.json`
- `boards.json`
