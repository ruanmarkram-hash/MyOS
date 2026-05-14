#!/usr/bin/env python3
"""
iMessage triage — read-only view over ~/Library/Messages/chat.db.

Commands:
  imessage.py unanswered [--hours N] [--k-only]
      Show threads where the LAST message came from someone else and [YOUR NAME] hasn't
      replied. --hours defaults to 24. --k-only restricts to K-tagged senders.

  imessage.py digest [--hours N]
      Same as unanswered --hours 12 by default, grouped by tag (K / W / S / I / ?)
      with one line per sender. Morning-brief friendly.

  imessage.py recent [--limit N]
      Last N threads with activity, regardless of direction. Debug / exploration.

  imessage.py thread "<name or number>" [--limit N]
      Show last N messages in a thread (default 10). Shows direction + text.

Contact resolution:
  - AddressBook-v22.abcddb (Sources/) for name lookup
  - ~/workspace/operations/email-triage/contacts-master.json for K/W/S/I tags
    (emails map 1:1 to people; phone numbers matched by normalising to E164)
"""
import os, sys, sqlite3, argparse, datetime, json, re, glob

CHAT_DB = os.path.expanduser('~/Library/Messages/chat.db')
AB_SOURCES = glob.glob(os.path.expanduser('~/Library/Application Support/AddressBook/Sources/*/AddressBook-v22.abcddb'))
CONTACTS_JSON = os.path.expanduser('~/workspace/operations/email-triage/contacts-master.json')
DISMISSED_JSON = os.path.expanduser('~/workspace/operations/engine-room/skills/imessage/dismissed.json')

APPLE_EPOCH_OFFSET = 978307200  # seconds between 1970-01-01 and 2001-01-01

# -------- contact resolution --------

def normalise_phone(s):
    if not s: return s
    s = re.sub(r'[^\d+]', '', s)
    # Apple stores as +61... usually. AU local starting with 0 -> +61...
    if s.startswith('0') and len(s) == 10:
        s = '+61' + s[1:]
    return s

def load_address_book():
    """Return dict {normalised_phone: full_name} and {email: full_name}."""
    phones, emails = {}, {}
    for ab in AB_SOURCES:
        try:
            db = sqlite3.connect(f'file:{ab}?mode=ro', uri=True)
            rows = db.execute("""
              SELECT r.ZFIRSTNAME, r.ZLASTNAME, r.ZORGANIZATION, p.ZFULLNUMBER
              FROM ZABCDRECORD r LEFT JOIN ZABCDPHONENUMBER p ON p.ZOWNER = r.Z_PK
              WHERE p.ZFULLNUMBER IS NOT NULL
            """).fetchall()
            for fn, ln, org, num in rows:
                name = ' '.join(x for x in [fn, ln] if x) or org or ''
                if not name: continue
                phones[normalise_phone(num)] = name
            rows = db.execute("""
              SELECT r.ZFIRSTNAME, r.ZLASTNAME, r.ZORGANIZATION, e.ZADDRESS
              FROM ZABCDRECORD r LEFT JOIN ZABCDEMAILADDRESS e ON e.ZOWNER = r.Z_PK
              WHERE e.ZADDRESS IS NOT NULL
            """).fetchall()
            for fn, ln, org, addr in rows:
                name = ' '.join(x for x in [fn, ln] if x) or org or ''
                if not name: continue
                emails[addr.lower()] = name
            db.close()
        except Exception:
            continue
    return phones, emails

PEOPLE_TAGS_JSON = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'people-tags.json')

def load_tags():
    """Return (by_name {lower:tag}, by_shortcode {exact:tag}) from people-tags.json."""
    by_name, by_shortcode = {}, {}
    if os.path.exists(PEOPLE_TAGS_JSON):
        with open(PEOPLE_TAGS_JSON) as f:
            data = json.load(f)
        for k, v in (data.get('by_name') or {}).items():
            by_name[k.lower()] = v
        for k, v in (data.get('by_shortcode') or {}).items():
            by_shortcode[k] = v  # exact match, brands are case-sensitive
    # Fall back to contacts-master.json for email senders (won't help most iMessage but defends future)
    if os.path.exists(CONTACTS_JSON):
        try:
            with open(CONTACTS_JSON) as f:
                data = json.load(f)
            entries = data.get('contacts') if isinstance(data, dict) else data
            for c in (entries or []):
                tag = c.get('tag') or c.get('category')
                if not tag: continue
                name = c.get('name')
                if name: by_name.setdefault(name.lower(), tag)
        except Exception:
            pass
    return by_name, by_shortcode

def resolve(handle_id, phones, emails, tags):
    """Return (display_name, tag) for an iMessage handle.
    tags is (by_name, by_shortcode)."""
    by_name, by_shortcode = tags
    if not handle_id:
        return ('(unknown)', '?')
    h = handle_id
    display = None
    is_brand = False
    if h.startswith('+') or (h and h[0].isdigit()):
        norm = normalise_phone(h)
        display = phones.get(norm)
    elif '@' in h:
        display = emails.get(h.lower())
    else:
        # Shortcode/brand (e.g. "Stripe", "ATO")
        is_brand = True
    display = display or h
    # Shortcodes default to S unless explicitly tagged
    if is_brand:
        tag = by_shortcode.get(h) or by_name.get(h.lower()) or 'S'
    else:
        tag = by_name.get(display.lower()) or by_name.get(h.lower()) or '?'
    # Numeric-only handles that didn't resolve to a name but look like spam shortcodes
    if tag == '?' and display == h and not (h.startswith('+') or h.startswith('0')):
        tag = 'S'
    return (display, tag)

# -------- dismissed state --------

def load_dismissed():
    """Return {handle_id: dismissed_apple_ts}. Any thread whose last_ts <= dismissed_ts is hidden."""
    if not os.path.exists(DISMISSED_JSON):
        return {}
    try:
        with open(DISMISSED_JSON) as f:
            return json.load(f)
    except Exception:
        return {}

def save_dismissed(d):
    os.makedirs(os.path.dirname(DISMISSED_JSON), exist_ok=True)
    with open(DISMISSED_JSON, 'w') as f:
        json.dump(d, f, indent=2, sort_keys=True)

def is_dismissed(handle_id, last_ts, dismissed):
    """True if this thread is dismissed and no newer message has arrived."""
    cut = dismissed.get(handle_id)
    if cut is None: return False
    return last_ts <= cut

# -------- iMessage queries --------

class IMessageAccessDenied(Exception):
    """Raised when chat.db cannot be read (Full Disk Access not granted to the
    binary running this script). Callers should treat as 'no urgent iMessages'
    rather than as a database error, so the mid-day pulse silently skips the
    section instead of surfacing a noisy attention item every run."""

def open_chat_ro():
    try:
        db = sqlite3.connect(f'file:{CHAT_DB}?mode=ro', uri=True)
        # Force an actual read so authorization is checked here, not later.
        db.execute("SELECT 1 FROM sqlite_master LIMIT 1").fetchone()
        return db
    except sqlite3.OperationalError as e:
        msg = str(e).lower()
        if 'unable to open' in msg or 'authorization denied' in msg or 'not authorized' in msg:
            raise IMessageAccessDenied(str(e))
        raise

def apple_to_dt(ts):
    return datetime.datetime.fromtimestamp(ts + APPLE_EPOCH_OFFSET)

def ago(seconds):
    if seconds < 60: return f"{int(seconds)}s"
    if seconds < 3600: return f"{int(seconds/60)}m"
    if seconds < 86400: return f"{int(seconds/3600)}h"
    return f"{int(seconds/86400)}d"

def get_threads(hours=None, direction_last=None):
    """Return list of dicts per handle: handle, last_ts, last_from_me, last_text, count_in, count_out."""
    db = open_chat_ro()
    rows = db.execute("""
      SELECT h.id,
        (SELECT m2.is_from_me FROM message m2 WHERE m2.handle_id=h.ROWID ORDER BY m2.date DESC LIMIT 1) as last_from_me,
        (SELECT m2.date/1000000000 FROM message m2 WHERE m2.handle_id=h.ROWID ORDER BY m2.date DESC LIMIT 1) as last_ts,
        (SELECT substr(m2.text,1,120) FROM message m2 WHERE m2.handle_id=h.ROWID ORDER BY m2.date DESC LIMIT 1) as last_text,
        (SELECT COUNT(*) FROM message m3 WHERE m3.handle_id=h.ROWID AND m3.is_from_me=0) as incoming,
        (SELECT COUNT(*) FROM message m3 WHERE m3.handle_id=h.ROWID AND m3.is_from_me=1) as outgoing
      FROM handle h
      WHERE EXISTS (SELECT 1 FROM message m WHERE m.handle_id=h.ROWID)
    """).fetchall()
    db.close()
    now = datetime.datetime.now().timestamp() - APPLE_EPOCH_OFFSET
    out = []
    for handle, lfm, lts, ltxt, inc, outg in rows:
        if lts is None: continue
        age = now - lts
        if hours is not None and age < hours * 3600:
            # too recent — caller said "only threads older than N hours"
            pass
        if direction_last is not None and lfm != direction_last:
            continue
        out.append({
            'handle': handle, 'last_from_me': lfm, 'last_ts': lts, 'last_text': ltxt,
            'incoming': inc, 'outgoing': outg, 'age_s': age,
        })
    out.sort(key=lambda r: r['last_ts'], reverse=True)
    return out

def cmd_unanswered(args):
    phones, emails = load_address_book()
    tags = load_tags()
    dismissed = load_dismissed()
    threads = get_threads(direction_last=0)  # last was incoming = waiting for [YOUR NAME]
    min_age = args.hours * 3600
    filtered = []
    for t in threads:
        if t['age_s'] < min_age: continue
        if not args.include_dismissed and is_dismissed(t['handle'], t['last_ts'], dismissed): continue
        name, tag = resolve(t['handle'], phones, emails, tags)
        if args.k_only and tag != 'K': continue
        filtered.append((name, tag, t))
    if not filtered:
        print("No unanswered threads." if not args.k_only else "No K-tagged unanswered threads.")
        return 0
    # escalation flag: 🚨 if 72h+ and K-tagged
    for name, tag, t in filtered:
        escalate = '🚨 ' if (tag == 'K' and t['age_s'] >= 72 * 3600) else ''
        preview = (t['last_text'] or '').replace('\n', ' ')[:70]
        print(f"{escalate}[{tag}] {name} ({ago(t['age_s'])} ago) — {preview}")
    return 0

def cmd_digest(args):
    phones, emails = load_address_book()
    tags = load_tags()
    dismissed = load_dismissed()
    threads = get_threads(direction_last=0)
    min_age = args.hours * 3600
    max_age_nonk = 14 * 24 * 3600  # non-K: anything 14d+ is dead
    buckets = {'K': [], 'W': [], '?': []}
    for t in threads:
        if t['age_s'] < min_age: continue
        if is_dismissed(t['handle'], t['last_ts'], dismissed): continue
        name, tag = resolve(t['handle'], phones, emails, tags)
        if tag in ('S', 'I'): continue  # skip noise and info-only
        if tag != 'K' and t['age_s'] > max_age_nonk: continue
        # Skip empty body AND no-name handle — pure spam shortcodes that slipped through
        if not (t['last_text'] or '').strip() and name == t['handle']: continue
        buckets.setdefault(tag, []).append((name, t))
    shown = 0
    for tag in ('K', 'W', '?'):
        items = buckets.get(tag, [])
        if not items: continue
        print(f"{tag}:")
        for name, t in items:
            escalate = '🚨 ' if (tag == 'K' and t['age_s'] >= 72 * 3600) else ''
            preview = (t['last_text'] or '').replace('\n', ' ')[:60]
            print(f"  {escalate}{name} ({ago(t['age_s'])}) — {preview}")
            shown += 1
    if shown == 0:
        print("No unanswered threads worth surfacing.")
    return 0

def cmd_recent(args):
    phones, emails = load_address_book()
    tags = load_tags()
    threads = get_threads()[:args.limit]
    for t in threads:
        name, tag = resolve(t['handle'], phones, emails, tags)
        direction = '←' if t['last_from_me'] == 0 else '→'
        preview = (t['last_text'] or '').replace('\n', ' ')[:60]
        print(f"[{tag}] {direction} {name} ({ago(t['age_s'])}) — {preview}")
    return 0

def cmd_thread(args):
    phones, emails = load_address_book()
    needle = args.who.lower()
    # Find handle by name OR phone substring
    db = open_chat_ro()
    handles = db.execute("SELECT ROWID, id FROM handle").fetchall()
    matches = []
    for row_id, h in handles:
        name, _ = resolve(h, phones, emails, {})
        if needle in name.lower() or needle in h.lower():
            matches.append((row_id, h, name))
    if not matches:
        print(f"NO MATCH: {args.who}")
        return 1
    if len(matches) > 1:
        print(f"Multiple matches:")
        for _, h, name in matches:
            print(f"  {name} ({h})")
        return 1
    row_id, h, name = matches[0]
    rows = db.execute("""
      SELECT is_from_me, date/1000000000 as ts, text
      FROM message WHERE handle_id=? ORDER BY date DESC LIMIT ?
    """, (row_id, args.limit)).fetchall()
    db.close()
    print(f"--- Thread: {name} ({h}) ---")
    for is_from_me, ts, text in reversed(rows):
        arrow = '→' if is_from_me else '←'
        dt = apple_to_dt(ts).strftime('%Y-%m-%d %H:%M')
        txt = (text or '').replace('\n', ' ')[:200]
        print(f"  {dt} {arrow} {txt}")
    return 0

def cmd_dismiss_all(args):
    """Mark every currently-unanswered thread as dismissed at its current last_ts.
    Any newer incoming message from the same handle will resurface naturally."""
    dismissed = load_dismissed()
    threads = get_threads(direction_last=0)
    n = 0
    for t in threads:
        handle = t['handle']
        current = dismissed.get(handle, 0)
        if t['last_ts'] > current:
            dismissed[handle] = t['last_ts']
            n += 1
    save_dismissed(dismissed)
    print(f"DISMISSED {n} threads. They'll resurface only if a new message arrives.")
    return 0

def cmd_dismiss(args):
    """Dismiss a single thread by name/number substring."""
    phones, emails = load_address_book()
    threads = get_threads(direction_last=0)
    needle = args.who.lower()
    matches = []
    for t in threads:
        name, _ = resolve(t['handle'], phones, emails, ({}, {}))
        if needle in name.lower() or needle in t['handle'].lower():
            matches.append((name, t))
    if not matches:
        print(f"NO MATCH: {args.who}")
        return 1
    if len(matches) > 1 and not args.force:
        print(f"AMBIGUOUS ({len(matches)} matches): use --force or be more specific")
        for name, t in matches:
            print(f"  {name} ({t['handle']})")
        return 1
    dismissed = load_dismissed()
    for name, t in matches:
        dismissed[t['handle']] = t['last_ts']
        print(f"DISMISSED {name} ({t['handle']})")
    save_dismissed(dismissed)
    return 0

def cmd_undismiss(args):
    """Remove dismissal for a handle — it will surface again if unanswered."""
    dismissed = load_dismissed()
    if args.who == 'ALL':
        n = len(dismissed)
        dismissed = {}
        save_dismissed(dismissed)
        print(f"Cleared {n} dismissals.")
        return 0
    needle = args.who.lower()
    removed = []
    for k in list(dismissed.keys()):
        if needle in k.lower():
            removed.append(k)
            del dismissed[k]
    if not removed:
        print(f"NO MATCH: {args.who}")
        return 1
    save_dismissed(dismissed)
    for k in removed:
        print(f"UNDISMISSED {k}")
    return 0

def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest='cmd', required=True)

    p = sub.add_parser('unanswered'); p.add_argument('--hours', type=int, default=24); p.add_argument('--k-only', action='store_true'); p.add_argument('--include-dismissed', action='store_true')
    p.set_defaults(func=cmd_unanswered)
    p = sub.add_parser('digest'); p.add_argument('--hours', type=int, default=12)
    p.set_defaults(func=cmd_digest)
    p = sub.add_parser('recent'); p.add_argument('--limit', type=int, default=15)
    p.set_defaults(func=cmd_recent)
    p = sub.add_parser('thread'); p.add_argument('who'); p.add_argument('--limit', type=int, default=10)
    p.set_defaults(func=cmd_thread)
    p = sub.add_parser('dismiss-all'); p.set_defaults(func=cmd_dismiss_all)
    p = sub.add_parser('dismiss'); p.add_argument('who'); p.add_argument('--force', action='store_true')
    p.set_defaults(func=cmd_dismiss)
    p = sub.add_parser('undismiss'); p.add_argument('who', help='substring or "ALL"')
    p.set_defaults(func=cmd_undismiss)

    args = ap.parse_args()
    try:
        sys.exit(args.func(args))
    except IMessageAccessDenied as e:
        # Full Disk Access not granted to the binary running this script.
        # Degrade silently: produce no stdout so callers (the mid-day pulse)
        # treat the section as empty and skip it. Note the cause on stderr
        # for debugging; stderr is not surfaced to the pulse summary.
        print(
            f"NOTE: iMessage chat.db not readable ({e}). "
            "Grant Full Disk Access to the binary running this script "
            "(System Settings -> Privacy & Security -> Full Disk Access) to enable.",
            file=sys.stderr,
        )
        sys.exit(0)
    except Exception as e:
        print(f"ERROR: {type(e).__name__}: {e}", file=sys.stderr)
        sys.exit(2)

if __name__ == '__main__':
    main()
