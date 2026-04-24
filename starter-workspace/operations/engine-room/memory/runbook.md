# Memory system runbook

This folder holds the portable artefacts needed to stand up the memory system on a new agentic platform. The current implementation is ClaudeClaw + OB1 (OpenBrain) on Supabase with pgvector. When you migrate off ClaudeClaw, copy this folder to the new machine and follow the steps below.

## What memory is

One Postgres database (Supabase free tier is enough for years at single-user scale) with a `thoughts` table holding 1536-dim vector embeddings, plus derived entity tables. An edge function exposes Model Context Protocol (MCP) tools over HTTPS so any MCP-speaking AI client can capture or search thoughts.

Two properties matter for portability:
1. The schema and the edge function code live here as flat files. They are small and self-contained.
2. Every write path is local: scripts scan your filesystem and call the edge function or insert directly via psql. No third-party integrations that would need re-auth on migration.

## Topography of capture paths

Three ways thoughts enter the brain:

1. **Telegram → <AGENT_NAME> → capture_thought (MCP)**. When you talk to <AGENT_NAME>, her memory extraction runs Gemini Flash on each turn. Passing turns land in OB1 with `metadata.source = 'mcp'`. This is the fastest path (seconds).

2. **Claude Code CLI sessions → watcher**. Every Claude Code session anywhere writes a JSONL transcript under `~/.claude/projects/<folder>/*.jsonl`. A launchd job scans these files every 10 minutes, distils turn pairs through Gemini Flash, and inserts thoughts with `metadata.source = 'claude_code'`. Delay: up to 10 min.

3. **Workspace markdown → watcher**. The same 10-min watcher scans `~/workspace/**/*.md`. New or edited files get chunked, embedded, and inserted with `metadata.source = 'workspace_vault'`. Delay: up to 10 min after you save the file.

A fourth path (one-off) is the bulk ETL that ran during migration — it pulled historical SQLite memories and conversation logs into OB1. That's a migration artefact, not part of steady state.

## Derived data pipelines

After a thought is captured, three background pipelines enrich it:

- **Entity extraction worker** runs every 3 minutes. For each new thought in `entity_extraction_queue` (populated by a trigger on `thoughts` insert), it calls Gemini Flash to extract people, projects, topics, tools, organisations, and places. Those become rows in the `entities` table, linked to the thought via `thought_entities`. Relationships between entities become rows in `edges`.

- **Brain drift check** runs weekly (Sunday 04:00). It looks for duplicate entities (variants of the same canonical name), over-polished canonicals (qualifier noise like "SharePoint access logs" when the real entity is "SharePoint"), and base64 garbage thoughts. It runs the consolidation + unpolish + cleanup scripts automatically, Telegram-pings only if action was taken.

- **Brain backup** runs weekly (Sunday 03:00). It exports all OB1 tables to dated JSON files in `~/claudeclaw/store/brain-backups/`. Retains 8 weeks. Alerts on failure only.

## <AGENT_NAME>'s read path

When a message arrives for <AGENT_NAME>, `buildMemoryContext()` runs. If `BRAIN=ob1` (the default since 2026-04-23), it queries the brain-mcp `search_thoughts` tool with the user's message as query, gets the top 5 matches over threshold 0.5, and prepends a `[Memory context]` block to <AGENT_NAME>'s prompt. Claude Code sessions don't get this automatic pre-injection — they get the `brain-mcp` MCP tools registered in `~/.claude.json` and rely on the `live-retrieval` skill (in engine-room/skills/) to decide when to search.

## Health monitoring

A fifth launchd job runs every 6 hours: `brain-monitor`. It pings the edge function, counts thoughts per source, confirms 100% embedding coverage, tails logs for OB1 errors, and exits silently if healthy. If it finds a WARN or CRITICAL condition, it Telegram-pings.

If you run a workspace-health-monitor agent (see `docs/AGENT-ARCHETYPES.md`), its audit should also verify that all five brain services are present in launchd with exit code 0, and that the watcher log shows a tick within the last 15 minutes.

## Rebuilding on a new platform

If you migrate to OpenClaw, Hermes, or another agentic system:

1. **Provision Supabase.** Create a new project (or reuse the existing one). Enable pgvector 0.8.0 or later.

2. **Apply the SQL migrations** in `migrations/` to the new Supabase database, in filename order:
   - `001_base_thoughts.sql` creates the `thoughts` table, `match_thoughts` function, RLS policies, `upsert_thought` RPC, fingerprint dedup.
   - `002_enhanced_thoughts.sql` adds structured metadata columns, full-text search RPC, brain stats aggregate, thought connections RPC.
   - If you want entity extraction, also apply `entity-extraction/schema.sql` from the OB1 repo (`vendor/ob1/schemas/entity-extraction/schema.sql`).

3. **Deploy the edge function.** `edge-function/brain-mcp.ts` is the Gemini-patched MCP server. Drop it at `supabase/functions/brain-mcp/index.ts`, copy `edge-function/deno.json` alongside, and run `supabase functions deploy brain-mcp --no-verify-jwt`. Set these secrets on the new Supabase project: `GOOGLE_API_KEY` (Gemini API key), `MCP_ACCESS_KEY` (a 64-char hex token, generated via `openssl rand -hex 32`).

4. **Wire the new agentic system to the brain.**
   - Point its MCP client at `https://<project-ref>.supabase.co/functions/v1/brain-mcp` with header `x-brain-key: <the MCP access key>`.
   - For memory pre-injection equivalent to <AGENT_NAME>'s, port the pattern in the old `src/brain/adapter.ts`: build a `search_thoughts` HTTP call, format results as a `[Memory context]` block, prepend to the user message before the model call.
   - Ingest paths can be rebuilt from the watcher scripts in the old `~/claudeclaw/scripts/brain-watcher.mjs` (expects Node 18+, `pg`, `better-sqlite3`, `@google/generative-ai` REST), `scripts/entity-extraction-worker.mjs`, `scripts/run-brain-drift-check.sh`, etc. These are thin enough to adapt.

5. **Replay your OB1 data** if you provisioned a fresh Supabase. Either: dump `thoughts`, `entities`, `edges`, `thought_entities` from the old project and COPY into the new one (cheapest), or re-run the ETL against the new project (expensive: embedding cost for all 5000+ thoughts).

6. **Re-install skills and agents** from `~/workspace/operations/engine-room/skills/` and `~/workspace/operations/engine-room/agents/` into whatever directory structure the new system expects. Symlink if the new system reads from a fixed location.

## Operational notes

- Embeddings are `gemini-embedding-001` @ `outputDimensionality=1536`. If you change the model, change the `VECTOR(...)` column type and re-embed all rows.
- Extraction is `gemini-2.5-flash` with `responseMimeType=application/json` and `temperature=0`.
- Auth is a single shared access key via the `x-brain-key` header. For multi-user you'd extend; for single-user this is fine.
- The Telegram pipeline preserves operational SQLite state (conversation_log, sessions, scheduled_tasks, audit_log, mission_tasks, token_usage, hive_mind) locally. Only distilled memories go to OB1. That separation is intentional.

## Rollback

The `BRAIN` env var in `.env` switches the read path. Set `BRAIN=sqlite` to ignore OB1 and fall back to the SQLite memories table. Useful if the brain is unavailable or if you want to compare answer quality. Setting requires a <AGENT_NAME> restart (`/restart` in Telegram) to pick up.

The four brain services in launchd can be stopped with `launchctl bootout gui/$(id -u)/com.claudeclaw.<service>`. They can be resumed with `launchctl bootstrap`. Data integrity is preserved — stopping the services just pauses new capture; existing data stays searchable.

## Costs

At the current single-user scale (around 5000 thoughts, steady-state ~30-50 new per day), monthly cost is under $1. The dominant cost is Gemini Flash extraction. Embedding cost is negligible because pre-check SQL skips already-fingerprinted chunks. Supabase stays on free tier indefinitely.

## File index

- `migrations/001_base_thoughts.sql` — base schema. Idempotent. Safe to re-run.
- `migrations/002_enhanced_thoughts.sql` — structured metadata layer. Idempotent.
- `edge-function/brain-mcp.ts` — MCP server, Gemini-patched.
- `edge-function/deno.json` — Deno import map for the edge function.
