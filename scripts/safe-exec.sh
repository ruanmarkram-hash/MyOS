#!/bin/bash
# safe-exec.sh — wrapper for destructive commands (rm, mv, chmod, chown) that
# refuses to operate on MyOS-critical paths.
#
# Usage:
#   safe-exec.sh rm -rf /some/path
#   safe-exec.sh mv /old /new
#   safe-exec.sh chmod 755 /some/file
#   safe-exec.sh chown user:group /some/file
#
# Drop-in: just prefix the real command. All arguments pass through unchanged
# after safety checks. If a protected path is targeted, the command is refused
# with a clear error.

set -euo pipefail

HQ_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# ── Protected paths ──────────────────────────────────────────────────────────
# These paths (and everything under them) cannot be rm'd, mv'd, chmod'd, or chown'd.
# Add to this list as needed.
PROTECTED_PATHS=(
  "$HQ_DIR"                                    # MyOS itself
  "$HQ_DIR/store"                              # Database, sessions, credentials
  "$HQ_DIR/scripts"                            # Safety scripts (including this one)
  "$HQ_DIR/src"                                # Source code
  "$HQ_DIR/dist"                               # Built code
  "$HQ_DIR/agents"                             # Agent configs
  "$HQ_DIR/.claude"                            # Claude settings
  "$HQ_DIR/.env"                               # Secrets
  "$HQ_DIR/CLAUDE.md"                          # System prompt
  "$HQ_DIR/package.json"                       # Dependencies
  "$HOME/.claude"                              # Global Claude config
  "$HOME/.ssh"                                 # SSH keys
  "$HOME/.gnupg"                               # GPG keys
  "$HOME/.env"                                 # Home env (if it exists)
  "$HOME/Library/LaunchAgents"                 # launchd plists
)

# ── Helpers ──────────────────────────────────────────────────────────────────

# Resolve a path to absolute (handles relative paths and symlinks).
resolve_path() {
  local p="$1"
  # Use realpath if available; fall back to manual resolution
  if command -v realpath &>/dev/null; then
    realpath -m "$p" 2>/dev/null || echo "$p"
  elif command -v readlink &>/dev/null; then
    readlink -f "$p" 2>/dev/null || echo "$p"
  else
    echo "$p"
  fi
}

# Check if a path falls within or IS a protected path.
is_protected() {
  local target
  target=$(resolve_path "$1")

  for protected in "${PROTECTED_PATHS[@]}"; do
    local resolved_protected
    resolved_protected=$(resolve_path "$protected")

    # Exact match
    if [[ "$target" == "$resolved_protected" ]]; then
      echo "$protected"
      return 0
    fi

    # Target is inside the protected path
    if [[ "$target" == "$resolved_protected/"* ]]; then
      echo "$protected"
      return 0
    fi

    # For rm/mv: target is a PARENT of a protected path (e.g. rm -rf ~)
    if [[ "$resolved_protected" == "$target/"* ]]; then
      echo "$protected"
      return 0
    fi
  done

  return 1
}

refuse() {
  local cmd="$1"
  local path="$2"
  local reason="$3"
  echo "safe-exec: REFUSED — cannot $cmd '$path'" >&2
  echo "  Reason: path is protected ($reason)" >&2
  echo "  If this is intentional, use the real command directly (not recommended)." >&2
  exit 1
}

# ── Validate arguments ───────────────────────────────────────────────────────

if [[ $# -lt 1 ]]; then
  echo "Usage: safe-exec.sh <command> [args...]" >&2
  echo "  Supported commands: rm, mv, chmod, chown" >&2
  exit 1
fi

CMD="$1"
shift

# Only gate destructive commands
case "$CMD" in
  rm|mv|chmod|chown) ;;
  *)
    echo "safe-exec: unsupported command '$CMD'. Only rm, mv, chmod, chown are supported." >&2
    exit 1
    ;;
esac

# ── Extract target paths from arguments ──────────────────────────────────────
# Skip flags (anything starting with -) and extract file/dir arguments.

TARGETS=()
ARGS=("$@")

for arg in "${ARGS[@]}"; do
  # Skip flags
  [[ "$arg" == -* ]] && continue
  # For chmod: skip the mode argument (e.g. "755", "u+x")
  if [[ "$CMD" == "chmod" ]] && [[ "$arg" =~ ^[0-7]+$ || "$arg" =~ ^[ugoa] ]]; then
    continue
  fi
  # For chown: skip the owner:group argument
  if [[ "$CMD" == "chown" ]] && [[ "$arg" == *":"* ]] && [[ ! -e "$arg" ]]; then
    continue
  fi
  TARGETS+=("$arg")
done

# ── Safety check each target ─────────────────────────────────────────────────

for target in "${TARGETS[@]}"; do
  protected_by=$(is_protected "$target" || true)
  if [[ -n "$protected_by" ]]; then
    refuse "$CMD" "$target" "$protected_by"
  fi
done

# Additional check: refuse rm -rf / or rm -rf ~ or rm -rf $HOME
for target in "${TARGETS[@]}"; do
  resolved=$(resolve_path "$target")
  if [[ "$resolved" == "/" || "$resolved" == "$HOME" ]]; then
    refuse "$CMD" "$target" "root or home directory"
  fi
done

# ── All clear — execute ─────────────────────────────────────────────────────

exec "$CMD" "${ARGS[@]}"
