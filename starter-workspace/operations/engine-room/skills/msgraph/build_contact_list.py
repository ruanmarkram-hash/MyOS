#!/usr/bin/env python3
"""Scan Sent Items for the last N days and build a frequency-ranked contact list.

Usage:
    python3 build_contact_list.py --days 180 --out /tmp/contacts.json
"""
import argparse
import json
import re
import sys
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from graph_client import GraphClient

# Domains to exclude entirely (automated / system / personal).
EXCLUDE_DOMAINS = {
    "noreply", "no-reply", "donotreply", "do-not-reply", "notifications",
    "mail.notion.so", "calendly.com", "slack.com", "github.com",
    "anthropic.com", "openai.com", "elevenlabs.io",
    "icloud.com",
}

# Domains we consider "internal" — Sage's own.
INTERNAL_DOMAINS = {"sonke.com.au"}


def domain_of(email: str) -> str:
    return email.split("@", 1)[-1].lower() if "@" in email else ""


def is_automated(email: str) -> bool:
    local = email.split("@", 1)[0].lower() if "@" in email else email.lower()
    if any(p in local for p in ("noreply", "no-reply", "donotreply", "do-not-reply",
                                 "notifications", "mailer", "auto-confirm",
                                 "support@", "billing@")):
        return True
    dom = domain_of(email)
    for excl in EXCLUDE_DOMAINS:
        if excl in dom:
            return True
    return False


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--days", type=int, default=180)
    ap.add_argument("--out", default="/tmp/sage-contacts.json")
    ap.add_argument("--md-out", default="/tmp/sage-contacts.md")
    args = ap.parse_args()

    since = (datetime.now(timezone.utc) - timedelta(days=args.days)).strftime("%Y-%m-%dT%H:%M:%SZ")
    print(f"Scanning sent items since {since}...", file=sys.stderr)

    gc = GraphClient()
    params = {
        "$top": 100,
        "$select": "subject,toRecipients,ccRecipients,sentDateTime",
        "$filter": f"sentDateTime ge {since}",
        "$orderby": "sentDateTime desc",
    }

    contacts = defaultdict(lambda: {"count": 0, "names": set(), "last_sent": None, "subjects": []})
    page = 0
    for msg in gc.get_all("/me/mailFolders/sentitems/messages", params=params, max_pages=100):
        page += 1
        sent_at = msg.get("sentDateTime", "")
        subj = (msg.get("subject") or "").strip()
        for field in ("toRecipients", "ccRecipients"):
            for r in msg.get(field, []) or []:
                ea = r.get("emailAddress") or {}
                addr = (ea.get("address") or "").lower().strip()
                name = (ea.get("name") or "").strip()
                if not addr or "@" not in addr:
                    continue
                if domain_of(addr) in INTERNAL_DOMAINS:
                    continue
                if is_automated(addr):
                    continue
                c = contacts[addr]
                c["count"] += 1
                if name and name.lower() != addr:
                    c["names"].add(name)
                if c["last_sent"] is None or sent_at > c["last_sent"]:
                    c["last_sent"] = sent_at
                if len(c["subjects"]) < 3 and subj:
                    c["subjects"].append(subj)
        if page % 5 == 0:
            print(f"  scanned {page} pages...", file=sys.stderr)

    # Rank
    ranked = []
    for addr, c in contacts.items():
        ranked.append({
            "email": addr,
            "count": c["count"],
            "names": sorted(c["names"]),
            "domain": domain_of(addr),
            "last_sent": c["last_sent"],
            "recent_subjects": c["subjects"],
        })
    ranked.sort(key=lambda x: (-x["count"], x["email"]))

    with open(args.out, "w") as f:
        json.dump({"generated_at": datetime.now(timezone.utc).isoformat(),
                    "since_days": args.days,
                    "total_contacts": len(ranked),
                    "contacts": ranked}, f, indent=2)

    # Markdown for human review
    lines = [
        f"# Sage Contact List", "",
        f"Generated: {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M UTC')}",
        f"Window: last {args.days} days",
        f"Total contacts: {len(ranked)}", "",
        "Contacts you've emailed 3+ times are pre-flagged as **regular**.",
        "Tag each row: K=keep (always surface), W=watch (surface if new thread),",
        "S=skip (auto-archive), I=ignore (no need to see).", "",
        "| # | Tag | Count | Name | Email | Last sent | Recent subjects |",
        "|---|-----|-------|------|-------|-----------|------------------|",
    ]
    for i, c in enumerate(ranked[:200], 1):
        tag = "K" if c["count"] >= 5 else ("W" if c["count"] >= 2 else " ")
        names = ", ".join(c["names"]) or "—"
        last = (c["last_sent"] or "")[:10]
        subs = " / ".join(s[:50] for s in c["recent_subjects"][:2])
        lines.append(f"| {i} | {tag} | {c['count']} | {names} | {c['email']} | {last} | {subs} |")
    with open(args.md_out, "w") as f:
        f.write("\n".join(lines) + "\n")

    print(f"\nDone. {len(ranked)} unique external contacts.", file=sys.stderr)
    print(f"  JSON: {args.out}", file=sys.stderr)
    print(f"  Markdown: {args.md_out}", file=sys.stderr)
    # Print top 20 to stdout
    print("\nTop 20:")
    for c in ranked[:20]:
        nm = ", ".join(c["names"]) or "—"
        print(f"  {c['count']:3}  {nm:<35}  {c['email']}")


if __name__ == "__main__":
    main()
