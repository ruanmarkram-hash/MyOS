#!/usr/bin/env python3
"""
Silent system health check for Sage.

Runs every 30 minutes via scheduled task cf9c0b1d. Outputs:
- "OK" on its own line if everything is healthy AND no new budget threshold crossed
- Otherwise a multi-line report describing the issues / alerts

Checks:
  (1) Stuck mission tasks running > 30 minutes
  (2) Failed scheduled tasks in the last 30 minutes
  (3) Audit errors in the last 30 minutes
  (4) Budget thresholds crossed today (90/100/150/200% of A$80 daily AUD budget)
      Dedup'd via budget_alerts_sent so each threshold alerts at most once per day.

Anthropic bills in USD; Sage displays AUD. Conversion: USD * AUD_USD_RATE
(default 1.52). The DB stores cost_usd as truth.

Returns exit code 0 always. Output goes to stdout for the scheduler to relay.
"""

import os
import sqlite3
import subprocess
import sys
import time
from datetime import datetime
from zoneinfo import ZoneInfo

# ── Config ──────────────────────────────────────────────────────────────────
DAILY_BUDGET_AUD = 80.0
THRESHOLDS = [90, 100, 150, 200]
AUD_USD_RATE = float(os.environ.get("AUD_USD_RATE", "1.52"))
BRISBANE = ZoneInfo("Australia/Brisbane")


def project_root() -> str:
    try:
        return subprocess.check_output(
            ["git", "rev-parse", "--show-toplevel"],
            cwd=os.path.expanduser("~/HQ"),
        ).decode().strip()
    except Exception:
        return os.path.expanduser("~/HQ")


def main() -> int:
    db_path = os.path.join(project_root(), "store", "myos.db")
    db = sqlite3.connect(db_path)
    db.row_factory = sqlite3.Row

    issues: list[str] = []
    now = int(time.time())
    thirty_min_ago = now - 30 * 60

    # (1) Stuck mission tasks
    stuck = db.execute(
        "SELECT id FROM mission_tasks WHERE status='running' AND started_at < ?",
        (thirty_min_ago,),
    ).fetchall()
    if stuck:
        ids = ", ".join(r["id"] for r in stuck)
        issues.append(f"Stuck mission tasks (>30m): {ids}")

    # (2) Failed scheduled tasks
    failed = db.execute(
        "SELECT id FROM scheduled_tasks WHERE last_status='error' AND last_run > ?",
        (thirty_min_ago,),
    ).fetchall()
    if failed:
        ids = ", ".join(r["id"] for r in failed)
        issues.append(f"Failed scheduled tasks (last 30m): {ids}")

    # (3) Audit errors (audit_log uses 'action' column)
    audit_errors = db.execute(
        "SELECT action FROM audit_log WHERE action LIKE '%error%' AND created_at > ?",
        (thirty_min_ago,),
    ).fetchall()
    if audit_errors:
        types = ", ".join(sorted({r["action"] for r in audit_errors}))
        issues.append(f"Audit errors (last 30m): {types}")

    # (4) Budget threshold check (Brisbane day, AUD)
    today_brisbane = datetime.now(BRISBANE).strftime("%Y-%m-%d")
    # Brisbane start-of-day as unix timestamp
    bris_start = datetime.now(BRISBANE).replace(hour=0, minute=0, second=0, microsecond=0)
    bris_start_unix = int(bris_start.timestamp())

    spend_usd_row = db.execute(
        "SELECT COALESCE(SUM(cost_usd), 0) AS s FROM token_usage WHERE created_at >= ?",
        (bris_start_unix,),
    ).fetchone()
    spend_usd = float(spend_usd_row["s"] or 0)
    spend_aud = spend_usd * AUD_USD_RATE
    pct = (spend_aud / DAILY_BUDGET_AUD) * 100 if DAILY_BUDGET_AUD > 0 else 0

    crossed = [t for t in THRESHOLDS if pct >= t]
    new_alerts: list[str] = []
    for t in crossed:
        already = db.execute(
            "SELECT 1 FROM budget_alerts_sent WHERE date=? AND threshold=?",
            (today_brisbane, t),
        ).fetchone()
        if already:
            continue
        db.execute(
            "INSERT INTO budget_alerts_sent (date, threshold, sent_at) VALUES (?, ?, ?)",
            (today_brisbane, t, now),
        )
        new_alerts.append(
            f"Budget alert: {t}% threshold crossed. "
            f"Spent A${spend_aud:.2f} of A${DAILY_BUDGET_AUD:.2f} daily AUD budget."
        )
    db.commit()

    if new_alerts:
        issues.extend(new_alerts)

    db.close()

    if not issues:
        print("OK")
        return 0

    for line in issues:
        print(line)
    return 0


if __name__ == "__main__":
    sys.exit(main())
