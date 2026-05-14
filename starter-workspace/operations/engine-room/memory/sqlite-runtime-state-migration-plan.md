# SQLite runtime state migration plan

**Date**: 2026-04-29
**Owner**: engine-room
**Status**: planned, not started

## Goal

Move the live MyOS SQLite runtime state out of HQ ownership and into the engine-room portability model, without breaking the current MyOS fleet.

This covers the local SQLite state at:

`/Users/sagecos1/HQ/store/myos.db`

This database is not only memory. It also contains operational state for sessions, scheduled tasks, mission tasks, audit logs, token usage, cost tracking, hive mind, and local fallback memory.

## Target Shape

Long-term target:

`/Users/sagecos1/workspace/operations/engine-room/runtime-state/myos-store/myos.db`

Compatibility target while HQ still runs:

`/Users/sagecos1/HQ/store -> /Users/sagecos1/workspace/operations/engine-room/runtime-state/myos-store`

or an explicit env/config override:

`MYOS_STORE_DIR=/Users/sagecos1/workspace/operations/engine-room/runtime-state/myos-store`

Prefer the env/config override if modifying HQ runtime code is in scope. Prefer the symlink only as a low-code bridge.

## What Must Move

Move as a store directory, not just one DB file:

- `myos.db`
- `myos.db-wal`
- `myos.db-shm`
- `*.pid`
- local runtime backups
- brain backups if still intentionally tied to HQ store
- any store-local comparison or diagnostic artefacts that runtime scripts expect

Before moving, checkpoint SQLite so WAL state is clean:

```bash
sqlite3 /Users/sagecos1/HQ/store/myos.db "PRAGMA wal_checkpoint(FULL);"
```

## Migration Phases

### Phase 0: Inventory

- List every hardcoded reference to `store/myos.db`, `HQ/store`, and `STORE_DIR`.
- Classify each reference as runtime, script, skill, scheduled task prompt, decision/session doc, or historical note.
- Update only live runtime/script references. Do not rewrite historical session logs.

Known live references to handle:

- `~/HQ/src/config.ts` currently derives `STORE_DIR` from `PROJECT_ROOT/store`.
- `engine-room/skills/rules-sync/sync.py` hardcodes `/Users/sagecos1/HQ/store/myos.db`.
- `engine-room/skills/rules-sync/monthly_audit.py` hardcodes `/Users/sagecos1/HQ/store/myos.db`.
- Agent CLAUDE.md files use `$(git rev-parse --show-toplevel)/store/myos.db`, which remains valid if HQ has a compatibility store path.

### Phase 1: Add Store Path Override

Modify HQ runtime to resolve `STORE_DIR` from an env var first:

```text
MYOS_STORE_DIR
```

Fallback remains:

```text
path.resolve(PROJECT_ROOT, 'store')
```

Add `MYOS_STORE_DIR` to `.env.example` and any relevant setup docs, but do not set it until the migration run.

### Phase 2: Prepare Engine-Room Store

Create:

```text
/Users/sagecos1/workspace/operations/engine-room/runtime-state/myos-store/
```

Set restrictive permissions:

```bash
chmod 700 /Users/sagecos1/workspace/operations/engine-room/runtime-state/myos-store
```

Do not commit the live DB. Add ignore rules for:

```text
runtime-state/
*.db
*.db-wal
*.db-shm
*.pid
```

### Phase 3: Stop Fleet And Move State

Stop the MyOS fleet cleanly:

- Main Sage via Telegram `/restart` or launchd stop if doing a full maintenance window.
- Specialist agents with launchd stop or kickstart after the move.

Checkpoint the DB:

```bash
sqlite3 /Users/sagecos1/HQ/store/myos.db "PRAGMA wal_checkpoint(FULL);"
```

Copy the entire store directory to the new location with metadata preserved.

Keep a timestamped backup before changing anything:

```text
/Users/sagecos1/HQ/store/backups/myos-pre-engine-room-store-YYYYMMDD-HHMMSS.db
```

### Phase 4: Compatibility Bridge

Choose one bridge:

1. **Env override:** set `MYOS_STORE_DIR` in `/Users/sagecos1/HQ/.env`.
2. **Symlink:** replace `/Users/sagecos1/HQ/store` with a symlink to the engine-room store directory.

Env override is cleaner because it makes ownership explicit. Symlink is simpler and preserves scripts that expect `HQ/store`.

### Phase 5: Restart And Verify

Restart the fleet and verify:

- Telegram message round trip works.
- Existing chat session resumes.
- Scheduled tasks list and next-run values are intact.
- Mission Control loads queued, running, and completed tasks.
- Dashboard loads token/cost state.
- Hive mind query returns recent rows.
- Rules sync reads lessons successfully.
- OB1 fallback path does not throw if forced to SQLite.
- No launchd job is crash-looping.

Minimum commands:

```bash
sqlite3 <new-store>/myos.db "SELECT COUNT(*) FROM scheduled_tasks;"
sqlite3 <new-store>/myos.db "SELECT COUNT(*) FROM mission_tasks;"
sqlite3 <new-store>/myos.db "SELECT COUNT(*) FROM sessions;"
sqlite3 <new-store>/myos.db "SELECT agent_id, action, summary FROM hive_mind ORDER BY created_at DESC LIMIT 5;"
```

### Phase 6: Codex Capture Bridge

After the store location is stable, add a Codex capture bridge that writes:

- OB1 via `capture_thought`
- SQLite `memories` with `source='codex'`
- SQLite `hive_mind` with `agent_id='codex'`

Input should be a human-readable summary file, not raw transcript ingestion.

Default command shape:

```bash
cd /Users/sagecos1/HQ
node dist/codex-capture.js --project <name> --type session --summary-file /absolute/path/to/summary.md
```

The bridge must redact obvious secrets before capture and print exactly what it wrote.

### Phase 7: OpenAI Runtime Migration

Only after Codex/ChatGPT becomes the active runtime candidate:

- Define which SQLite tables remain needed.
- Replace MyOS-specific session IDs with OpenAI/Codex thread IDs where useful.
- Preserve scheduled tasks, audit logs, mission tasks, hive mind, and lessons unless explicitly retired.
- Add an OpenAI-native read/write adapter rather than letting Codex write raw SQL ad hoc.

Do not drop MyOS tables until the new runtime has run in parallel for at least one week.

## Rollback

Rollback must be one command path:

1. Stop fleet.
2. Point `MYOS_STORE_DIR` back to `/Users/sagecos1/HQ/store`, or restore the original `HQ/store` directory if using a symlink.
3. Restart fleet.
4. Verify Telegram, dashboard, scheduled tasks, mission tasks, and hive mind.

Keep the pre-move backup until at least two successful daily cycles have passed.

## Acceptance Criteria

The migration is complete only when:

- No live script hardcodes `/Users/sagecos1/HQ/store/myos.db` unless it is intentionally using the compatibility symlink.
- The MyOS fleet runs normally for 24 hours from the engine-room-owned store.
- OB1 capture and search remain healthy.
- SQLite fallback remains functional.
- Codex capture can write a test `source='codex'` memory and `agent_id='codex'` hive row without corrupting existing state.
- The move is recorded in HANDOFF.md and the relevant engine-room session log.
