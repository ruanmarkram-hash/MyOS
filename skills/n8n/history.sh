#!/bin/bash
# Show recent n8n execution history
# Usage: bash history.sh [limit]

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

set -a
source "$PROJECT_ROOT/.env" 2>/dev/null
set +a

LIMIT="${1:-10}"

if [ -z "$N8N_API_KEY" ]; then
  echo "Error: N8N_API_KEY not set in .env" >&2
  exit 1
fi

curl -s "http://127.0.0.1:5678/api/v1/executions?limit=$LIMIT" \
  -H "X-N8N-API-KEY: $N8N_API_KEY" \
  | python3 -c "
import json, sys
try:
    data = json.load(sys.stdin)
    executions = data.get('data', [])
    if not executions:
        print('No executions found.')
        sys.exit(0)
    print(f'{'ID':>8s}  {'Status':>10s}  {'Workflow':>8s}  Started')
    print('-' * 60)
    for e in executions:
        eid = str(e.get('id', '?'))
        status = e.get('status', e.get('finished', '?'))
        wf = str(e.get('workflowId', '?'))
        started = e.get('startedAt', '?')[:19] if e.get('startedAt') else '?'
        print(f'{eid:>8s}  {status:>10s}  {wf:>8s}  {started}')
except Exception as ex:
    print(f'Error: {ex}', file=sys.stderr)
    sys.exit(1)
"
