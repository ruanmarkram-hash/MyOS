#!/bin/bash
# List all n8n workflows
# Usage: bash list.sh

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# Source .env
set -a
source "$PROJECT_ROOT/.env" 2>/dev/null
set +a

if [ -z "$N8N_API_KEY" ]; then
  echo "Error: N8N_API_KEY not set in .env" >&2
  exit 1
fi

curl -s http://127.0.0.1:5678/api/v1/workflows \
  -H "X-N8N-API-KEY: $N8N_API_KEY" \
  | python3 -c "
import json, sys
try:
    data = json.load(sys.stdin)
    workflows = data.get('data', [])
    if not workflows:
        print('No workflows found.')
        sys.exit(0)
    print(f'{'ID':>6s}  {'Active':>6s}  Name')
    print('-' * 50)
    for w in workflows:
        active = 'YES' if w.get('active') else 'no'
        print(f\"{w['id']:>6s}  {active:>6s}  {w['name']}\")
except Exception as e:
    print(f'Error parsing response: {e}', file=sys.stderr)
    sys.exit(1)
"
