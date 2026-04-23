#!/usr/bin/env python3
"""
availability.py - Find free/busy across attendees and suggest meeting times.

Usage:
  freebusy:  python3 availability.py freebusy --emails a@x.com,b@y.com
                                              --start 2026-04-25T09:00:00
                                              --end 2026-04-25T17:00:00
                                              [--tz Australia/Brisbane]
                                              [--interval 30]   # minutes
  suggest:   python3 availability.py suggest --emails a@x.com,b@y.com
                                              --duration 30   # minutes
                                              [--days 5]
                                              [--tz Australia/Brisbane]
"""
import sys
import json
import argparse
from datetime import datetime, timedelta
from graph_client import GraphClient


DEFAULT_TZ = "Australia/Brisbane"


def cmd_freebusy(g: GraphClient, args):
    body = {
        "schedules": [e.strip() for e in args.emails.split(",") if e.strip()],
        "startTime": {"dateTime": args.start, "timeZone": args.tz},
        "endTime":   {"dateTime": args.end,   "timeZone": args.tz},
        "availabilityViewInterval": args.interval,
    }
    res = g.post("/me/calendar/getSchedule", body=body)
    out = []
    for s in res.get("value", []):
        out.append({
            "email": s.get("scheduleId"),
            # availabilityView: 0=Free 1=Tentative 2=Busy 3=OOF 4=WorkingElsewhere
            "view": s.get("availabilityView"),
            "busy_blocks": [
                {"start": (it.get("start") or {}).get("dateTime"),
                 "end":   (it.get("end") or {}).get("dateTime"),
                 "status": it.get("status"),
                 "subject": it.get("subject")}
                for it in (s.get("scheduleItems") or [])
            ],
            "working_hours": s.get("workingHours"),
        })
    print(json.dumps(out, indent=2, default=str))


def cmd_suggest(g: GraphClient, args):
    body = {
        "attendees": [
            {"type": "required", "emailAddress": {"address": e.strip()}}
            for e in args.emails.split(",") if e.strip()
        ],
        "timeConstraint": {
            "activityDomain": "work",
            "timeSlots": [{
                "start": {"dateTime": (datetime.now()).strftime("%Y-%m-%dT%H:%M:%S"), "timeZone": args.tz},
                "end":   {"dateTime": (datetime.now() + timedelta(days=args.days)).strftime("%Y-%m-%dT%H:%M:%S"), "timeZone": args.tz},
            }],
        },
        "meetingDuration": f"PT{args.duration}M",
        "maxCandidates": args.max,
    }
    res = g.post("/me/findMeetingTimes", body=body)
    out = {
        "empty_suggestions_reason": res.get("emptySuggestionsReason"),
        "suggestions": [
            {
                "confidence": s.get("confidence"),
                "score": s.get("organizerAvailability"),
                "start": (s.get("meetingTimeSlot") or {}).get("start", {}).get("dateTime"),
                "end":   (s.get("meetingTimeSlot") or {}).get("end", {}).get("dateTime"),
                "tz":    (s.get("meetingTimeSlot") or {}).get("start", {}).get("timeZone"),
                "attendee_availability": [
                    {"email": a.get("attendee", {}).get("emailAddress", {}).get("address"),
                     "availability": a.get("availability")}
                    for a in (s.get("attendeeAvailability") or [])
                ],
            }
            for s in (res.get("meetingTimeSuggestions") or [])
        ],
    }
    print(json.dumps(out, indent=2, default=str))


def main():
    p = argparse.ArgumentParser()
    sub = p.add_subparsers(dest="cmd", required=True)

    pf = sub.add_parser("freebusy")
    pf.add_argument("--emails", required=True)
    pf.add_argument("--start", required=True)
    pf.add_argument("--end", required=True)
    pf.add_argument("--tz", default=DEFAULT_TZ)
    pf.add_argument("--interval", type=int, default=30)

    ps = sub.add_parser("suggest")
    ps.add_argument("--emails", required=True)
    ps.add_argument("--duration", type=int, default=30)
    ps.add_argument("--days", type=int, default=5)
    ps.add_argument("--tz", default=DEFAULT_TZ)
    ps.add_argument("--max", type=int, default=10)

    args = p.parse_args()
    g = GraphClient()
    if args.cmd == "freebusy": cmd_freebusy(g, args)
    elif args.cmd == "suggest": cmd_suggest(g, args)


if __name__ == "__main__":
    main()
