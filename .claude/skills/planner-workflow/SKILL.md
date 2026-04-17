---
name: planner-workflow
description: This project's planner workflow. Use when acting as the planner for `plan:` or `revise:` tasks so Claude follows the required step order for impact analysis, benchmark gathering, UPDATE/CREATE branching, planning doc updates, and Penpot `wf_*` / `desc_*` work.
when_to_use: Trigger for planner agent work in this repo, especially when the task requires writing or revising planning docs, wireframes, descriptions, or Loop B planning review updates.
user-invocable: false
---

# Planner Workflow

Use this skill when you are the planner in this project.

## Core rule
- Keep the original order. Do not skip ahead.
- The sequence is:
  1. 영향도 분석
  2. 유사 흐름 / 관성 패턴 정보수집
  3. UPDATE / CREATE / UPDATE+CREATE / NO_CHANGE 판별
  4. 기획서 작성 또는 수정
  5. `wf_*` / `desc_*` 생성 또는 수정
  6. gap check + 디자이너 가이드 작성
  7. claim / evidence / 반환 정리

## What stays outside this skill
- done / skip ticket 게이트
- validator checklist
- claim / evidence 필수 필드
- planner mode 강제(`plan:` / `revise:`)

Those remain in `planner.md`, `validator.js`, and the checklist files.

## Load these references when needed
- For the ordered planner procedure, read [references/sequence.md](references/sequence.md).
- For Penpot board placement, desc text stacking, and export checks, read `workflow/references/planner-penpot-reference.md`.

## Execution
- At the start of any planner task, read `references/sequence.md`.
- Follow the sequence for the current mode:
  - `plan:` -> initial planning flow
  - `revise:` -> Loop B review-response flow
- If a required input is missing, do not invent it. Leave `missing_items`, return `partial`, and let the gate loop back.
