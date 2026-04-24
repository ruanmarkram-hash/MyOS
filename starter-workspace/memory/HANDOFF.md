# HANDOFF

**Updated:** `<YYYY-MM-DD>` (fresh install, system set up from scratch)
**Maintained by:** `<AGENT_NAME>` / Claude Code (on-demand via `/handoff` skill)

---

## ⭐ Current state

Fresh install. System is live. Brain is empty and ready to capture. No projects active yet.

First things to do (pick whichever matters most):

1. Create your first project folder under `projects/`. Use the `_template/` as a starting point, or ask the assistant to scaffold it.
2. Add reference material you've been meaning to organise under `knowledge/`.
3. Start a first work session, then at the end say "update handoff" to watch the dashboard come alive.

---

## 🟢 Active projects

_(None yet. When you create a project, the `/handoff` skill will list it here with status, current work, blockers, and next steps.)_

---

## 🚧 Blocked / awaiting decision

_(Empty. Add items here or have the assistant surface them from your session activity.)_

---

## 🔜 Next up (this week)

_(Empty. The assistant populates this from your planned work.)_

---

## 📦 Recent sessions (last 7 days, newest first)

_(Empty. Every time you run `/handoff`, a new entry lands at the top of this section.)_

---

## 📦 Archive (older than 7 days)

_(Empty. Session entries older than 7 days roll down here automatically.)_

---

## Infrastructure state

### Healthy
- `<AGENT_NAME>` agent installed at `~/workspace/operations/engine-room/agents/main/`
- 5 brain launchd services: `brain-watcher` (every 10 min), `entity-worker` (every 3 min), `brain-monitor` (every 6 hr), `brain-backup` (Sun 03:00), `brain-drift` (Sun 04:00)
- Supabase project with pgvector, `thoughts` table, MCP edge function deployed

### Known warnings
_(None yet. When your monitor agent catches something, it'll land here.)_
