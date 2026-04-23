# Task Gate Checklists

이 문서는 validator가 역할별 `done ticket`을 발급할 때 어떤 **기계 검증 항목**을 통과해야 하는지 정리한다.
정본은 [task-gate-checklists.json](/Users/yoojaekwon/Desktop/develop/harness/workflow/checklists/task-gate-checklists.json:1)이고, 이 문서는 사람이 읽는 설명본이다.

## 현재 게이트 방식

- 입구 차단: `PreToolUse(Agent)`
- 매핑 다리: `SubagentStart`
- 출구 차단: `SubagentStop`
- `TaskCreated` / `TaskCompleted` / `TeammateIdle`는 현재 Agent 호출 패턴에서 주 게이트로 쓰지 않는다.
- 한 번에 하나의 Agent만 in-flight 상태여야 하며, dispatch lock으로 강제한다.

## 작업명 규칙

- 모든 Agent `description`은 아래 형식을 따른다.
- 형식: `[Batch{N}][R{M}][role] subject`
- 예: `[Batch8][R17][tester] floating-button verification`
- 이 형식을 어기면 `PreToolUse(Agent)`에서 입구 차단된다.

## 검증 원칙

- `done ticket`은 에이전트가 직접 만들지 않는다. validator가 발급한다.
- 공통 기준은 3가지다.
- claim 파일은 현재 시도(`dispatch_created_at`) 이후 갱신되어야 한다.
- evidence는 `workspace/evidence/{role}/{batch_id}/{item_id}/` 아래 현재 시도 이후 생성/수정 흔적이 있어야 한다.
- shared report는 파일 존재만이 아니라 현재 시도 이후 `mtime` 갱신으로 본다.

## 역할별 핵심 체크

### Planner

- `revise:` 모드에서는 transcript 안에 `wf_*` / `desc_*` 삭제/재할당 호출이 없어야 함
- `workspace/claims/{batch_id}/{item_id}/planner.claim.json`가 현재 시도 이후 갱신
- claim의 `covered_items`에 현재 `item_id` 포함
- claim 안의 `wf_boards`, `desc_boards`가 비어 있지 않음
- claim 안의 `reference_flows`, `expected_user_path`, `critical_states`, `avoid_patterns`가 비어 있지 않음
- claim 안의 `export_shape_summary` 존재
- claim 안의 `missing_items`가 비어 있음
- claim 안에 유예/나중 처리 표현이 없어야 함
- claim 안의 `request_coverage`, `routing`, `read_log`, `action_rationale`, `planning_doc_sections`, `user_raw`, `pre_review`가 유효해야 함
- `workspace/evidence/planner/{batch_id}/{item_id}/wf-export.json`가 현재 시도 이후 갱신
- `wf-export.json` 안의 `type = wf_export`, `board_id` 존재, `board_name`이 `wf_`로 시작
- `workspace/evidence/planner/{batch_id}/{item_id}/desc-export.json`가 현재 시도 이후 갱신
- `desc-export.json` 안의 `type = desc_export`, `board_id` 존재, `board_name`이 `desc_`로 시작
- `A-planning-doc.md`가 표준 섹션과 현재 시도 기준 내용 변경을 포함해야 함
- claim의 `wf_boards` / `desc_boards`가 실제 Penpot 보드 목록에도 존재해야 함
- `desc-export`에 구현 용어(API/DB/hook/props 등)가 없어야 함
- `request-state.json`의 planner status가 `done`

### Designer

- `apply:` 모드에서는 transcript 안에 `wf_*` / `desc_*` 삭제/재할당 호출이 없어야 함
- `workspace/claims/{batch_id}/{item_id}/designer.claim.json`가 현재 시도 이후 갱신
- claim의 `covered_items`에 현재 `item_id` 포함
- apply claim에서는 `developer_ready = Y`, `developer_targets`/`design_boards` 비어 있지 않음, `missing_items` 비어 있음
- review claim에서는 `mode=review`, `review_score`, `review_approval`, `review_issues`, `review_summary`가 완결돼 있어야 함
- `workspace/evidence/designer/{batch_id}/{item_id}/design-export.json`가 현재 시도 이후 갱신
- `design-export.json` 안의 `type = design_export`, `board_id` 존재, `board_name`이 `design_`으로 시작
- `workspace/evidence/designer/{batch_id}/{item_id}/boards.json`가 현재 시도 이후 갱신
- `boards.json` 안의 `design_boards`가 비어 있지 않음
- planner가 넘긴 대상 보드와 `wf_*` 기준 screen_id를 전부 커버해야 함
- claim의 `design_boards`가 실제 Penpot 보드 목록에도 존재해야 함
- `design_*`는 대응 `wf_*` / `desc_*` 아래에 배치되고 서로 겹치지 않아야 함
- `request-state.json`의 designer status가 `done`

### Developer

- transcript에 `workspace/planning/request-workboard.md` Read 호출 존재
- transcript에 `workspace/planning/project-config.md` Read 호출 존재
- transcript에 `workspace/planning/A-planning-doc.md` Read 호출 존재
- transcript에 `workspace/claims/{batch_id}/{item_id}/developer.claim.json` Write/Edit 호출 존재
- transcript에서 developer claim 쓰기 호출이 구현 evidence 생성 이후에 존재
- `workspace/claims/{batch_id}/{item_id}/developer.claim.json`가 현재 시도 이후 갱신
- claim의 `covered_items`에 현재 `item_id` 포함
- `workspace/evidence/developer/{batch_id}/{item_id}/`에 현재 시도 이후 evidence 존재
- `request-state.json`의 developer status가 `done`

### QA

- transcript에 `workspace/planning/request-workboard.md` Read 호출 존재
- transcript에 `workspace/planning/project-config.md` Read 호출 존재
- transcript에 `workspace/planning/A-planning-doc.md` Read 호출 존재
- transcript에 `workspace/claims/{batch_id}/{item_id}/qa.claim.json` Write/Edit 호출 존재
- `workspace/claims/{batch_id}/{item_id}/qa.claim.json`가 현재 시도 이후 갱신
- `workspace/evidence/qa/{batch_id}/{item_id}/`에 현재 시도 이후 evidence 존재
- `workspace/reports/.qa-last-run.json`이 현재 시도 이후 갱신
- `workspace/reports/D-qa-verification.md`가 현재 시도 이후 갱신
- `request-state.json`의 qa status가 `done`

### Tester

- transcript에 `workspace/planning/request-workboard.md` Read 호출 존재
- transcript에 `workspace/planning/project-config.md` Read 호출 존재
- transcript에 `workspace/planning/A-planning-doc.md` Read 호출 존재
- transcript에 `workspace/claims/{batch_id}/{item_id}/tester.claim.json` Write/Edit 호출 존재
- transcript에 `workspace/testing/.tester-state.json` Write/Edit 호출 존재
- `workspace/claims/{batch_id}/{item_id}/tester.claim.json`가 현재 시도 이후 갱신
- `workspace/evidence/tester/{batch_id}/{item_id}/`에 현재 시도 이후 evidence 존재
- `workspace/reports/playwright-results.json`이 현재 시도 이후 갱신
- `workspace/reports/D-tester-verification.md`가 현재 시도 이후 갱신
- `request-state.json`의 tester status가 `done`

### Secretary

- `workspace/claims/{batch_id}/{item_id}/secretary.claim.json`가 현재 시도 이후 갱신
- `workspace/evidence/secretary/{batch_id}/{item_id}/`에 현재 시도 이후 evidence 존재
- `workspace/reports/final-report.md`가 현재 시도 이후 갱신
- `workspace/reports/final-report.md`에 `요약` 섹션 존재
- `request-state.json`의 secretary status가 `done`

## 메모

- `skipped`도 ticket이 있어야 유효하다. `skip ticket` 없는 `skipped`는 무효다.
- validator는 `workflow/checklists/task-gate-checklists.json`을 읽어 실행한다.
- 체크 1개라도 실패하면 `done ticket`은 발급되지 않고, 같은 역할이 다시 루프를 돈다.
