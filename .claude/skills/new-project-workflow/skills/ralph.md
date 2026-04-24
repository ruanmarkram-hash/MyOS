# Skill: ralph

## Purpose
Autonomously implement PRD slices using TDD, code review gates, and issue-driven iteration.

## Source behavior to preserve
- Parse PRD issue number, mode, and max iterations
- Require ralph scripts in the project root
- Run one issue at a time in once mode
- Run repeated issue loops in afk mode
- Fetch PRD and sub-issues via gh
- Implement the next open, unblocked sub-issue with TDD
- Run tests before every commit
- Run a code review gate after each iteration
- Close each sub-issue with a commit-linked comment
- Continue until all sub-issues are done

## Output contract
- Completed sub-issue
- Review result
- Commit-ready changes
- Final branch or PR if afk

## Rules
- Keep slices small
- Validate the first iteration before going AFK
- Use blocked-by dependencies in issue order
- Continue iterating autonomously until the next true issue, dependency, or decision boundary

## Loading rule
Load only when the PRD has been sliced and execution is ready.
