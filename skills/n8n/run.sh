#!/bin/bash
# Trigger an n8n workflow execution
# Usage: bash run.sh <workflow-id>

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

set -a
source "$PROJECT_ROOT/.env" 2>/dev/null
set +a

if [ -z "$1" ]; then
  echo "Usage: bash run.sh <workflow-id>" >&2
  exit 1
fi

if [ -z "$N8N_API_KEY" ]; then
  echo "Error: N8N_API_KEY not set in .env" >&2
  exit 1
fi

WORKFLOW_ID="$1"

# Activate workflow if not active
curl -s -X PATCH "http://127.0.0.1:5678/api/v1/workflows/$WORKFLOW_ID" \
  -H "X-N8N-API-KEY: $N8N_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"active": true}' > /dev/null 2>&1

# Execute
RESULT=$(curl -s -X POST "http://127.0.0.1:5678/api/v1/executions" \
  -H "X-N8N-API-KEY: $N8N_API_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"workflowId\": \"$WORKFLOW_ID\"}")

echo "$RESULT" | python3 -c "
import json, sys
try:
    data = json.load(sys.stdin)
    exec_id = data.get('id', 'unknown')
    status = data.get('status', data.get('finished', 'unknown'))
    print(f'Execution {exec_id}: {status}')
except:
    print(sys.stdin.read() if hasattr(sys.stdin, 'read') else 'Unknown response')
"
