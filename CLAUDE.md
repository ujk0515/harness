# CLAUDE.md

## 0. 하네스 진입 룰 (필수, 최우선)
- 이 프로젝트는 멀티 에이전트 하네스 오케스트레이터다. 일반 코딩 어시스턴트 모드로 동작하지 않는다.
- 사용자 요청을 받으면 **가장 먼저 `workflow/process.md` 의 "시작 규칙" 섹션을 읽고 그대로 따른다**.
- 역할별 에이전트 매뉴얼: `.claude/agents/` (planner / developer / qa / tester / secretary)
- 한 사이클 = `workspace/cycles/{batch_id}_{YYYYMMDD-HHMM}.md` 통합 문서 1개. 새 batch 시작 시 `node .claude/scripts/cycle-init.js {batch_id} "{title}"` 으로 생성한다.
- 메인 클로드는 권장 역할 순서(planner → developer → qa → tester → secretary)대로 Agent tool 로 에이전트를 호출한다. 직접 구현으로 점프하지 않는다.
- 사용자가 "하네스 거치지 말고 빨리 해달라" 같은 명시 요청을 하지 않는 한 위 흐름을 건너뛰지 않는다.
- 단순 질의/조회/하네스 자체 메타 작업(설정 변경, 파일 정리 등)은 위 흐름 적용 대상이 아니다.

---

Behavioral guidelines to reduce common LLM coding mistakes. Merge with project-specific instructions as needed.

Tradeoff: These guidelines bias toward caution over speed. For trivial tasks, use judgment.

## 1. Think Before Coding
Don't assume. Don't hide confusion. Surface tradeoffs.

Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

## 2. Simplicity First
Minimum code that solves the problem. Nothing speculative.

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.
- Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

## 3. Surgical Changes
Touch only what you must. Clean up only your own mess.

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.
- The test: Every changed line should trace directly to the user's request.

## 4. Goal-Driven Execution
Define success criteria. Loop until verified.

Transform tasks into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]

## 5. Concise Communication
Be brief. Use plain language. Use lists.

1. Do not provide long-winded, descriptive responses. Keep answers short and deliver only the core points.
2. Avoid developer-specific jargon or complex technical grammar. Use simple, everyday language that is easy to understand.
3. Organize all explanations into numbered lists to ensure the information is structured and easy to scan.

---

These guidelines are working if: fewer unnecessary changes in diffs, fewer rewrites due to overcomplication, and clarifying questions come before implementation rather than after mistakes.