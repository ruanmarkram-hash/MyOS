# Local-model integration deferred

**Date**: 2026-05-03
**Scope**: engine-room
**Status**: active
**Session**: `~/workspace/operations/engine-room/sessions/2026-05-03-tier0-shell-bypass-expansion.md`

## Decision

The Qwen3-Coder-Next + Qwen3.6-27B + Qwen3.6-35B-A3B GGUFs at `/path/to/models/` are not being wired into MyOS at this time. No `LocalLlamaProvider`, no llama-swap daemon, no priority queue, no fallback chain to local. The hardware stays available but unused by the harness.

This is a deferral, not a rejection. The architecture work (4-tier routing audit + RAM/swap/priority-queue runtime design + specialist HuggingFace model shortlist) is preserved in the session log and PDF artefacts for revival when there's a real reason.

## Reasoning

The case for local *looked* compelling at first sketch: Mac mini 64 GB, three capable Qwen models on disk, 60-70% of the daily workload is silent automation that doesn't need Claude. The proposal was to route Tier-1 workloads (memory extraction, brain-watcher, mid-day pulse composition, etc.) to a local generalist with Codex/Claude as fallback.

The case broke under honest cost analysis. The 2026-04-28 200% budget alert was Mason on Opus during the tag-team adversarial review sprint. The actual cost driver is sprint-time frontier usage on heavy-lifting work, not background heartbeats. Routing background work to local would target the wrong tier — a meaningful saving in absolute tokens but a small saving on the actual budget line that fires alerts.

Building the local stack adds: a llama-swap proxy daemon, a Node-side LocalLlamaProvider, a priority queue for in-local contention, new launchd plists, new failure modes for warden to monitor, swap-thrash observability. It's a meaningful complexity tax on a harness that only finished stabilising at Phase 2 close (2026-05-02). Phase 3 cutover is scheduled for early June with 2 unresolved decisions — adding Phase 2.5 between them risks delaying or destabilising Phase 3.

A better lever: a Mason Opus budget guardrail. Auto-downshift to Sonnet after N tokens in a window, or surface a soft cap requiring confirmation. Targets the real cost driver. No new daemons, no provider abstraction expansion, no swap mechanics.

Alternatives considered: (a) build local now and target only Tier-1 — declined, wrong cost target, real complexity for marginal saving; (b) build local but don't migrate any consumer yet — declined, dead infrastructure rots; (c) run local as Phase 4 of the Codex migration plan once Phase 3 cutover is stable — accepted as the revival path if needed.

## What this locks in

- No Phase 2.5 between current Phase 2 close and Phase 3 cutover. Phase 3 stays on its early-June timeline.
- Local-model integration revisited only if (a) Phase 3 surfaces a real cost or privacy gap, or (b) local data protection requirements become active, or (c) Mason Opus guardrail proves insufficient as a cost lever.
- The Qwen GGUFs on disk are not load-bearing. They can be deleted or left in place; nothing depends on them.

## What this unlocks

- Engineering attention stays on Phase 3 cutover preparation + Mason Opus guardrail + custom workflow launch readiness rather than on a parallel local-model build.
- The harness retains its current shape: Claude / Codex / Gemini providers, no local complexity. Easier to reason about, easier to debug.
- Reference architecture preserved at `/tmp/myos-routing-audit.pdf` and `/tmp/myos-local-runtime.pdf` for revival without re-deriving.

## Superseded by / supersedes

Standalone. Aligns with the Codex migration plan at `~/workspace/projects/myos-codex-migration/PLAN.md` Phase 4/5 gating ("local hardware ~6 weeks") — this decision says "hardware arrived early, but the gate is now real cost-driver evidence, not just hardware availability."
