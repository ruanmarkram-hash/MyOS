# Codex SQLite runtime state migration

**Date**: 2026-04-29
**Scope**: operations/engine-room
**Status**: active
**Session**: `~/workspace/operations/engine-room/sessions/2026-04-29-codex-sqlite-runtime-state-migration.md`

## Decision

For the eventual ChatGPT/Codex migration, engine-room owns the migration contract for the live SQLite runtime state. The live database may remain at `~/HQ/store/claudeclaw.db` while ClaudeClaw is the active runtime, but the target ownership is engine-room. The move must be planned, verified, and compatibility-preserving.

## Reasoning

The current location is a runtime implementation detail: HQ is the running ClaudeClaw app, and `STORE_DIR` is currently `PROJECT_ROOT/store`. That is why operational SQLite state lives in `~/HQ/store/`. But engine-room is now the canonical portable system layer. If ChatGPT/Codex becomes the primary platform, leaving the live state conceptually inside HQ would force future migration work to rely on ClaudeClaw archaeology.

The OB1 brain already has portable artefacts under `engine-room/memory/`. SQLite operational state needs the same treatment: a documented contract, a target location, a compatibility path, and a verification checklist.

## What this locks in

- Do not casually move `~/HQ/store/claudeclaw.db` while ClaudeClaw is live.
- Engine-room is the canonical owner of the future SQLite runtime-state migration plan.
- Any Codex runtime integration must preserve or intentionally replace the SQLite-backed capabilities before HQ is retired.
- The first safe migration path is compatibility-preserving: env override or symlink first, runtime rewrite later.

## What this unlocks

- Codex can be evaluated as a primary runtime without losing operational memory continuity.
- The future migration can separate durable memory, runtime state, and platform-specific implementation.
- The live ClaudeClaw fleet can keep running while the state location is moved behind a compatibility layer.

## Superseded by / supersedes

Complements: `./2026-04-23-portable-memory-artefacts.md`
