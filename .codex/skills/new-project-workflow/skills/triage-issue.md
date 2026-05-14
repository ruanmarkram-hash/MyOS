# Skill: triage-issue

## Purpose
Investigate a bug or issue, find the root cause, then produce a TDD fix plan.

## Source behavior to preserve
- Ask one brief question if needed, then investigate immediately
- Use subagent exploration when deep codebase review is needed
- Trace the manifestation, code path, root cause, and related patterns
- Determine the minimal change needed
- Create a concrete RED-GREEN sequence
- Produce a GitHub issue with the fix plan when appropriate

## Output contract
- Root-cause summary
- Behaviors to verify
- Ordered RED-GREEN cycles
- Refactor step if needed

## Rules
- Prefer public behavior over implementation details
- Keep the plan durable across refactors
- Minimize user follow-up questions
- Investigate and advance until the actual root-cause or decision boundary is reached

## Loading rule
Load only when a bug or failure needs investigation.
