#!/usr/bin/env python3
"""
freshness.py -- UTC-correct log-tick freshness checker.

Replaces the LLM-eyeballed timestamp comparison in warden's scheduled
audit (item 8 brain-watcher, item 9 entity-worker), which was reading
`Z`-suffixed UTC timestamps as Brisbane-local and producing 10-hour
phantom staleness deltas.

Contract:
  freshness.py <log_path> --warn <minutes> [--info <minutes>] [--now <iso>]

  - Reads the LAST line of <log_path>.
  - Extracts the first bracketed ISO-8601 timestamp [YYYY-MM-DDTHH:MM:SS(.fff)?Z].
  - Parses it as UTC. Compares to datetime.now(timezone.utc) (or the
    --now override, also parsed as UTC).
  - Prints a single line: "<age_min:.1f> min  (<iso_tick>)".
  - Exit codes:
      0 = fresh (age <= info threshold, or info unset and age <= warn)
      1 = INFO  (info < age <= warn) -- only emitted if --info given
      2 = WARNING (age > warn)
      3 = hard parse failure (no log, no timestamp, malformed)

The --now flag exists solely so the regression test can pin "now" to a
known UTC moment. Do not use it from the audit prompt.
"""
from __future__ import annotations

import argparse
import datetime
import re
import sys
from pathlib import Path

TS_RE = re.compile(r"\[([0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]+)?Z)\]")


def _parse_utc(s: str) -> datetime.datetime:
    # fromisoformat in 3.11+ accepts "...Z" via the +00:00 swap.
    return datetime.datetime.fromisoformat(s.replace("Z", "+00:00"))


def _last_nonempty_line(path: Path) -> str | None:
    try:
        with path.open("rb") as f:
            data = f.read()
    except FileNotFoundError:
        return None
    for line in reversed(data.splitlines()):
        s = line.decode("utf-8", errors="replace").strip()
        if s:
            return s
    return None


def check(log_path: str, warn_min: float, info_min: float | None, now: datetime.datetime) -> tuple[int, str]:
    p = Path(log_path)
    line = _last_nonempty_line(p)
    if line is None:
        return 3, f"no log at {log_path}"
    m = TS_RE.search(line)
    if not m:
        return 3, f"no [ISO-Z] timestamp in last line: {line[:80]!r}"
    try:
        tick = _parse_utc(m.group(1))
    except ValueError as exc:
        return 3, f"bad timestamp {m.group(1)!r}: {exc}"
    if tick.tzinfo is None or tick.utcoffset() != datetime.timedelta(0):
        # Defensive. TS_RE only matches Z, but be loud if that ever changes.
        return 3, f"timestamp not UTC: {m.group(1)!r}"
    if now.tzinfo is None:
        return 3, "now is naive (must be tz-aware UTC)"
    age_min = (now - tick).total_seconds() / 60.0
    msg = f"{age_min:.1f} min  ({m.group(1)})"
    if age_min > warn_min:
        return 2, msg
    if info_min is not None and age_min > info_min:
        return 1, msg
    # Fresh: stay silent so warden has nothing to echo as its reply.
    return 0, ""


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("log_path")
    ap.add_argument("--warn", type=float, required=True, help="age in minutes that triggers WARNING")
    ap.add_argument("--info", type=float, default=None, help="optional INFO threshold (must be < --warn)")
    ap.add_argument("--now", default=None, help="override 'now' as ISO-8601 UTC; testing only")
    args = ap.parse_args(argv)

    if args.now:
        now = _parse_utc(args.now)
    else:
        now = datetime.datetime.now(datetime.timezone.utc)

    rc, msg = check(args.log_path, args.warn, args.info, now)
    print(msg)
    return rc


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
