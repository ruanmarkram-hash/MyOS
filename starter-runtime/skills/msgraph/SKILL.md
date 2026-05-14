# MS Graph Skill

Microsoft Graph API access for email and calendar management.

Automated sends must use a shared/service mailbox. Do not send automated
messages from a person's mailbox unless that person has given express written
confirmation for that specific send.

## Architecture

Two parallel clients sharing the same refresh token (`pass: msgraph/refresh-token`):

- **`msgraph_auth.py`** — original MSAL-based client (token refresh + send email). Untouched.
- **`graph_client.py`** — new HTTP-based client with broad scopes for inbox + calendar management. Used by all `read_inbox.py`, `reply_email.py`, `manage_email.py`, `calendar_ops.py`, `availability.py`.

Both refresh tokens persist back to `pass`.

## Capabilities

### 1. Token refresh (auto, every 45 min)
```bash
bash ~/HQ/skills/msgraph/refresh.sh
```

### 2. Send email
```bash
python3 ~/HQ/skills/msgraph/send_graph_email.py \
  --from "shared-mailbox@example.com" --to "x@y.com" --subject "Hello" --body "..." [--attach /tmp/file.pdf]
```

If `--from` is omitted, the helper uses `REVIEW_EXPORT_SHARED_MAILBOX` or
`REVIEW_EXPORT_FROM_EMAIL` from `.env`, and posts to
`/users/{shared-mailbox}/sendMail`. It must not fall back to `/me/sendMail` for
automated sends. If `--from` is supplied, it must match the configured shared
mailbox.

### 3. Read inbox
```bash
# List recent
python3 ~/HQ/skills/msgraph/read_inbox.py list --top 10
python3 ~/HQ/skills/msgraph/read_inbox.py list --unread-only --top 20
python3 ~/HQ/skills/msgraph/read_inbox.py list --from someone@x.com
python3 ~/HQ/skills/msgraph/read_inbox.py list --since 2026-04-20T00:00:00Z

# Search
python3 ~/HQ/skills/msgraph/read_inbox.py search "invoice quarterly"

# Full message body
python3 ~/HQ/skills/msgraph/read_inbox.py get <message_id>

# List folders
python3 ~/HQ/skills/msgraph/read_inbox.py folders
```

### 4. Reply / Forward
```bash
python3 ~/HQ/skills/msgraph/reply_email.py reply <id> --body "Thanks, will do."
python3 ~/HQ/skills/msgraph/reply_email.py reply-all <id> --body "..."
python3 ~/HQ/skills/msgraph/reply_email.py forward <id> --to a@x.com,b@y.com --body "FYI"
# Add --html if body is HTML
```

### 5. Manage messages
```bash
python3 ~/HQ/skills/msgraph/manage_email.py read <id>     # mark as read
python3 ~/HQ/skills/msgraph/manage_email.py unread <id>
python3 ~/HQ/skills/msgraph/manage_email.py flag <id>
python3 ~/HQ/skills/msgraph/manage_email.py unflag <id>
python3 ~/HQ/skills/msgraph/manage_email.py archive <id>
python3 ~/HQ/skills/msgraph/manage_email.py move <id> --folder <folder_id_or_name>
python3 ~/HQ/skills/msgraph/manage_email.py delete <id>   # to Deleted Items
python3 ~/HQ/skills/msgraph/manage_email.py purge <id>    # permanent
```

### 6. Calendar
```bash
# List
python3 ~/HQ/skills/msgraph/calendar_ops.py list --days 7
python3 ~/HQ/skills/msgraph/calendar_ops.py list --start 2026-04-25T00:00:00Z --end 2026-05-02T00:00:00Z
python3 ~/HQ/skills/msgraph/calendar_ops.py get <event_id>

# Create
python3 ~/HQ/skills/msgraph/calendar_ops.py create \
  --subject "Sync with Mason" \
  --start "2026-04-25T14:00:00" --end "2026-04-25T15:00:00" \
  --attendees mason@x.com --location "Office" --body "Agenda..." --online

# Update
python3 ~/HQ/skills/msgraph/calendar_ops.py update <event_id> --start "2026-04-25T15:00:00" --end "2026-04-25T16:00:00"

# Cancel / respond
python3 ~/HQ/skills/msgraph/calendar_ops.py cancel <event_id> --comment "Conflict came up"
python3 ~/HQ/skills/msgraph/calendar_ops.py accept <event_id>
python3 ~/HQ/skills/msgraph/calendar_ops.py decline <event_id> --comment "..."
```

### 7. Availability
```bash
# Free/busy view (raw schedule blocks)
python3 ~/HQ/skills/msgraph/availability.py freebusy \
  --emails owner@example.com,colleague@example.com \
  --start 2026-04-25T09:00:00 --end 2026-04-25T17:00:00 --interval 30

# Suggest meeting times
python3 ~/HQ/skills/msgraph/availability.py suggest \
  --emails owner@example.com,colleague@example.com --duration 30 --days 5
```

### 8. Health check
```bash
python3 ~/HQ/skills/msgraph/msgraph_auth.py --health
```

## Granted scopes (admin-consented in tenant)

`Mail.ReadWrite`, `Mail.Send`, `Mail.ReadWrite.Shared`, `Mail.Send.Shared`,
`Calendars.ReadWrite`, `MailboxSettings.Read`, `OnlineMeetings.ReadWrite`,
`Files.ReadWrite.All`, `Sites.ReadWrite.All`, `User.Read`, `openid`, `profile`, `email`, `offline_access`.

## Folder shortcuts

Well-known names accepted by `--folder`: `inbox`, `archive`, `sentitems`, `drafts`,
`deleteditems`, `junkemail`, `outbox`, `clutter`. Or pass a real folder id from
`read_inbox.py folders`.

## Environment

| Var | Notes |
|-----|-------|
| `GRAPH_CLIENT_ID` | Defaults to your Microsoft app app |
| `GRAPH_TENANT_ID` | Defaults to Microsoft common tenant |
| `GRAPH_REFRESH_TOKEN` | Fallback if `pass` unavailable |

## Dependencies

Python 3.9+, `pip3 install msal requests`, `brew install pass`.

## Owner

Mason. Inbox + calendar additions: 2026-04-23.
