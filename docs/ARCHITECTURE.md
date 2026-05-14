# Architecture

How the pieces fit together. Read this if you want the "why" behind the structure.

## System overview

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           YOUR MAC                                       │
│                                                                           │
│   ┌──────────────────┐        ┌──────────────────────────────────────┐  │
│   │  Codex     │        │  ~/myos/ (MyOS runtime)          │  │
│   │  (terminal CLI)  │◄──────►│  ┌────────────────────────────────┐  │  │
│   │                  │        │  │  Bot process (<AGENT_NAME>)            │  │  │
│   │  Loads skills    │        │  │  Reads ~/myos/agents/<name>/     │  │  │
│   │  from ~/.codex/ │        │  │  Reads ~/myos/.env (secrets)     │  │  │
│   │  skills/         │        │  │  Connects to brain via MCP     │  │  │
│   └──────────────────┘        │  └────────────────────────────────┘  │  │
│          ▲                    │                                        │  │
│          │                    │  ┌────────────────────────────────┐  │  │
│          │                    │  │  5 launchd services (cron-like)│  │  │
│          │                    │  │   brain-watcher    (10 min)    │  │  │
│          │                    │  │   entity-worker    (3 min)     │  │  │
│          │                    │  │   brain-monitor    (6 hours)   │  │  │
│          │                    │  │   brain-backup     (weekly)    │  │  │
│          │                    │  │   brain-drift      (weekly)    │  │  │
│          │                    │  └────────────────────────────────┘  │  │
│          │                    └──────────────────────────────────────┘  │
│          │                                    ▲                          │
│          │                                    │ scans                    │
│          │                                    ▼                          │
│   ┌──────▼──────────────────────────────────────────────────────────┐   │
│   │              ~/workspace/                                         │   │
│   │                                                                    │   │
│   │   ├── projects/<your-projects>/                                    │   │
│   │   ├── operations/                                                  │   │
│   │   │   ├── engine-room/                                             │   │
│   │   │   │   ├── agents/  ─►  symlinked into ~/myos/agents/            │   │
│   │   │   │   ├── skills/  ─►  symlinked into ~/.codex/skills/       │   │
│   │   │   │   └── memory/  (migrations + edge function + runbook)    │   │
│   │   │   └── <your-domains>/                                         │   │
│   │   ├── memory/HANDOFF.md  (your dashboard)                         │   │
│   │   ├── knowledge/                                                  │   │
│   │   ├── decisions/                                                  │   │
│   │   └── scratchpad/                                                 │   │
│   │                                                                    │   │
│   │   Watched continuously by brain-watcher (every 10 min)            │   │
│   └───────────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────┘
                                      ▲
                                      │ HTTPS over MCP protocol
                                      │ (x-brain-key auth header)
                                      ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                     SUPABASE (CLOUD, FREE TIER)                          │
│                                                                           │
│   ┌──────────────────────────────┐  ┌──────────────────────────────┐  │
│   │  brain-mcp (edge function)   │  │  Postgres + pgvector         │  │
│   │                              │  │                               │  │
│   │  HTTP endpoint speaking MCP  │  │   thoughts        table      │  │
│   │  Tools: search_thoughts,     │◄─┼──────────────────────────────│  │
│   │         capture_thought,     │  │   entities        table      │  │
│   │         list_thoughts,       │  │   edges           table      │  │
│   │         thought_stats        │  │   thought_entities table     │  │
│   │                              │  │   entity_extraction_queue    │  │
│   │  Calls Gemini (embedding +   │  │                               │  │
│   │  classification) on every    │  │   Semantic search via        │  │
│   │  capture                     │  │   VECTOR(1536) + HNSW index  │  │
│   └──────────────────────────────┘  └──────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────┘
                    ▲
                    │ Gemini API calls
                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│           GOOGLE AI STUDIO (Gemini API, free tier)                      │
│                                                                           │
│   gemini-embedding-001 @ 1536d   (embedding generation)                  │
│   gemini-2.5-flash              (metadata extraction, entity detection)  │
└─────────────────────────────────────────────────────────────────────────┘
```

## Capture paths (how memory gets IN)

Three ways memory enters the brain:

### 1. Telegram conversation
```
You → Telegram → <AGENT_NAME> bot → Gemini extraction → brain
```
Fastest path. Seconds. Only meaningful turns get captured (importance ≥ 0.5). Chitchat dropped.

### 2. Codex sessions (anywhere on your Mac)
```
You → Codex session → JSONL transcript → brain-watcher → Gemini extraction → brain
```
Delay: up to 10 minutes. Covers every `codex` CLI session, not just Telegram.

### 3. Workspace markdown files
```
You → edit a markdown file → save → brain-watcher → chunk + embed → brain
```
Delay: up to 10 minutes. The same watcher handles both JSONL transcripts and `~/workspace/**/*.md`. Distinguishes them by file extension.

## Read paths (how memory gets OUT)

### Automatic (pre-injection)
Every Telegram message to <AGENT_NAME> triggers: search_thoughts with user's message as query → top 5 matches prepended as `[Memory context]` block → <AGENT_NAME> reads it before replying.

### On-demand (MCP tool call)
Codex sessions have `brain-mcp` registered. The `live-retrieval` skill fires automatically whenever Codex is about to say "I don't know" — forces a search first. You can also explicitly invoke: `mcp__brain-mcp__search_thoughts({"query": "..."})`.

## Derived data pipelines

Three background pipelines enrich captured memories:

- **Entity extraction** (every 3 min): pulls new thoughts, runs Gemini to detect people/projects/topics/tools/organisations/places, links them via foreign-key tables. Builds a knowledge graph over time.
- **Drift check** (weekly Sunday 04:00): scans for duplicate entities (variants of same canonical), over-polished names, base64 garbage. Auto-runs consolidation if thresholds breached. Silent when clean.
- **Backup** (weekly Sunday 03:00): JSON export of all OB1 tables to `~/myos/store/brain-backups/`. Keeps 8 weeks. Alerts on failure.

## Why this shape

### Why Supabase for the brain
Free at this scale. pgvector native. Edge Functions for the MCP server. REST API for fallback. Row-level security built in. If you outgrow it, migrate the SQL elsewhere.

### Why Gemini (not OpenAI, not OpenRouter)
Direct API, no broker. Free tier is generous. `gemini-embedding-001` at 1536 dimensions is competitive with ada-002. `gemini-2.5-flash` is cheap enough for turn-by-turn extraction ($0.001 per turn roughly).

### Why MCP protocol
Standard. Claude Desktop, Codex, Cursor, future ChatGPT clients all speak it. One brain, many front-ends.

### Why launchd for the background services
macOS native. No daemon to install. Survives reboots. Logs to standard locations. Each service is its own plist.

### Why the engine-room pattern
Portability. When you migrate to another agentic system, the brain + the agent definitions + the skills all come with you in one folder. The runtime (MyOS) is the only thing that changes.

### Why HANDOFF.md as a human-readable file
The brain stores everything but it's unordered. HANDOFF.md is the curated snapshot — 500 words that tell you (and your assistant) what's live. Auto-updated by the `/handoff` skill so it doesn't go stale.

## Rollback paths

| If this breaks | Do this |
|----------------|---------|
| Brain unreachable | Flip `BRAIN=sqlite` in `.env`, restart <AGENT_NAME>. Falls back to local SQLite memories. |
| Skills not loading | Check `~/.codex/skills/` symlinks aren't broken. Re-symlink from engine-room. |
| Agent not discovered | Check `~/myos/agents/<name>/` symlink. Must point at engine-room. |
| Supabase down | Not much you can do. Wait. <AGENT_NAME> still works in SQLite fallback mode. |
| Edge function crashes | `supabase functions deploy brain-mcp --no-verify-jwt` redeploys. |
| launchd service stuck | `launchctl bootout gui/$(id -u)/com.myos.<name>` then bootstrap again. |

## Costs

At single-user scale (around 5,000 thoughts, 30-50 new per day), monthly cost is under $1. Breakdown:
- Supabase: free tier forever
- Gemini: free tier handles ~1500 extractions/day; if exceeded, cheap overage
- Mac compute: negligible

## Security notes

Three secrets matter:
1. **SUPABASE_SERVICE_KEY** — master password for your database. Never paste into Telegram or Slack. Rotate if exposed.
2. **MCP_ACCESS_KEY** — locks the brain MCP endpoint. Rotate if exposed.
3. **GOOGLE_API_KEY** — your Gemini quota. Rotate if exposed.

All three live in `~/myos/.env` with `chmod 600`. Don't commit this file to git.

Sensitive content (client names, health info, financial details) gets a `sensitivity_tier` flag during extraction. Future local-inference layer will sanitise these before they hit the cloud.
