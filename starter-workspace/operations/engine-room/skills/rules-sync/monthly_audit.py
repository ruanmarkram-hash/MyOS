#!/usr/bin/env python3
"""Monthly rules audit.

Surfaces three things to [YOUR NAME]:
  1. Domains at or near the soft cap (15 rules).
  2. Possible duplicate / overlapping lesson pairs.
  3. Stale lessons (30+ days old, never recalled).

Writes a report to ~/workspace/scratchpad/rules-audit-YYYY-MM-DD.md and
returns the path so the scheduler can surface it.
"""
import sqlite3
import json
import os
import time
import datetime
import difflib
import sys

DB_PATH = os.path.expanduser('~/HQ/store/myos.db')
OUT_DIR = os.path.expanduser('~/workspace/scratchpad')
DOMAIN_CAP = 15
DOMAIN_NEAR = 12  # warn at 80%
SIMILARITY_THRESHOLD = 0.65
STALE_DAYS = 30

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

    rows = db.execute(
        "SELECT id, summary, raw_text, topics, importance, salience, "
        "       created_at, accessed_at "
        "FROM memories "
        "WHERE source = 'lesson' AND suppressed = 0 AND superseded_by IS NULL "
        "ORDER BY created_at DESC"
    ).fetchall()

    grouped = {}
    for r in rows:
        d = classify(r['topics'], r['raw_text'])
        grouped.setdefault(d, []).append(r)

    out = []
    today = datetime.date.today().isoformat()
    out.append(f"# Monthly rules audit — {today}")
    out.append("")
    out.append(f"Total active lessons: **{len(rows)}**")
    out.append(f"Soft cap per domain: **{DOMAIN_CAP}** (warning at {DOMAIN_NEAR})")
    out.append("")

    # --- 1. Domain caps ---
    out.append("## Domain counts")
    out.append("")
    cap_warnings = []
    for domain, _ in DOMAIN_ORDER + [("Other / uncategorised", [])]:
        items = grouped.get(domain, [])
        n = len(items)
        if n == 0:
            continue
        bar = "▰" * n + "▱" * max(0, DOMAIN_CAP - n)
        flag = ""
        if n >= DOMAIN_CAP:
            flag = " 🚨 AT CAP"
            cap_warnings.append((domain, n, "at cap"))
        elif n >= DOMAIN_NEAR:
            flag = " ⚠️ NEAR CAP"
            cap_warnings.append((domain, n, "near cap"))
        out.append(f"- {domain}: {n}/{DOMAIN_CAP} `{bar}`{flag}")
    out.append("")

    if cap_warnings:
        out.append("### Action required: cap decisions")
        out.append("")
        for domain, n, status in cap_warnings:
            out.append(f"**{domain}** is {status} ({n}/{DOMAIN_CAP}). Decide:")
            out.append(f"- (a) Raise the cap for this domain (legitimate density of rules)")
            out.append(f"- (b) Prune: surface lowest-importance / oldest rules below for review")
            out.append(f"- (c) Merge: collapse overlapping rules into one")
            out.append("")
            # surface lowest-importance candidates
            cands = sorted(grouped[domain], key=lambda r: (r['importance'], r['created_at']))[:3]
            for c in cands:
                out.append(f"  - mem #{c['id']} imp={c['importance']:.2f} — {c['summary'][:120]}")
            out.append("")

    # --- 2. Possible duplicates ---
    out.append("## Possible duplicates / overlap")
    out.append("")
    pairs = []
    texts = [(r['id'], r['summary'] or '', r['raw_text'] or '') for r in rows]
    for i in range(len(texts)):
        for j in range(i + 1, len(texts)):
            a_id, a_sum, a_raw = texts[i]
            b_id, b_sum, b_raw = texts[j]
            ratio = difflib.SequenceMatcher(None, a_sum.lower(), b_sum.lower()).ratio()
            if ratio >= SIMILARITY_THRESHOLD:
                pairs.append((ratio, a_id, b_id, a_sum, b_sum))
    pairs.sort(reverse=True)
    if not pairs:
        out.append("None above similarity threshold.")
    else:
        for ratio, a_id, b_id, a_sum, b_sum in pairs[:10]:
            out.append(f"- **{ratio:.2f} match** mem #{a_id} ↔ mem #{b_id}")
            out.append(f"  - #{a_id}: {a_sum[:140]}")
            out.append(f"  - #{b_id}: {b_sum[:140]}")
            out.append(f"  - Action: keep newer + set `superseded_by={max(a_id,b_id)}` on older, or merge.")
    out.append("")

    # --- 3. Stale lessons ---
    out.append("## Stale candidates (30+ days, never recalled)")
    out.append("")
    cutoff = int(time.time()) - (STALE_DAYS * 86400)
    stale = [r for r in rows if r['created_at'] < cutoff and r['accessed_at'] <= r['created_at'] + 60]
    if not stale:
        out.append("None.")
    else:
        for r in sorted(stale, key=lambda x: x['importance']):
            age = (int(time.time()) - r['created_at']) // 86400
            out.append(f"- mem #{r['id']} ({age}d old, imp={r['importance']:.2f}) — {r['summary'][:120]}")
    out.append("")

    # --- Footer ---
    out.append("---")
    out.append("")
    out.append("**To suppress a memory:** `UPDATE memories SET suppressed=1 WHERE id=N;`")
    out.append("**To supersede:** `UPDATE memories SET superseded_by=NEW_ID WHERE id=OLD_ID;`")
    out.append("**To raise a domain cap:** edit `DOMAIN_CAP` in `monthly_audit.py` (or per-domain dict if added).")

    os.makedirs(OUT_DIR, exist_ok=True)
    out_path = os.path.join(OUT_DIR, f'rules-audit-{today}.md')
    with open(out_path, 'w') as f:
        f.write('\n'.join(out))

    # Print path so scheduled task can attach it as a file marker
    print(out_path)
    return 0


if __name__ == '__main__':
    sys.exit(main())
