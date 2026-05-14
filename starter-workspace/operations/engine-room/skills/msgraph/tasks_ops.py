#!/usr/bin/env python3
"""
tasks_ops.py - Manage Microsoft To-Do tasks via MS Graph Tasks API.

Replaces CalDAV-based reminders.py with MS Graph integration.

Usage:
  list:     python3 tasks_ops.py list [--all] [--overdue] [--due-today] [--list-name "Tasks"]
  add:      python3 tasks_ops.py add "Task title" [--due 2026-05-10T17:00] [--list-name "Tasks"]
  complete: python3 tasks_ops.py complete <task_id_or_substring>
  delete:   python3 tasks_ops.py delete <task_id_or_substring>
  find:     python3 tasks_ops.py find "substring"

Output is machine-parseable (one per line) and human-readable.
Exit 0 on success, non-zero on failure.
"""
import sys
import json
import argparse
from datetime import datetime, timezone, timedelta
from graph_client import GraphClient


DEFAULT_LIST_NAME = "Tasks"


def _get_task_list_id(g: GraphClient, list_name: str) -> str:
    """Find the task list ID by name. Create it if it doesn't exist."""
    lists = g.get("/me/todo/lists").get("value", [])
    for lst in lists:
        if lst.get("displayName") == list_name:
            return lst["id"]
    # Create the list if it doesn't exist
    new_list = g.post("/me/todo/lists", {"displayName": list_name})
    return new_list["id"]


def _parse_due(s: str) -> datetime:
    """Parse ISO-like datetime strings."""
    if not s:
        return None
    s = s.strip()
    for fmt in ('%Y-%m-%dT%H:%M:%S', '%Y-%m-%dT%H:%M', '%Y-%m-%d %H:%M', '%Y-%m-%d'):
        try:
            dt = datetime.strptime(s, fmt)
            # If no time component, default to 9am Brisbane
            if 'T' not in s and ' ' not in s:
                dt = dt.replace(hour=9, minute=0, second=0)
            # MS Graph expects UTC, so convert from Brisbane time
            brisbane_offset = timedelta(hours=10)
            return dt - brisbane_offset
        except ValueError:
            continue
    raise ValueError(f"Unparseable due date: {s!r}")


def _format_task(task: dict, timezone_offset_hours: int = 10) -> str:
    """Format a task for console output."""
    task_id = task.get("id", "")[:8]
    title = task.get("title", "(no title)")
    status = task.get("status", "notStarted")
    due_dt = task.get("dueDateTime")

    if due_dt and due_dt.get("dateTime"):
        # Convert UTC to Brisbane time for display
        utc_dt = datetime.fromisoformat(due_dt["dateTime"].replace("Z", "+00:00"))
        local_dt = utc_dt + timedelta(hours=timezone_offset_hours)
        due_display = local_dt.strftime('%Y-%m-%d %H:%M')
    else:
        due_display = "—"

    flag = '✓' if status == 'completed' else ' '
    return f"{flag} [{task_id}] due={due_display} | {title}"


def cmd_list(g: GraphClient, args):
    """List tasks from the specified list."""
    list_id = _get_task_list_id(g, args.list_name)
    tasks = g.get_all(f"/me/todo/lists/{list_id}/tasks", params={"$top": "100"})

    now = datetime.now(timezone.utc)
    today_end = now.replace(hour=13, minute=59, second=59, microsecond=0)  # 11:59pm Brisbane = 1:59pm UTC

    out = []
    for task in tasks:
        status = task.get("status", "notStarted")
        due_dt = task.get("dueDateTime")

        # Parse due date
        due = None
        if due_dt and due_dt.get("dateTime"):
            due = datetime.fromisoformat(due_dt["dateTime"].replace("Z", "+00:00"))

        # Apply filters
        if args.overdue:
            if not due or due >= now or status == 'completed':
                continue
        if args.due_today:
            if not due or due > today_end or status == 'completed':
                continue
        if not args.all and status == 'completed':
            continue

        out.append((due, task))

    # Sort: due first (soonest), then no-due at bottom
    out.sort(key=lambda r: (r[0] is None, r[0] or datetime.max.replace(tzinfo=timezone.utc)))

    for due, task in out:
        print(_format_task(task))

    if args.json:
        data = [{
            'id': task.get('id'),
            'title': task.get('title'),
            'status': task.get('status'),
            'due': due.isoformat() if due else None,
            'importance': task.get('importance'),
        } for due, task in out]
        sys.stderr.write(json.dumps(data) + '\n')

    return 0


def cmd_add(g: GraphClient, args):
    """Add a new task."""
    list_id = _get_task_list_id(g, args.list_name)

    body = {
        "title": args.text,
        "status": "notStarted",
    }

    if args.due:
        due_dt = _parse_due(args.due)
        body["dueDateTime"] = {
            "dateTime": due_dt.isoformat(),
            "timeZone": "UTC"
        }

    if args.priority:
        # MS Graph uses importance: low, normal, high
        # Map our 1-9 priority to importance
        if args.priority >= 7:
            body["importance"] = "high"
        elif args.priority <= 3:
            body["importance"] = "low"
        else:
            body["importance"] = "normal"

    task = g.post(f"/me/todo/lists/{list_id}/tasks", body)
    print(f"ADDED {task['id'][:8]} | {args.text}")
    return 0


def _find_task(g: GraphClient, list_id: str, needle: str, include_completed: bool = False):
    """Find tasks matching a substring (in ID or title)."""
    tasks = g.get_all(f"/me/todo/lists/{list_id}/tasks", params={"$top": "100"})
    needle = needle.lower()
    matches = []

    for task in tasks:
        status = task.get("status", "notStarted")
        if not include_completed and status == 'completed':
            continue

        task_id = task.get("id", "")
        title = task.get("title", "")

        if needle in task_id.lower() or needle in title.lower():
            matches.append(task)

    return matches


def cmd_complete(g: GraphClient, args):
    """Mark a task as completed."""
    list_id = _get_task_list_id(g, args.list_name)
    matches = _find_task(g, list_id, args.needle)

    if not matches:
        print(f"NO MATCH: {args.needle}")
        return 1

    if len(matches) > 1 and not args.force:
        print(f"AMBIGUOUS ({len(matches)} matches): use --force to complete all or be more specific")
        for task in matches:
            print(f"  {_format_task(task)}")
        return 1

    for task in matches:
        task_id = task["id"]
        g.patch(f"/me/todo/lists/{list_id}/tasks/{task_id}", {"status": "completed"})
        print(f"COMPLETED [{task_id[:8]}] {task.get('title')}")

    return 0


def cmd_delete(g: GraphClient, args):
    """Delete a task."""
    list_id = _get_task_list_id(g, args.list_name)
    matches = _find_task(g, list_id, args.needle, include_completed=True)

    if not matches:
        print(f"NO MATCH: {args.needle}")
        return 1

    if len(matches) > 1 and not args.force:
        print(f"AMBIGUOUS ({len(matches)} matches): use --force or be more specific")
        for task in matches:
            print(f"  {_format_task(task)}")
        return 1

    for task in matches:
        task_id = task["id"]
        g.delete(f"/me/todo/lists/{list_id}/tasks/{task_id}")
        print(f"DELETED [{task_id[:8]}] {task.get('title')}")

    return 0


def cmd_find(g: GraphClient, args):
    """Find tasks matching a substring."""
    list_id = _get_task_list_id(g, args.list_name)
    matches = _find_task(g, list_id, args.needle, include_completed=args.all)

    if not matches:
        print(f"NO MATCH: {args.needle}")
        return 1

    for task in matches:
        print(_format_task(task))

    return 0


def main():
    p = argparse.ArgumentParser(description="Manage Microsoft To-Do tasks via MS Graph")
    sub = p.add_subparsers(dest='cmd', required=True)

    # list
    pl = sub.add_parser('list', help='List tasks')
    pl.add_argument('--all', action='store_true', help='Include completed tasks')
    pl.add_argument('--overdue', action='store_true', help='Show only overdue tasks')
    pl.add_argument('--due-today', action='store_true', help='Show only tasks due today')
    pl.add_argument('--list-name', default=DEFAULT_LIST_NAME, help='Task list name')
    pl.add_argument('--json', action='store_true', help='Also output JSON to stderr')

    # add
    pa = sub.add_parser('add', help='Add a task')
    pa.add_argument('text', help='Task title')
    pa.add_argument('--due', help='Due date (ISO format: 2026-05-10T17:00 or 2026-05-10)')
    pa.add_argument('--priority', type=int, help='Priority 1-9 (maps to low/normal/high)')
    pa.add_argument('--list-name', default=DEFAULT_LIST_NAME, help='Task list name')

    # complete
    pc = sub.add_parser('complete', help='Mark task as completed')
    pc.add_argument('needle', help='Task ID or substring to match')
    pc.add_argument('--force', action='store_true', help='Complete all matches')
    pc.add_argument('--list-name', default=DEFAULT_LIST_NAME, help='Task list name')

    # delete
    pd = sub.add_parser('delete', help='Delete a task')
    pd.add_argument('needle', help='Task ID or substring to match')
    pd.add_argument('--force', action='store_true', help='Delete all matches')
    pd.add_argument('--list-name', default=DEFAULT_LIST_NAME, help='Task list name')

    # find
    pf = sub.add_parser('find', help='Find tasks by substring')
    pf.add_argument('needle', help='Substring to search for')
    pf.add_argument('--all', action='store_true', help='Include completed tasks')
    pf.add_argument('--list-name', default=DEFAULT_LIST_NAME, help='Task list name')

    args = p.parse_args()

    try:
        g = GraphClient()

        if args.cmd == 'list':
            sys.exit(cmd_list(g, args))
        elif args.cmd == 'add':
            sys.exit(cmd_add(g, args))
        elif args.cmd == 'complete':
            sys.exit(cmd_complete(g, args))
        elif args.cmd == 'delete':
            sys.exit(cmd_delete(g, args))
        elif args.cmd == 'find':
            sys.exit(cmd_find(g, args))
    except Exception as e:
        print(f"ERROR: {type(e).__name__}: {e}", file=sys.stderr)
        sys.exit(2)


if __name__ == '__main__':
    main()
