# New Project Workflow — Generation Template

## Inputs
- Project name
- Project type
- Target folder
- Discovery branch (`shape` or `grill-me`)
- Desired execution mode (`plan` only, or plan + build)

## Output set
Create these docs in the target project folder:
- `context.md`
- `decisions.md`
- `brief.md`
- `roadmap.md`
- `sprint-log.md`

Create these directories when needed:
- `Outputs/`
- `decisions/`
- `research/`
- `workflows/`
- `assets/`

## Flow
1. Confirm project name and target folder.
2. Choose the discovery branch.
3. Generate the first PRD draft.
4. Review and amend the PRD until locked.
5. Create the project folder structure.
6. Generate starter docs.
7. Break the PRD into slices if execution is required.
8. Hand off to the implementation engine.

## Notification rules
- If blocked, stalled, or awaiting a human decision, notify <USER_NAME>.
- If a decision is safe and within delegated authority, continue.
- If the project folder is missing or ambiguous, stop and ask.

## Notes
This template is the working contract for generating new project setups.
