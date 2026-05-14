---
name: intake-and-setup
description: |
  Guided, end-to-end installation of the MyOS system on the user's Mac.
  Walks a non-technical user through: inventory of existing Codex files,
  consolidation of scattered workspaces, signup + credential collection for
  Supabase + Gemini + Telegram, application of SQL migrations, deployment of
  the brain MCP edge function, installation of 5 launchd brain services,
  creation of the first agent, and verification via smoke test. Use this skill
  when the user says "set up MyOS", "run the setup", "install myos",
  or when they open the starter kit folder with SETUP-PROMPT.md.
author: Ruan Markram
version: 1.0.0
---

# Intake and setup

Walk the user through setting up the entire system from bare scratch. This is a long conversation with many pauses for user input, credential collection, and verification. The skill runs in phases; each phase has an explicit name, a goal, and clear exit criteria.

## Core operating rules

- **One question at a time.** Do not present checklists. Ask, wait, act, confirm, next.
- **Explain before you execute.** Every shell command or API call gets a one-sentence plain-language explanation before it runs.
- **Verify every phase.** No advancing until the current phase is green.
- **Pause for user input** when credentials, choices, or permissions are needed. Do not guess.
- **Be concrete.** If they need to click somewhere, give them the exact URL and what to look for on the page.
- **Narrate only outcomes.** Do not say what you're about to do. Do it, then say what happened.
- **No em dashes. No AI cliches.**

## Phase 0 — Inventory (conversational, not prescriptive)

**Goal:** Understand what's already on the user's Mac so nothing of value is lost and the new system is built clean. The user's folders are unique to them. Don't assume where anything lives. Ask them first, then search based on their pointers.

### Step 0.1 — Ask plainly

Ask the user, in sequence:

1. **"Have you used Codex before?** If yes, roughly where did you run it from — any folders you can name? Just approximate, like 'I opened a terminal in my Desktop sometimes' or 'I think I had something in Documents'. If you're not sure, that's fine — I'll look around."

2. **"Are there any folders you've been using as a workspace for your work?** Places where you keep notes, project files, or anything AI-related? Again, just rough pointers — 'my Documents folder', 'a folder on Desktop called X'."

3. **"Have you tried installing anything MyOS, OpenClaw, Hermes, or similar before?** If yes, do you remember where?"

4. **"Is there anything specific you want me to make sure I preserve?** Like a specific folder, a specific file, a specific project you've been working on?"

Wait between each question. Note the answers.

### Step 0.2 — Search based on what they said

Now search the locations they pointed at, plus a few sensible defaults. Do NOT assume `~/.codex/`, `~/myos/`, `~/workspace/`, or any specific path — check if each exists before assuming.

**Check these common locations one at a time** (explain each check briefly as you go):

- **Codex config** (usually at `~/.codex/` if Codex is installed): check if it exists, list what's inside if so.
- **User-pointed folders**: run a `find` or `ls` on each folder they mentioned.
- **Common defaults for scattered work**: `~/Desktop/`, `~/Documents/`, `~/iCloud Drive (if synced)`, `~/Downloads/`. Look for folders with names like `workspace`, `projects`, `codex`, `agents`, `myos`, or any `AGENTS.md` files.

**Use an adaptive search.** Example pattern for each user-indicated folder:

```bash
# For each folder the user pointed at, do a shallow check
ls -la "$USER_FOLDER"
# And a shallow recursive search for relevant filenames
find "$USER_FOLDER" -maxdepth 4 -type f \( -name "AGENTS.md" -o -name "HANDOFF.md" -o -name "agent.yaml" -o -name ".env" -o -name "SKILL.md" \) 2>/dev/null
```

**Do NOT deep-scan their entire home directory.** That's invasive and slow. Only go where they've pointed or where common-default locations make sense.

### Step 0.3 — Report in plain language

Summarise what you found. No paths dumped raw. Group by what you think you're looking at:

```
Here's what I found:

  Codex config (~/.codex/):  Looks unused, just defaults. Safe.

  On your Desktop:
    ~/Desktop/ai-stuff/     Has some notes and a AGENTS.md from what
                            looks like an early setup attempt. About 12 files.
    ~/Desktop/my-writing/   A folder of markdown notes you've been
                            keeping. About 40 files.

  In Documents:
    ~/Documents/workspace/  Has project folders inside. Not sure
                            exactly what's here — want me to list them?

  Nothing found matching: myos, openclaw, hermes.

Before we build the new system:
  - Which of these do you want to keep and integrate? (we'll copy them
    into the new workspace later)
  - Which are safe to leave where they are / archive / ignore?
  - Are we starting fresh or merging with existing work?
```

### Step 0.4 — Listen to the user

If they want to explore one of the folders in more detail ("what's in Documents/workspace?"), do a deeper `ls` on that specific one. Don't presume.

If they say "that folder I made last year, never used it, ignore", mark it for later archive and move on.

If they point at something you didn't find, ask them to give you the exact path or a better hint ("check my iCloud Drive", "it's in Downloads/old-stuff") and search there.

**Wait for their answer. Do not proceed until they've confirmed what to preserve vs ignore vs merge.**

### Step 0.5 — Record decisions

Make a quick mental/working note of:
- Folders to PRESERVE (merge into new workspace in Phase 7)
- Folders to IGNORE (leave alone)
- Folders to ARCHIVE (move aside, don't delete, out of the way)

**Exit criteria:** User has named what matters and what doesn't. You have a list of paths to handle in Phase 7 (integration of existing content), if any. You have NOT deleted or moved anything yet.

## Phase 1 — Explain what we're building

**Goal:** Set expectations. Tell the user what the next 30-60 minutes looks like.

**Say something like:**

> I'm going to set up your own personal AI assistant with memory. It has five pieces:
>
> 1. A **database in the cloud** that stores every memory and decision (free Supabase project).
> 2. A **small server** on that database that the AI talks to (an edge function).
> 3. **Five background helpers** on your Mac that keep the memory fresh (watch for new files, health checks, weekly backups).
> 4. An **agent** (the AI personality) that reads your memory and answers you.
> 5. A **folder structure** on your Mac (`~/workspace/`) where you keep your work, and a daily file called HANDOFF.md that shows what's current.
>
> To set this up I'll need you to sign up for 2 free services (Supabase and Google Gemini) and paste a few keys back to me. Optionally a 3rd (Telegram) if you want phone access.
>
> Ready?

**Wait for them to say yes.**

**Exit criteria:** User has acknowledged the scope.

## Phase 2 — Collect essential user info

Ask these questions in order, one at a time. Wait for each answer.

### 2.1 — About you

1. **Your first name?** (used by your agent to address you)
2. **What do you mainly want this assistant for?** One-to-two sentence answer. Examples: "managing my small business", "staying on top of family admin", "writing and research". This shapes the agent's personality.
3. **Do you want Telegram access?** Yes = create a bot so you can message the assistant from your phone. No = only use it through your Mac via Codex.
4. **What timezone are you in?** (so morning briefings fire at the right time)

### 2.2 — Your main agent

Explain this first:

> You'll have one main agent — your "chief of staff." They'll be the first point of contact for everything. Later you can add specialists, but let's start with one.

Then ask:

5. **What do you want to name your main agent?** Offer suggestions if they hesitate. Generic options that work well:
   - **Atlas** (broad, confident, carries-the-world vibe)
   - **Pilot** (guides, steers, takes charge)
   - **Navigator** (finds the way, keeps course)
   - **Compass** (points true north, orienting)
   - **Signal** (clean, clear, cuts through noise)
   - **Echo** (warm, reflects you back to yourself)
   - Or any human name they like (e.g. "Jane", "Marcus")

6. **What personality should they have?** Offer a few archetypes:
   - **Warm and calm** — friendly, unhurried, patient explainer
   - **Sharp and direct** — no fluff, gets to the point, pushes back
   - **Analytical** — careful, evidence-first, asks clarifying questions
   - **Supportive coach** — encouraging, reframes problems, cheerleader energy

   Let them mix and match. Capture their answer in free text — you'll bake it into the agent's AGENTS.md in Phase 14.

### 2.3 — Specialist agents (optional, can skip)

Explain:

> Beyond your main agent, you can add specialists for specific domains. You can also add these later — nothing here is permanent. Want to set any up now, or skip this for now?

If they want to skip, move on. If they want specialists, offer these archetypes (full detail is in `docs/AGENT-ARCHETYPES.md`):

- **Compliance / governance agent** — tracks regulations, audits, corrective actions. Good if you run a regulated business.
- **Developer / builder agent** — writes code, wires integrations, does automation.
- **Content / outreach agent** — drafts emails, social posts, marketing copy.
- **Strategic intelligence agent** — market scanning, decision support, pushback on weak thinking.
- **Workspace health monitor** — silent watchdog, only speaks when something breaks.

For each specialist they want:

7. **Which archetype?** (pick one from the list)
8. **What should the specialist be named?** (generic suggestions: Warden, Forge, Muse, Scout, Sentry — or let them choose)
9. **Any personality tweaks?** (optional free-text; they can leave blank and you'll use the archetype default)

**Save all of this to memory.** You'll use it in Phase 14 where you actually create the agent folders.

**Exit criteria:** You have: user name, use-case, telegram-yes-no, timezone, main agent name + personality, and (optionally) a list of specialist agents with their archetype + name + personality notes.

## Phase 2.5 — Extra services wishlist (planning only)

**Goal:** Find out which external services the user wants their agent to reach into so we can plan for it. This is a survey — no wiring happens until Phase 18.5, after the core system is live.

Explain to the user:

> Beyond talking in Telegram or Codex, your agent can be connected to other services so it can read, write, and act on your behalf. Let me find out which ones you're interested in now — we'll actually wire them up at the end once everything else is working.

Then walk through these categories one at a time. For each, ask **"yes / no / not yet"**:

### Communication
- **iMessage** (read your conversations, draft replies) — macOS only, needs Full Disk Access
- **Email (Gmail)** — OAuth, agent can draft, search, and send emails
- **Email (Outlook / Microsoft 365)** — OAuth via Microsoft Graph
- **WhatsApp** — runs as a bridge in your account; needs the bot to be always-on
- **Slack** — personal workspaces only; OAuth User Token
- **Telegram** (already covered in Phase 2 if yes)

### Calendar & tasks
- **Google Calendar** — OAuth; agent can read, create, move events
- **Apple Calendar / Reminders** — macOS only, needs Full Disk Access
- **Notion** — integration token, agent can read and edit pages

### Files & notes
- **Obsidian vault** — point the agent at a vault folder; auto-reads notes for context
- **Google Drive** — OAuth; agent can search and read files
- **SharePoint / OneDrive** — via Microsoft Graph; useful for work documents

### Voice & media
- **Voice transcription (Groq Whisper)** — send voice notes to Telegram, get text back
- **Text-to-speech (ElevenLabs)** — agent can reply with voice
- **War Room** (video boardroom with multiple AI voices) — advanced, Pipecat-based

### Monitoring & alerts
- **Sentry** — error tracking for your own projects
- **Grafana / Prometheus webhooks** — system alerts routed to Telegram

### ⚠️ Important warning to give the user

> Some of these services require **administrator permissions** on the machine, or require approval from an IT admin on work / company accounts. If your email, calendar, or Slack is managed by your employer, you may not be able to grant the access needed. That's OK — we'll skip anything that can't be wired without causing friction. If you're not sure, we can try and see what the service responds with.

Specifically flag these as at-risk for corporate accounts:
- Work Gmail / G Suite (often has OAuth apps disabled by admin)
- Work Microsoft 365 (admin consent required for many scopes)
- Work Slack workspace (installer often restricted)
- iMessage / Apple Calendar (requires Full Disk Access prompt — user must approve, device must not be MDM-restricted)

### Record the plan

Write everything to `~/workspace/scratchpad/extra-services-plan.md` in this format:

```markdown
# Extra services wishlist

Captured during intake on <DATE>.

## Yes — wire up in Phase 18.5
- <Service A> — <any relevant notes, account type, scopes needed>
- <Service B> — ...

## Not yet / unsure
- <Service X> — <user wanted to think about it>

## Skipped / blocked
- <Service Y> — <reason: admin-locked, not used, etc.>
```

**Exit criteria:** File `extra-services-plan.md` exists with the user's answers. User has been warned about admin-access constraints on work accounts.

## Phase 3 — Install the starter workspace

**Goal:** Lay down the `~/workspace/` folder structure on the user's Mac.

```bash
# Create ~/workspace/ if it doesn't exist
mkdir -p ~/workspace

# Copy the scaffolded starter-workspace from this kit into ~/workspace/
# (assuming the user's current working directory is the starter kit root)
rsync -av starter-workspace/ ~/workspace/

# Verify
ls ~/workspace/
```

**Edit the top-level README.md** at `~/workspace/README.md`: replace placeholder `<USER_FIRST_NAME>` with what you collected in Phase 2.

**Edit the HANDOFF.md template** at `~/workspace/memory/HANDOFF.md`: replace placeholders with initial content. The initial HANDOFF should say something like "Fresh install, system set up on <date>. No projects active yet."

**Show the user:**

```bash
tree -L 2 ~/workspace/
```

**Explain:** "This is your new workspace. You'll live in here from now on. Two folders matter most: `projects/` for things you're building, `operations/` for things you run."

**Exit criteria:** `~/workspace/` exists with the full scaffolded structure. User has seen the tree.

## Phase 4 — Install MyOS runtime

**Goal:** Copy the bundled MyOS runtime code from this starter kit to `~/myos/` and install its Node.js dependencies.

The runtime lives in `starter-runtime/` inside this starter kit — a fully sanitised copy of the TypeScript bot runtime, brain worker scripts, DB migrations, edge function, and launchd templates.

```bash
# Copy bundled runtime (this starter kit is your current working directory)
mkdir -p ~/myos
rsync -av --exclude='node_modules/' --exclude='dist/' starter-runtime/ ~/myos/

# Install Node.js dependencies
cd ~/myos && npm install
```

**Explain to the user:** "This is the actual bot code. It lives at `~/myos/` and will run as a background service once we set it up. The starter kit folder can be moved or deleted after setup finishes — everything from here on lives at `~/myos/` and `~/workspace/`."

**Verify:**

```bash
ls ~/myos/src/ ~/myos/scripts/ ~/myos/migrations/ ~/myos/supabase/functions/brain-mcp/ ~/myos/launchd/
```

Expect to see source files, scripts, migrations, the edge function, and the 6 launchd plists.

**If `npm install` errors:** The most common cause is Node version. Check:

```bash
node -v
```

If less than 20, install newer Node:

```bash
brew install node@20 && brew link node@20 --overwrite
```

Then retry `npm install`.

**Exit criteria:** `~/myos/` contains source, scripts, migrations, edge function, launchd plists. `npm install` ran clean.

## Phase 5 — Supabase signup and setup

**Goal:** Get a free Supabase project that will host the brain.

**Tell the user, step by step, one message at a time:**

### Step 5.1

> Open https://supabase.com and sign up with your Google or GitHub account. It's free. Tell me when you're signed in.

Wait.

### Step 5.2

> Click **New project**. For name, type `my-brain` (or anything). For password, use something you'll remember or save to a password manager. Choose the region closest to you. Click Create. This takes about 1-2 minutes while it provisions. Tell me when it's ready (the dashboard will show).

Wait.

### Step 5.3

> In the left sidebar: go to **Database → Extensions**. Search for "vector" and flip it ON. This enables the brain's search mechanism.

Wait for confirmation.

### Step 5.4

> In the left sidebar: go to **Project Settings → API**. You'll see three values. Copy and paste each one back to me, one at a time, when I ask.
>
> First: **Project URL** (it looks like `https://<something>.supabase.co`). Paste that here.

Wait. Store the answer as `OB1_SUPABASE_URL`.

### Step 5.5

> Next: the **anon public** key (a long string starting with `eyJ...`). Paste that here.

Wait. Store as `OB1_SUPABASE_ANON_KEY`.

### Step 5.6

> Next: the **service_role** key (also starts with `eyJ...`, but it's marked secret). Click "Reveal" first. Paste it here.

Wait. Store as `OB1_SUPABASE_SERVICE_KEY`. **Warn the user:** this key is like a master password for the database. Don't share it with anyone. Don't post it in Telegram or Slack.

### Step 5.7

> Now click **Connect** (top right of the Supabase project dashboard). Find the "Direct" connection option (the database-cylinder icon). Copy the full connection string. It looks like `postgresql://postgres.xxx:[YOUR-PASSWORD]@...`. Replace `[YOUR-PASSWORD]` with the password you set in step 5.2. Paste the complete thing back to me.

Wait. Store as `OB1_SUPABASE_DB_URL`.

### Step 5.8

> Install the Supabase CLI if it's not already. I'll do this for you.

```bash
brew install supabase/tap/supabase
```

### Step 5.9

> Log in to Supabase CLI. I'll start it; you'll get a browser popup to confirm.

```bash
supabase login
```

Wait for browser flow completion.

### Step 5.10

> Link this project to your new Supabase project.

```bash
cd ~/myos
supabase link --project-ref <project-ref>
```

(Extract the project-ref from the URL the user gave in 5.4. It's the subdomain part of `https://<ref>.supabase.co`.)

**Exit criteria:** 4 Supabase credentials collected. CLI logged in and linked. pgvector extension enabled.

## Phase 6 — Gemini API key

### Step 6.1

> Open https://aistudio.google.com and sign in with your Google account. Click **Get API key** in the top left.

Wait.

### Step 6.2

> Click **Create API key**. Pick any Google project (or create a new one). Copy the key that appears. It starts with `AIza...`. Paste it here.

Wait. Store as `GOOGLE_API_KEY`. **Warn the user:** same as the Supabase service key — treat this as a password.

**Exit criteria:** `GOOGLE_API_KEY` collected.

## Phase 7 — Telegram bot (skip if user said no in Phase 2)

### Step 7.1

> Open Telegram. Search for `@BotFather`. Start a chat with it. Send `/newbot`.

Wait.

### Step 7.2

> BotFather will ask for a name and a username. Pick anything. The username must end in `bot` and be unique.

Wait.

### Step 7.3

> BotFather will send you a message with a token that looks like `1234567890:AAH...`. Paste it here.

Wait. Store as `TELEGRAM_BOT_TOKEN`.

### Step 7.4

> Send your new bot any message in Telegram (just "hi" works). Then come back.

Wait.

### Step 7.5

> Run this for me to find your chat ID.

```bash
curl -s "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/getUpdates" | jq '.result[0].message.chat.id'
```

Capture the chat ID. Store as `ALLOWED_CHAT_ID`. **Explain:** this locks the bot so only you can talk to it.

**Exit criteria:** `TELEGRAM_BOT_TOKEN` + `ALLOWED_CHAT_ID` collected.

## Phase 8 — Generate the MCP access key

```bash
MCP_ACCESS_KEY=$(openssl rand -hex 32)
echo "Your MCP access key: $MCP_ACCESS_KEY"
```

Store as `MCP_ACCESS_KEY`. This is a 64-character secret that locks the brain's API.

## Phase 9 — Write the .env file

**Goal:** Create `~/myos/.env` with every secret collected so far.

Compose the file from the template at `~/myos/.env.example`, filling in each value.

```bash
cat > ~/myos/.env <<EOF
# Supabase
OB1_SUPABASE_URL=<value from Phase 5.4>
OB1_SUPABASE_ANON_KEY=<value from 5.5>
OB1_SUPABASE_SERVICE_KEY=<value from 5.6>
OB1_SUPABASE_DB_URL=<value from 5.7>

# Gemini
GOOGLE_API_KEY=<value from Phase 6>

# Brain MCP
MCP_ACCESS_KEY=<value from Phase 8>
OB1_BRAIN_FUNCTION=brain-mcp
BRAIN=ob1

# Telegram (only if set up)
TELEGRAM_BOT_TOKEN=<value from 7.3>
ALLOWED_CHAT_ID=<value from 7.5>
EOF

chmod 600 ~/myos/.env  # only the user can read it
```

**Verify:**

```bash
grep -c "=" ~/myos/.env  # should match the number of variables above
```

**Exit criteria:** `~/myos/.env` written with all collected values. File permissions are 600.

## Phase 10 — Apply the database migrations

**Goal:** Create the `thoughts` table and all supporting structures in Supabase.

```bash
source ~/myos/.env
/opt/homebrew/opt/libpq/bin/psql "$OB1_SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f ~/myos/migrations/ob1/001_base_thoughts.sql
/opt/homebrew/opt/libpq/bin/psql "$OB1_SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f ~/myos/migrations/ob1/002_enhanced_thoughts.sql
```

**If `psql` isn't installed, install it:**

```bash
brew install libpq
```

**Verify:**

```bash
source ~/myos/.env
/opt/homebrew/opt/libpq/bin/psql "$OB1_SUPABASE_DB_URL" -c "\d thoughts" | head -20
```

Show the user: "Your brain database is now ready. It has a `thoughts` table waiting for content."

**Exit criteria:** Both migrations ran cleanly. `thoughts` table visible.

## Phase 11 — Deploy the edge function

```bash
cd ~/myos
source .env
supabase secrets set GOOGLE_API_KEY="$GOOGLE_API_KEY" MCP_ACCESS_KEY="$MCP_ACCESS_KEY"
supabase functions deploy brain-mcp --no-verify-jwt
```

**Verify:**

```bash
# Smoke test: ping the MCP endpoint
curl -sS -X POST "$OB1_SUPABASE_URL/functions/v1/brain-mcp" \
  -H "x-brain-key: $MCP_ACCESS_KEY" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"setup","version":"1"}}}'
```

Expect a response like `{"result":{"protocolVersion":"2024-11-05", ...}}`. If you get that, the brain is alive.

**Exit criteria:** Edge function deployed. Initialize ping returns a valid JSON-RPC response.

## Phase 12 — Build MyOS

```bash
cd ~/myos
npm run build
```

**Verify:** `~/myos/dist/` now exists with compiled JS.

**Exit criteria:** `npm run build` exits 0.

## Phase 13 — Install the launchd services

**Goal:** Schedule the 5 brain services and the main bot so they run forever in the background. The plist templates live in `~/myos/launchd/` (copied there in Phase 4).

```bash
# Copy templates to the LaunchAgents folder, substituting <USER_HOME> with $HOME.
cd ~/myos/launchd

for plist in com.myos.*.plist; do
  sed "s|<USER_HOME>|$HOME|g" "$plist" > "$HOME/Library/LaunchAgents/$plist"
done

# Load each service. "main" is the Telegram bot; the other 5 handle the brain.
for label in main brain-watcher brain-monitor brain-backup brain-drift entity-worker; do
  launchctl bootstrap gui/$(id -u) "$HOME/Library/LaunchAgents/com.myos.$label.plist" 2>/dev/null || \
    launchctl load -w "$HOME/Library/LaunchAgents/com.myos.$label.plist"
done
```

**Note on `launchctl bootstrap` vs `load`:** `bootstrap` is the modern syntax (macOS 11+). On some systems it returns `Input/output error` — the `||` fallback uses the older `load -w` syntax. Either works.

**If the user opted out of Telegram access in Phase 2**, skip loading the `main` service. The bot will not run without `TELEGRAM_BOT_TOKEN` / `ALLOWED_CHAT_ID` set in `.env`; use Codex as the access path instead.

**Verify:**

```bash
launchctl list | grep myos
```

Expect 6 entries with exit code 0 (or 5 if Telegram was skipped).

**Exit criteria:** All expected services loaded.

## Phase 14 — Create the agents

**Goal:** Stand up every agent the user asked for in Phase 2 (the main agent plus any specialists).

### 14.1 — The main agent

Using the user's inputs from Phase 2 (their name, use-case, main agent name, main agent personality), copy the `_template/` folder to `~/workspace/operations/engine-room/agents/main/` and customize.

```bash
cp -r ~/workspace/operations/engine-room/agents/_template ~/workspace/operations/engine-room/agents/main
```

Then edit `~/workspace/operations/engine-room/agents/main/AGENTS.md`. Replace every placeholder:

- `<AGENT_NAME>` → the name they chose for their main agent (from Phase 2 step 5)
- `<USER_NAME>` → their first name (from Phase 2 step 1)
- `<USER_CONTEXT>` → their use-case (from Phase 2 step 2)
- `<USER_TIMEZONE>` → their timezone (from Phase 2 step 4)
- Personality section → fold in the personality answer (from Phase 2 step 6)

Also edit `~/workspace/operations/engine-room/agents/main/agent.yaml`:

- `name:` → agent name
- `bot_token_env:` → `TELEGRAM_BOT_TOKEN` if they set up Telegram, else leave blank
- `timezone:` → their timezone

**Symlink back to `~/myos/agents/` so MyOS can discover it:**

```bash
mkdir -p ~/myos/agents
ln -s ~/workspace/operations/engine-room/agents/main ~/myos/agents/main
```

### 14.2 — Specialist agents (if any)

If the user asked for specialists in Phase 2.3, repeat the pattern for each one. The folder name should be a lowercased version of the agent's name (e.g. "Warden" → `warden`).

For each specialist:

```bash
# Replace <NAME_LOWER> with the lowercased agent name
cp -r ~/workspace/operations/engine-room/agents/_template \
      ~/workspace/operations/engine-room/agents/<NAME_LOWER>
```

Then edit that specialist's `AGENTS.md`:

- `<AGENT_NAME>` → the specialist's name
- `<USER_NAME>` / `<USER_CONTEXT>` / `<USER_TIMEZONE>` → same as main
- **Scope section**: pull from the matching archetype in `docs/AGENT-ARCHETYPES.md` (Compliance / Developer / Content / Strategy / Monitor). Lift the "Personality snippet" block into the AGENTS.md, adjusting the name.
- Fold in any user-supplied personality tweaks.

Edit their `agent.yaml`:

- `name:` → specialist name
- `bot_token_env:` → blank for now (specialists can be wired to their own bot later; for day one they run via the main agent's chat or via Codex)

Symlink each one:

```bash
ln -s ~/workspace/operations/engine-room/agents/<NAME_LOWER> \
      ~/myos/agents/<NAME_LOWER>
```

**Note to the user:** "Specialists don't get their own Telegram bot by default. If you later want, say, your Content agent reachable on its own Telegram chat, we create a second bot via BotFather, add its token to `.env`, and update that agent's `agent.yaml`. Not needed day one."

### 14.3 — Verify

```bash
ls -la ~/myos/agents/
```

Each entry should be a symlink (starts with `l`) pointing at `~/workspace/operations/engine-room/agents/<name>/`.

**Exit criteria:** Main agent plus any requested specialists created from the template, AGENTS.md files customized, agent.yaml files customized, symlinks in place, directory listing shows them all.

## Phase 15 — Register brain-mcp with Codex

```bash
source ~/myos/.env
codex mcp add --scope user --transport http brain-mcp \
  "$OB1_SUPABASE_URL/functions/v1/brain-mcp" \
  --header "x-brain-key: $MCP_ACCESS_KEY"
```

Verify:

```bash
codex mcp list
```

Expect `brain-mcp` to be listed with a ✓ Connected.

**Exit criteria:** brain-mcp registered and connecting from Codex.

## Phase 16 — Symlink skills into ~/.codex/skills/

For every skill in `~/workspace/operations/engine-room/skills/`, create a symlink in `~/.codex/skills/` so Codex auto-discovers them.

```bash
mkdir -p ~/.codex/skills
for skill in ~/workspace/operations/engine-room/skills/*/; do
  name=$(basename "$skill")
  ln -s "$skill" ~/.codex/skills/"$name"
done
ls -la ~/.codex/skills/
```

**Exit criteria:** All skills symlinked.

## Phase 17 — Smoke test

```bash
cd ~/myos
node scripts/smoke-brain.mjs
```

Expect: `brain smoke: PASS`.

Also run the monitor:

```bash
node scripts/monitor-brain.mjs
```

Expect: `[brain monitor] OK`.

**Exit criteria:** Both tests PASS.

## Phase 18 — First memory + first handoff

**Capture a memory** so the user sees the brain working:

Via the MCP endpoint, capture: "<USER_NAME> finished setting up their MyOS instance on <date>. Starting with a clean slate." (substitute the user's first name from Phase 2.1).

**Then run the handoff skill** for the first time: ask the user "update handoff" and let the `handoff-update` skill write the first session log + first HANDOFF.md update.

## Phase 18.5 — Wire up extra services

**Goal:** Now that the core system is live, work through the wishlist captured in Phase 2.5 (`~/workspace/scratchpad/extra-services-plan.md`) and actually connect the services the user wanted.

### Approach

For **each** item marked "Yes" in the plan, do these in order:

1. **Check the prerequisite.** Does the user have the account ready? For OAuth services, do they need to sign in somewhere first?
2. **Check admin constraints.** If this is a work/company account, try the OAuth consent screen and see if it errors. Common failure mode: "Your administrator has disabled this app." If that happens, move on and mark the item as "blocked — needs IT admin."
3. **Run the wire-up.** Each service has a different flow — see the service-specific playbook below.
4. **Test.** One end-to-end test: ask the agent to read or send something trivial. Don't claim done without a successful round-trip.
5. **Update the plan file.** Move the item from "Yes" to "Wired up" with the date.

### Service-specific playbooks

**Gmail:**
- Direct user to https://console.cloud.google.com → create project → enable Gmail API → create OAuth credentials → download `credentials.json` → save to `~/myos/credentials/gmail-creds.json`
- Set `GMAIL_CREDS_PATH` in `.env`
- Run first-time auth: `node scripts/gmail-auth.mjs` (opens browser, user signs in, token gets cached)
- Test: "Draft an email to myself saying hello."

**Google Calendar:** same credentials file as Gmail if same Google project; enable Calendar API in the console; set `GCAL_CREDS_PATH`.

**Outlook / Microsoft 365:**
- Azure Portal → App registrations → new app → add Microsoft Graph scopes (Mail.Read, Mail.Send, Calendars.ReadWrite)
- Copy client ID, client secret, tenant ID into `.env`
- **Warning**: for work accounts, the tenant admin must consent to the app. If the user sees "Need admin approval" on the consent screen, note it, ask the user if they can get IT to approve, and move on.

**iMessage (macOS only):**
- Grant the bot's executable Full Disk Access: System Settings → Privacy & Security → Full Disk Access → add `/opt/homebrew/bin/node` (or whatever Node binary runs the bot)
- Set `IMESSAGE_ENABLED=true` in `.env`
- Restart the bot
- Test: ask "read my last 3 iMessages."

**Obsidian vault:**
- Ask the user: "Where is your Obsidian vault?" (full path)
- In the agent's `agent.yaml`, add:
  ```yaml
  obsidian:
    vault: /Users/<user>/path/to/vault
    folders:
      - <folder-to-include>
  ```
- No API needed; agent reads the vault files directly.

**Slack (personal workspace):**
- Slack app directory → create app → add scopes `channels:read`, `channels:history`, `chat:write`
- Install to workspace; copy User OAuth Token starting with `xoxp-`
- Add `SLACK_USER_TOKEN=xoxp-...` to `.env`
- Restart bot; test with "list my Slack channels"

**Voice transcription (Groq):**
- https://console.groq.com → get API key (free tier fine)
- Add `GROQ_API_KEY=...` to `.env`
- Restart bot; send a voice note in Telegram. Should auto-transcribe.

**Text-to-speech (ElevenLabs):**
- https://elevenlabs.io → profile → API key
- Pick a voice, copy its Voice ID
- Add `ELEVENLABS_API_KEY=...` and `ELEVENLABS_VOICE_ID=...` to `.env`
- Restart bot; test by asking it to speak a reply.

**War Room (advanced):**
- Only if user explicitly asked. Python venv + Pipecat install; `WARROOM_ENABLED=true` in `.env`; browser opens at `http://localhost:7860`. Full instructions in `~/myos/warroom/README.md` if the user chose to install that optional module.

**For anything NOT on this list** that the user asked for: tell them honestly that it needs custom integration work (not a day-one task), and add it to the plan under "Future work."

### Exit criteria

- Every "Yes" item from Phase 2.5 is either `Wired up` or `Blocked` (with the reason captured in the plan file).
- The plan file has a "Future work" section for anything deferred.
- User has tested at least one of the newly-wired services end-to-end.

## Phase 19 — Day 1 training

**Goal:** Before wrap-up, walk the user through every major way they'll use the system: the different modes of interaction, the two scaffolding skills (new-project-workflow + workflow-designer), and the critical session-close ritual. This is not optional — it's the difference between a tool that works and a tool the user knows how to operate.

### Step 19.1 — Frame what's next

Say:

> You're installed. Before I hand you over, I want to walk through how to use this day-to-day. It takes about 20 minutes. At the end you'll know:
>
> - The 7 different ways people use this system
> - How to start a project properly (the scaffolding skill)
> - How to design a recurring workflow (the workflow skill)
> - **Most importantly: how to close a session so your memory is preserved**
>
> We'll also actually start a real project and design one real workflow so you've seen the motions once.
>
> Ready?

Wait for yes.

### Step 19.2 — The 7 ways you'll use this

Walk through each one. For each, show an example prompt the user can try RIGHT NOW. Demonstrate a couple live.

**1. Quick factual question.** "What did I decide about X?" or "What's my Y?"
   - The assistant searches your brain and answers.
   - Example to try: "What did I decide about my workspace layout?" (answer should reference the decision we just filed).

**2. Work session.** Open Codex or Telegram, work on something, close with /handoff.
   - This is the main loop. Walked through in 19.8.

**3. Starting a new project.** Say "new project" or "let's start a project".
   - Triggers `new-project-workflow` skill.
   - Walked through in 19.3.

**4. Designing a recurring workflow.** Say "design a workflow" or "I keep doing X and want to systemise it".
   - Triggers `workflow-designer` skill.
   - Walked through in 19.4.

**5. Explicit memory capture.** Say "remember: X" or "capture: X".
   - For facts you want pinned at high importance right now, not left to auto-extraction.
   - Example: "Remember: my accountant's name is Jane Smith, email jane@example.com."

**6. Memory recall.** "Do you remember Y?" or "Tell me what I know about Z."
   - Broader than a factual question — asks the assistant to pull together everything relevant.
   - Example: "Tell me everything you know about Project Foo."

**7. System-level check-ins.** "Audit my HANDOFF", "how's the brain looking?", "what's going stale?"
   - Monthly rhythm. Keeps the system clean.
   - Example: run "audit my HANDOFF" now, see how the assistant responds.

Demonstrate #1, #5, and #6 live with simple prompts so the user sees it work.

### Step 19.3 — Starting a project (live walkthrough)

Ask:

> What's one project you've been meaning to start or better organise? Could be a business thing, a hobby, a side project, a house renovation — anything with multiple moving parts worth keeping notes on.
>
> If nothing comes to mind, we can use a placeholder like "organise my garage" just to see how it works.

Wait. When they name one, invoke the `new-project-workflow` skill on it.

The skill will:
- Ask shape questions (what is it, who's it for, what does success look like, what's the first milestone)
- Generate `context.md`, `brief.md`, `decisions.md`, `roadmap.md`, `sprint-log.md` under `~/workspace/projects/<project-name>/`
- Scaffold `sessions/` and `decisions/` subfolders inside the project
- Offer a first decision to lock in

**Explain live, as it runs:** "Watch what it's doing. It's creating structured documents before you've written anything. That scaffold is the skeleton. You fill in the body over time. The pattern is the same whether you're building a software product or organising a garage."

After it completes, show the user the new project folder with `tree ~/workspace/projects/<project-name>/`.

### Step 19.4 — Designing a workflow (live walkthrough)

Ask:

> What's one thing you do regularly that feels repetitive? Weekly admin, monthly invoicing, the way you respond to new inquiries, your morning routine — anything that happens more than once and you'd like to execute the same way every time.
>
> Again, if nothing obvious, we can use "weekly grocery planning" or "monthly bank reconciliation" just to see the motions.

Wait. When they describe one, invoke the `workflow-designer` skill.

The skill will:
- Conduct a 6-question interview (trigger, inputs, tools, decision points, success criteria, output format)
- Generate a standardised workflow brief
- Save it under `~/workspace/operations/<domain>/workflows/<slug>.md`
- If the domain folder doesn't exist yet, prompt to name the domain and scaffold it from `operations/_template/`

**Explain live:** "Once this brief exists, you or the assistant can run the workflow by referencing the brief. No re-thinking the process each time. Design it once, fire it repeatedly. That's what scales."

After it completes, show the user the new workflow file with `cat ~/workspace/operations/<domain>/workflows/<slug>.md`.

### Step 19.5 — Scaffolding a new operations domain

If step 19.4 revealed a new operations area (e.g. invoicing, recruitment, content marketing), walk the user through creating the domain folder:

```bash
cp -r ~/workspace/operations/_template ~/workspace/operations/<domain-name>
```

Then edit the README.md in that new folder to describe the domain.

**Explain:** "Every new area of work you want systematised gets its own folder under `operations/`. Copy the template, rename it, customise the README. The internal structure is always the same: sessions, decisions, skills, workflows. You never redesign the layout. The consistency is the value."

### Step 19.6 — THE CRITICAL SKILL: session-close ritual

This is the most important section. Spend real time here.

**Frame it:**

> Everything else we just did only works if you close your sessions properly. The whole system falls apart if you don't. Here's what "closing a session" means and why it matters.
>
> Every time you work with the assistant — on your Mac or via Telegram — you generate new memories, decisions, progress. The system captures most of it automatically via the background watcher (every 10 minutes it scans for new files and turns they into searchable memory). But HANDOFF.md, your daily dashboard, does NOT update itself. The assistant only refreshes it when you say "update handoff" or "/handoff".
>
> If you skip the handoff ritual, three things happen:
>
> 1. Your dashboard goes stale. Tomorrow's version of you opens it and sees yesterday's state.
> 2. Your active projects list doesn't reflect reality. Blockers you hit today don't surface tomorrow.
> 3. Locked decisions don't get filed as standalone documents. They live only in conversation memory, which is fine for recall but terrible for audit.
>
> The handoff ritual is 30 seconds. Do it every time you stop working for the day, and the system compounds. Skip it, and the system degrades to a chat log.

**The ritual:**

```
┌───────────────────────────────────────────────────────┐
│                                                        │
│  At the end of any meaningful work session, say:      │
│                                                        │
│        "update handoff"                                │
│        or                                              │
│        "/handoff"                                      │
│                                                        │
│  The assistant will:                                   │
│  1. Query your brain for activity since last update   │
│  2. Infer which domain the work belonged to           │
│     (project vs operation vs engine-room)              │
│  3. Write a dense session log in the right folder     │
│     (sessions/<YYYY-MM-DD>-<slug>.md)                  │
│  4. Detect any locked decisions and file them as      │
│     individual MD files under decisions/               │
│  5. Refresh HANDOFF.md's top sections                 │
│  6. Archive any session entries older than 7 days     │
│  7. Regenerate decisions/INDEX.md                      │
│                                                        │
│  It will show you a diff before committing. You say   │
│  "yes" or "change X" or "merge it". Done.             │
│                                                        │
└───────────────────────────────────────────────────────┘
```

**When to do it:**

- At the end of any work session longer than 15 minutes
- Before switching to a completely different context (e.g. finished project work, now doing personal admin)
- Before closing your laptop for the day
- Before opening a new Codex session (`/newchat` in Telegram)

**When NOT to do it:**

- Quick factual questions ("what time is it in London?") — nothing to capture
- You're mid-task and planning to continue — wait until you actually stop

### Step 19.7 — Run the first /handoff LIVE

Now that real content exists (one project + one workflow + whatever else got captured during this setup session), run the handoff skill.

Invoke the `handoff-update` skill. Say to the user:

> Watch this. This is what you'll do at the end of every session from now on.

The skill will:
- Query OB1 for today's activity (should return the project scaffolding, the workflow design, the setup itself)
- Infer today's primary domain (likely operations/engine-room — "set up the system")
- Write `~/workspace/operations/engine-room/sessions/<today>-initial-setup.md`
- File any decisions it detected (the name you chose, the use case, the timezone, the first project, the first workflow)
- Rewrite HANDOFF.md's Current state, Active projects (now with the new project listed), Recent sessions, Blocked, Next up
- Show a diff for approval

After approval, show the user:

```bash
cat ~/workspace/memory/HANDOFF.md
```

Walk them through what changed:
- "See? Your Current state paragraph now reflects what we did today."
- "Your new project is in Active projects."
- "Today's session is at the top of Recent sessions with a link to the full writeup."
- "Tomorrow morning, this file is what you read first. It's your dashboard."

### Step 19.8 — Practice: close and reopen

Make them do it themselves, not just watch. Tell them:

> OK, now YOU do the full loop once. Type these, one at a time:
>
> 1. "Capture: today is my first day using this system."
> 2. "What did I capture today?"  (should find the capture from step 1)
> 3. "Update handoff."  (should run the skill again, this time adding "day 1 capture" to Recent sessions)
>
> Go.

Wait for them to do all three. If anything goes wrong, troubleshoot live. If it all works, they've just run the full daily loop once. They'll remember it.

## Phase 20 — Wrap up + quick-reference card

Tell the user:

```
────────────────────────────────────────────────────────────
  YOU'RE LIVE
────────────────────────────────────────────────────────────

  Your brain:      <OB1_SUPABASE_URL>
  Your workspace:  ~/workspace/
  Your dashboard:  ~/workspace/memory/HANDOFF.md (read first)
  Your agent:      <AGENT_NAME> at ~/workspace/operations/engine-room/agents/main/

────────────────────────────────────────────────────────────
  DAILY RITUAL
────────────────────────────────────────────────────────────

  START:  cd ~/workspace && codex    (or message your bot)
  END:    "update handoff"             (save + close)

────────────────────────────────────────────────────────────
  THE 7 MODES OF USE
────────────────────────────────────────────────────────────

  1. Factual question    "what did I decide about X?"
  2. Work session        open codex → work → /handoff
  3. New project         "let's start a project"
  4. Design workflow     "design a workflow for X"
  5. Capture memory      "remember: <fact>"
  6. Recall memory       "what do I know about Y?"
  7. System check-in     "audit my HANDOFF"

────────────────────────────────────────────────────────────
  THREE SKILLS YOU'LL USE MOST
────────────────────────────────────────────────────────────

  /handoff                 End of every meaningful session.
                           Writes session log, refreshes
                           HANDOFF.md, archives old entries,
                           files locked decisions.

  new-project-workflow     Starting ANY new thing worth
                           keeping notes on. Scaffolds the
                           folder, asks shape questions.

  workflow-designer        Turning recurring work into a
                           reusable brief. Design once,
                           fire repeatedly.

────────────────────────────────────────────────────────────
  RHYTHMS
────────────────────────────────────────────────────────────

  Daily:    /handoff at end of work
  Weekly:   "audit my HANDOFF" — check for stale entries
  Monthly:  "how's the brain looking?" — consolidation

────────────────────────────────────────────────────────────
  IF YOU GET STUCK
────────────────────────────────────────────────────────────

  Ask the assistant directly. It knows the system. It knows
  the runbook. Describe what's going wrong and it'll walk
  you through.

  For deep-technical issues: ~/workspace/operations/engine-room/memory/runbook.md
  For first-day questions:   <starter-kit>/docs/FIRST-DAY.md
```

Ask if anything's unclear. If not, confirm we're done and the setup succeeded.

**Bonus if the user seems confident:** offer to set up ONE more domain under `operations/` that matches their most frequent real-world activity (e.g. `operations/invoicing/` if they run a business, `operations/family-admin/` if they're a home organiser). Show them how fast it is to add a domain once the system is in place.

**Exit criteria:** User has seen their populated HANDOFF.md, has run through `/handoff` once themselves, understands the daily ritual, knows the three main skills + the 7 modes of use, knows how to restart the system next time.

## Error handling

For each phase, if a command fails:

1. Show the user the error verbatim (trimmed to the most useful lines).
2. Diagnose: which known failure mode does this match?
3. Offer a concrete next step.
4. If unrecoverable, roll back what was done in the failed phase and offer to try again.

Common failures:

- **Supabase CLI not installed** → `brew install supabase/tap/supabase`
- **psql not found** → `brew install libpq`, then use full path `/opt/homebrew/opt/libpq/bin/psql`
- **`npm install` fails** → usually Node version. Check with `node -v`; if < 18, install via `brew install node@20`.
- **Edge function deploy fails** → check Docker isn't running. Supabase CLI prefers it off in dev.
- **launchd bootstrap fails with domain error** → user is on macOS Big Sur / Monterey. Use `launchctl load` instead of `bootstrap`.
