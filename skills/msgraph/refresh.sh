#!/bin/bash
# MS Graph token refresh (runs every 45 min via scheduled task)
# Silently refreshes the access token. If it fails, alerts via Telegram.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
LOG_FILE="/tmp/msgraph-refresh.log"
TIMESTAMP=$(date +"%Y-%m-%d %H:%M:%S")

# Source .env for credentials
set -a
source "$PROJECT_ROOT/.env" 2>/dev/null
set +a

# Run refresh (suppress urllib3 SSL warnings from system Python's LibreSSL)
RESULT=$(python3 -c "
import warnings
warnings.filterwarnings('ignore', message='.*urllib3.*OpenSSL.*')
import sys, os
sys.path.insert(0, '$SCRIPT_DIR')
os.environ.setdefault('GRAPH_CLIENT_ID', '4938226d-531c-4334-b3a0-7b40058fc34e')
os.environ.setdefault('GRAPH_TENANT_ID', '4e4a54d8-0cc6-473f-baee-a99418c99ce6')

from msgraph_auth import MSGraphAuth
auth = MSGraphAuth()
if not auth.refresh_token:
    print('NO_REFRESH_TOKEN')
    sys.exit(1)

try:
    auth.refresh_access_token()
    print('OK')
except Exception as e:
    print(f'FAILED: {e}')
    sys.exit(1)
" 2>&1)

EXIT_CODE=$?

if [ $EXIT_CODE -eq 0 ] && [ "$RESULT" = "OK" ]; then
  echo "[$TIMESTAMP] Token refreshed successfully" >> "$LOG_FILE"
  echo "OK"
else
  echo "[$TIMESTAMP] REFRESH FAILED: $RESULT" >> "$LOG_FILE"
  echo "FAILED: $RESULT"
  # Alert via notify script if available
  NOTIFY="$PROJECT_ROOT/scripts/notify.sh"
  if [ -f "$NOTIFY" ]; then
    bash "$NOTIFY" "MS Graph token refresh failed: $RESULT" 2>/dev/null
  fi
  exit 1
fi

# Keep log under 200 lines
tail -200 "$LOG_FILE" > "$LOG_FILE.tmp" && mv "$LOG_FILE.tmp" "$LOG_FILE"
