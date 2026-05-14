#!/bin/bash
# Sentry → Mason auto-fix pipeline
#
# Polls Sentry API for unresolved JS issues. New ones get:
#   1. Logged to ~/workspace/compliance/sentry-error-log.md
#   2. Dispatched to Mason as a mission task (mission-cli)
#
# State tracked in ~/HQ/store/.sentry-state — stores last-seen issue IDs.
# Runs silent when no new errors. Prints to stdout only when something happens
# (so a scheduled task wrapping this only messages Telegram on real activity).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="$PROJECT_ROOT/.env"
STATE_FILE="$PROJECT_ROOT/store/.sentry-state"
LOG_FILE="$HOME/workspace/compliance/sentry-error-log.md"
MISSION_CLI="$PROJECT_ROOT/dist/mission-cli.js"

# Load env
if [ ! -f "$ENV_FILE" ]; then
  echo "sentry-check: .env not found" >&2
  exit 1
fi

TOKEN=$(grep -E '^SENTRY_AUTH_TOKEN=' "$ENV_FILE" | cut -d= -f2- | tr -d '"' | tr -d "'")
ORG=$(grep -E '^SENTRY_ORG=' "$ENV_FILE" | cut -d= -f2- | tr -d '"' | tr -d "'")
PROJECT=$(grep -E '^SENTRY_PROJECT=' "$ENV_FILE" | cut -d= -f2- | tr -d '"' | tr -d "'")
API=$(grep -E '^SENTRY_API=' "$ENV_FILE" | cut -d= -f2- | tr -d '"' | tr -d "'")

if [ -z "$TOKEN" ] || [ -z "$ORG" ] || [ -z "$PROJECT" ]; then
  echo "sentry-check: missing SENTRY_AUTH_TOKEN / SENTRY_ORG / SENTRY_PROJECT in .env" >&2
  exit 1
fi

# Init state file if missing (touch, treat as "no IDs seen yet = bootstrap")
if [ ! -f "$STATE_FILE" ]; then
  touch "$STATE_FILE"
fi

# Ensure log file exists with header
if [ ! -f "$LOG_FILE" ]; then
  mkdir -p "$(dirname "$LOG_FILE")"
  cat > "$LOG_FILE" <<EOF
# Sentry Error Log

Master record of Sentry errors detected by the auto-fix pipeline. One row per issue.

| Detected | Issue ID | Title | Dispatched mission | Status |
|---|---|---|---|---|
EOF
fi

# Fetch unresolved issues (newest first)
response=$(curl -sS --max-time 20 \
  -H "Authorization: Bearer $TOKEN" \
  "$API/projects/$ORG/$PROJECT/issues/?query=is:unresolved&limit=25&sort=new" || true)

if [ -z "$response" ] || [ "$response" = "null" ]; then
  # Transient network issue — silent exit so we don't spam Telegram
  exit 0
fi

# Validate JSON response
if ! echo "$response" | jq -e 'type == "array"' >/dev/null 2>&1; then
  echo "sentry-check: unexpected API response (auth failure?)" >&2
  echo "$response" | head -c 500 >&2
  exit 1
fi

new_count=0
new_issues=""

while IFS=$'\t' read -r id title level permalink; do
  # Skip empty rows
  [ -z "$id" ] && continue

  # Already seen?
  if grep -qxF "$id" "$STATE_FILE"; then
    continue
  fi

  # New issue — dispatch + log
  new_count=$((new_count + 1))
  new_issues="${new_issues}${id}|${title}|${level}|${permalink}"$'\n'

  # Append to log
  now=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
  escaped_title=$(echo "$title" | sed 's/|/\\|/g' | head -c 120)
  echo "| $now | $id | $escaped_title | (pending) | open |" >> "$LOG_FILE"

  # Dispatch mission task to Mason
  brief="Sentry error detected in custom workflow. Issue ID: $id. Level: $level. Title: $title. Permalink: $permalink.

Fetch the full stack trace: curl -sS -H \"Authorization: Bearer \$SENTRY_AUTH_TOKEN\" \"\$SENTRY_API/issues/$id/events/latest/\" | jq .

Then:
1. Diagnose the root cause from the stack trace
2. Check the custom workflow repo for the affected code
3. Propose a fix (draft branch: fix/sentry-$id). Do not push without user's review.
4. Reply with: (a) diagnosis, (b) proposed fix summary, (c) branch name, (d) whether manual review is needed before deploy.

Log result to hive_mind and append the fix branch + status to ~/workspace/compliance/sentry-error-log.md."

  if [ -x "$(command -v node)" ] && [ -f "$MISSION_CLI" ]; then
    node "$MISSION_CLI" create --agent mason \
      --title "Sentry fix: $(echo "$title" | head -c 60)" \
      --priority 3 \
      "$brief" >/dev/null 2>&1 || echo "  (mission-cli dispatch failed for $id)" >&2
  fi

  # Track as seen
  echo "$id" >> "$STATE_FILE"

done < <(echo "$response" | jq -r '.[] | [.id, .title, .level, .permalink] | @tsv')

# Emit summary only when new issues detected (silent run = no Telegram noise)
if [ "$new_count" -gt 0 ]; then
  echo "Sentry pipeline: $new_count new issue(s) dispatched to Mason."
  echo ""
  echo "$new_issues" | while IFS='|' read -r id title level permalink; do
    [ -z "$id" ] && continue
    echo "  • [$level] $title (${permalink})"
  done
fi

exit 0
