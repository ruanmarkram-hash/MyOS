# Skill: tdd

## Purpose
Implement and verify behavior with red-green-refactor, one vertical slice at a time.

## Source behavior to preserve
- Test behavior through public interfaces only
- Write one test at a time
- Keep implementation minimal for the current test
- Avoid horizontal test dumps
- Refactor only after green

## Output contract
- Focused behavioral tests
- Minimal code changes
- Refactor notes after green

## Rules
- Use integration-style tests where possible
- Mock only at system boundaries
- Keep tests resilient to internal refactors
- Keep implementing and refining slices without pausing unless a true failure or decision boundary appears

## Loading rule
Load only during implementation.
