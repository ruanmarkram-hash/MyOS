#!/bin/bash
# Weekly brain drift check. Detects and auto-fixes:
#   1. Duplicate entities (re-run consolidation)
#   2. Degraded canonical names with qualifiers / slugs (re-run unpolish)
#   3. Base64/binary garbage thoughts (DELETE)
# Silent when clean; Telegram-pings when action was taken or something breached.
#
# Called by com.claudeclaw.brain-drift-check launchd plist every Sunday 04:00
# (one hour after brain-backup so we don't thrash at the same time).

set -uo pipefail
cd /Users/sagecos1/HQ
export PATH="/opt/homebrew/opt/libpq/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

LOG=/Users/sagecos1/HQ/logs/brain-drift.log
set -a
source /Users/sagecos1/HQ/.env
set +a

TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)

# Thresholds
DUP_THRESHOLD=10
POLISH_THRESHOLD=20
GARBAGE_THRESHOLD=5

q() {
  psql "$OB1_SUPABASE_DB_URL" -t -A -c "$1" 2>/dev/null | tr -d ' \n'
}

# Extract "Planned: N" from dry-run output of an entity script
planned_count() {
  node "$1" --dry-run 2>/dev/null | grep -oE 'Planned[: ]+[0-9]+' | grep -oE '[0-9]+' | head -1
}

report_lines=()
action_taken=false

# ── 1. Duplicate entities (actionable by consolidate-entities.mjs) ───
dup_plan=$(planned_count /Users/sagecos1/HQ/scripts/consolidate-entities.mjs)
report_lines+=("actionable duplicate entities: ${dup_plan:-0}")
if [ "${dup_plan:-0}" -gt "$DUP_THRESHOLD" ]; then
  report_lines+=("  -> running consolidate-entities.mjs")
  node /Users/sagecos1/HQ/scripts/consolidate-entities.mjs >> "$LOG" 2>&1
  action_taken=true
  dup_after=$(planned_count /Users/sagecos1/HQ/scripts/consolidate-entities.mjs)
  report_lines+=("  -> actionable after: ${dup_after:-0}")
fi

# ── 2. Degraded canonicals (actionable by unpolish-entity-names.mjs) ─
polish_plan=$(planned_count /Users/sagecos1/HQ/scripts/unpolish-entity-names.mjs)
report_lines+=("actionable degraded canonicals: ${polish_plan:-0}")
if [ "${polish_plan:-0}" -gt "$POLISH_THRESHOLD" ]; then
  report_lines+=("  -> running unpolish-entity-names.mjs")
  node /Users/sagecos1/HQ/scripts/unpolish-entity-names.mjs >> "$LOG" 2>&1
  action_taken=true
  polish_after=$(planned_count /Users/sagecos1/HQ/scripts/unpolish-entity-names.mjs)
  report_lines+=("  -> actionable after: ${polish_after:-0}")
fi

# ── 3. Garbage thoughts ──────────────────────────────────────────────
garbage_count=$(q "
  SELECT count(*) FROM thoughts
  WHERE content ~ '^[A-Za-z0-9+/=]{200,}\$'
     OR content LIKE '%AAAAAAAAAAAAAAAA%'
     OR content LIKE '%EA/%GgQD%';
")
report_lines+=("garbage thoughts: ${garbage_count}")
if [ "${garbage_count:-0}" -gt "$GARBAGE_THRESHOLD" ]; then
  report_lines+=("  -> deleting garbage thoughts")
  deleted=$(psql "$OB1_SUPABASE_DB_URL" -t -A -c "
    WITH d AS (
      DELETE FROM thoughts
      WHERE content ~ '^[A-Za-z0-9+/=]{200,}\$'
         OR content LIKE '%AAAAAAAAAAAAAAAA%'
         OR content LIKE '%EA/%GgQD%'
      RETURNING id
    )
    SELECT count(*) FROM d;
  " | tr -d ' \n')
  report_lines+=("  -> deleted: ${deleted}")
  action_taken=true
fi

# ── Write log + notify conditionally ─────────────────────────────────
{
  echo "[${TS}] drift check"
  for line in "${report_lines[@]}"; do echo "  $line"; done
  echo "---"
} >> "$LOG"

if [ "$action_taken" = true ]; then
  summary=$(printf '%s\n' "${report_lines[@]}" | tr '\n' ' ' | head -c 800)
  bash /Users/sagecos1/HQ/scripts/notify.sh "brain drift: action taken — ${summary}"
fi

exit 0
