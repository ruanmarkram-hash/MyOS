#!/usr/bin/env python3
"""
Regression test for freshness.py.

Pins the exact false-positive scenario from 2026-05-09 08:02 Brisbane
(22:02 UTC). The audit prompt was reading `Z` timestamps as
Brisbane-local, computing ~10h deltas, and firing two phantom WARNINGs
for brain-watcher and entity-worker. Both ticks were actually fresh.

Run:  python3 test_freshness.py
Exit: 0 = pass, 1 = regression detected.
"""
from __future__ import annotations

import datetime
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import freshness  # noqa: E402


NOW = freshness._parse_utc("2026-05-08T22:02:00Z")  # 08:02 Brisbane


def _write(line: str) -> Path:
    f = tempfile.NamedTemporaryFile("w", suffix=".log", delete=False)
    f.write(line + "\n")
    f.close()
    return Path(f.name)


def case(name: str, log_line: str, warn: float, info: float | None, expect_rc: int) -> bool:
    p = _write(log_line)
    rc, msg = freshness.check(str(p), warn, info, NOW)
    ok = rc == expect_rc
    flag = "PASS" if ok else "FAIL"
    print(f"[{flag}] {name}: rc={rc} (want {expect_rc}) -> {msg}")
    return ok


def main() -> int:
    results = [
        # The two false-positive ticks from the 08:02 Brisbane audit.
        # 22:02Z - 21:54:16Z = 7m44s, threshold 30 -> fresh.
        case(
            "brain-watcher 8 min, warn 30",
            "[2026-05-08T21:54:16.427Z] done in 65.4s | claude: ...",
            warn=30, info=None, expect_rc=0,
        ),
        # 22:02Z - 21:58:56Z = 3m4s, threshold 10 -> fresh.
        case(
            "entity-worker 4 min, warn 10",
            "[2026-05-08T21:58:56.720Z] tick done in 8.1s | claimed=...",
            warn=10, info=None, expect_rc=0,
        ),
        # Sanity: a genuinely stale tick must still fire.
        case(
            "brain-watcher 45 min stale, warn 30",
            "[2026-05-08T21:17:00.000Z] done in 65.4s",
            warn=30, info=None, expect_rc=2,
        ),
        # Sanity: INFO band between info and warn.
        case(
            "entity-worker 7 min, info 5 warn 10",
            "[2026-05-08T21:55:00.000Z] tick done",
            warn=10, info=5, expect_rc=1,
        ),
        # Sanity: malformed line.
        case(
            "no timestamp",
            "garbage line with no brackets",
            warn=30, info=None, expect_rc=3,
        ),
    ]
    failed = sum(1 for r in results if not r)
    print(f"\n{len(results) - failed}/{len(results)} passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
