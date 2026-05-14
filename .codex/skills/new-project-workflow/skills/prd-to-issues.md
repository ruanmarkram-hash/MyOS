# Skill: prd-to-issues

## Purpose
Turn a locked PRD into independently-grabbable issues using tracer-bullet vertical slices.

## Source behavior to preserve
- Ask for the PRD issue number or URL if missing
- Fetch the PRD with comments if needed
- Explore the codebase if not already done
- Break the PRD into thin, complete slices
- Mark slices as HITL or AFK when appropriate
- Preserve blocked-by dependencies in issue order
- Iterate on the breakdown until the user approves
- Create issues in dependency order

## Output contract
- Numbered slice list
- Type, blockers, and user stories for each slice
- GitHub issue bodies with the Parent PRD section

## Rules
- Prefer AFK slices where possible
- Do not close or modify the parent PRD issue
- Keep slices demoable or verifiable on their own
- Continue slicing autonomously until the approval or dependency boundary is reached

## Loading rule
Load only when the PRD is ready to be ticketed.
