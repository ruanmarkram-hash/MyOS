# Your first day using the system

Setup is done. Here's what to actually do now.

## Five minutes after install

1. **Open `~/workspace/memory/HANDOFF.md`**. This is your dashboard. It was seeded with a few lines during setup. It'll feel empty because nothing real has happened yet.

2. **Read it.** Get used to the layout:
   - Top shows "Current state"
   - Then Active projects
   - Then Blocked / Next up
   - Then Recent sessions
   - Then Archive

3. **Open Terminal and start a session**:
   ```
   cd ~/workspace
   codex
   ```

4. **Say hi to your assistant.** Try a few of these to see how it feels:
   - "Good morning"
   - "What does my workspace look like?"
   - "Remind me, what are the 7 ways I'll use you?"
   - "What's my timezone?"

## Day 1: seed some real content

You've got an empty system. The fastest way to feel its value is to put real stuff in.

### Pick one project you care about

It can be anything:
- A business you run
- A side project
- A house renovation
- A study goal
- A writing project
- A health routine

Say to the assistant: **"Let's start a project: <name>"**

The assistant will trigger `new-project-workflow` and ask you shape questions. Answer honestly, even roughly. It's faster to adjust later than to stall trying to be precise now.

### Capture 3-5 things you don't want to forget

For the next 10 minutes, just tell the assistant anything you want pinned. Each one gets saved to the brain at high importance.

- "Remember: my accountant is Jane Smith, jane@example.com, billed quarterly"
- "Remember: I'm allergic to penicillin"
- "Remember: my passport expires March 2028"
- "Remember: the shed key is in the blue drawer under the kitchen island"
- "Remember: my gas meter reading is always due on the 15th of each month"

### Stop, close properly

When you're done, say: **"update handoff"**

The assistant will write a session log, file any decisions, refresh your dashboard, and show you a diff before saving. Say "yes" or "merge it" to commit.

**Look at HANDOFF.md now.** It has content. Your project is in Active projects. Your session is in Recent sessions. That's the loop.

## Week 1: find your rhythm

Do this for a week:

- Any meaningful work session → `/handoff` at the end.
- Anything worth remembering → tell the assistant explicitly or just mention it in conversation; auto-extraction handles the rest.
- A recurring task you're doing manually → say "design a workflow for this" the third time you do it.

By Friday, you should have:
- A HANDOFF.md that reflects actual work
- 3-6 session logs filed in the right places
- 1-2 locked decisions
- 50-200 thoughts in the brain

If that's not the case, you're probably skipping `/handoff`. That's the single most important habit.

## Month 1: consolidation check

Monthly, ask the assistant:

- **"Audit my HANDOFF."** It'll flag stale entries, items that should be moved to Archive, blockers that have silently resolved.
- **"How's the brain looking?"** It'll report: total thoughts, new entities, anything drifting.
- **"What have I not thought about in a while?"** It'll surface low-activity projects you might have abandoned or want to re-prioritise.

## Common questions

### "Does it remember everything I've told it?"

Yes, if the content is meaningful. Short acknowledgments ("ok", "thanks") don't get captured. Everything with substance does, automatically.

### "Can I use it from my phone?"

Yes, if you set up Telegram during install. Message the bot. Everything you send goes through the same extraction pipeline.

### "What if I forget to run /handoff?"

The brain still captures turn-by-turn. You don't lose memory. You just lose the curated HANDOFF.md refresh — your dashboard will feel stale until you do run it. The system self-recovers; you just nudge it.

### "Can I delete a memory I wish I hadn't captured?"

Yes. Ask the assistant: "Delete the thought about X." It'll find and remove it.

### "What happens if Supabase goes down?"

<AGENT_NAME> (on Telegram) falls back to local SQLite memory. Codex sessions will get errors from brain-mcp. You wait it out. Rare.

### "How do I add a new agent for a specific domain?"

Copy the template:
```bash
cp -r ~/workspace/operations/engine-room/agents/_template ~/workspace/operations/engine-room/agents/<new-agent-name>
```
Edit that agent's `AGENTS.md` and `agent.yaml`. Symlink it into `~/myos/agents/`. Create a launchd plist for it if you want it always-on.

### "What do I do if something breaks?"

Open `docs/TROUBLESHOOTING.md` or ask the assistant directly: "something isn't working, help me debug."

### "Can I change my agent's name or personality later?"

Yes. Edit `~/workspace/operations/engine-room/agents/main/AGENTS.md`. Restart the bot (if on Telegram: `/restart`). Changes take effect immediately.

## What NOT to do

- Don't try to read every file in the system. You don't need to.
- Don't bypass `/handoff` — it's the glue.
- Don't edit `~/myos/` source code unless you know what you're doing. If you need to change behaviour, do it through skills or agent AGENTS.md.
- Don't commit `.env` to any git repo. Ever.

## When you're stuck

Ask the assistant first. It knows this system. If it can't resolve the issue, check `docs/TROUBLESHOOTING.md` for common failures.
