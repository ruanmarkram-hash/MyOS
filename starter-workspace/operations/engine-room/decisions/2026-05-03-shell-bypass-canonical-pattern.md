# Shell-bypass is the canonical pattern for silent shell-only scheduled tasks

**Date**: 2026-05-03
**Scope**: engine-room
**Status**: active
**Session**: `~/workspace/operations/engine-room/sessions/2026-05-03-tier0-shell-bypass-expansion.md`

## Decision

Silent scheduled tasks that exist only to run a shell command and report its stdout MUST use the shell-bypass fast path in `src/shell-task.ts`, not the LLM session path. Concretely: their prompt body is `Execute exactly: <command>` (or `Run: <command>` / bare `bash <path>` / `python3 <path>`) at line-start, followed by the SILENT MODE trailer, and nothing else. Any prose before the directive defeats the bypass regex and silently re-routes the task through Claude.

The agent path is reserved for prompts that genuinely need judgment: conditional reporting (CRITICAL/WARNING/INFO/PASSED), free-form summarisation, multi-step interpretation of script outputs.

## Reasoning

This was implicit in Phase 2's shell-bypass implementation but undocumented. The 2026-05-03 audit found 6 of 10 silent tasks were bypassable in principle but only 4 were actually bypassing — three needed wrapping in deterministic Python scripts (heartbeat, HANDOFF freshness, login cleanup), and one (`3e068061` sage-rules sync, hourly Opus session) was missing the bypass purely because of "Regenerate sage-rules.md from memory DB. Execute exactly: python3 ..." putting the directive mid-line.

Locking this as a standing rule prevents the same drift in future task creation. Without the rule, the convenience of writing a prose preamble in front of `Execute exactly:` will keep re-introducing expensive LLM sessions for trivial shell wrappers.

Alternatives considered: (a) extend the bypass regex to allow leading prose — rejected, multi-match logic in `tryExtractShellCommand` exists for a reason and softening it risks false-bypass on real judgment prompts; (b) auto-detect bypass candidates at task creation time — premature, manual discipline is sufficient given the small task volume.

## What this locks in

- New silent shell-only tasks must use the line-start directive form. PR/sprint reviews flag prose preambles before `Execute exactly:` as a violation.
- The 2 silent tasks intentionally on the agent path (`3c06974f` workspace audit, `693e0a75` memory consolidation) stay on agent because they do conditional reporting / free-form summarisation, not shell wrapping.
- New silent shell tasks ship with a deterministic Python script that returns `OK` on success or a single-line `WARNING:`/`CRITICAL:` on failure. Multi-step shell pipelines must be wrapped in a script; chaining prose-style instructions breaks the pattern.

## What this unlocks

- Predictable cost ceiling on background automation. The hourly Opus session for sage-rules sync alone was meaningful; aggregated across all bypassed tasks it's a clean win.
- Phase 3 Codex cutover doesn't have to revalidate trivial shell wrappers on the new provider — they don't go through the provider at all.
- Future Tier-1 local-model work (deferred per separate decision) can target only the agent-path silent tasks that genuinely need an LLM.

## Superseded by / supersedes

Standalone. Builds on Phase 2's `src/shell-task.ts` infrastructure (introduced in `~/workspace/operations/engine-room/sessions/2026-05-02-codex-phase2-paperwork-mcp-allowlist-sigterm-drain.md`).
