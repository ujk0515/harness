---
name: planner-workflow
description: Planner가 사이클별 계획 md를 만드는 순서를 따르기 위한 프로젝트 전용 skill.
when_to_use: planner가 `plan:` 또는 `revise:` 작업을 수행할 때 사용한다.
user-invocable: false
---

# Planner Workflow

## 목적
- planner가 item별 새 계획 md를 일관된 구조로 만들도록 돕는다.
- 외부 디자인 툴이나 행정용 파일 전제는 없다.

## 순서
1. 요청과 범위 파악
2. 기존 맥락 읽기
3. 새 계획 md 생성
4. 기능 명세 작성
5. ASCII 화면 작성
6. 요소 디스크립션 작성
7. 동작·상태 작성
8. 실행 가능한 프로젝트면 실행·검증 메모 작성
9. 완료 기준과 비범위 정리

## 읽을 자료
- `references/sequence.md`
- `workflow/standards/planning-doc-sections.md`
- `workflow/standards/planning-cycle-template.md`

## 출력
- 새 계획 md 파일 경로
- 핵심 변경 요약
