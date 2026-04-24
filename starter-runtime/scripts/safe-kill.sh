#!/bin/bash
# safe-kill.sh — kill wrapper that refuses to kill ClaudeClaw processes.
# Usage:
#   safe-kill.sh <pid>
#   safe-kill.sh -<signal> <pid>
#   safe-kill.sh --signal <signal> <pid>
#   safe-kill.sh -name <process-name>    (kills by name via pkill, same guard)
#
# Drop-in replacement for kill/pkill for agent process management tasks.

set -euo pipefail

HQ_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# ── Helpers ────────────────────────────────────────────────────────────────────

is_claudeclaw_pid() {
  local pid="$1"
  # Must be a running process
  if ! kill -0 "$pid" 2>/dev/null; then
    return 1
  fi
  # Get full command line for this PID
  local cmd
  cmd=$(ps -p "$pid" -o command= 2>/dev/null || echo "")

  # Match: any node/tsx process whose command references the HQ directory
  if echo "$cmd" | grep -qF "$HQ_DIR"; then
    return 0
  fi
  # Match: 'claudeclaw' anywhere in the command
  if echo "$cmd" | grep -qi "claudeclaw"; then
    return 0
  fi
  # Match: PID file contents (main + agents)
  for pidfile in "$HQ_DIR"/store/*.pid; do
    [ -f "$pidfile" ] || continue
    local stored_pid
    stored_pid=$(cat "$pidfile" 2>/dev/null || echo "")
    if [ "$stored_pid" = "$pid" ]; then
      return 0
    fi
  done
  return 1
}

refuse() {
  echo "safe-kill: REFUSED — cannot kill ClaudeClaw process (PID $1)." >&2
  echo "Use /restart in Telegram to restart the main agent, or use launchctl for other agents." >&2
  exit 1
}

# ── Argument parsing ───────────────────────────────────────────────────────────

SIGNAL=""
PIDS=()
NAME_MODE=false
NAME_ARG=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    -name)
      NAME_MODE=true
      NAME_ARG="$2"
      shift 2
      ;;
    --signal)
      SIGNAL="$2"
      shift 2
      ;;
    -[0-9]*)
      # -9, -15, -SIGKILL style
      SIGNAL="${1#-}"
      shift
      ;;
    -[A-Z]*)
      # -SIGTERM, -KILL style
      SIGNAL="${1#-}"
      shift
      ;;
    [0-9]*)
      PIDS+=("$1")
      shift
      ;;
    *)
      echo "safe-kill: unrecognised argument: $1" >&2
      exit 1
      ;;
  esac
done

# ── Name mode (pkill equivalent) ──────────────────────────────────────────────

if $NAME_MODE; then
  if [ -z "$NAME_ARG" ]; then
    echo "safe-kill: -name requires a process name" >&2
    exit 1
  fi
  # Collect matching PIDs and check each one
  MATCHING_PIDS=()
  while IFS= read -r pid; do
    [ -n "$pid" ] && MATCHING_PIDS+=("$pid")
  done < <(pgrep -f "$NAME_ARG" 2>/dev/null || true)
  if [ ${#MATCHING_PIDS[@]} -eq 0 ]; then
    echo "safe-kill: no process matching '$NAME_ARG'" >&2
    exit 1
  fi
  for pid in "${MATCHING_PIDS[@]}"; do
    if is_claudeclaw_pid "$pid"; then
      refuse "$pid"
    fi
  done
  if [ -n "$SIGNAL" ]; then
    pkill -"$SIGNAL" -f "$NAME_ARG"
  else
    pkill -f "$NAME_ARG"
  fi
  echo "safe-kill: killed process(es) matching '$NAME_ARG'"
  exit 0
fi

# ── PID mode ──────────────────────────────────────────────────────────────────

if [ ${#PIDS[@]} -eq 0 ]; then
  echo "Usage: safe-kill.sh [-<signal>] <pid> [<pid>...]" >&2
  echo "       safe-kill.sh -name <process-name> [-<signal>]" >&2
  exit 1
fi

for pid in "${PIDS[@]}"; do
  if is_claudeclaw_pid "$pid"; then
    refuse "$pid"
  fi
done

# All clear — pass through to real kill
if [ -n "$SIGNAL" ]; then
  kill -"$SIGNAL" "${PIDS[@]}"
else
  kill "${PIDS[@]}"
fi
