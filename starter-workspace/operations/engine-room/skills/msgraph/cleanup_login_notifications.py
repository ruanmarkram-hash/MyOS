#!/usr/bin/env python3
"""
cleanup_login_notifications.py — Purge transactional login/verification email noise.

Replaces a multi-step LLM-driven scheduled task with a single deterministic call
so the scheduler shell-bypass fast path can run it directly.

Safety model (post adversarial review):
  - Two-key gate: a message is archived ONLY if BOTH the sender matches a
    trusted transactional source AND the subject matches a tight transactional
    pattern. Either alone is not enough.
  - Sender match is exact-address OR exact parent-domain — never substring.
  - Pagination is followed end-to-end so old matches are not silently missed.
  - The 25h lower bound on receivedDateTime keeps live OTPs untouched.

Output contract (silent-mode safe):
  - stdout = "OK"                      → nothing to do; scheduler stays silent
  - stdout = "purged N message(s)"     → telegram notification, surfaces count
  - stdout = "WARNING: ..."            → soft failure, surfaces but non-fatal
  - non-zero exit + stderr             → hard error path
"""
from __future__ import annotations

import re
import sys
import datetime as dt
from pathlib import Path
from typing import Iterable

# Reuse the existing Graph client; scripts in this folder assume cwd-on-sys.path
sys.path.insert(0, str(Path(__file__).parent))
from graph_client import GraphClient  # noqa: E402

# --- Subject patterns -------------------------------------------------------
# Anchored on transactional verbs/phrases as whole words. Looser fragments
# like "verification" alone are intentionally avoided — a real email saying
# "I cannot complete verification" should NOT be auto-archived.
SUBJECT_PATTERNS: list[re.Pattern[str]] = [
    re.compile(r"\bverification code\b", re.IGNORECASE),
    re.compile(r"\bverify your (device|account|email|sign[- ]?in)\b", re.IGNORECASE),
    re.compile(r"\bone[- ]?time (passcode|password|code)\b", re.IGNORECASE),
    re.compile(r"\bsingle[- ]?use code\b", re.IGNORECASE),
    re.compile(r"\b(your|new) (login|sign[- ]?in) code\b", re.IGNORECASE),
    re.compile(r"\bsecurity (code|alert)\b", re.IGNORECASE),
    re.compile(r"\b2[- ]?factor (auth(entication)?|verification|code)\b", re.IGNORECASE),
    re.compile(r"\btwo[- ]?factor (auth(entication)?|verification|code)\b", re.IGNORECASE),
    re.compile(r"\bnew device sign[- ]?in\b", re.IGNORECASE),
    re.compile(r"\baccess code\b", re.IGNORECASE),
    re.compile(r"\bOTP\b", re.IGNORECASE),
]

# --- Sender allowlist -------------------------------------------------------
# Two forms only: exact addresses, or exact parent-domain matches.
# Parent-domain entries match `foo@<domain>` AND `foo@*.<domain>`.
EXACT_ADDRESSES: frozenset[str] = frozenset({
    "notify@github.com",
    "noreply@github.com",
    "noreply@google.com",
    "no-reply@accounts.google.com",
    "account-security-noreply@accountprotection.microsoft.com",
    "account-security-noreply@accountprotection.microsoft.com".lower(),
    "no-reply@supabase.io",
    "noreply@supabase.io",
    "noreply@supabase.com",
})

PARENT_DOMAINS: tuple[str, ...] = (
    "accountprotection.microsoft.com",
    "accounts.microsoft.com",
    "accounts.google.com",
    "supabase.com",
    "supabase.io",
)

WINDOW_NEW_HOURS = 25       # don't touch anything newer (codes might be live)
WINDOW_OLD_DAYS = 4         # don't reach further back than this
PAGE_SIZE = 200
MAX_PAGES = 25              # 5,000 messages cap; well above realistic volume


def _sender_address(msg: dict) -> str:
    return (
        ((msg.get("from") or {}).get("emailAddress") or {}).get("address") or ""
    ).lower().strip()


def _sender_trusted(addr: str) -> bool:
    if not addr or "@" not in addr:
        return False
    if addr in EXACT_ADDRESSES:
        return True
    domain = addr.split("@", 1)[1]
    for parent in PARENT_DOMAINS:
        if domain == parent or domain.endswith("." + parent):
            return True
    return False


def _subject_transactional(subject: str) -> bool:
    s = subject or ""
    return any(p.search(s) for p in SUBJECT_PATTERNS)


def _matches(msg: dict) -> bool:
    """Two-key gate: sender trust AND subject transactional pattern."""
    return _sender_trusted(_sender_address(msg)) and _subject_transactional(
        msg.get("subject") or ""
    )


def _iter_pages(g: GraphClient, path: str, params: dict) -> tuple[list[list[dict]], bool]:
    """Return (pages, truncated). Follow @odata.nextLink up to MAX_PAGES."""
    pages: list[list[dict]] = []
    page = g.get(path, params=params)
    pages_seen = 0
    truncated = False
    while True:
        pages_seen += 1
        pages.append(page.get("value", []) or [])
        next_link = page.get("@odata.nextLink")
        if not next_link:
            break
        if pages_seen >= MAX_PAGES:
            truncated = True
            break
        # GraphClient.get() handles absolute URLs natively (line 162).
        page = g.get(next_link)
    return pages, truncated


def main() -> int:
    g = GraphClient()
    now = dt.datetime.now(dt.timezone.utc)
    upper = now - dt.timedelta(hours=WINDOW_NEW_HOURS)
    lower = now - dt.timedelta(days=WINDOW_OLD_DAYS)

    params = {
        "$top": str(PAGE_SIZE),
        "$orderby": "receivedDateTime DESC",
        "$select": "id,subject,from,receivedDateTime",
        "$filter": (
            f"receivedDateTime ge {lower.strftime('%Y-%m-%dT%H:%M:%SZ')} "
            f"and receivedDateTime le {upper.strftime('%Y-%m-%dT%H:%M:%SZ')}"
        ),
    }

    purged = 0
    errors = 0

    try:
        pages, truncated = _iter_pages(g, "/me/mailFolders/inbox/messages", params)
    except Exception as exc:
        print(f"ERROR: inbox list failed: {exc}", file=sys.stderr)
        return 2

    for page in pages:
        for m in page:
            if not _matches(m):
                continue
            mid = m.get("id")
            if not mid:
                continue
            try:
                g.post(
                    f"/me/messages/{mid}/move",
                    body={"destinationId": "archive"},
                )
                purged += 1
            except Exception as exc:
                errors += 1
                print(f"WARN: archive failed for {mid}: {exc}", file=sys.stderr)

    if errors and not purged:
        print(f"ERROR: {errors} archive failure(s), 0 purged", file=sys.stderr)
        return 1

    if truncated:
        # Don't silently drop the tail — surface it.
        suffix = f", {errors} errors" if errors else ""
        print(
            f"WARNING: purged {purged} login-notification message(s){suffix}; "
            f"hit pagination cap ({MAX_PAGES} pages × {PAGE_SIZE}), older "
            "matches may remain"
        )
        return 0

    if purged == 0 and errors == 0:
        print("OK")
        return 0

    suffix = f" ({errors} errors)" if errors else ""
    print(f"purged {purged} login-notification message(s){suffix}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
