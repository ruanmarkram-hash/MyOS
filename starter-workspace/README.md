# `<USER_FIRST_NAME>`'s workspace

The neutral landing zone for your files. Agents read and write here. Codex sessions read and write here. This folder is portable: if you ever move to a different AI system, everything here comes with you.

## Mental model

Two top-level categories:

- **`projects/`** — things you build (code products, one-off deliverables)
- **`operations/`** — things you run (day-to-day work and the system that manages everything else)

Everything else is supporting infrastructure: memory, knowledge, scratchpad, decisions.

## Structure

```
workspace/
├── projects/                        Things you build
│   └── <project-name>/
│       ├── sessions/                Sprint writeups
│       └── decisions/               Per-decision MD files
│
├── operations/                      Things you run
│   ├── engine-room/                 The meta layer (agents + skills + memory infra)
│   │   ├── agents/                  Agent identity files
│   │   ├── skills/                  Reusable workflows
│   │   ├── memory/                  Portable memory-system artefacts + runbook
│   │   ├── sessions/                System change logs
│   │   ├── decisions/               System decisions ledger
│   │   └── templates/               sprint-handoff, decision, cross-ref-stub
│   └── <your-domains>/              (marketing, finance, whatever you add)
│
├── memory/                          Persistent memory across sessions
│   └── HANDOFF.md                   Your daily dashboard. Read this first every day.
│
├── knowledge/                       Wiki-style reference material
│
├── decisions/                       Top-level locked decisions
│
└── scratchpad/                      Temporary files. Delete anything older than 7 days.
```

## End-of-session ritual

When you're done working for the day:

1. Save any markdown files you edited.
2. Say **"update handoff"** or **"/handoff"** to your assistant.
3. The assistant writes a session log in the right place, files any locked decisions, and refreshes HANDOFF.md.

Next day: open HANDOFF.md to see what's current and where you left off.

## What does NOT live here

- Source code for products (stays in its own repo)
- Secrets or credentials (stay in `.env` files)
- Binary blobs, large datasets, node_modules

## Want the deep explanation?

Read `operations/engine-room/memory/runbook.md` for how the memory system works end to end.
