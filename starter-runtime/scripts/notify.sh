#!/bin/bash
# Send a Telegram message mid-task.
# Usage: notify.sh "message text" [chat_id]
# If chat_id is omitted, falls back to ALLOWED_CHAT_ID from .env.
# Reads TELEGRAM_BOT_TOKEN and ALLOWED_CHAT_ID from .env in the project root.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$SCRIPT_DIR/../.env"

if [ ! -f "$ENV_FILE" ]; then
  echo "notify.sh: .env not found at $ENV_FILE" >&2
  exit 1
fi

TOKEN=$(grep -E '^TELEGRAM_BOT_TOKEN=' "$ENV_FILE" | cut -d'=' -f2- | tr -d '"' | tr -d "'")
ENV_CHAT_ID=$(grep -E '^ALLOWED_CHAT_ID=' "$ENV_FILE" | cut -d'=' -f2- | tr -d '"' | tr -d "'")
CHAT_ID="${2:-$ENV_CHAT_ID}"

if [ -z "$TOKEN" ] || [ -z "$CHAT_ID" ]; then
  echo "notify.sh: TELEGRAM_BOT_TOKEN or chat_id not set (pass as 2nd arg or in .env)" >&2
  exit 1
fi

# Fail loudly on Telegram-side errors. `curl -s ... > /dev/null` exits 0
# even on HTTP 4xx/5xx and Telegram-level errors (bad chat_id, malformed
# message, rate limit), which made mission-notify.ts think delivery had
# succeeded when it hadn't. We capture both body and status code, then
# require HTTP 200 *and* `"ok":true` from Telegram before exiting 0.
RESPONSE=$(curl -s -w $'\n%{http_code}' \
  -X POST "https://api.telegram.org/bot${TOKEN}/sendMessage" \
  --data-urlencode "chat_id=${CHAT_ID}" \
  --data-urlencode "text=${1}" \
  --data-urlencode "parse_mode=HTML")
CURL_EXIT=$?
if [ $CURL_EXIT -ne 0 ]; then
  echo "notify.sh: curl failed with exit $CURL_EXIT" >&2
  exit 1
fi
HTTP_CODE=$(printf '%s' "$RESPONSE" | tail -n1)
BODY=$(printf '%s' "$RESPONSE" | sed '$d')
if [ "$HTTP_CODE" != "200" ] || ! printf '%s' "$BODY" | grep -q '"ok":true'; then
  echo "notify.sh: telegram error (HTTP ${HTTP_CODE}): ${BODY}" >&2
  exit 1
fi
