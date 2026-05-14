# Skill: write-a-prd

## Purpose
Draft a full PRD from discovery input, codebase exploration, and module design.

## Source behavior to preserve
- Ask for a long, detailed problem description
- Explore the repo to verify current state
- Interview until the plan is fully understood
- Sketch major modules and identify deep modules
- Confirm modules and test scope with the user
- Write the PRD in the standard full format
- Offer a GitHub issue push only at the end

## Output contract
- Problem statement
- Solution
- Long numbered user stories list
- Implementation decisions
- Testing decisions
- Out of scope
- Further notes

## Rules
- Do not include file paths or code snippets in the PRD
- Use external behavior, not implementation detail
- Keep the PRD matchable to downstream issue slicing and implementation
- Keep moving through the PRD build until the user needs to make a real choice

## Loading rule
Load only when a PRD draft is being created or updated.
