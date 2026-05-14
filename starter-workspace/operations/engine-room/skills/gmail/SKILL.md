---
name: gmail
description: Manage your Gmail inbox from Claude Code. List, read, triage, reply, send, and create filters.
allowed-tools: Bash(CLAUDECLAW_DIR=* ~/.venv/bin/python3 ~/.config/gmail/gmail.py *)
---

# Gmail Skill

## Purpose

Read, triage, reply, and send emails from your Gmail inbox via Claude Code.

## Environment

The Gmail CLI reads credential paths from environment variables, loaded from ClaudeClaw's `.env` via `CLAUDECLAW_DIR`. Every command MUST use this prefix:

```
CLAUDECLAW_DIR=/path/to/claudeclaw
```

Your `.env` should contain:

```
GOOGLE_CREDS_PATH=~/.config/gmail/credentials.json
GMAIL_TOKEN_PATH=~/.config/gmail/token.json
```

If these aren't set, the script falls back to `~/.config/gmail/credentials.json` and `~/.config/gmail/token.json`.

## Commands

### List inbox (full inbox, grouped by thread)

```bash
CLAUDECLAW_DIR=/path/to/claudeclaw ~/.venv/bin/python3 ~/.config/gmail/gmail.py list --all
```

Returns JSON array grouped by thread. Each entry has: `id`, `threadId`, `from`, `subject`, `date`, `snippet`, `unread`, `thread_count`. If `thread_count > 1`, also includes `all_ids`.

**This is the default command.** Always use `--all` unless the user specifically asks for a time-filtered view.

### List with time filter

```bash
CLAUDECLAW_DIR=/path/to/claudeclaw ~/.venv/bin/python3 ~/.config/gmail/gmail.py list --hours 48
```

### Read full email

```bash
CLAUDECLAW_DIR=/path/to/claudeclaw ~/.venv/bin/python3 ~/.config/gmail/gmail.py read <msg_id>
```

### Move email to label/folder

```bash
CLAUDECLAW_DIR=/path/to/claudeclaw ~/.venv/bin/python3 ~/.config/gmail/gmail.py move <msg_id> "Label Name"
```

- If the label doesn't exist, it creates it automatically
- Removes from INBOX, adds to target label, marks as read

### List all labels

```bash
CLAUDECLAW_DIR=/path/to/claudeclaw ~/.venv/bin/python3 ~/.config/gmail/gmail.py labels
```

### Reply to an email

```bash
CLAUDECLAW_DIR=/path/to/claudeclaw ~/.venv/bin/python3 ~/.config/gmail/gmail.py reply <msg_id> "Your reply body here"
```

- Automatically threads correctly (In-Reply-To, References headers)
- Prefixes subject with "Re:" if not already there
- Replies to the sender's From/Reply-To address

### Reply with attachments

```bash
CLAUDECLAW_DIR=/path/to/claudeclaw ~/.venv/bin/python3 ~/.config/gmail/gmail.py reply <msg_id> "Your reply body here" --attachments "/path/to/file1.pdf,/path/to/file2.png"
```

### Send a new email

```bash
CLAUDECLAW_DIR=/path/to/claudeclaw ~/.venv/bin/python3 ~/.config/gmail/gmail.py send "to@example.com" "Subject here" "Body here"
```

### Send with attachments

```bash
CLAUDECLAW_DIR=/path/to/claudeclaw ~/.venv/bin/python3 ~/.config/gmail/gmail.py send "to@example.com" "Subject" "Body" --attachments "/path/to/file.pdf,/path/to/other.xlsx"
```

### Create a Gmail filter (auto-sort rule)

```bash
CLAUDECLAW_DIR=/path/to/claudeclaw ~/.venv/bin/python3 ~/.config/gmail/gmail.py filter --from "sender@example.com" --label "LabelName" --archive --read
```

- `--from` / `--to` / `--subject` / `--query` for criteria
- `--label` to apply a label, `--archive` to skip inbox, `--read` to mark as read, `--trash` to trash
- Creates the label automatically if it doesn't exist

### List existing filters

```bash
CLAUDECLAW_DIR=/path/to/claudeclaw ~/.venv/bin/python3 ~/.config/gmail/gmail.py filters
```

### Re-authenticate

```bash
CLAUDECLAW_DIR=/path/to/claudeclaw ~/.venv/bin/python3 ~/.config/gmail/gmail.py auth
```

## Workflow

1. Run `list --all` to show all inbox emails
2. Display as a table with columns: #, Unread, From, Subject, Replies, Time
3. Ask the user which to move and where
4. Run `move` for each, confirm results

## Display Format

Use a proper markdown table for the inbox:

| # | Unread | From | Subject | Replies | Time |
|---|--------|------|---------|---------|------|
| 1 | * | someone@example.com | Re: Project update | 3 | 2h ago |
| 2 | | newsletter@co.com | Your weekly digest | 1 | 5h ago |

- **Replies** column shows `thread_count` (1 = single message, 2+ = thread)
- Each row is one thread (conversation), not individual messages

## Drafting Rules

- Always draft email content and show the user before sending
- Never send without confirmation

## One-Time Setup

If `credentials.json` is missing:

1. Go to [Google Cloud Console](https://console.cloud.google.com)
2. Create a project (or select existing)
3. Enable the **Gmail API** (APIs & Services > Library)
4. Go to APIs & Services > Credentials
5. Create an **OAuth 2.0 Client ID** > Desktop app
6. Download the JSON file
7. Save it to the path in your `GOOGLE_CREDS_PATH` (default: `~/.config/gmail/credentials.json`)
8. Run the `auth` command (see above)
9. Browser opens, sign in, authorize, done

## Error Handling

- If `credentials.json` missing, show setup instructions above
- If `token.json` missing, run auth automatically
- If label not found, the script creates it
- If any command fails, show the error and ask the user what to do
