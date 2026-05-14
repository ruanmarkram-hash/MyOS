# Portable memory artefacts pattern

**Date**: 2026-04-23
**Scope**: operations/engine-room
**Status**: active
**Session**: `~/workspace/operations/engine-room/sessions/2026-04-23-engine-room-finalisation.md`

## Decision

System infrastructure that needs to be portable (the brain, future agents, future workflows) is represented in `engine-room/` as a dedicated subfolder containing the minimum files needed to rebuild that infrastructure on a new platform, plus a runbook.md explaining how the pieces fit together.

For the memory system, this means `engine-room/memory/` holds: the SQL migrations (idempotent, can apply to any fresh Supabase project), the edge function source (Gemini-patched MCP server), and the runbook (capture paths, derived pipelines, rebuild steps, operational notes).

## Reasoning

The previous pattern had infrastructure sources scattered: migrations under `~/HQ/migrations/`, edge function under `~/HQ/supabase/functions/`, operational knowledge spread across code comments, commit messages, and one-off chat transcripts. Migrating off ClaudeClaw would require archaeology to reconstruct how the brain was built.

Consolidating under `engine-room/memory/` means a migration becomes a copy operation: grab `engine-room/`, apply the migrations to a new Supabase project, deploy the edge function with new secrets, point the new runtime at the folder.

## What this locks in

- The canonical source of truth for memory-system deployment is `engine-room/memory/`, not `~/HQ/`.
- New system-infrastructure pieces (future: hooks, pipelines, adapters) follow the same pattern: create `engine-room/<thing>/` with migrations + source + runbook.
- Portability is a file-copy operation, not a rewrite operation.

## What this unlocks

- Migrating off ClaudeClaw to OpenClaw, Hermes, or another agentic system is tractable. Estimated work: apply 2 migrations, deploy 1 edge function, re-wire 1 MCP client, re-install skills + agents from engine-room folders. No archaeology required.
- New agentic systems [YOUR NAME] evaluates in future can be stood up against the same OB1 brain for side-by-side comparison without duplicating memory infrastructure.
- If the brain's storage backend changes (e.g. moves off Supabase), the schema migrations and edge function source are already in one place, so the swap is localised.

## Drift risk

The HQ-side copies (`~/HQ/migrations/ob1/*.sql`, `~/HQ/supabase/functions/brain-mcp/index.ts`) and the engine-room-side copies can diverge over time. Mitigation for now: manual refresh on significant changes. Eventual fix: make engine-room the canonical source and symlink from HQ, or add a git hook that syncs the two on commit to `memory-v2-ob1`.

## Superseded by / supersedes

Standalone. No predecessor. This is the first codified portability pattern for the engine-room.
