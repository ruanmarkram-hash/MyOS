#!/usr/bin/env python3
"""
calendar.py - List, create, update, cancel Outlook calendar events.

Usage:
  list:    python3 calendar.py list [--days 7] [--top 50]
                                    [--start ISO --end ISO]
  get:     python3 calendar.py get <event_id>
  create:  python3 calendar.py create --subject "Title" --start "2026-04-25T14:00:00"
                                       --end "2026-04-25T15:00:00" [--tz Australia/Brisbane]
                                       [--attendees a@x.com,b@y.com] [--location "Office"]
                                       [--body "agenda..."] [--online]   # adds Teams link
  update:  python3 calendar.py update <event_id> [--subject ...] [--start ...] [--end ...]
                                                  [--location ...] [--body ...]
  cancel:  python3 calendar.py cancel <event_id> [--comment "Reason"]
  decline: python3 calendar.py decline <event_id> [--comment "..."]
  accept:  python3 calendar.py accept <event_id> [--comment "..."]
"""
import sys
import json
import argparse
from datetime import datetime, timedelta, timezone
from graph_client import GraphClient


DEFAULT_TZ = "Australia/Brisbane"


def _compact_event(e: dict) -> dict:
    return {
        "id": e.get("id"),
        "subject": e.get("subject"),
        "start": (e.get("start") or {}).get("dateTime"),
        "start_tz": (e.get("start") or {}).get("timeZone"),
        "end": (e.get("end") or {}).get("dateTime"),
        "end_tz": (e.get("end") or {}).get("timeZone"),
        "location": (e.get("location") or {}).get("displayName"),
        "is_online": e.get("isOnlineMeeting", False),
        "online_url": (e.get("onlineMeeting") or {}).get("joinUrl"),
        "organizer": (e.get("organizer") or {}).get("emailAddress", {}).get("address"),
        "attendees": [
            {
                "email": a.get("emailAddress", {}).get("address"),
                "name": a.get("emailAddress", {}).get("name"),
                "response": (a.get("status") or {}).get("response"),
                "type": a.get("type"),
            }
            for a in (e.get("attendees") or [])
        ],
        "preview": (e.get("bodyPreview") or "")[:200],
    }


def cmd_list(g: GraphClient, args):
    if args.start and args.end:
        start, end = args.start, args.end
    else:
        now = datetime.now(timezone.utc)
        start = now.isoformat().replace("+00:00", "Z")
        end = (now + timedelta(days=args.days)).isoformat().replace("+00:00", "Z")

    # calendarView expands recurring meetings into instances within the window
    events = g.get_all(
        "/me/calendarView",
        params={
            "startDateTime": start,
            "endDateTime": end,
            "$top": str(args.top),
            "$orderby": "start/dateTime",
            "$select": "id,subject,start,end,location,isOnlineMeeting,onlineMeeting,organizer,attendees,bodyPreview",
        },
    )
    print(json.dumps([_compact_event(e) for e in events], indent=2, default=str))


def cmd_get(g: GraphClient, args):
    e = g.get(f"/me/events/{args.event_id}")
    out = _compact_event(e)
    out["body"] = (e.get("body") or {}).get("content", "")
    print(json.dumps(out, indent=2, default=str))


def cmd_create(g: GraphClient, args):
    body = {
        "subject": args.subject,
        "start": {"dateTime": args.start, "timeZone": args.tz},
        "end": {"dateTime": args.end, "timeZone": args.tz},
    }
    if args.location:
        body["location"] = {"displayName": args.location}
    if args.body:
        body["body"] = {"contentType": "html" if args.html else "text", "content": args.body}
    if args.attendees:
        body["attendees"] = [
            {"emailAddress": {"address": a.strip()}, "type": "required"}
            for a in args.attendees.split(",") if a.strip()
        ]
    if args.online:
        body["isOnlineMeeting"] = True
        body["onlineMeetingProvider"] = "teamsForBusiness"

    res = g.post("/me/events", body=body)
    print(json.dumps({"ok": True, "event": _compact_event(res)}, indent=2, default=str))


def cmd_update(g: GraphClient, args):
    body = {}
    if args.subject:  body["subject"] = args.subject
    if args.start:    body["start"] = {"dateTime": args.start, "timeZone": args.tz}
    if args.end:      body["end"]   = {"dateTime": args.end,   "timeZone": args.tz}
    if args.location: body["location"] = {"displayName": args.location}
    if args.body:     body["body"] = {"contentType": "text", "content": args.body}
    if not body:
        print('{"ok": false, "error": "no fields to update"}'); return
    res = g.patch(f"/me/events/{args.event_id}", body)
    print(json.dumps({"ok": True, "event": _compact_event(res)}, indent=2, default=str))


def cmd_cancel(g: GraphClient, args):
    g.post(f"/me/events/{args.event_id}/cancel", body={"comment": args.comment or ""})
    print('{"ok": true, "action": "cancelled"}')


def cmd_respond(action: str, g: GraphClient, args):
    g.post(f"/me/events/{args.event_id}/{action}", body={"comment": args.comment or "", "sendResponse": True})
    print(f'{{"ok": true, "action": "{action}"}}')


def main():
    p = argparse.ArgumentParser()
    sub = p.add_subparsers(dest="cmd", required=True)

    pl = sub.add_parser("list")
    pl.add_argument("--days", type=int, default=7)
    pl.add_argument("--top", type=int, default=50)
    pl.add_argument("--start", default=None)
    pl.add_argument("--end", default=None)

    pg = sub.add_parser("get")
    pg.add_argument("event_id")

    pc = sub.add_parser("create")
    pc.add_argument("--subject", required=True)
    pc.add_argument("--start", required=True, help='Local datetime "2026-04-25T14:00:00"')
    pc.add_argument("--end", required=True)
    pc.add_argument("--tz", default=DEFAULT_TZ)
    pc.add_argument("--attendees", default=None)
    pc.add_argument("--location", default=None)
    pc.add_argument("--body", default=None)
    pc.add_argument("--html", action="store_true")
    pc.add_argument("--online", action="store_true", help="Add Teams meeting link")

    pu = sub.add_parser("update")
    pu.add_argument("event_id")
    pu.add_argument("--subject", default=None)
    pu.add_argument("--start", default=None)
    pu.add_argument("--end", default=None)
    pu.add_argument("--tz", default=DEFAULT_TZ)
    pu.add_argument("--location", default=None)
    pu.add_argument("--body", default=None)

    px = sub.add_parser("cancel")
    px.add_argument("event_id")
    px.add_argument("--comment", default=None)

    for name in ("accept", "decline", "tentativelyAccept"):
        pr = sub.add_parser(name)
        pr.add_argument("event_id")
        pr.add_argument("--comment", default=None)

    args = p.parse_args()
    g = GraphClient()

    if args.cmd == "list":     cmd_list(g, args)
    elif args.cmd == "get":    cmd_get(g, args)
    elif args.cmd == "create": cmd_create(g, args)
    elif args.cmd == "update": cmd_update(g, args)
    elif args.cmd == "cancel": cmd_cancel(g, args)
    elif args.cmd in ("accept","decline","tentativelyAccept"): cmd_respond(args.cmd, g, args)


if __name__ == "__main__":
    main()
