# Sage must never self-restart main during a Telegram conversation

**Date**: 2026-05-02
**Scope**: engine-room
**Status**: active
**Session**: `~/workspace/operations/engine-room/sessions/2026-05-02-codex-phase2-paperwork-mcp-allowlist-sigterm-drain.md`

## Decision

`launchctl kickstart -k com.myos.main` (or any equivalent SIGTERM/SIGKILL of the main bot process) MUST NOT be invoked from inside an active Telegram conversation. Three layers enforce this:

1. **Mechanical**: `~/HQ/scripts/safe-launchctl.sh` refuses the pattern with a clear error. Override with `FORCE=1` for genuine maintenance only. Other launchctl operations (list, print, kickstart of OTHER agents) pass through.
2. **Code**: `src/index.ts` shutdown handler now calls `messageQueue.close()` + `bot.stop()` first, then `messageQueue.drain(30_000)` to flush in-flight Telegram replies and DB commits before `process.exit(0)`. Even if a SIGTERM arrives mid-reply, the current message survives.
3. **Procedural**: CLAUDE.md updated with explicit rule and pointer to the wrapper. Lesson saved at importance 0.95 / salience 5.0 so future sessions retrieve it on any restart-related task.

When new code needs to go live, options are: (a) `/restart` in Telegram (preferred), (b) wait for the next natural restart, (c) ask [YOUR NAME] to restart via terminal himself.

## Reasoning

Diagnostic from `~/HQ/logs/main.log` showed the actual failure mode:

```
[14:36:15.661] Processing message      ← [YOUR NAME]'s request arrives
[14:36:21.659] Starting agent query
[14:36:21.982] Session initialized
[14:41:50.022] Shutting down...        ← SIGTERM mid-reply
[14:41:54.334] (new pid) Database ready
```

Sage's pattern was: do code work, run `npm test`, commit, then `launchctl kickstart -k com.myos.main` to "verify the new code is live". The kickstart SIGTERMed the very process streaming Sage's final reply to Telegram. Result: ~5 minutes of progress events visible to [YOUR NAME], then nothing — the assistant turn never committed to `conversation_log`, the Telegram send was cut mid-flush.

This had been happening repeatedly across the day's sessions. [YOUR NAME] flagged it explicitly with "you give me a task and you work for 5 minutes then just go death-forced and don't get results from it."

Alternatives considered:
- **Don't restart at all, ever**: too restrictive; legitimate maintenance needs the option.
- **Block via Bash tool permission deny rule**: bot doesn't run inside Claude Code's permission system; the agent loop spawns Bash directly. Permission rules don't reach.
- **Defer the kickstart by 30s after current message**: introduces race conditions and is fragile.
- **Make shutdown actually drain (the chosen primary fix)**: required because even non-Sage-initiated SIGTERMs (system updates, launchd recycling, manual `/restart`) had the same mid-flush problem. Drain is the correct fix; the wrapper is belt-and-braces.

The drain fix had its own subtleties (HIGH finding from adversarial Codex review: drain was theatrical because new messages kept enqueuing during the wait). Resolved by adding `MessageQueue.close()` to block new enqueues, then looping the drain until the queue is genuinely empty or timeout fires.

## What this locks in

- Sage cannot kill her own bot via standard launchctl invocation.
- Bot shutdown drains the message queue with a 30s ceiling regardless of who initiated the SIGTERM.
- New code-change responses end with "send `/restart` when you're ready" rather than auto-restart.
- Any future engineer touching the shutdown path must preserve the close-then-drain ordering. Drain BEFORE close was the bug Codex caught.

## What this unlocks

- Long code-change tasks complete cleanly even during the unavoidable transient SIGTERMs from system updates / launchd recycling / manual `/restart`.
- Agent self-restart is no longer a foot-gun.
- Conversation log integrity: assistant turns commit before exit, no orphaned user messages.

## Superseded by / supersedes

Standalone.
