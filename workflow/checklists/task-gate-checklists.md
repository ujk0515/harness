# Task Gate Checklists

이 문서는 `request-state.json`의 역할별 체크리스트를 어떤 **기계 검증 명령**으로 판정할지 정리한 초안이다.
실제 validator는 [task-gate-checklists.json](/Users/yoojaekwon/Desktop/develop/harness/workflow/checklists/task-gate-checklists.json:1)을 읽어 동작한다.
모든 체크는 `node .claude/scripts/validator.js check ...` 형태로 실행 가능해야 한다.

## 작업명 규칙

- 모든 task subject는 아래 형식을 따른다.
- 형식: `[Batch{N}][R{M}][role] subject`
- 예: `[Batch8][R17][tester] floating-button verification`
- 이 규칙을 어기면 `TaskCreated` 단계에서 생성 자체가 차단된다.
- 파싱 확인 명령:

```bash
node .claude/scripts/validator.js parse-subject "[Batch8][R17][tester] floating-button verification"
```

## Planner

| check_id | 의미 | 검증 명령 |
|---|---|---|
| planning_doc_exists | 기획서 파일 존재 | `node .claude/scripts/validator.js check file_exists workspace/planning/A-planning-doc.md` |
| planner_claim_exists | planner claim 존재 | `node .claude/scripts/validator.js check file_exists workspace/claims/{batch_id}/{item_id}/planner.claim.json` |
| wf_evidence_exists | 와이어프레임 evidence 존재 | `node .claude/scripts/validator.js check file_exists workspace/evidence/planner/{batch_id}/{item_id}/wf-export.json` |
| desc_evidence_exists | 설명 Board evidence 존재 | `node .claude/scripts/validator.js check file_exists workspace/evidence/planner/{batch_id}/{item_id}/desc-export.json` |
| planner_state_done | request-state 내 planner status = done | `node .claude/scripts/validator.js check json_field_equals workspace/planning/request-state.json batches.0.items.0.roles.0.status done` |

## Designer

| check_id | 의미 | 검증 명령 |
|---|---|---|
| designer_claim_exists | designer claim 존재 | `node .claude/scripts/validator.js check file_exists workspace/claims/{batch_id}/{item_id}/designer.claim.json` |
| design_evidence_exists | design export evidence 존재 | `node .claude/scripts/validator.js check file_exists workspace/evidence/designer/{batch_id}/{item_id}/design-export.json` |
| design_board_manifest_exists | 대상 design board manifest 존재 | `node .claude/scripts/validator.js check file_exists workspace/evidence/designer/{batch_id}/{item_id}/boards.json` |
| designer_targets_truthy | claim 안에 developer_targets 존재 | `node .claude/scripts/validator.js check json_field_truthy workspace/claims/{batch_id}/{item_id}/designer.claim.json developer_targets` |
| designer_state_done | request-state 내 designer status = done | `node .claude/scripts/validator.js check json_field_equals workspace/planning/request-state.json batches.0.items.0.roles.1.status done` |

## Developer

| check_id | 의미 | 검증 명령 |
|---|---|---|
| developer_claim_exists | developer claim 존재 | `node .claude/scripts/validator.js check file_exists workspace/claims/{batch_id}/{item_id}/developer.claim.json` |
| development_dir_has_entries | 프론트 산출물 디렉터리 비어있지 않음 | `node .claude/scripts/validator.js check dir_has_entries workspace/development/src` |
| developer_report_exists | 기술 검토 또는 구현 보고 존재 | `node .claude/scripts/validator.js check file_exists workspace/reports/B-tech-review.md` |
| developer_coverage_truthy | claim 안에 covered_items 존재 | `node .claude/scripts/validator.js check json_field_truthy workspace/claims/{batch_id}/{item_id}/developer.claim.json covered_items` |
| developer_state_done | request-state 내 developer status = done | `node .claude/scripts/validator.js check json_field_equals workspace/planning/request-state.json batches.0.items.0.roles.2.status done` |

## QA

| check_id | 의미 | 검증 명령 |
|---|---|---|
| qa_claim_exists | qa claim 존재 | `node .claude/scripts/validator.js check file_exists workspace/claims/{batch_id}/{item_id}/qa.claim.json` |
| testcase_exists | 테스트케이스 파일 존재 | `node .claude/scripts/validator.js check file_exists workspace/testing/C-testcases.md` |
| qa_summary_exists | QA 상태 요약 존재 | `node .claude/scripts/validator.js check file_exists workspace/reports/.qa-last-run.json` |
| qa_report_exists | QA 검증 보고 존재 | `node .claude/scripts/validator.js check file_exists workspace/reports/D-qa-verification.md` |
| qa_state_done | request-state 내 qa status = done | `node .claude/scripts/validator.js check json_field_equals workspace/planning/request-state.json batches.0.items.0.roles.3.status done` |

## Tester

| check_id | 의미 | 검증 명령 |
|---|---|---|
| tester_claim_exists | tester claim 존재 | `node .claude/scripts/validator.js check file_exists workspace/claims/{batch_id}/{item_id}/tester.claim.json` |
| playwright_spec_exists | Playwright spec 존재 | `node .claude/scripts/validator.js check dir_has_entries workspace/testing/playwright` |
| playwright_result_exists | Playwright JSON 결과 존재 | `node .claude/scripts/validator.js check file_exists workspace/reports/playwright-results.json` |
| tester_report_exists | tester 보고 존재 | `node .claude/scripts/validator.js check file_exists workspace/reports/D-tester-verification.md` |
| tester_state_done | request-state 내 tester status = done | `node .claude/scripts/validator.js check json_field_equals workspace/planning/request-state.json batches.0.items.0.roles.4.status done` |

## Secretary

| check_id | 의미 | 검증 명령 |
|---|---|---|
| final_report_exists | 최종 보고서 존재 | `node .claude/scripts/validator.js check file_exists workspace/reports/final-report.md` |
| agent_log_exists | agent log 존재 | `node .claude/scripts/validator.js check file_exists workspace/reports/agent-log.txt` |
| final_report_has_summary | 최종 보고서에 요약 섹션 존재 | `node .claude/scripts/validator.js check file_contains workspace/reports/final-report.md \"요약\"` |
| secretary_claim_exists | secretary claim 존재 | `node .claude/scripts/validator.js check file_exists workspace/claims/{batch_id}/{item_id}/secretary.claim.json` |
| secretary_state_done | request-state 내 secretary status = done | `node .claude/scripts/validator.js check json_field_equals workspace/planning/request-state.json batches.0.items.0.roles.5.status done` |

## 메모

- 위 `batches.0.items.0.roles.N` 경로는 **예시**다. 실제 validator 연결 전에는 `batch_id`, `item_id`, `role`로 동적으로 찾아가는 로직이 필요하다.
- claim / evidence / ticket 디렉터리는 아직 초안 경로다.
- 이 문서의 목적은 “기계 검증 가능한 체크만 남긴다”는 기준을 고정하는 데 있다.
- `done ticket`은 에이전트가 직접 만들지 않는다. validator가 체크리스트 통과 후 `workspace/tickets/{batch_id}/{item_id}/{role}.done.json`을 발급한다.
- 역할이 정말 불필요하면 `validator.js issue-skip BatchN RN role "reason"`으로 `skip ticket`을 발급해야 다음 단계가 열린다.
