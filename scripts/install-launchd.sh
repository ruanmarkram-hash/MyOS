#!/bin/bash
# Install MyOS launchd agents for auto-start on login + auto-restart on crash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
LAUNCHD_DIR="$PROJECT_DIR/launchd"
LAUNCH_AGENTS_DIR="$HOME/Library/LaunchAgents"
LOG_DIR="$PROJECT_DIR/logs"
USER_DOMAIN="gui/$(id -u)"

unload_plist() {
  local plist="$1"
  local label
  label=$(basename "$plist" .plist)
  launchctl bootout "$USER_DOMAIN/$label" 2>/dev/null \
    || launchctl bootout "$USER_DOMAIN" "$plist" 2>/dev/null \
    || launchctl unload "$plist" 2>/dev/null \
    || true
}

remove_plist() {
  local plist="$1"
  local reason="$2"
  local label
  label=$(basename "$plist" .plist)
  [ -f "$plist" ] || return 0
  echo "  Removing $reason agent: $label"
  unload_plist "$plist"
  rm -f "$plist"
}

NODE_PATH="$(command -v node)"
if [ -z "$NODE_PATH" ]; then
  echo "Error: node not found on PATH. Install Node 20+ first." >&2
  exit 1
fi

echo "MyOS launchd installer"
echo "============================"
echo "Using Node binary: $NODE_PATH"
echo ""

# Ensure logs directory exists
mkdir -p "$LOG_DIR"

# Clean up stale/orphaned myos agents not in the current launchd/ directory.
# Also unload legacy com.claudeclaw agents so a renamed install cannot
# duplicate-run the same bot under old and new service labels.
echo "Cleaning up stale agents..."
for existing in "$LAUNCH_AGENTS_DIR"/com.claudeclaw.*.plist; do
  [ -f "$existing" ] || continue
  remove_plist "$existing" "legacy"
done
remove_plist "$LAUNCH_AGENTS_DIR/com.claudeclaw.plist" "legacy"
for existing in "$LAUNCH_AGENTS_DIR"/com.myos.*.plist; do
  [ -f "$existing" ] || continue
  label=$(basename "$existing" .plist)
  # Check if this plist has a corresponding file in our launchd/ dir
  if [ ! -f "$LAUNCHD_DIR/$label.plist" ]; then
    remove_plist "$existing" "stale"
  fi
done
# Also remove the bare com.myos.plist (legacy, pre-multi-agent)
remove_plist "$LAUNCH_AGENTS_DIR/com.myos.plist" "legacy"
echo ""

# Build the project first
echo "Building project..."
cd "$PROJECT_DIR"
npm run build
echo "Build complete."
echo ""

# Install each plist
for plist in "$LAUNCHD_DIR"/com.myos.*.plist; do
  label=$(basename "$plist" .plist)
  dest="$LAUNCH_AGENTS_DIR/$label.plist"

  # Unload if already loaded
  if launchctl list "$label" &>/dev/null; then
    echo "Unloading existing $label..."
    unload_plist "$dest"
  fi

  echo "Installing $label..."
  # Copy template and substitute placeholders with actual paths
  sed -e "s|__PROJECT_DIR__|$PROJECT_DIR|g" \
      -e "s|__HOME__|$HOME|g" \
      -e "s|__NODE_PATH__|$NODE_PATH|g" \
      "$plist" > "$dest"
  launchctl load "$dest"
done

# Install cloudflared tunnel if config exists
if [ -f "$HOME/.cloudflared/config.yml" ]; then
  TUNNEL_LABEL="com.cloudflare.cloudflared"
  TUNNEL_PLIST="$LAUNCH_AGENTS_DIR/$TUNNEL_LABEL.plist"

  if launchctl list "$TUNNEL_LABEL" &>/dev/null; then
    echo "Cloudflare tunnel already running."
  else
    echo "Installing Cloudflare tunnel..."
    cloudflared service install 2>/dev/null || true
    # Fix the generated plist to include tunnel run args
    if [ -f "$TUNNEL_PLIST" ] && ! grep -q "tunnel" "$TUNNEL_PLIST"; then
      launchctl unload "$TUNNEL_PLIST" 2>/dev/null || true
      # Replace the ProgramArguments to include tunnel run
      python3 -c "
import plistlib
with open('$TUNNEL_PLIST', 'rb') as f:
    plist = plistlib.load(f)
plist['ProgramArguments'] = [
    '/opt/homebrew/bin/cloudflared',
    'tunnel',
    '--config',
    '$HOME/.cloudflared/config.yml',
    'run',
]
with open('$TUNNEL_PLIST', 'wb') as f:
    plistlib.dump(plist, f)
"
      launchctl load "$TUNNEL_PLIST"
    fi
  fi
fi

echo ""
echo "Verifying..."
sleep 2

all_ok=true
for plist in "$LAUNCHD_DIR"/com.myos.*.plist; do
  label=$(basename "$plist" .plist)
  if launchctl list "$label" &>/dev/null; then
    pid=$(launchctl list "$label" | grep PID | awk '{print $NF}' 2>/dev/null || echo "?")
    echo "  $label: running (PID: $pid)"
  else
    echo "  $label: FAILED to start"
    all_ok=false
  fi
done

# Check tunnel
if launchctl list "com.cloudflare.cloudflared" &>/dev/null 2>&1; then
  echo "  com.cloudflare.cloudflared: running"
else
  echo "  com.cloudflare.cloudflared: not running (optional)"
fi

echo ""
if $all_ok; then
  echo "All agents installed and running."
  echo "Logs: $LOG_DIR/"
  echo ""
  echo "Useful commands:"
  echo "  launchctl list | grep myos    # check status"
  echo "  tail -f $LOG_DIR/main.log           # follow main bot logs"
  echo "  $SCRIPT_DIR/uninstall-launchd.sh    # remove all agents"
else
  echo "Some agents failed to start. Check logs in $LOG_DIR/"
fi
