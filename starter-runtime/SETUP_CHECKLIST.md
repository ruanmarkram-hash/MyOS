# ClaudeClaw OS Setup Checklist

Use this after cloning the starter repo onto a fresh Mac. The root README and
`SETUP-PROMPT.md` are the preferred guided setup path; this file is the manual
checklist for what the setup flow is doing.

## Before You Start

- macOS machine with Terminal access.
- Git installed.
- Node.js 20 or newer installed.
- Claude Code installed and logged in with `claude login`.
- A Telegram account if you want phone access.

## 1. Clone The Starter

```bash
git clone https://github.com/ruanmarkram-hash/StarterOSDad.git
cd StarterOSDad
```

## 2. Run The Guided Setup

```bash
claude
```

Paste the contents of `SETUP-PROMPT.md` into Claude Code. The setup flow should
ask questions one at a time and create the live runtime and workspace from:

- `starter-runtime/`
- `starter-workspace/`

Expected live install locations:

- Runtime: `~/HQ`
- Workspace: `~/workspace`

## 3. Create A Telegram Bot

Do this only if phone access is wanted.

1. Open Telegram and message `@BotFather`.
2. Send `/newbot`.
3. Choose a bot name and username ending in `bot`.
4. Copy the token into `~/HQ/.env` as `TELEGRAM_BOT_TOKEN`.

## 4. Fill In Required Environment Values

Copy the example file if setup has not already done it:

```bash
cd ~/HQ
cp .env.example .env
```

Minimum required values:

```bash
TELEGRAM_BOT_TOKEN=
ALLOWED_CHAT_ID=
DASHBOARD_TOKEN=
DB_ENCRYPTION_KEY=
```

Recommended LLM setup:

```bash
LLM_PROVIDER=claude
```

Leave `ANTHROPIC_API_KEY` blank if using Claude Code OAuth through
`claude login`. Add an API key only if you want pay-per-token API usage.

Optional values:

```bash
GOOGLE_API_KEY=      # video analysis, Gemini helper flows, War Room features
GROQ_API_KEY=        # voice transcription
SLACK_BOT_TOKEN=     # Slack integration
```

## 5. First Run

```bash
cd ~/HQ
npm ci
npm run build
npm run dev
```

If using Telegram, send `/chatid` to the new bot, then paste the returned number
into `~/HQ/.env` as `ALLOWED_CHAT_ID`.

Stop the dev server with `Ctrl+C`, then start again:

```bash
npm run dev
```

Send the bot a test message.

## 6. Dashboard

With the runtime running, open:

```text
http://localhost:3141
```

Use `DASHBOARD_TOKEN` from `~/HQ/.env`.

Useful switches:

```bash
MISSION_CONTROL_V2=0   # legacy at /, v2 at /v2
MISSION_CONTROL_V2=1   # v2 at /, legacy at /legacy
BRAIN=sqlite           # local memory
BRAIN=ob1              # OpenBrain/OB1 with SQLite fallback
LLM_PROVIDER=claude
LLM_PROVIDER=codex
```

## 7. Keep It Running

Use manual mode until the first few test conversations work:

```bash
cd ~/HQ
npm run dev
```

Only enable launchd after the manual run is stable.

## 8. Sanity Checks

```bash
cd ~/HQ
npm audit
npm run build
npm test
```

Expected for this starter snapshot:

- `npm audit`: 0 vulnerabilities
- Build passes
- Test suite passes with skipped live-integration tests unless explicitly enabled

## Important Safety Notes

- Never commit `~/HQ/.env`.
- Never commit `~/HQ/store/`.
- Never reuse another running bot's Telegram token.
- Treat WhatsApp, Slack, Telegram, and OAuth session files as credentials.
