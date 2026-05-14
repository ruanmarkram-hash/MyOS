# Existing-Project Deep Audit — Method Guide

**Purpose:** Define what a real existing-project audit looks like when the new-project-workflow runs in existing-project mode. The shallow 20-line audit that was produced for a brand-new project is NOT the target — that project had no code yet. This guide is for projects that have substantial code already written and need to be mapped against "production ready."

**Context:** Use this guide for any project with existing code that needs mapping against "production ready." The shallow 20-line audit that suits a brand-new project is not the target here.

---

## When to use this guide

Use this when running the new-project-workflow against a project that:

- Has substantial code already written (not just a brief)
- Has a live or near-live deployment
- Has "shipped" claims that need verification
- Has been worked on across multiple sessions where state drift is likely
- Has a roadmap or feature list to compare against

Do NOT use this for greenfield projects. A 20-line readiness checklist is correct for those. This is for brownfield feature-completeness audits.

---

## The six anti-patterns to hunt for

When <EXAMPLE_PROJECT> was audited, five structural patterns recurred across domains. Every deep audit should start by hunting for these specific patterns. They're the classes of failure that manual testing surfaces one at a time and that audits can catch all at once.

### 1. Writes work, reads are mock

The most common failure mode. `createX()` in `db.ts` correctly writes to the database. The list/detail view reads from a mock array in `src/data/*`. In production mode (mocks gated to `[]`), writes succeed silently while the UI renders blank. Users create things and "lose" them.

**Grep triggers:**
- `import { [A-Z_]+ } from ['"](\.\./)?data/`
- `const [A-Z_]+ = \[` near view files
- `_useMock`, `mockData`, `demoData`, `DEMO_DATA`
- Hardcoded arrays used as render sources

**Verify by:** tracing every list view to its data source. If the source is a constant array, not a `useEffect` + `getX()` call, flag it HALF-BUILT.

### 2. Persistence missing from wizards

Multi-step wizards collect data into React state across steps and never write it back at submit. The submit handler is a `console.log`, a `toast`, or calls a function that itself is a stub.

**Grep triggers:**
- `setStep`, `currentStep`, `step === N` — large wizards
- `onSubmit`, `handleSubmit`, `handleNext` — trace to the actual persist call
- `// TODO`, `// not yet`, `// <AGENT_NAME> will` near wizard submit handlers

**Verify by:** finding the final step handler and confirming it calls a `db.ts` function that persists. If data flows into React state and never flows back out to Supabase, flag it HALF-BUILT.

### 3. Infrastructure built but never wired

A library file (`esig.ts`, `email.ts`, `sa-generator.ts`) is fully implemented. A table exists in the schema. But no view imports the library or calls the function. Comments like `// <AGENT_NAME> will build the UI` are a tell.

**Grep triggers:**
- Fully implemented functions in `src/lib/` that have no imports elsewhere
- `// [Name] will build`, `// TODO: implement`, `// stubbed`, `// not yet`
- Tables in migrations that have no `.from('x')` references in `db.ts`

**Verify by:** for each file in `src/lib/`, run `grep -r "from.*[lib-file-name]" src/` and confirm there's at least one import into a view. For each table in migrations, run `grep -r "from.*table_name" src/` and confirm there's at least one db.ts reader AND writer.

### 4. Claimed-done items are half-built

Prior sprint logs say "GAP-01 through GAP-09 resolved" or "22 forms wired." The audit re-checks each claim against the code. Common finding: a few items are fully done, most are partially done, some were never touched.

**Method:**
- List every claim from the sprint log and memory
- For each claim, independently verify by reading the code it references
- Mark each claim as VERIFIED, PARTIAL, or FALSE with file:line evidence
- Update the memory after the audit to temper overconfident claims

### 5. Security policies missing on the sensitive tables

RLS (Row Level Security) is declared "applied to 10 tables" in the sprint log. The audit finds those 10 tables are not the ones that need it most. Specifically: tables reached via the end-user portal (family, participant, staff) have no policies or wrong-shaped policies.

**Method:**
- List every table accessed from non-admin views (FamilyPortal, participant-facing flows, staff-facing flows)
- For each, grep migrations for `ALTER TABLE X ENABLE ROW LEVEL SECURITY` and `CREATE POLICY ... ON X`
- If the table has no policy for the current role's access path, flag it BLOCKS_PROD
- A participant JWT should not be able to `SELECT` rows they don't own. Confirm.

### 6. DEMO_MODE gates that mask production failures

Features work in demo mode. In production mode (`VITE_DEMO_MODE=false`), they break. This is not "the feature is broken" — it's "the feature only exists in demo mode."

**Grep triggers:**
- `if (VITE_DEMO_MODE)`, `if (DEMO_MODE)`, `isDemoMode`
- `?? []`, `|| []`, `?? MOCK_DATA`
- `import.meta.env.VITE_DEMO_MODE`

**Verify by:** mentally running every flow with `DEMO_MODE=false`. If the flow requires demo mode to work, it's HALF-BUILT at best, BROKEN at worst.

---

## Parallelisation strategy

One agent covering the whole codebase is too slow and too shallow. The audit must be parallel across domains. For <EXAMPLE_PROJECT>, 6 domains worked well:

1. **Admin flows** — what the operator does to onboard clients/users
2. **End-user portal** — what participants/families see when logged in
3. **Staff/worker portal** — what workers do for onboarding and ongoing compliance
4. **Operational core** — the primary day-to-day workflow (scheduling, notes, payments for <EXAMPLE_PROJECT>)
5. **Regulated/compliance** — highest-stakes features (clinical, incidents, legal)
6. **Strategy + admin + leftovers** — long-tail features, settings, dashboards

Adapt domain count to project size. A 10-view app needs 2-3 agents. A 100-view app needs 8-10. Rule of thumb: one agent per 10-15 views.

**Each agent must stay in its lane.** Explicit "Other agents running in parallel: A, B, C — don't duplicate their work" in every prompt. Cross-domain findings get a brief note, not a deep dive.

---

## Required output schema

Every deep audit produces files in this format, one per domain:

```markdown
# [Project] Audit — [Domain] — [YYYY-MM-DD]

**Auditor:** Agent [letter]
**Files scanned:** [count]
**Features reviewed:** [count]

## Top 3 critical findings
1. [Feature name — STATE — SEVERITY, one line]
2. ...
3. ...

## Feature matrix

| # | Feature | Purpose | State | Evidence | Gap | Severity | Fix |
|---|---|---|---|---|---|---|---|

## Details (HALF-BUILT and BROKEN only)

### [Feature] — [STATE] — [SEVERITY]

**What exists:** file:line references
**What's missing:** specific gap
**How to verify:** 1 sentence test path a human could walk
**Proposed fix:** 1-2 lines, pointer only (not full spec)

## Recommendations
Top 3 from this domain to tackle first. Justify with severity.
```

### State definitions (strict)

A feature is WORKING only if ALL of these are true:

1. DB schema exists for the data
2. A `db.ts` (or equivalent) function exists and persists/reads correctly
3. UI renders the feature
4. User action in the UI reaches the persistence function (not a mock, not a `console.log`, not a `TODO`)
5. Data that goes in is the data that comes back out
6. Any side effect (external API, upload, email, signing) actually fires in production mode

If any step is missing: **HALF-BUILT**.
If it throws at runtime: **BROKEN**.
If it's referenced in a brief/roadmap but has no code: **NOT_BUILT**.
If evidence is insufficient to determine: **UNKNOWN** (and explain what you'd need to check).

### Severity definitions

- **BLOCKS_PROD** — project cannot go to production with this broken
- **DEGRADES_UX** — ships but users will be frustrated or confused
- **POLISH** — minor, not a user-facing blocker
- **NA** — for WORKING features

### Fix scopes

- **S** — <1 day
- **M** — 1 to 3 days
- **L** — >3 days
- **NA** — for WORKING

---

## Non-negotiable audit rules

These rules prevent the shallow-audit failure mode. Every agent prompt must include them verbatim:

1. **Do NOT fix anything.** Audit only. Fixing during audit loses the signal about what's broken.
2. **Cite file:line for every claim.** No claim without evidence. Minimum 2 file:line references per feature. No "probably broken" or "seems to not work."
3. **Don't speculate.** Mark UNKNOWN if evidence is insufficient. Explain what you'd need to check.
4. **Trust code over docs.** Docs may be stale. Grep first, then read file, then cite.
5. **Don't skip obviously-WORKING features in the matrix.** List them anyway, marked WORKING, with evidence. Absence of a feature from the matrix is ambiguous — it could mean "working" or "forgot to audit it."
6. **No wall-of-text details for WORKING features.** Only HALF-BUILT and BROKEN features get the detailed section. Save token budget for the failures.
7. **Hunt the six anti-patterns explicitly.** Don't just read the code — specifically grep for the triggers above.
8. **Trace end-to-end, not just spot-check.** For each feature: DB → query function → UI → action → persist → display back. Break the chain at any link and flag it.

---

## Workflow integration

When the new-project-workflow runs in existing-project mode:

1. **Project detection** — workflow detects that the target has substantial code (heuristic: >N views, >N files, has a git log). Activates this guide.
2. **Domain discovery** — workflow reads the roadmap.md and brief.md to identify natural domain clusters. Proposes a split to the user.
3. **Parallel agent spawning** — workflow spawns one agent per domain, each with the prompt template derived from this guide + the domain-specific file list.
4. **Output collection** — each agent writes to `projects/[name]/audits/[date]/[letter]-[domain].md`
5. **Synthesis** — workflow reads all audit files and produces a unified punch list sorted by severity + domain
6. **Memory correction** — workflow updates any project memories that the audit disproves
7. **Handoff to discovery** — the audit output becomes the primary input to `grill-me` or `shape` for PRD writing. The PRD's sprint queue is derived from the audit's BLOCKS_PROD items.

---

## Anti-patterns in auditing itself

These are failures to avoid when running an audit, not failures to find in the code.

### "Readme-driven audit"
Reading the brief/roadmap and assuming claims are true. Always re-verify against the code. The <EXAMPLE_PROJECT> sprint log claimed "GAP-01 through GAP-09 resolved" — re-verification found 3 of those were half-resolved at best.

### "Test-driven audit"
Running the app and finding issues by clicking. This is what the audit is supposed to REPLACE. Manual testing is O(features). Parallel agent audit is O(domains) with constant-time per domain.

### "Single-pass audit"
One agent reading the whole codebase. Too shallow because token budget forces summarization. Parallelize by domain.

### "Exit-code audit"
Running tests or `tsc --noEmit` and declaring victory if they pass. Type safety + tests passing does NOT mean features work. <EXAMPLE_PROJECT> builds in 774ms with zero errors, and the audit found 19 BLOCKS_PROD issues. The build tells you the code COMPILES. The audit tells you if it DOES what it's supposed to.

### "Claim-centric audit"
Auditing only what someone claims is broken. <EXAMPLE_PROJECT>'s Cuba Service Agreement incident was one feature out of dozens that were broken — the user found one, the audit found the other 18. Always audit the whole domain, not just the reported symptom.

---

## <EXAMPLE_PROJECT> audit as reference

The 2026-04-11 <EXAMPLE_PROJECT> audit is the reference implementation of this guide. Review it before running your first deep audit:

- Input files the agents read: `projects/<your-project>/brief.md`, `roadmap.md`, `context.md`, `sprint-log.md`, `qa-punch-list.md`, plus 6 domain-specific file lists
- Agent prompts: each agent got ~2000 words of context including the six anti-patterns, strict WORKING definition, severity/scope tables, method, and a scoped file list
- Output files: `projects/<EXAMPLE_PROJECT>/audits/<DATE>/{A,B,C,D,E,F}-*.md`
- Synthesis output: see the session that ran the audit for the unified punch list
- Time cost: ~6-7 minutes wall time per agent in parallel, ~35 minutes total for 6 agents
- Token cost: ~130k-180k tokens per agent (6x), plus synthesis

Compare this to a brand-new project audit at `audit-report-<industry>-doc-generator.md` — 20 lines, high-level, pre-kickoff. Both are valid outputs for their contexts; they serve different purposes.

---

## Update cadence

Update this guide after every deep audit. Capture:

- New anti-patterns discovered
- Domain split heuristics that worked or didn't
- Agent prompt refinements
- Output format adjustments

This guide should improve with every run.
