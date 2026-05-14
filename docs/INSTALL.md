# Install guide (plain English)

**Short version:** open Codex in this folder, paste the contents of `SETUP-PROMPT.md`, follow along.

Codex does the actual work. You answer a handful of questions. This guide is only here if you want to know what's coming before you start, or if something breaks and you want to know what SHOULD be happening.

**Prefer pictures over text?** Open [`how-it-works.html`](how-it-works.html) in your browser for a visual walkthrough of the whole system.

## Before you begin

### You need

- A Mac (macOS 12 or newer)
- Codex installed ([download here](https://codex.com/codex-code) if not)
- A Google account (for Gemini API)
- Either a Google or GitHub account (for Supabase)
- Optionally: a Telegram account (for phone access)
- About an hour of focused time (most of it is waiting for installs to finish)

### You'll be signing up for

All free:

1. **Supabase** — cloud database for your memory
2. **Google AI Studio** — the Gemini API your assistant uses to think
3. **Telegram BotFather** (optional) — to create a bot you can message from your phone

None of these cost money at your usage level. Probably forever.

## The phases at a glance

The setup runs in phases. Each one has a clear goal. The assistant walks you through them in order, one at a time.

| Phase | What happens | Your job |
|-------|--------------|----------|
| 0 | Assistant asks where your existing Codex / workspace files live, then looks around based on your pointers | Answer a few questions about where you've used Codex before |
| 1 | Assistant explains what it's about to build | Say yes to proceed |
| 2 | Collects basic info about you and your agents | Answer: name, use-case, Telegram yes/no, timezone, main agent name + personality, optional specialist agents |
| 2.5 | Surveys which extra services you'd like your agent connected to (email, iMessage, Slack, etc.) | Say yes / no / not yet for each. Warning given about admin-access limits on work accounts |
| 3 | Creates `~/workspace/` folder structure on your Mac | Confirm the tree looks right |
| 4 | Copies bundled MyOS runtime into `~/myos/` and runs `npm install` | Wait for `npm install` |
| 5 | Walks you through Supabase signup + setup | Sign up, click through to create project, paste 4 values back |
| 6 | Walks you through Gemini API key | Sign in, create key, paste back |
| 7 | (Optional) Walks you through Telegram bot creation | Create bot via BotFather, paste token + chat ID back |
| 8 | Generates the MCP access key | Just watch |
| 9 | Writes your `.env` file with every secret collected | Watch |
| 10 | Applies database migrations to your Supabase | Watch |
| 11 | Deploys the edge function (MCP server) | Watch |
| 12 | Builds MyOS | Watch |
| 13 | Installs 5 brain services + main bot (launchd) | Watch |
| 14 | Creates your main agent + any specialists you asked for | Confirm the agents' personalities fit |
| 15 | Registers the brain MCP with Codex | Watch |
| 16 | Symlinks skills into `~/.codex/skills/` | Watch |
| 17 | Runs smoke test end-to-end | Watch for PASS |
| 18 | Captures your first memory + runs first `/handoff` | Watch |
| 18.5 | Wires up each extra service from your Phase 2.5 wishlist | Follow along; for work accounts that fail admin checks, the assistant just moves on |
| 19 | **Day 1 training** (very important): walks through the 7 modes of use, scaffolds your first real project, designs your first workflow, shows the session-close ritual LIVE, has YOU practice it | Follow along, answer questions, do the practice loop |
| 20 | Wrap-up: hands you a quick-reference card | Ask any final questions |

## What could go wrong

The most common failures and what to do:

### "`psql` command not found"
The assistant will install it via `brew install libpq`. If Homebrew isn't installed either, it'll walk you through that first.

### "`supabase` command not found"
Same deal: `brew install supabase/tap/supabase`.

### "Gemini API says quota exceeded"
Free tier has per-minute limits. The setup will pause and retry. If it keeps failing, you can wait 10 minutes or bump to the paid tier (cents per day at your volume).

### "launchd bootstrap: 5: Input/output error"
Your macOS version might need a different command (`launchctl load` instead of `bootstrap`). The assistant handles this automatically.

### "My Supabase URL has a different format"
New Supabase projects sometimes format URLs differently. Paste whatever they give you. The assistant will normalise it.

### "I closed Codex in the middle of setup"
No problem. Reopen the starter folder, run `codex` again, paste `SETUP-PROMPT.md` again. The assistant can pick up from where it left off by checking what's already done (`.env` exists? `~/workspace/` exists? services loaded?).

## What happens after install

Open `docs/FIRST-DAY.md` for what to do now.

The TL;DR:
1. Open `~/workspace/memory/HANDOFF.md` — your dashboard
2. Open Terminal, `cd ~/workspace`, type `codex`, start working
3. End of session, say **"update handoff"**
4. Repeat forever

## Getting help

- Ask the assistant directly. It knows the system. "Something's not working, walk me through fixing it."
- Check `docs/TROUBLESHOOTING.md` for common issues.
- If you're really stuck, open an issue on the repo with the exact error message, the command you were running, and the last thing that worked.
