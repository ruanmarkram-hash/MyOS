# MyOS — Setup Checklist

**Install location:** `~/HQ`
**Version:** v1.1.1
**Status as of 2026-04-15: Tokens in place. Ready for first run.**

> Full session context: `~/workspace/scratchpad/DISPATCH_SESSION_HANDOFF_2026-04-15.md`
> Resume prompt for new session: `~/workspace/scratchpad/RESUME_PROMPT.md`

### Current state (2026-04-15)

- [x] Repo cloned and `npm install` complete
- [x] `.env` configured — all 5 bot tokens set (Sage, Charter, Ember, Marlow, Mason)
- [x] `DASHBOARD_TOKEN` and `DB_ENCRYPTION_KEY` auto-generated
- [x] Agent souls migrated from OpenClaw (Charter, Ember, Marlow, Mason, Warden)
- [x] Forge merged into Mason, Lens merged into Marlow
- [x] `~/workspace/` landing zone created
- [ ] `ALLOWED_CHAT_ID` — **needs first run** (send `/chatid` to Sage bot, paste result here)
- [ ] First run test

**One command to start:**
```bash
cd ~/HQ && npm start
```

---

---

## Phase 1: Phone Steps (do these first, anywhere)

### 1. Create a dedicated Telegram bot

> This MUST be a new bot. Do NOT reuse OpenClaw's bot token.

1. Open Telegram, search for **@BotFather**
2. Send `/newbot`
3. Choose a name (e.g. "HQ" or "MyOS")
4. Choose a username ending in `bot` (e.g. `ruan_hq_bot`)
5. BotFather gives you a token like `123456789:AAF...`
6. Copy it — you'll paste it into `.env` at your desk

### 2. Get your Telegram chat ID

After you paste in the bot token and do a first run (Phase 3), send `/chatid` to your new bot and paste the number into `.env` as `ALLOWED_CHAT_ID`. You cannot do this until the bot is running once.

### 3. (Optional but recommended) Get a Groq API key — free

- Go to https://console.groq.com
- Sign in with Google or GitHub
- Create a free API key
- This enables voice transcription (Whisper) — send voice notes to your bot

### 4. (Optional) Get a Google AI Studio key — free

- Go to https://aistudio.google.com
- Sign in and create an API key
- This enables: video analysis, memory consolidation, and War Room voice mode

---

## Phase 2: Desk Steps — Fill in .env

Open `~/HQ/.env` and fill in the following. Everything else is pre-filled or optional.

| Variable | Where to get it | Required? |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | @BotFather on Telegram | **YES** |
| `ALLOWED_CHAT_ID` | Send `/chatid` to your bot after first run | **YES** |
| `ANTHROPIC_API_KEY` | https://console.anthropic.com — only needed for pay-per-token. Leave blank to use `claude login` OAuth (recommended for Max plan) | Optional |
| `GROQ_API_KEY` | https://console.groq.com (free) | Optional — enables voice input |
| `GOOGLE_API_KEY` | https://aistudio.google.com (free) | Optional — enables video, memory consolidation, War Room |
| `ELEVENLABS_API_KEY` + `ELEVENLABS_VOICE_ID` | https://elevenlabs.io | Optional — cloud TTS |
| `SLACK_USER_TOKEN` | Slack app settings (see README) | Optional |

> **Already pre-filled (no action needed):**
> - `DASHBOARD_TOKEN` — generated automatically
> - `DB_ENCRYPTION_KEY` — generated automatically
> - `GOOGLE_CREDS_PATH`, `GMAIL_TOKEN_PATH`, `GCAL_TOKEN_PATH` — default paths

---

## Phase 3: Desk Steps — First Run

### 1. Make sure Claude Code CLI is logged in

```bash
claude login
```

If already logged in for OpenClaw, this is the same global auth — no action needed unless you want a separate account.

### 2. Do a first run to get your chat ID

```bash
cd ~/HQ
npm run dev
```

- Watch the terminal for the banner
- On first launch, macOS may show permission dialogs — click **Allow** on each one
- Open Telegram, message your new bot with `/chatid`
- Copy the number it replies with
- Press Ctrl+C to stop the bot

### 3. Paste your chat ID into .env

```bash
# Open ~/HQ/.env and set:
ALLOWED_CHAT_ID=<the number from step 2>
```

### 4. Start the bot again and test it

```bash
cd ~/HQ
npm run dev
```

Send a message to your bot. It should reply.

### 5. (Optional) Run the interactive setup wizard

```bash
cd ~/HQ
npm run setup
```

This can help configure PIN security, emergency kill phrase, and other settings interactively.

---

## Phase 4: Optional Features

### Voice input (Groq/Whisper)

Paste `GROQ_API_KEY` into `.env` and restart. Send a voice note to your bot — it transcribes automatically.

### War Room (voice boardroom)

Requires `GOOGLE_API_KEY` set in `.env`, then:

```bash
cd ~/HQ
python3 -m venv warroom/.venv
source warroom/.venv/bin/activate
pip install -r warroom/requirements.txt
```

Enable in `.env`:
```
WARROOM_ENABLED=true
WARROOM_PORT=7860
WARROOM_MODE=live
```

### Web dashboard

Already configured — `DASHBOARD_TOKEN` is set. When the bot is running, open:

```
http://localhost:3141
```

Use `DASHBOARD_TOKEN` from `.env` to log in.

### Specialist agents (research, comms, content, ops)

Agents are pre-configured in `~/HQ/agents/`. Each needs its own `agent.yaml` copied from `agent.yaml.example` and filled in. See the README for the multi-agent setup section.

---

## Phase 5: Keep It Running (Manual Only — DO NOT enable launchd yet)

To start HQ manually each session:

```bash
cd ~/HQ && npm run dev
```

To run as a background process (without launchd):

```bash
cd ~/HQ && nohup npm run dev > /tmp/hq.log 2>&1 &
```

---

## Important Notes

- **Isolation:** HQ is fully isolated from OpenClaw (`~/.openclaw`). Different bot token, different database, different config directory.
- **launchd is NOT enabled.** Run manually until everything is stable.
- **Do NOT reuse OpenClaw's Telegram bot token** — two bots on the same token will conflict silently.
- **The `.env` file contains secrets** — it is gitignored. Do not commit it.

---

## Quick Reference: What's Already Done

- [x] Node.js 25.9.0 verified (>= 20 required)
- [x] git 2.53.0 verified
- [x] Port 3141 (dashboard) — free
- [x] Port 7860 (warroom) — free
- [x] Repo cloned to `~/HQ`
- [x] `npm install` completed (6 moderate deprecation warnings, nothing critical)
- [x] `.env` created from `.env.example`, safe values pre-filled
- [x] `DASHBOARD_TOKEN` generated and set
- [x] `DB_ENCRYPTION_KEY` generated and set
- [ ] `TELEGRAM_BOT_TOKEN` — needs your new bot token
- [ ] `ALLOWED_CHAT_ID` — get after first run
- [ ] `ANTHROPIC_API_KEY` — optional (leave blank for OAuth)
- [ ] `GROQ_API_KEY` — optional (voice input)
- [ ] `GOOGLE_API_KEY` — optional (video + War Room)
