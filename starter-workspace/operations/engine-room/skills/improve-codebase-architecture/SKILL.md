---
name: improve-codebase-architecture
description: Use when asked to improve, refactor, simplify, harden, or review a codebase architecture. Guides agents through evidence-led architecture diagnosis, root-cause refactoring, dependency and boundary cleanup, migration planning, tests, and verification without speculative rewrites or broad churn. Especially useful for Mason, ClaudeClaw engineering work, Codex, and Claude CLI.
triggers:
  - architecture
  - refactor
  - codebase
  - technical debt
  - cleanup
  - simplify
  - harden
  - modularize
  - dependency
  - boundaries
  - design review
---

# Improve Codebase Architecture

Use this skill for non-trivial architecture work: refactoring, untangling modules, improving boundaries, reducing duplication, replacing brittle patterns, or reviewing a codebase for structural risk.

Do not use it for small local fixes unless the bug reveals a wider architectural class of issue.

## Operating stance

Architecture work is not aesthetic cleanup. Start from observed friction, defects, coupling, slow delivery, unsafe change paths, or failing tests. Prefer the smallest structural change that removes the root cause and makes the next change easier.

Default priorities:

1. Preserve behavior.
2. Reduce accidental complexity.
3. Converge duplicated logic into one path.
4. Strengthen boundaries and contracts.
5. Improve verification so future edits are safer.

## Workflow

### 1. Establish the target

Before editing, name the architecture problem in one sentence:

- What is painful or risky?
- Who or what is affected?
- What outcome would prove the architecture is better?

If the request is broad, produce a short plan and get sign-off before implementation.

### 2. Map the current shape

Inspect the code before judging it.

Use targeted searches:

```bash
rg "pattern_or_symbol" .
rg --files
```

Identify:

- Main entry points and ownership boundaries.
- Data flow and side effects.
- Duplicate implementations of the same rule.
- Hidden dependencies, global state, environment coupling, or circular imports.
- Test coverage around the behavior being changed.

Do not bulk-read unrelated files. Build the smallest useful map.

### 3. Find the root cause

Write down the root cause before choosing the fix. Distinguish symptoms from causes.

Common architecture root causes:

- Business rules duplicated across callers.
- Types or schemas drifting between layers.
- Data mapping split across multiple helpers.
- UI components owning domain logic.
- Services mixing orchestration, validation, persistence, and transport.
- Feature flags, env vars, or auth assumptions read in scattered places.
- Tests coupled to implementation details rather than behavior.

If the root cause is unclear, keep investigating.

### 4. Choose the smallest durable intervention

Prefer these mechanisms in order:

1. Central helper or service boundary that every caller routes through.
2. Schema, type, or validation contract that makes invalid state impossible.
3. Module split that separates domain logic from transport, persistence, or UI.
4. One-time migration or backfill for historic bad state.
5. Focused caller patches only when convergence is not practical.

Avoid:

- Rewrites without a safety harness.
- New abstractions that only rename existing complexity.
- Special-case branches that preserve the bad architecture.
- Cosmetic folder reshuffles without behavior or dependency improvement.

### 5. Plan the migration path

For changes touching multiple files or public contracts, use a staged path:

1. Add the new shared path while preserving current behavior.
2. Move one caller and verify.
3. Move remaining callers found by grep.
4. Delete the old path once no caller remains.
5. Add or update tests around the shared contract.

For database or API contracts, include backfills, compatibility windows, and rollback notes when relevant.

### 6. Implement with tight scope

Touch only files required by the architecture change. Match the repo's existing style and naming. Keep commits and diffs reviewable.

When working in custom workflow or Mason-owned code, follow Mason's stricter root-cause rule: grep the entire codebase for every call site that can produce the same class of bug and converge them onto the same path where possible.

### 7. Verify

Verification must match risk.

Minimum:

```bash
rg "old_helper_or_pattern" .
npm test
npm run build
```

Use the repo's actual commands. If tests do not exist, run typecheck/build and add focused tests when feasible. For UI architecture changes, smoke-test the relevant screen. For production wiring changes, verify env/config assumptions explicitly.

### 8. Report back

Keep the summary practical:

- Root cause found.
- Architecture change made.
- Files or modules touched.
- Verification run and result.
- Residual risk or follow-up, if any.

## Review checklist

Before calling the work done, confirm:

- The old problematic pattern is removed or contained.
- All known call sites route through the new contract.
- Behavior is preserved.
- Tests or smoke checks cover the main path.
- No unrelated refactors slipped in.
- The change would still make sense to a future maintainer reading the diff cold.
