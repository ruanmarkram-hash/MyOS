# Fleet model + 1M context standard

**Date**: 2026-04-27
**Scope**: engine-room
**Status**: active
**Session**: `~/workspace/operations/engine-room/sessions/2026-04-27-1m-context-sdk-upgrade.md`

## Decision

The ClaudeClaw fleet runs on a standardised 1M-context configuration:

- `@anthropic-ai/claude-agent-sdk` floor: **0.2.111** (current: 0.2.119). Below 0.2.111, Opus 4.7 is unrecognised by the SDK's context-window resolver and falls back to a 200k-window assumption regardless of the model's native capability.
- **Opus-tier agents (Sage, Marlow, Mason) run `claude-opus-4-7`.** Native 1M, no beta header, standard pricing.
- **Sonnet-tier agents (Charter, Ember) run `claude-sonnet-4-6`.** Native 1M, standard pricing.
- **Haiku-tier agents (Warden) run `claude-haiku-4-5`.** 200k cap by design, unaffected by the 1M push.
- **No `[1m]` model-name suffix tricks. No `betas: ['context-1m-2025-08-07']` in `query()` options.** Both stop working once the SDK is at 0.2.111+ with a model that ships native 1M.

## Reasoning

The pre-2026-04-27 setup hit auto-compaction at ~167k tokens because the SDK's window-resolver function (`tM` in 0.2.50's `cli.js`) returned 200000 for any model not matching `claude-sonnet-4` or `opus-4-6` substrings. Sage had been on Opus 4.7 since at least mid-April, but the SDK silently demoted it to a 200k window. `CONTEXT_LIMIT=1000000` in `.env` was cosmetic — only fed the `convolife` display, never propagated to the SDK.

Three alternatives were considered before locking this:

1. **Pass `betas: ['context-1m-2025-08-07']` in `query()` options.** Doesn't work on OAuth auth. SDK's internal `CCA()` silently strips user-supplied betas when authenticated via Claude Code OAuth (only API-key auth honours them). This was the dead-end that burned multiple prior sessions.
2. **`[1m]` model-name suffix.** Works on OAuth (parses before the OAuth gate, flips the window AND auto-injects the beta header server-side). But it's an undocumented hack and is unnecessary once the model itself ships native 1M.
3. **Server-side compaction (`context-management-2025-06-27` beta).** Different beta, different conversation. Possible follow-up but not needed for the immediate problem.

The chosen path is the simplest: pin to a recent SDK and use models that ship 1M natively. No magic strings, no auth-class branches, no beta gymnastics.

## What this locks in

- SDK upgrades require an immediate fleet restart. `npm install` overwrites SDK files on disk while running agent processes still hold old SDK code in memory; subprocess spawns fail until restart. Operational sequence: bump → build → `/restart` Sage in Telegram → `for a in ember marlow charter mason warden; do launchctl kickstart -k gui/$(id -u)/com.claudeclaw.$a; done`.
- Future SDK floor moves up, never down. If a model demands a newer SDK, the floor moves. Reverting the SDK below 0.2.111 demotes Opus 4.7 back to a 200k window and re-creates the auto-compact-at-167k pain.
- Model assignment is set at `agents/<name>/agent.yaml`. Per-agent overrides in code (e.g. `bot.ts:505` for Sage's default, `task-model-classifier.ts` for routing) follow the same tier rule. Don't introduce new tiers without revisiting this decision.
- The auto-compact threshold formula is `effective_window − 20k − 13k`. On a 1M window that's ~967k. Don't expect a percentage-based override to work; the SDK uses an absolute offset, not a ratio.

## What this unlocks

- All Opus agents (Sage, Marlow, Mason) and all Sonnet agents (Charter, Ember) now have ~5.8x more context headroom before auto-compaction (~967k vs ~167k).
- Long-running agentic loops, deep research, and multi-file refactors no longer hit the early compaction wall.
- Mason promoted to Opus 4.7 — dev work gets deeper reasoning. Cost increase accepted (Opus is ~5x Sonnet's per-token rate).
- The 6+ stale memory entries telling future Sage that "1M context is hard/blocked/complex" are now superseded by lesson 141 in the memory DB and a fresh OpenBrain capture at `[For Sage] Claude Agent SDK + Context Window + OAuth Authentication`. Future retrievals will hit the working solution first.

## Superseded by / supersedes

- Implicitly supersedes any prior assumption that `CONTEXT_LIMIT` in `.env` controls the SDK window. It does not.
- Implicitly supersedes the "1M context is too complex / OAuth-blocked" framing that appears in conversation memories from 2026-04-23 to 2026-04-27 morning.
- No formal predecessor decision document.
