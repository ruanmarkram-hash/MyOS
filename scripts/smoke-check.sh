#!/bin/bash
# Smoke check: run after setup to confirm all the pieces are alive.
# Exits 0 on success, non-zero on first failure.

set -uo pipefail

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo "ClaudeClaw smoke check"
echo "======================"

check() {
  local label="$1"
  local cmd="$2"
  printf "%-50s" "$label"
  if eval "$cmd" > /dev/null 2>&1; then
    printf "${GREEN}✓${NC}\n"
    return 0
  else
    printf "${RED}✗${NC}\n"
    return 1
  fi
}

# 1. ~/claudeclaw/ exists and has the expected structure
check "~/claudeclaw/ present"                     "[ -d $HOME/claudeclaw ]"
check "~/claudeclaw/dist/ present (build ran)"    "[ -d $HOME/claudeclaw/dist ]"
check "~/claudeclaw/.env present"                 "[ -f $HOME/claudeclaw/.env ]"

# 2. ~/workspace/ structure
check "~/workspace/ present"              "[ -d $HOME/workspace ]"
check "engine-room/ present"              "[ -d $HOME/workspace/operations/engine-room ]"
check "HANDOFF.md present"                "[ -f $HOME/workspace/memory/HANDOFF.md ]"

# 3. Agent symlinks
check "~/claudeclaw/agents/ has symlinks"         "[ -L $HOME/claudeclaw/agents/main ]"

# 4. Skill symlinks
check "~/.claude/skills/handoff-update"   "[ -e $HOME/.claude/skills/handoff-update/SKILL.md ]"
check "~/.claude/skills/live-retrieval"   "[ -e $HOME/.claude/skills/live-retrieval/SKILL.md ]"

# 5. launchd services loaded
for svc in brain-watcher entity-worker brain-monitor brain-backup brain-drift; do
  check "$svc loaded"                     "launchctl list | grep -q com.claudeclaw.$svc"
done

# 6. Environment variables set (check by parsing .env without sourcing secrets into shell)
if [ -f $HOME/claudeclaw/.env ]; then
  for var in OB1_SUPABASE_URL OB1_SUPABASE_SERVICE_KEY GOOGLE_API_KEY MCP_ACCESS_KEY BRAIN; do
    check ".env has $var"                 "grep -q \"^$var=.\\+\" $HOME/claudeclaw/.env"
  done
fi

# 7. Brain reachable (ping the edge function)
if [ -f $HOME/claudeclaw/.env ]; then
  set -a
  source $HOME/claudeclaw/.env
  set +a
  echo ""
  printf "Pinging brain at %s... " "$OB1_SUPABASE_URL/functions/v1/${OB1_BRAIN_FUNCTION:-brain-mcp}"
  resp=$(curl -sS -o /dev/null -w "%{http_code}" -X POST \
    "$OB1_SUPABASE_URL/functions/v1/${OB1_BRAIN_FUNCTION:-brain-mcp}" \
    -H "x-brain-key: $MCP_ACCESS_KEY" \
    -H "Content-Type: application/json" \
    -H "Accept: application/json, text/event-stream" \
    -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"1"}}}' \
    --max-time 10)
  if [ "$resp" = "200" ]; then
    printf "${GREEN}✓${NC} (HTTP 200)\n"
  else
    printf "${RED}✗${NC} (HTTP %s)\n" "$resp"
  fi
fi

echo ""
echo "Done. Any ${RED}✗${NC} above needs attention — see docs/TROUBLESHOOTING.md."
