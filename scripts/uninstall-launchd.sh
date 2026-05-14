#!/bin/bash
# Uninstall all MyOS launchd agents
set -e

LAUNCH_AGENTS_DIR="$HOME/Library/LaunchAgents"
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

echo "Uninstalling MyOS launchd agents..."
echo ""

for plist in "$LAUNCH_AGENTS_DIR"/com.myos.*.plist \
             "$LAUNCH_AGENTS_DIR"/com.claudeclaw.*.plist \
             "$LAUNCH_AGENTS_DIR"/com.myos.plist \
             "$LAUNCH_AGENTS_DIR"/com.claudeclaw.plist; do
  [ -f "$plist" ] || continue
  label=$(basename "$plist" .plist)
  echo "Unloading $label..."
  unload_plist "$plist"
  rm "$plist"
  echo "  Removed $plist"
done

echo ""
echo "All MyOS agents uninstalled."
echo "Processes will stop within a few seconds."
