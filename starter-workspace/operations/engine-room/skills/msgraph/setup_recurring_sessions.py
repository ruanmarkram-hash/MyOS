#!/usr/bin/env python3
"""
One-off setup: create [YOUR NAME]'s 5 weekly recurring sessions in Outlook,
24 occurrences each, with reminder lead times matched to travel.
Outputs the seriesMaster IDs.
"""
import json
import sys
from datetime import date, timedelta
from graph_client import GraphClient

TZ = "Australia/Brisbane"

# Find next occurrence of each weekday from today
today = date.today()  # 2026-04-24 Fri

def next_weekday(weekday: int) -> date:
    """weekday: 0=Mon, 1=Tue, ..., 6=Sun"""
    days_ahead = (weekday - today.weekday()) % 7
    if days_ahead == 0:
        days_ahead = 7  # next occurrence, not today
    return today + timedelta(days=days_ahead)

next_mon = next_weekday(0)
next_tue = next_weekday(1)
next_wed = next_weekday(2)
next_sat = next_weekday(5)

SESSIONS = [
    {
        "subject": "Invoicing + wages (weekly)",
        "weekday": "monday",
        "start_date": next_mon,
        "start_time": "07:30:00",
        "end_time":   "10:00:00",
        "reminder_min": 15,
        "body": "Weekly invoicing and wages block.",
    },
    {
        "subject": "Joey Spowart - support session",
        "weekday": "monday",
        "start_date": next_mon,
        "start_time": "10:00:00",
        "end_time":   "17:30:00",
        "reminder_min": 45,   # leave at 09:15
        "body": "Individual support, in community.",
    },
    {
        "subject": "Cuba Marie - support session",
        "weekday": "tuesday",
        "start_date": next_tue,
        "start_time": "14:30:00",
        "end_time":   "17:30:00",
        "reminder_min": 30,   # leave at 14:00
        "body": "Community access support.",
    },
    {
        "subject": "Darren Howell - support session",
        "weekday": "wednesday",
        "start_date": next_wed,
        "start_time": "15:00:00",
        "end_time":   "17:30:00",
        "reminder_min": 45,   # leave at 14:15
        "body": "Individual support, community access.",
    },
    {
        "subject": "Ethan Robertson - support session",
        "weekday": "saturday",
        "start_date": next_sat,
        "start_time": "08:30:00",
        "end_time":   "15:30:00",
        "reminder_min": 60,   # leave at 07:30
        "body": "Individual support, in community.",
    },
]

def build_event(s) -> dict:
    return {
        "subject": s["subject"],
        "body": {"contentType": "text", "content": s["body"]},
        "start": {"dateTime": f"{s['start_date'].isoformat()}T{s['start_time']}", "timeZone": TZ},
        "end":   {"dateTime": f"{s['start_date'].isoformat()}T{s['end_time']}",   "timeZone": TZ},
        "isReminderOn": True,
        "reminderMinutesBeforeStart": s["reminder_min"],
        "showAs": "busy",
        "recurrence": {
            "pattern": {
                "type": "weekly",
                "interval": 1,
                "daysOfWeek": [s["weekday"]],
            },
            "range": {
                "type": "numbered",
                "startDate": s["start_date"].isoformat(),
                "numberOfOccurrences": 24,
                "recurrenceTimeZone": TZ,
            },
        },
    }

def main():
    g = GraphClient()
    results = []
    for s in SESSIONS:
        body = build_event(s)
        try:
            ev = g.post("/me/events", body=body)
            results.append({
                "subject": s["subject"],
                "id": ev.get("id"),
                "first": ev.get("start", {}).get("dateTime"),
                "weekday": s["weekday"],
                "reminder_min": s["reminder_min"],
            })
        except Exception as e:
            results.append({"subject": s["subject"], "error": str(e)})
    print(json.dumps(results, indent=2, default=str))

if __name__ == "__main__":
    main()
