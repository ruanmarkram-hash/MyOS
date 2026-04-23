#!/bin/bash
# Weekly OB1 brain backup to store/brain-backups/
# Called by com.claudeclaw.brain-backup launchd plist every Sunday 03:00.

set -uo pipefail
cd /Users/sagecos1/HQ

BACKUP_DIR=/Users/sagecos1/HQ/store/brain-backups
LOG=/Users/sagecos1/HQ/logs/brain-backup.log
mkdir -p "$BACKUP_DIR"

# Export the env vars the vendored script expects
set -a
source /Users/sagecos1/HQ/.env
set +a
export SUPABASE_URL="$OB1_SUPABASE_URL"
export SUPABASE_SERVICE_ROLE_KEY="$OB1_SUPABASE_SERVICE_KEY"

TS=$(date +%Y-%m-%d-%H%M%S)
RUN_DIR="$BACKUP_DIR/$TS"
mkdir -p "$RUN_DIR"
cd "$RUN_DIR"

OUT=$(/opt/homebrew/bin/node /Users/sagecos1/HQ/vendor/ob1/recipes/brain-backup/backup-brain.mjs 2>&1)
CODE=$?

{
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] run=$TS exit=$CODE dir=$RUN_DIR"
  echo "$OUT" | tail -20
  echo "---"
} >> "$LOG"

# Retain 8 most recent weekly backups, prune older
cd "$BACKUP_DIR"
ls -t | tail -n +9 | while read -r d; do
  if [ -d "$d" ]; then rm -rf "$d"; fi
done

# Only alert on failure; silent on success
if [ "$CODE" -ne 0 ]; then
  bash /Users/sagecos1/HQ/scripts/notify.sh "brain-backup FAILED exit=$CODE — see $LOG"
fi

exit "$CODE"
