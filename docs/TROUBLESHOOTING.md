# Troubleshooting

Common things that break and how to fix them. For anything not listed, ask your assistant directly: "something's not working, walk me through debugging it."

## Setup-time issues

### "psql command not found"

Install Postgres client tools:

```bash
brew install libpq
```

Then use the full path when running SQL:

```bash
/opt/homebrew/opt/libpq/bin/psql "$OB1_SUPABASE_DB_URL" -c "..."
```

### "supabase command not found"

```bash
brew install supabase/tap/supabase
```

If that fails with "brew: command not found", install Homebrew first:

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
```

### "Docker is not running" (during edge function deploy)

The Supabase CLI prefers Docker off for deploys. If Docker Desktop is running, quit it. If you've never installed Docker, ignore this — just means the deploy will take a slightly different path.

### Migrations fail with "extension vector is not available"

You forgot to enable pgvector in Phase 5.3. Go to Supabase dashboard → Database → Extensions → search "vector" → flip ON. Re-run the migration.

### Edge function deploy fails with "401 Unauthorized"

You weren't logged in to the Supabase CLI, or your project link broke.

```bash
supabase login    # opens browser to confirm
cd ~/claudeclaw
supabase link --project-ref <your-project-ref>
```

### "launchctl bootstrap: 5: Input/output error"

Your macOS version uses the older syntax. Use `load` instead:

```bash
launchctl load -w ~/Library/LaunchAgents/com.claudeclaw.<name>.plist
```

### `npm install` fails in `~/claudeclaw/`

Usually Node version is too old. Check:

```bash
node -v
```

Need Node 18 or newer. If older:

```bash
brew install node@20
brew link node@20 --overwrite
```

Then retry.

## Runtime issues

### Brain monitor reports "ping FAIL"

The edge function is down or the MCP access key is wrong. Check:

1. Is the URL in your `.env` correct? `echo $OB1_SUPABASE_URL`
2. Is the MCP key correct? `echo $MCP_ACCESS_KEY`
3. Is the function deployed? Go to Supabase dashboard → Edge Functions → check `brain-mcp` is listed with recent deploy.

If it's deployed but returning 401, redeploy with the secret set:

```bash
cd ~/claudeclaw
source .env
supabase secrets set MCP_ACCESS_KEY="$MCP_ACCESS_KEY"
supabase functions deploy brain-mcp --no-verify-jwt
```

### <AGENT_NAME> doesn't seem to remember anything

Two possible causes:

1. **BRAIN=sqlite in `.env`** but you expected OB1 to be live. Check `grep BRAIN= ~/claudeclaw/.env`. If it says `sqlite`, change to `ob1` and restart <AGENT_NAME>.

2. **<AGENT_NAME> hasn't restarted** since the brain came online. In Telegram, send `/restart`. Or via launchctl:

   ```bash
   launchctl kickstart -k gui/$(id -u)/com.claudeclaw.main
   ```

### Skills not discovered by Claude Code

Claude Code reads from `~/.claude/skills/`. Check the symlinks:

```bash
ls -la ~/.claude/skills/
```

Each entry should be a symlink (starts with `l`) pointing at `/Users/.../workspace/operations/engine-room/skills/<name>`.

If any are broken, re-create:

```bash
rm ~/.claude/skills/<name>
ln -s ~/workspace/operations/engine-room/skills/<name> ~/.claude/skills/<name>
```

### Agent not loading ("agent <name> not found")

ClaudeClaw looks for agents in `~/claudeclaw/agents/<name>/` or `$CLAUDECLAW_CONFIG/agents/<name>/`. With the engine-room pattern, those should be symlinks:

```bash
ls -la ~/claudeclaw/agents/
```

If missing, re-create:

```bash
ln -s ~/workspace/operations/engine-room/agents/<name> ~/claudeclaw/agents/<name>
```

### Brain-watcher log is stale (not ticking)

Check if the launchd service is loaded:

```bash
launchctl list | grep claudeclaw
```

You should see 5 entries (brain-watcher, entity-worker, brain-monitor, brain-backup, brain-drift). If brain-watcher is missing:

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.claudeclaw.brain-watcher.plist
```

If it keeps exiting with non-zero, check the error log:

```bash
tail -30 ~/claudeclaw/logs/brain-watcher.stderr.log
```

### Entity queue is growing, not draining

The entity-worker service may have died. Kick it manually:

```bash
launchctl kickstart gui/$(id -u)/com.claudeclaw.entity-worker
```

Watch the log:

```bash
tail -f ~/claudeclaw/logs/entity-worker.log
```

### `/handoff` skill doesn't trigger

Claude Code uses the skill's description to decide when to fire. Check the skill file exists:

```bash
cat ~/.claude/skills/handoff-update/SKILL.md | head -15
```

If it exists but the model isn't picking up on "update handoff", try being more explicit:

> "Run the handoff-update skill now."

### Supabase free tier: exceeded project limits

Free tier gives you 2 projects and 500MB database. At your usage it's unlikely to hit this. If you do, either delete inactive projects or upgrade to $25/mo Pro.

## Data recovery

### I accidentally deleted a workspace file

Check if the brain-watcher already ingested it. Query OB1:

```bash
cd ~/claudeclaw
source .env
/opt/homebrew/opt/libpq/bin/psql "$OB1_SUPABASE_DB_URL" -c "
  SELECT content FROM thoughts
  WHERE metadata->>'path' LIKE '%<partial filename>%'
  LIMIT 10;"
```

If the content is there, the file can be reconstructed (mostly) from the captured chunks.

### HANDOFF.md got corrupted

Restore from the last brain-backup:

```bash
ls ~/claudeclaw/store/brain-backups/
```

Find the most recent folder. Inside is a JSON file. Import the thought(s) that contain HANDOFF.md snapshots and recover.

Or restore from git if you've been committing `~/workspace/`:

```bash
cd ~/workspace
git log memory/HANDOFF.md
git checkout <older-sha> -- memory/HANDOFF.md
```

## Nuclear options

### Re-run the whole setup

Open the starter kit folder, `claude`, paste SETUP-PROMPT.md. The intake skill checks what's already done and only does missing steps.

### Start completely fresh

**Warning: destructive.** This wipes everything.

```bash
# Stop all services
for svc in brain-watcher entity-worker brain-monitor brain-backup brain-drift main; do
  launchctl bootout gui/$(id -u)/com.claudeclaw.$svc 2>/dev/null
done

# Back up workspace first (just in case)
mv ~/workspace ~/workspace-old-$(date +%Y%m%d)

# Remove ClaudeClaw source
rm -rf ~/claudeclaw

# Remove launchd plists
rm ~/Library/LaunchAgents/com.claudeclaw.*.plist

# Remove Claude Code skill symlinks
rm ~/.claude/skills/*

# You'll also want to delete the Supabase project manually from the dashboard
# (https://supabase.com → project settings → Delete project)

# Then run the starter kit setup again
```

## When all else fails

Open an issue on the repo. Include:
- The exact error message (copy-paste, no paraphrasing)
- The command you were running
- The last thing that worked before it broke
- Your macOS version (`sw_vers`) and Node version (`node -v`)

The more specific you are, the faster someone can spot it.
