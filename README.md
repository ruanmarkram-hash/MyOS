# ClaudeClaw Starter Kit

A guided setup for your own personal AI assistant with memory, agents, and a clean workspace. Designed so anyone who can copy and paste can stand up a full instance.

Claude Code does the actual work. You answer a handful of questions.

> 👉 **Want the visual tour first?** Open [`docs/how-it-works.html`](docs/how-it-works.html) in your browser. It's a one-page picture-first explainer of what the whole thing does.

---

## What you're building

```
                    ┌─────────────────────────────┐
                    │         YOU                 │
                    │   ┌─────────────────┐       │
                    │   │ Ask a question  │       │
                    │   │ Make a decision │       │
                    │   │ Do some work    │       │
                    │   └────────┬────────┘       │
                    └────────────│────────────────┘
                                 │
                    ┌────────────▼────────────────┐
                    │   CLAUDE CODE / YOUR AGENT  │
                    │   ┌─────────────────────┐   │
                    │   │   Your assistant    │   │
                    │   │   Skills load auto  │   │
                    │   │   Reads your brain  │   │
                    │   │   Answers you       │   │
                    │   └──┬────────────────┬─┘   │
                    └──────│────────────────│─────┘
                           │                │
                           ▼                ▼
                ┌──────────────────┐ ┌─────────────────┐
                │    THE BRAIN     │ │  YOUR WORKSPACE │
                │  (in the cloud)  │ │  (on your Mac)  │
                │                  │ │                 │
                │  ● Your thoughts │ │  ● Projects     │
                │  ● Past decisions│ │  ● Notes        │
                │  ● Context       │ │  ● Daily status │
                │                  │ │  ● Decisions    │
                │  Searches by     │ │                 │
                │  meaning, not    │ │  Feeds the      │
                │  keywords        │ │  brain          │
                └──────────────────┘ └─────────────────┘
                           ▲                │
                           │                │
                           └────────────────┘
                       Everything you write to
                       the workspace gets captured
                       into the brain every 10 minutes
```

**In plain words**: you have an AI assistant (named whatever you choose during setup) that remembers everything you've ever told it, every decision you've ever made, and every piece of writing you've ever saved. When you ask it a question, it searches your history and gives you an informed answer. It's like having a personal chief of staff who never forgets.

---

## How the folders are laid out

```
  ~/workspace/                          ← Your files live here
  │
  ├── 📁 projects/                      ← Things you BUILD
  │   └── <project-name>/
  │       ├── sessions/                 (sprint writeups)
  │       └── decisions/                (locked choices)
  │
  ├── 📁 operations/                    ← Things you RUN
  │   │
  │   ├── 🔧 engine-room/               ← The system itself (portable, carries over)
  │   │   ├── agents/                   (<AGENT_NAME> + specialists)
  │   │   ├── skills/                   (reusable workflows)
  │   │   ├── memory/                   (how the brain is built)
  │   │   ├── sessions/                 (system change logs)
  │   │   ├── decisions/                (system decisions)
  │   │   └── templates/                (document shapes)
  │   │
  │   └── <your-domains>/               (marketing, finance, whatever)
  │
  ├── 📒 memory/                        ← Your dashboard
  │   └── HANDOFF.md                    (THE file you read first every day)
  │
  ├── 📚 knowledge/                     ← Reference material (wiki-style)
  │
  ├── ✅ decisions/                     ← Top-level ledger
  │
  └── 📝 scratchpad/                    ← Temporary stuff, delete after 7 days
```

**Reading priority (top-to-bottom, most-important first):**
```
  ⭐ memory/HANDOFF.md         ← What's happening now
  📁 projects/                 ← What I'm building
  🔧 operations/engine-room/   ← How the system runs itself
  📚 knowledge/                ← Reference when needed
```

---

## How memory flows

```
   YOU TALK                         YOUR MAC                       THE CLOUD
   TO YOUR AGENT                 ┌─────────────────┐             ┌──────────┐
   on Telegram  ──────────────▶  │ <AGENT_NAME> bot│ ──────────▶ │          │
                                 │ extracts memory │             │          │
                                 └─────────────────┘             │   BRAIN  │
   YOU USE                       ┌─────────────────┐             │ (Supabase│
   CLAUDE CODE   ──────────────▶ │ Watcher service │ ──────────▶ │          │
   anywhere                      │ scans every 10m │             │    +     │
                                 └─────────────────┘             │  OB1 MCP │
   YOU SAVE A                    ┌─────────────────┐             │ endpoint)│
   MARKDOWN FILE ──────────────▶ │ Same watcher    │ ──────────▶ │          │
   in workspace                  │ picks it up     │             │          │
                                 └─────────────────┘             └────┬─────┘
                                                                      │
                                                                      ▼
                                 ┌─────────────────────────────────────────┐
                                 │ Every question you ask <AGENT_NAME>     │
                                 │ queries the brain first, then answers   │
                                 └─────────────────────────────────────────┘
```

You don't manage this. The services run automatically. You just talk and write, and the system remembers.

---

## End-of-day ritual

```
  ┌─────────────────────────────────────────────────────┐
  │  When you're done working for the day, say:         │
  │                                                      │
  │        "update handoff"  or  "/handoff"              │
  │                                                      │
  │  Your agent does:                                    │
  │  1. Writes today's session log in the right place   │
  │  2. Detects locked decisions and files them         │
  │  3. Updates your HANDOFF.md dashboard                │
  │  4. Archives anything older than 7 days             │
  │                                                      │
  │  Next morning: open HANDOFF.md, see what's live,    │
  │  pick up where you left off.                        │
  └─────────────────────────────────────────────────────┘
```

---

## Getting started

**Don't worry about following this by hand.** The whole setup is automated via Claude Code. Here's literally all you do:

```
┌──── STEP 1 ────────────────────────────────────────────┐
│                                                         │
│  Open Terminal (press Cmd+Space, type "Terminal",      │
│  press Enter)                                          │
│                                                         │
└─────────────────────────────────────────────────────────┘
                          │
                          ▼
┌──── STEP 2 ────────────────────────────────────────────┐
│                                                         │
│  Type this and press Enter:                             │
│                                                         │
│     cd ~/path/to/this/folder                            │
│     claude                                              │
│                                                         │
└─────────────────────────────────────────────────────────┘
                          │
                          ▼
┌──── STEP 3 ────────────────────────────────────────────┐
│                                                         │
│  When Claude Code starts, copy the contents of         │
│                                                         │
│     SETUP-PROMPT.md                                     │
│                                                         │
│  and paste it into the Claude Code prompt.             │
│                                                         │
└─────────────────────────────────────────────────────────┘
                          │
                          ▼
┌──── STEP 4 ────────────────────────────────────────────┐
│                                                         │
│  Answer the questions Claude Code asks you.            │
│  It will walk through everything step by step.         │
│                                                         │
│  Estimated time: 30-60 minutes                         │
│  (most of it is waiting for installs)                  │
│                                                         │
└─────────────────────────────────────────────────────────┘
                          │
                          ▼
                    ┌──────────────┐
                    │   ✅  DONE    │
                    │              │
                    │  You have    │
                    │  your own    │
                    │  AI agent.   │
                    └──────────────┘
```

---

## What you'll need ready

Before you start, have these tabs open in your browser (you can sign up for everything during setup, this is just to know what's coming):

```
  ┌─────────────────────────────────────────────────────┐
  │  1. Supabase  (database + brain storage)            │
  │     https://supabase.com                            │
  │     Cost: FREE forever at your scale                │
  │                                                      │
  │  2. Google AI Studio  (Gemini API for thinking)     │
  │     https://aistudio.google.com                     │
  │     Cost: FREE tier is plenty                       │
  │                                                      │
  │  3. Telegram BotFather  (optional, for phone use)   │
  │     Search "@BotFather" in Telegram                 │
  │     Cost: FREE                                       │
  └─────────────────────────────────────────────────────┘
```

You'll also need:
- A Mac (this is designed for macOS)
- Claude Code installed (https://claude.com/claude-code if not yet)
- About an hour of focused time

---

## If something breaks

Open the file `docs/TROUBLESHOOTING.md` or ask Claude Code: *"something went wrong during setup, help me figure out what"*.

The intake skill is designed to be re-runnable. If you get stuck mid-setup, close Claude Code, reopen it in the same folder, paste `SETUP-PROMPT.md` again, and it'll pick up from where you left off by checking what's already done.

---

## Want to understand it first?

Read `docs/ARCHITECTURE.md` for the "how does this actually work" explainer.

Read `docs/FIRST-DAY.md` for "what do I do with this once it's installed".

Read `starter-workspace/operations/engine-room/memory/runbook.md` for the deep technical explanation of the memory system.

You don't NEED to read any of those to get started. The setup prompt handles everything.
