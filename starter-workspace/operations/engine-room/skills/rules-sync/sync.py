#!/usr/bin/env python3
"""Regenerate ~/workspace/memory/sage-rules.md from the memory DB.

Runs idempotently: if the newest lesson memory is older than the MD file's
mtime, does nothing and prints 'OK'. Otherwise rebuilds the MD and prints
the change summary.

Intended to be called from a scheduled task every 30-60 minutes.
"""
import sqlite3
import json
import os
import sys
import time

DB_PATH = os.path.expanduser('~/HQ/store/myos.db')
OUT_PATH = os.path.expanduser('~/workspace/memory/sage-rules.md')

DOMAIN_ORDER = [
    ("Behaviour & tone",          ["behaviour", "tone", "budget"]),
    ("Decision thresholds",       ["decision-thresholds"]),
    ("Document handling",         ["document-handling"]),
    ("Confidentiality",           ["confidentiality"]),
    ("Email & routing",           ["email", "route", "routing"]),
    ("Calendar & meetings",       ["calendar", "meetings"]),
    ("Reminders & follow-ups",    ["reminders", "follow-ups"]),
    ("iMessage & comms triage",   ["imessage", "sms"]),
    ("System & operations",       ["system", "operations", "scheduled-tasks", "signal-policy", "lessons"]),
]


def classify(topics_json: str, raw: str) -> str:
    try:
        topics = json.loads(topics_json) if topics_json else []
    except Exception:
        topics = []
    topics_lower = [t.lower() for t in topics]
    raw_lower = (raw or '').lower()
    for domain, keys in DOMAIN_ORDER:
        for k in keys:
            if any(k in t for t in topics_lower):
                return domain
            if domain == "System & operations" and k in raw_lower:
                return domain
    if 'budget' in raw_lower:
        return "Behaviour & tone"
    return "Other / uncategorised"


def main() -> int:
    db = sqlite3.connect(DB_PATH)
    db.row_factory = sqlite3.Row

    # Find newest lesson memory (created or accessed)
    row = db.execute(
        "SELECT MAX(MAX(created_at), MAX(accessed_at)) as latest FROM memories "
        "WHERE source = 'lesson' AND suppressed = 0 AND superseded_by IS NULL"
    ).fetchone()
    latest_mem = row['latest'] or 0

    # Compare to MD file mtime
    md_mtime = int(os.path.getmtime(OUT_PATH)) if os.path.exists(OUT_PATH) else 0

    if latest_mem <= md_mtime:
        print('OK')
        return 0

    # Rebuild
    rows = db.execute(
        "SELECT id, summary, raw_text, topics, importance, salience, created_at "
        "FROM memories WHERE source = 'lesson' AND suppressed = 0 AND superseded_by IS NULL "
        "ORDER BY importance DESC, created_at DESC"
    ).fetchall()

    grouped = {d[0]: [] for d in DOMAIN_ORDER}
    grouped["Other / uncategorised"] = []
    for r in rows:
        d = classify(r['topics'], r['raw_text'])
        grouped.setdefault(d, []).append(r)

    out = []
    out.append("# Sage's Standing Rules")
    out.append("")
    out.append(f"Auto-regenerated from memory DB on {time.strftime('%Y-%m-%d %H:%M')} Brisbane time.")
    out.append(f"Source: `memories` table WHERE `source='lesson'`.")
    out.append(f"Regenerator: `~/workspace/operations/engine-room/skills/rules-sync/sync.py` (scheduled hourly).")
    out.append("")
    out.append(f"Total rules locked: **{len(rows)}**")
    out.append("")
    out.append("---")
    out.append("")

    for domain in [d[0] for d in DOMAIN_ORDER] + ["Other / uncategorised"]:
        items = grouped.get(domain, [])
        if not items:
            continue
        out.append(f"## {domain}")
        out.append("")
        for r in items:
            hard = "**HARD RULE** " if "hard-rule" in (r['topics'] or '').lower() or "HARD RULE" in r['raw_text'] else ""
            out.append(f"- {hard}{r['raw_text']}")
            out.append(f"  *(mem #{r['id']} · imp={r['importance']:.2f} · sal={r['salience']:.1f})*")
        out.append("")

    os.makedirs(os.path.dirname(OUT_PATH), exist_ok=True)
    with open(OUT_PATH, 'w') as f:
        f.write('\n'.join(out))

    print(f"Rebuilt: {len(rows)} rules")
    return 0


if __name__ == '__main__':
    sys.exit(main())
