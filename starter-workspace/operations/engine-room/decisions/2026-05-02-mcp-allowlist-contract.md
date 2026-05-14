# MCP allowlist is a provider contract, enforced via cross-provider test

**Date**: 2026-05-02
**Scope**: engine-room
**Status**: active
**Session**: `~/workspace/operations/engine-room/sessions/2026-05-02-codex-phase2-paperwork-mcp-allowlist-sigterm-drain.md`

## Decision

`RunAgentOptions.mcpAllowlist` is a hard contract. Every `LlmProvider` implementation in `src/llm-providers/` MUST honor it: if non-undefined, only servers in the allowlist may be exposed to the model; an empty list means zero servers; `undefined` means "no constraint" (whatever the user's global config says).

The contract is enforced at the provider boundary, not via runtime trust. A cross-provider test in `src/llm-provider.test.ts` runs against every registered provider and asserts that, given a config exposing N servers and an allowlist of K, only K are exposed downstream. Adding a new provider (Codex, Ollama-future, etc.) that doesn't filter MUST fail CI.

For Codex specifically, where `~/.codex/config.toml` is global, filtering is implemented via a per-call temp `CODEX_HOME` directory: symlink everything from the real home except `config.toml`, then write a filtered `config.toml` containing only the allowlisted `[mcp_servers.<name>]` blocks. Temp dir is created with cleanup-on-throw and removed in the finally block.

## Reasoning

The previous behaviour was forward-leaning leak: `mcpAllowlist` was a hint that Claude provider happened to honor and Codex silently ignored. The moment a second MCP server lands globally (e.g. gmail-mcp, supabase-mcp), every Codex-routed agent inherits access regardless of declared `agent.yaml.mcp_servers`.

Alternatives considered:
- **Trust the agent prompts to not call disallowed tools**: not a security boundary; prompt injection would defeat it instantly.
- **Codex `-c` overrides only**: `-c` cannot delete keys, only override scalars. Removing servers requires `--ignore-user-config` + reconstructing all global state (plugins, marketplaces, model defaults) per call. Brittle.
- **Codex `--ignore-user-config` + temp `CODEX_HOME` containing only allowlisted servers**: chosen. Symlinks keep auth/sessions/marketplaces intact; only `config.toml` is filtered. Surgical and reversible.

Cross-provider contract test was added because experience with the migration showed each provider drifts from the interface in subtle ways (footer mismatch, model alias passthrough, etc.). Without an enforced test, the next provider (local Ollama, Gemini, etc.) will have to be retroactively audited. With the test, it can't ship without satisfying the rule.

## What this locks in

- Every new LLM provider added to ClaudeClaw must implement `mcpAllowlist` filtering at its provider boundary before merge.
- Codex provider's MCP filtering is via temp `CODEX_HOME`, not `-c` overrides. Future maintainers should not "simplify" by switching to overrides without re-evaluating the global-state reconstruction problem.
- `RunAgentOptions.mcpAllowlist` interface contract is documented in `src/llm-provider.ts` as a security boundary, not a hint.
- Empty allowlist `[]` = zero servers. Distinct from `undefined` which means "no constraint."

## What this unlocks

- Per-agent `agent.yaml.mcp_servers` is now meaningful regardless of provider. Today every specialist has `[brain-mcp]`. Adding a new MCP server (gmail-mcp, supabase-mcp) requires a conscious per-agent grant decision; no agent inherits it by default.
- Phase 3 cutover lanes can be evaluated on Codex with confidence that MCP scoping isn't silently drifting.
- Future local-model provider can be added with a clear gate: contract test must pass.
- Defense-in-depth backlog items (3b Bash allowlist, 3c HTTP egress allowlist) can layer on top of this same `agent.yaml`-driven pattern when their time comes.

## Superseded by / supersedes

Standalone. Resolves Open Decision #1 from `~/workspace/projects/claudeclaw-codex-migration/PLAN.md`.
