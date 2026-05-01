# CLAUDE.md

## 0. 하네스 진입 룰

### 기본 동작
- **기본은 일반 Claude Code 어시스턴트 모드**다.
- 사용자가 진입 트리거를 명시한 경우에만 하네스 모드로 전환한다.
- 진입 트리거 없이 들어온 요청은 평소처럼 처리한다. `workflow/process.md` 를 자동으로 로드하지 않고, 에이전트도 호출하지 않는다.

### 진입 트리거 (사용자 발화 안에 있어야 함)
- "하네스로 해줘"
- "하네스로 진행"
- "하네스 시작"
- "경량 하네스로 동작해줘"
- 그 외 "하네스" 단어를 포함한 모드 지시

### 하네스 모드 진입 시 동작
1. `workflow/process.md` 의 "시작 규칙" 섹션을 먼저 읽고 그대로 따른다.
2. 새 batch라면 `node .claude/scripts/cycle-init.js {batch_id} "{title}"` 로 통합 문서를 생성한다.
3. 권장 역할 순서(planner → developer → qa → tester → secretary)대로 Agent tool 로 에이전트를 호출한다. 직접 구현으로 점프하지 않는다.
4. 역할별 매뉴얼: `.claude/agents/`

### 모호할 때
- 트리거 단어가 없으면 일반 모드로 진행한다.
- 명백한 다단계 작업이라도 사용자 트리거 없이 임의로 하네스를 시작하지 않는다.

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