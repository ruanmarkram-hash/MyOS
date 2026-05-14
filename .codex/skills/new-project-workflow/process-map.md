# New Project Workflow — Process Map

## New project branch

1. Start command receives project name and destination folder.
2. User chooses discovery branch, `shape` or `grill-me`.
3. Workflow generates PRD draft.
4. User reviews PRD and requests amendments.
5. Workflow updates PRD until locked.
6. Workflow generates project folder structure and starter documents.
7. Workflow breaks the PRD into implementation slices.
8. Workflow hands off to `ralph` or equivalent execution mode.
9. Workflow tracks completion and closes the loop.
10. If the workflow is blocked, stalled, or needs a human decision, it alerts <USER_NAME> immediately.
11. If the next step is clear and within delegation authority, the workflow continues autonomously.

## Existing project branch

1. Start command receives project name and path to the existing codebase.
2. Workflow runs a **deep parallel audit** against `existing-project-deep-audit.md` in this folder. This is NOT a 20-line readiness checklist — it is a domain-sliced, parallel agent audit with strict WORKING/HALF-BUILT/BROKEN/NOT_BUILT classification and BLOCKS_PROD/DEGRADES_UX/POLISH severity. See the guide for method and schema. Reference implementation: `projects/<your-project>/audits/2026-04-11/`.
3. Workflow produces audit files, one per domain, under `projects/[name]/audits/[date]/`.
4. Workflow synthesises findings into a unified punch list sorted by severity and domain.
5. Workflow corrects any project memories that the audit disproves. Overconfident "repair complete" claims get tempered with audit findings and file:line references.
6. Workflow user chooses discovery branch — `shape` or `grill-me` — to fill in the gaps between "current state" (audit) and "production ready" (user vision, constraints, priorities).
7. Workflow generates PRD draft that treats the project as a repair sprint. The PRD's sprint queue is derived from the audit's BLOCKS_PROD items, ordered by risk-adjusted priority (security first, data-integrity second, user-facing third, polish last).
8. Workflow user reviews PRD and requests amendments.
9. Workflow updates PRD until locked.
10. Workflow breaks the PRD into implementation slices.
11. Workflow hands off to `ralph` or equivalent execution mode.
12. Workflow tracks completion against the audit baseline. Each sprint's deliverable re-runs its relevant audit section to confirm the gap is closed before moving on.
13. Same escalation/autonomy rules as the new project branch.

## Development workflow

All code execution (steps 8-12 in both branches) must follow the development workflow defined in `development-workflow.md` in this folder. That document defines the mandatory build-verify-ship process: scenario walk-through, constraint checks, Playwright verification, round-trip testing, and post-deploy validation. It exists because skipping these steps caused repeated production bugs.

## Non-negotiables
- Keep startup context lean.
- Load only the skills needed for the current step.
- Do not copy third-party content verbatim.
- Record durable decisions immediately.
- For existing-project branch: never trust a prior session's "done" claims without re-verification. If a sprint log says "GAP-X resolved," the audit must independently verify with file:line evidence.
- Shallow audits (20-line readiness checklists) are appropriate for greenfield projects. They are NOT appropriate for projects with substantial code — use the deep-audit method instead.
