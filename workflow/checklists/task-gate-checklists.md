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

- `workspace/claims/{batch_id}/{item_id}/planner.claim.json`가 현재 시도 이후 갱신
- claim의 `covered_items`에 현재 `item_id` 포함
- claim 안의 `wf_boards`, `desc_boards`, `export_shape_summary` 존재
- `workspace/evidence/planner/{batch_id}/{item_id}/wf-export.json`가 현재 시도 이후 갱신
- `wf-export.json` 안의 `type = wf_export`, `board_id` 존재, `board_name`이 `wf_`로 시작
- `workspace/evidence/planner/{batch_id}/{item_id}/desc-export.json`가 현재 시도 이후 갱신
- `desc-export.json` 안의 `type = desc_export`, `board_id` 존재, `board_name`이 `desc_`로 시작
- `request-state.json`의 planner status가 `done`

### Designer

- `workspace/claims/{batch_id}/{item_id}/designer.claim.json`가 현재 시도 이후 갱신
- claim 안의 `developer_targets` 존재
- `workspace/evidence/designer/{batch_id}/{item_id}/design-export.json`가 현재 시도 이후 갱신
- `workspace/evidence/designer/{batch_id}/{item_id}/boards.json`가 현재 시도 이후 갱신
- `request-state.json`의 designer status가 `done`

### Developer

- `workspace/claims/{batch_id}/{item_id}/developer.claim.json`가 현재 시도 이후 갱신
- claim의 `covered_items`에 현재 `item_id` 포함
- `workspace/evidence/developer/{batch_id}/{item_id}/`에 현재 시도 이후 evidence 존재
- `workspace/reports/B-tech-review.md`가 현재 시도 이후 갱신
- `request-state.json`의 developer status가 `done`

### QA

- `workspace/claims/{batch_id}/{item_id}/qa.claim.json`가 현재 시도 이후 갱신
- `workspace/evidence/qa/{batch_id}/{item_id}/`에 현재 시도 이후 evidence 존재
- `workspace/reports/.qa-last-run.json`이 현재 시도 이후 갱신
- `workspace/reports/D-qa-verification.md`가 현재 시도 이후 갱신
- `request-state.json`의 qa status가 `done`

### Tester

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
