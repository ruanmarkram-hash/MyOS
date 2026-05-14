# Budget alerts: single source of truth = scheduled task cf9c0b1d

**Date**: 2026-04-24
**Scope**: engine-room
**Status**: active
**Session**: `~/workspace/operations/engine-room/sessions/2026-04-24-pa-setup-msgraph-email-calendar.md`

## Decision

Budget alert behaviour is owned by a single mechanism: scheduled task `cf9c0b1d`
("Silent health check"), with a $50 daily budget, four threshold gates
(90 / 100 / 150 / 200%), Brisbane-anchored, dedup'd once per threshold per day
via the `budget_alerts_sent` table. The in-memory rate-tracker
(`src/rate-tracker.ts` + `src/bot.ts:759`) is disabled by setting
`DAILY_COST_BUDGET=0` in `.env`.

## Reasoning

Two parallel budget systems were running:

1. The intentional gated alert (`cf9c0b1d`) — fires once per threshold per day,
   reports only on crossings.
2. The in-memory rate-tracker — fires on EVERY message reply when costToday ≥
   80% (high) or ≥ 95% (critical), no dedup.

Result: [YOUR NAME] got a "Daily cost high: $29.09 of $35.00 budget used (83%)"
notification despite the gated alert system being correctly silent.

[YOUR NAME]'s preference is unambiguous: alerts only when crossing his chosen
percentage gates, once per gate per day. The gated system already implements
that exactly. The rate-tracker duplicates the alerting concern without the
dedup, so it spams.

Cleanest fix: kill the duplicate. The rate-tracker code respects 0 as
"disabled", so the env flip is sufficient. No code change required, no
two-systems-to-keep-in-sync risk.

Rejected alternative: bumping `DAILY_COST_BUDGET=50.00` to match. Would still
leave the no-dedup spam problem and create two systems with overlapping
responsibilities.

## What this locks in

- All daily-cost alerting flows through `cf9c0b1d`.
- Threshold gates are 90 / 100 / 150 / 200%, daily budget is $50.
- The in-memory rate-tracker can stay in the codebase but is treated as
  inactive infrastructure.
- Any future change to budget logic happens by editing the scheduled task
  prompt, not by re-enabling the rate-tracker.

## What this unlocks

- No more spam alerts mid-conversation.
- Single, well-defined surface for tuning budget behaviour.
- Future PA-setup work can proceed without notification noise.

## Superseded by / supersedes

Standalone. Memory captured 2026-04-23 about the original threshold-dedup
policy is the upstream context.
