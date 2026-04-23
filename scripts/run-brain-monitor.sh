#!/bin/bash
# Wrapper for scripts/monitor-brain.mjs — pipes output to log, alerts on critical.
# Called every 6h by launchd (com.claudeclaw.brain-monitor.plist).

set -uo pipefail
cd /Users/sagecos1/HQ

LOG=/Users/sagecos1/HQ/logs/brain-monitor.log
OUT=$(/opt/homebrew/bin/node scripts/monitor-brain.mjs 6 2>&1)
CODE=$?

{
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] exit=${CODE}"
  echo "$OUT"
  echo "---"
} >> "$LOG"

# Alert on CRITICAL (exit 2) and WARN (exit 1). OK (exit 0) = silent.
if [ "$CODE" -ge 2 ]; then
  bash /Users/sagecos1/HQ/scripts/notify.sh "🚨 brain-monitor CRITICAL: $(echo "$OUT" | head -6 | tr '\n' ' ')"
elif [ "$CODE" -eq 1 ]; then
  bash /Users/sagecos1/HQ/scripts/notify.sh "⚠️ brain-monitor WARN: $(echo "$OUT" | head -6 | tr '\n' ' ')"
fi

exit 0
