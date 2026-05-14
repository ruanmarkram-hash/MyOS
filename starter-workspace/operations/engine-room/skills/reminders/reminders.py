#!/usr/bin/env python3
"""
Assistant reminders — CalDAV client for an Apple Reminders list.

Commands:
  python3 reminders.py add "text" [--due 2026-04-25T17:00] [--priority 1-9]
  python3 reminders.py list [--all] [--overdue] [--due-today] [--due-before ISO]
  python3 reminders.py complete <uid_or_substring>
  python3 reminders.py delete   <uid_or_substring>
  python3 reminders.py find     "substring match"

Exit 0 on success, non-zero on failure. Output is machine-parseable (one per line).
"""
import os, sys, re, argparse, datetime, uuid, json

ENV_PATH = os.path.expanduser('~/HQ/.env')
ENGINE_ROOM_PYTHON = os.path.expanduser('~/workspace/operations/engine-room/.venv/bin/python')

if sys.executable != ENGINE_ROOM_PYTHON and os.path.exists(ENGINE_ROOM_PYTHON):
    os.execv(ENGINE_ROOM_PYTHON, [ENGINE_ROOM_PYTHON, __file__, *sys.argv[1:]])

def load_env():
    env = {}
    with open(ENV_PATH) as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith('#') or '=' not in line: continue
            k, v = line.split('=', 1)
            env[k.strip()] = v.strip().strip('"').strip("'")
    return env

def get_client():
    import caldav
    env = load_env()
    client = caldav.DAVClient(
        url='https://caldav.icloud.com',
        username=env['APPLE_ID_EMAIL'],
        password=env['APPLE_CALDAV_APP_PASSWORD'],
    )
    principal = client.principal()
    for c in principal.calendars():
        if c.name == os.environ.get('REMINDERS_LIST_NAME', 'Assistant'):
            return client, c
    raise RuntimeError("Reminder list not found in iCloud. Set REMINDERS_LIST_NAME or create an 'Assistant' list.")

def parse_due(s):
    """Accept ISO-like strings: 2026-04-25, 2026-04-25T17:00, 2026-04-25T17:00:00."""
    if not s: return None
    s = s.strip()
    for fmt in ('%Y-%m-%dT%H:%M:%S', '%Y-%m-%dT%H:%M', '%Y-%m-%d %H:%M', '%Y-%m-%d'):
        try:
            return datetime.datetime.strptime(s, fmt)
        except ValueError:
            continue
    raise ValueError(f"Unparseable due date: {s!r}")

def make_vtodo(summary, due=None, priority=None, uid=None):
    uid = uid or str(uuid.uuid4())
    now = datetime.datetime.utcnow().strftime('%Y%m%dT%H%M%SZ')
    lines = [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//MyOS//Sage reminders//EN",
        "BEGIN:VTODO",
        f"UID:{uid}",
        f"DTSTAMP:{now}",
        f"CREATED:{now}",
        f"LAST-MODIFIED:{now}",
        f"SUMMARY:{summary}",
        "STATUS:NEEDS-ACTION",
    ]
    if due:
        # Floating local time (Brisbane-style, no TZ suffix so Apple treats as local)
        lines.append(f"DUE:{due.strftime('%Y%m%dT%H%M%S')}")
    if priority is not None:
        lines.append(f"PRIORITY:{priority}")
    lines += ["END:VTODO", "END:VCALENDAR"]
    return uid, "\r\n".join(lines) + "\r\n"

def cmd_add(args):
    client, cal = get_client()
    due = parse_due(args.due) if args.due else None
    uid, ics = make_vtodo(args.text, due=due, priority=args.priority)
    # Use Todo constructor directly — save_todo(ics=...) wraps improperly on iCloud
    from caldav import Todo
    todo = Todo(client=client, data=ics, parent=cal, id=uid)
    todo.save()
    print(f"ADDED {uid} | {args.text}")
    return 0

def todo_props(todo):
    """Return (uid, summary, status, due, completed, priority)."""
    raw = todo.data
    def grab(key):
        m = re.search(rf'^{key}(?:;[^:]*)?:(.*?)$', raw, re.MULTILINE)
        return m.group(1).strip() if m else None
    uid = grab('UID')
    summary = grab('SUMMARY') or ''
    status = grab('STATUS') or 'NEEDS-ACTION'
    due = grab('DUE')
    completed = grab('COMPLETED')
    priority = grab('PRIORITY')
    return uid, summary, status, due, completed, priority

def parse_ical_date(s):
    if not s: return None
    s = s.strip()
    for fmt in ('%Y%m%dT%H%M%SZ', '%Y%m%dT%H%M%S', '%Y%m%d'):
        try:
            return datetime.datetime.strptime(s, fmt)
        except ValueError:
            continue
    return None

def _all_vtodos(cal):
    """Use .objects() since iCloud 500s on REPORT-based .todos() filter.
    Each resource must be .load()ed to fetch its ICS body."""
    out = []
    for obj in cal.objects():
        try:
            obj.load()
        except Exception:
            continue
        raw = obj.data or ''
        if 'BEGIN:VTODO' in raw:
            out.append(obj)
    return out

def cmd_list(args):
    _, cal = get_client()
    todos = _all_vtodos(cal)
    now = datetime.datetime.now()
    today_end = now.replace(hour=23, minute=59, second=59, microsecond=0)
    filter_before = parse_due(args.due_before) if args.due_before else None

    out = []
    for t in todos:
        uid, summary, status, due_s, completed, priority = todo_props(t)
        due = parse_ical_date(due_s)
        if args.overdue and (not due or due >= now or status == 'COMPLETED'): continue
        if args.due_today and (not due or due > today_end or status == 'COMPLETED'): continue
        if filter_before and (not due or due >= filter_before): continue
        if not args.all and status == 'COMPLETED': continue
        out.append((due, uid, summary, status, due_s, priority))

    # sort: due first (soonest), then no-due at bottom
    out.sort(key=lambda r: (r[0] is None, r[0] or datetime.datetime.max))
    for due, uid, summary, status, due_s, priority in out:
        due_display = due.strftime('%Y-%m-%d %H:%M') if due else '—'
        flag = '!' if status == 'COMPLETED' else ' '
        print(f"{flag} [{uid[:8]}] due={due_display} | {summary}")
    if args.json:
        # also print JSON to stderr for programmatic use
        import sys
        data = [{
            'uid': uid, 'summary': summary, 'status': status,
            'due': due.isoformat() if due else None, 'priority': priority
        } for due, uid, summary, status, _, priority in out]
        sys.stderr.write(json.dumps(data) + '\n')
    return 0

def find_match(cal, needle, include_completed=False):
    needle = needle.lower()
    todos = _all_vtodos(cal)
    matches = []
    for t in todos:
        uid, summary, status, *_ = todo_props(t)
        if not include_completed and status == 'COMPLETED':
            continue
        if needle in uid.lower() or needle in summary.lower():
            matches.append((t, uid, summary))
    return matches

def cmd_complete(args):
    _, cal = get_client()
    matches = find_match(cal, args.needle)
    if not matches:
        print(f"NO MATCH: {args.needle}"); return 1
    if len(matches) > 1 and not args.force:
        print(f"AMBIGUOUS ({len(matches)} matches): use --force to complete all or be more specific")
        for _, uid, summary in matches:
            print(f"  [{uid[:8]}] {summary}")
        return 1
    now = datetime.datetime.utcnow().strftime('%Y%m%dT%H%M%SZ')
    for t, uid, summary in matches:
        ics = t.data
        # replace STATUS, add COMPLETED, add PERCENT-COMPLETE
        ics = re.sub(r'STATUS:.*', 'STATUS:COMPLETED', ics)
        if 'COMPLETED:' not in ics:
            ics = ics.replace('END:VTODO', f'COMPLETED:{now}\r\nPERCENT-COMPLETE:100\r\nEND:VTODO')
        ics = re.sub(r'LAST-MODIFIED:.*', f'LAST-MODIFIED:{now}', ics)
        t.data = ics
        t.save()
        print(f"COMPLETED [{uid[:8]}] {summary}")
    return 0

def cmd_delete(args):
    _, cal = get_client()
    matches = find_match(cal, args.needle, include_completed=True)
    if not matches:
        print(f"NO MATCH: {args.needle}"); return 1
    if len(matches) > 1 and not args.force:
        print(f"AMBIGUOUS ({len(matches)} matches): use --force or be more specific")
        for _, uid, summary in matches:
            print(f"  [{uid[:8]}] {summary}")
        return 1
    for t, uid, summary in matches:
        t.delete()
        print(f"DELETED [{uid[:8]}] {summary}")
    return 0

def cmd_find(args):
    _, cal = get_client()
    matches = find_match(cal, args.needle, include_completed=args.all)
    if not matches:
        print(f"NO MATCH: {args.needle}"); return 1
    for _, uid, summary in matches:
        print(f"[{uid[:8]}] {summary}")
    return 0

def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest='cmd', required=True)

    p_add = sub.add_parser('add'); p_add.add_argument('text'); p_add.add_argument('--due'); p_add.add_argument('--priority', type=int)
    p_add.set_defaults(func=cmd_add)

    p_list = sub.add_parser('list'); p_list.add_argument('--all', action='store_true'); p_list.add_argument('--overdue', action='store_true'); p_list.add_argument('--due-today', action='store_true'); p_list.add_argument('--due-before'); p_list.add_argument('--json', action='store_true')
    p_list.set_defaults(func=cmd_list)

    p_comp = sub.add_parser('complete'); p_comp.add_argument('needle'); p_comp.add_argument('--force', action='store_true')
    p_comp.set_defaults(func=cmd_complete)

    p_del = sub.add_parser('delete'); p_del.add_argument('needle'); p_del.add_argument('--force', action='store_true')
    p_del.set_defaults(func=cmd_delete)

    p_find = sub.add_parser('find'); p_find.add_argument('needle'); p_find.add_argument('--all', action='store_true')
    p_find.set_defaults(func=cmd_find)

    args = ap.parse_args()
    try:
        sys.exit(args.func(args))
    except Exception as e:
        print(f"ERROR: {type(e).__name__}: {e}", file=sys.stderr)
        sys.exit(2)

if __name__ == '__main__':
    main()
