#!/bin/bash
# safe-launchctl.sh — launchctl wrapper that refuses self-restart of the
# main ClaudeClaw bot from inside an active Telegram conversation.
#
# Why: `launchctl kickstart -k com.claudeclaw.main` SIGTERMs the live bot
# process. If Sage runs that herself while replying to a Telegram message,
# the message stream gets cut mid-flush and her final reply is dropped —
# Ruan sees ~5 minutes of activity then nothing. Per CLAUDE.md the rule
# is "tell Ruan to send /restart in Telegram" — this wrapper enforces it.
#
# Other launchctl operations (list, print, kickstart of OTHER agents) pass
# through unchanged. Specifically:
#   - kickstart -k com.claudeclaw.main         → REFUSED
#   - kickstart -k com.claudeclaw.charter      → allowed
#   - list, print, bootstrap, bootout, etc.    → allowed
#
# Override: pass FORCE=1 in the env to bypass (for genuine maintenance).

set -euo pipefail

# Detect the bad pattern: any kickstart whose target is com.claudeclaw.main
is_main_kickstart=false
saw_kickstart=false
for arg in "$@"; do
  if [[ "$arg" == "kickstart" ]]; then
    saw_kickstart=true
  fi
  if $saw_kickstart && [[ "$arg" == *"com.claudeclaw.main"* ]]; then
    is_main_kickstart=true
    break
  fi
done

if $is_main_kickstart && [[ "${FORCE:-}" != "1" ]]; then
  cat >&2 <<'EOF'
safe-launchctl: REFUSED — cannot kickstart com.claudeclaw.main from an
agent session. SIGTERM'ing the live bot mid-reply drops the in-flight
Telegram message and orphans the assistant turn in conversation_log.

If you want the new code live, ask Ruan to send `/restart` in Telegram
(per CLAUDE.md). The bot will pick up new code on its next natural
restart anyway.

Override: prefix with `FORCE=1` if you genuinely need to do this.
EOF
  exit 2
fi

exec /bin/launchctl "$@"
