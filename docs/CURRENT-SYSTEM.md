# Current System Snapshot

This repo is a portable starter copy of a live ClaudeClaw-style operating system.
It is not a database backup and it does not include private runtime state.

## What Is Included

- `starter-runtime/`: the Telegram bot runtime, dashboard, mission scheduler, provider adapter, agent creation flow, launchd scripts, and tests.
- `starter-workspace/`: the workspace shape the assistant expects: projects, memory, knowledge, decisions, scratchpad, and the operations engine room.
- `starter-workspace/operations/engine-room/skills/`: reusable operating skills and helper scripts.
- `starter-workspace/operations/engine-room/agents/_template/`: a blank specialist-agent template.

## What Is Intentionally Not Included

- `.env` files, API keys, bot tokens, OAuth tokens, and local Claude settings.
- `store/`, SQLite databases, WhatsApp sessions, Slack messages, Telegram logs, and conversation history.
- Built output such as `dist/`, `web/dist/`, `node_modules/`, and local virtualenvs.
- Personal `CLAUDE.md` files and active agent `agent.yaml` configs.

## Main Switches

Set these in `.env` after setup.

```bash
# Main LLM provider. Default is Claude.
LLM_PROVIDER=claude
# LLM_PROVIDER=codex

# Mission Control UI.
MISSION_CONTROL_V2=0   # legacy at /, v2 at /v2
# MISSION_CONTROL_V2=1 # v2 at /, legacy at /legacy

# Remote memory.
BRAIN=sqlite           # default local memory
# BRAIN=ob1            # OpenBrain/OB1 with SQLite fallback

# Safety switches.
LLM_SPAWN_ENABLED=true
DASHBOARD_MUTATIONS_ENABLED=true
```

Specialist agents default to Claude even when the main assistant uses Codex. To opt
a specialist into Codex, set this in that agent's `agent.yaml`:

```yaml
provider: codex
model: gpt-5.4
```

## AFK Mission Pattern

AFK work runs as mission tasks, not as one long foreground chat turn.

1. The main assistant creates a mission with `dist/mission-cli.js`.
2. The scheduler assigns it to a specialist agent.
3. Code missions run in isolated git worktrees under `.worktrees/mission-<id>/`.
4. The scheduler snapshots, pushes, and merges successful mission branches.
5. Mission results surface back through Mission Control and Telegram.

This avoids moving the shared runtime checkout while other agents are active.

## Durable Check-Backs

Use operation notifications for "check again later" style work. They are stored in
SQLite and survive bot restarts, session resets, and user replies.

```ts
import { scheduleOperationNotification } from './src/operation-notify.js';

scheduleOperationNotification({
  agentId: 'main',
  chatId: ALLOWED_CHAT_ID,
  operationId: `checkback-${Date.now()}`,
  fireAt: new Date(Date.now() + 30 * 60 * 1000),
  message: 'Reminder: check the mission result',
});
```

## Setup Flow

For a fresh machine:

```bash
git clone <this repo>
cd <this repo>
claude
```

Then paste the contents of `SETUP-PROMPT.md` into Claude Code. The setup flow is
designed to ask one question at a time and create the live runtime from the starter
folders.
