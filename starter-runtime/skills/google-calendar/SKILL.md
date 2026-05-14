---
name: google-calendar
description: Manage your Google Calendar from Claude Code. Create events with Meet links, send invites, check availability.
allowed-tools: Bash(CLAUDECLAW_DIR=* ~/.venv/bin/python3 ~/.config/calendar/gcal.py *)
---

# Google Calendar Skill

## Purpose

Create meetings with Google Meet links, send invites, check availability, and manage calendar events from Claude Code.

## Environment

The calendar CLI reads credential paths from environment variables, loaded from ClaudeClaw's `.env` via `CLAUDECLAW_DIR`. Every command MUST use this prefix:

```
CLAUDECLAW_DIR=/path/to/claudeclaw
```

Your `.env` should contain:

```
GOOGLE_CREDS_PATH=~/.config/gmail/credentials.json
GCAL_TOKEN_PATH=~/.config/calendar/token.json
```

If these aren't set, the script falls back to `~/.config/gmail/credentials.json` (shared with Gmail) and `~/.config/calendar/token.json`.

## Commands

### List upcoming events

```bash
CLAUDECLAW_DIR=/path/to/claudeclaw ~/.venv/bin/python3 ~/.config/calendar/gcal.py list
```

Returns next 10 events as JSON. Each entry has: `id`, `summary`, `start`, `end`, `attendees`, `meet_link`.

### List events within N days

```bash
CLAUDECLAW_DIR=/path/to/claudeclaw ~/.venv/bin/python3 ~/.config/calendar/gcal.py list --days 7
```

### Get event details

```bash
CLAUDECLAW_DIR=/path/to/claudeclaw ~/.venv/bin/python3 ~/.config/calendar/gcal.py get <event_id>
```

### Create event with Meet link and invites

```bash
CLAUDECLAW_DIR=/path/to/claudeclaw ~/.venv/bin/python3 ~/.config/calendar/gcal.py create "Meeting Title" "2026-03-15 10:00" --duration 30 --attendees "person@example.com,other@example.com" --meet
```

- `--duration` in minutes (default: 30)
- `--attendees` comma-separated emails (sends invite emails automatically)
- `--meet` adds a Google Meet video link
- `--description` adds event description
- `--location` adds location

### Update an event

```bash
CLAUDECLAW_DIR=/path/to/claudeclaw ~/.venv/bin/python3 ~/.config/calendar/gcal.py update <event_id> --title "New Title" --start "2026-03-16 14:00" --duration 60 --add-attendees "new@example.com" --meet
```

All flags are optional. Only provided fields are updated. Attendees are notified of changes.

### Cancel an event

```bash
CLAUDECLAW_DIR=/path/to/claudeclaw ~/.venv/bin/python3 ~/.config/calendar/gcal.py cancel <event_id>
```

Cancels the event and sends cancellation notices to all attendees.

### Check free/busy

```bash
CLAUDECLAW_DIR=/path/to/claudeclaw ~/.venv/bin/python3 ~/.config/calendar/gcal.py freebusy "2026-03-15 09:00" "2026-03-15 17:00"
```

Shows busy time slots in the given range. If no conflicts, says "Time range is free."

### Re-authenticate

```bash
CLAUDECLAW_DIR=/path/to/claudeclaw ~/.venv/bin/python3 ~/.config/calendar/gcal.py auth
```

## CRITICAL: Day-of-Week Verification

**NEVER assume a date from a day name** (e.g. "Monday", "next Thursday"). Always verify before creating an event:

```bash
python3 -c "from datetime import date; d = date(2026, 3, 15); print(f'{d.strftime(\"%A\")} {d}')"
```

- If the output day name does NOT match what was requested, find the correct date
- This is a **blocking requirement**. Getting the day wrong sends a wrong invite to a real person.

## Workflow

1. If the user doesn't specify a time, check the calendar first with `list --days 7`
2. **If a day name was mentioned, verify the date matches that day**
3. Check `freebusy` for the proposed slot
4. Create the event with `--meet` and `--attendees`
5. Confirm: show title, time, **day of week**, attendees, and Meet link

## Confirmation Before Creating

Always show the user what you're about to create before running the command:
- Title
- **Day of week + Date/time** (e.g. "Monday Mar 15, 12:00pm")
- Duration
- Attendees
- Meet: yes/no

Then ask for confirmation before executing.

## Datetime Formats

All of these work:
- `2026-03-15 10:00`
- `2026-03-15 2:00PM`
- `2026-03-15T14:00`
- `03/15/2026 10:00`

## Timezone

The script defaults to **America/New_York**. To change it, edit the `TIMEZONE` constant in `gcal.py`.

## Defaults

- Duration: 30 minutes (unless the user specifies otherwise)
- Always add `--meet` unless the user specifically says no video call
- Invites are sent to all attendees automatically

## One-Time Setup

Uses the same Google Cloud project as Gmail. If `token.json` is missing:

```bash
CLAUDECLAW_DIR=/path/to/claudeclaw ~/.venv/bin/python3 ~/.config/calendar/gcal.py auth
```

Browser opens, sign in, approve Calendar access, done.

If you haven't set up Gmail yet, you'll need `credentials.json` first. See the Gmail skill setup instructions.

## Error Handling

- If `credentials.json` missing, point to Gmail setup (same file)
- If `token.json` missing, run auth automatically
- If event creation fails, show error and ask the user what to do
