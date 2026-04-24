# Development Workflow

Mandatory process for all code work across all projects. This is not optional. Every step exists because skipping it caused a production bug.

---

## Phase 1: Understand

### Step 1: Audit the code you will touch

Read the files you intend to change. Trace the data flow end-to-end:
- Database table (schema, CHECK constraints, FK relationships)
- Query function (db.ts or direct Supabase call)
- Component fetch (where data is loaded)
- State management (React state, props, module-level arrays)
- Render (what the user sees)

Do not guess what the code does based on file names or previous sessions. Read it.

### Step 2: Identify the real problem

- Does the view use mock data or real Supabase queries?
- Do db.ts functions exist but never get called?
- Is data persisted (Supabase) or ephemeral (React state, localStorage)?
- Are there duplicate mapper functions that could drift independently?
- Does the mapper pass through ALL database fields, or does it hardcode empty values?

If the foundation is broken, fix the foundation first. Do not patch symptoms on a broken base.

---

## Phase 2: Plan

### Step 3: Write a plan and get alignment

Write up findings and a phased plan. Present it before writing code. Get alignment on scope and priority.

### Step 4: Scenario walk-through

Before building any feature, narrate the real-world scenario:
- Who is in the room?
- What are they holding? (papers, phone, laptop)
- What do they need to do?
- Where does every piece of information or document end up?

Think through the physical context, not just the digital flow. For every input the feature accepts, answer ALL of these:

| Question | Must answer before building |
|----------|---------------------------|
| Where does this data go in the database? | Table name, column name |
| Where does this file go in SharePoint/storage? | Exact path |
| What flag or status does it update? | Column + allowed values |
| Does a CHECK constraint exist on that column? | If yes, what values are allowed? |
| Who gets notified? | Email, dashboard notification, both, neither? |
| What happens if the save/upload fails? | Retry queue, error toast, silent failure? |
| Does the user need to do this action more than once? | Multi-file upload, multiple entries, etc. |
| What does the user see AFTER the action completes? | Does the UI update without refresh? |
| What happens if the user navigates away mid-action? | Is state lost? |

If you cannot answer all of these for every input, the plan is incomplete. Do not start building.

---

## Phase 3: Build

### Step 5: Write code

Wire to real data from the start. No "mock first, real later" pattern.

### Step 6: Constraint check

Before ANY code that writes a value to a database column:

1. Find the table in the migrations
2. Check for CHECK constraints, ENUM types, FK relationships
3. Verify the value you are writing is in the allowed list
4. If it is not, write a migration to update the constraint BEFORE writing the code
5. This applies to sub-agents too. Verify agent output against constraints before committing. Agents do not automatically follow constraint rules.

### Step 7: Component check

- All `<select>` elements must use white background with `colorScheme: "light"`
- Multi-item workflows must use a row-based UI with "+ Add another" button
- Every action button must show: loading state while processing, toast on success, toast on failure
- After any save action, the UI must update to reflect the change without manual refresh
- If a shared UI component exists (Select, Input, Modal), use it. Do not create raw HTML elements that bypass the shared styling.

---

## Phase 4: Verify

This phase is MANDATORY. Never skip any step. "tsc passes" is not "it works."

### Step 8: Type check

```bash
tsc --noEmit    # zero errors required
vite build      # clean build required
```

This proves the code compiles. It does NOT prove it works.

### Step 9: Functional verification

Run the relevant Playwright E2E test:
```bash
PLAYWRIGHT_TEST_EMAIL=... PLAYWRIGHT_TEST_PASSWORD=... npx playwright test [spec] --headed
```

For new features: watch the headed test run and verify the UI visually.
For bug fixes: write a test that reproduces the bug, verify it passes.
For UI changes: take a Playwright screenshot and inspect it.

If you cannot run Playwright (no browser, no credentials), say so explicitly. Do NOT claim "it works" based on tsc alone.

### Step 10: Round-trip test

For any feature that saves data:
1. Save the data via the UI
2. Refresh the page
3. Verify the data appears with correct values

If you skip this step, the mapper/field-drop bug class WILL recur. This is the single most important test.

### Step 11: Production verify

Confirm it works with DEMO_MODE=false. Demo mode working is not the same as production working.

---

## Phase 5: Ship

### Step 12: Commit and push

Only after steps 8-11 pass.

### Step 13: Post-deploy verification

After the deployment platform finishes (~60 seconds):
1. Run E2E suite against the deployed URL
2. If any test fails, fix immediately before moving to next task
3. Do not move on until the deployed version passes

---

## Periodic Audits

Every 3-4 sessions, or after any major feature build:

| Audit | What to check |
|-------|--------------|
| Mapper audit | All _fromDb mappers pass through every DB column |
| Constraint audit | All status/enum writes match CHECK constraints |
| Button audit | Click every button in affected views, verify they work |
| Round-trip audit | Save data, refresh, verify it appears |
| Silent error audit | Search for `.catch(() => {})` on user-facing operations |
| Type suppression audit | Count `as any`, `@ts-ignore`, `@ts-nocheck` (trend should decrease) |
| Unused code audit | Dead imports, dead functions, unreachable branches |

When an audit finds issues, fix ALL of them. Not just critical ones.

---

## Bug classes this workflow prevents

| Bug class | Which step prevents it |
|-----------|----------------------|
| CHECK constraint violation | Step 6 (constraint check) |
| Status value mismatch between functions | Step 6 + Step 9 (functional verification) |
| Mapper dropping fields (data silently lost) | Step 10 (round-trip test) + periodic mapper audit |
| Stale props after data refresh | Step 10 (round-trip test) |
| Dark/broken UI styling | Step 9 (visual verification in headed Playwright) |
| Single-item UX for multi-item workflows | Step 4 (scenario walk-through) |
| Button with no feedback | Step 7 (component check) |
| Silent error swallowing | Periodic silent error audit |
| Feature works in demo but not production | Step 11 (production verify) |
| Agent code violates project rules | Step 6 (verify agent output before committing) |

---

## Git Hooks (install at project setup)

Every project repo must have two git hooks installed during initial setup. These are not optional. They enforce the verification steps automatically and apply to all agents and manual commits equally.

### Pre-commit hook (.git/hooks/pre-commit)

Runs on every commit. Blocks the commit if it fails.

Must include:
1. **Type check:** `tsc --noEmit` (or equivalent for the project's language). Zero errors required.
2. **Constraint validation:** scan staged files for status/enum value writes and warn if they might violate DB constraints.
3. **Build check:** `vite build` or equivalent. Must pass.

### Pre-push hook (.git/hooks/pre-push)

Runs on every push. Blocks the push if it fails.

Must include:
1. **E2E test suite:** run the project's Playwright (or equivalent) test suite against the deployed or local URL.
2. If test credentials are not configured, warn but allow push (so CI setup is not blocked).

### Installation

Hooks live in `.git/hooks/` and do not transfer between clones. At project setup, create a `scripts/install-hooks.sh` that copies the hooks into place:

```bash
#!/bin/bash
cp scripts/hooks/pre-commit .git/hooks/pre-commit
cp scripts/hooks/pre-push .git/hooks/pre-push
chmod +x .git/hooks/pre-commit .git/hooks/pre-push
echo "Git hooks installed."
```

Store the hook source files in `scripts/hooks/` (tracked by git) so they are versioned and available to anyone who clones the repo.

### Why hooks, not rules

Rules in documentation get ignored. Agents do not read CLAUDE.md before every commit. Git hooks are enforced by git itself. No bypass without `--no-verify`, which project rules must forbid.

---

## Non-negotiables

- Compiling is not testing. Never claim something works based only on tsc/build.
- Fix ALL audit findings, not just critical ones. No time pressure.
- Never trust agent output without verifying against constraints and rules.
- Never maintain duplicate mapper functions. Single source of truth.
- Never hardcode empty values in mappers. Map ALL DB columns.
- After any schema change: regenerate typed definitions from the live schema.
- Every action the user takes must have visible feedback (loading, success, error).
