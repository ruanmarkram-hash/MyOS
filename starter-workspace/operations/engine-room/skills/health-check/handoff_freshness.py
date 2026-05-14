#!/usr/bin/env python3
"""
handoff_freshness.py — Stale-file check on HANDOFF.md.

Replaces an LLM-driven scheduled task with a deterministic mtime check so the
scheduler shell-bypass fast path can run it directly.

Output contract (silent-mode safe):
  - stdout = "OK"                              → fresh; scheduler stays silent
  - stdout = "STALE: HANDOFF.md ... hours old" → notify [YOUR NAME]
  - non-zero exit                              → error path
"""
import os
import sys
import time

HANDOFF = os.path.expanduser("~/workspace/memory/HANDOFF.md")
STALE_HOURS = 48
# Future-mtime grace: accept up to 5 minutes of clock skew as harmless. Beyond
# that we surface a WARNING — a far-future mtime would otherwise mask staleness
# indefinitely (negative age compares as "always fresh").
FUTURE_GRACE_SECONDS = 300


def main() -> int:
    # Use lstat so a broken/recursive symlink fails loudly rather than
    # following silently into a stale target. resolve() through the symlink
    # is deliberate — we want the freshness of whatever HANDOFF points at.
    if not os.path.exists(HANDOFF):
        print(f"ERROR: {HANDOFF} not found", file=sys.stderr)
        return 2
    try:
        mtime = os.path.getmtime(HANDOFF)
    except OSError as exc:
        print(f"ERROR: cannot stat HANDOFF.md: {exc}", file=sys.stderr)
        return 2
    age_seconds = time.time() - mtime
    if age_seconds < -FUTURE_GRACE_SECONDS:
        skew_min = -age_seconds / 60
        print(
            f"WARNING: HANDOFF.md mtime is {skew_min:.0f} minutes in the "
            "future (clock drift?); freshness check unreliable"
        )
        return 0
    age_hours = max(age_seconds, 0.0) / 3600
    if age_hours > STALE_HOURS:
        print(f"STALE: HANDOFF.md is {age_hours:.0f} hours old (threshold {STALE_HOURS}h)")
        return 0
    print("OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
