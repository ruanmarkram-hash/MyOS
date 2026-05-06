#!/usr/bin/env python3
"""
Send email via Microsoft Graph using persistent token management.

Uses MSGraphAuth for automatic token refresh and pass persistence.
No manual re-auth needed after first setup.

Usage:
  python3 send_graph_email.py \
    --to "recipient@example.com" \
    --subject "Test" \
    --body "Hello" \
    [--from "shared-mailbox@example.com"] \
    [--attach /path/to/file.pdf] \
    [--html]
"""

import sys
import os
import argparse
import base64
import requests
from pathlib import Path
from urllib.parse import quote

sys.path.insert(0, str(Path(__file__).parent))
from msgraph_auth import MSGraphAuth


PROJECT_ROOT = Path(__file__).resolve().parents[2]


def read_env_file(keys):
    wanted = set(keys)
    values = {}
    env_path = PROJECT_ROOT / ".env"
    try:
        content = env_path.read_text()
    except Exception:
        return values

    for line in content.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            continue
        key, value = stripped.split("=", 1)
        key = key.strip()
        if key not in wanted:
            continue
        value = value.strip().strip('"').strip("'")
        if value:
            values[key] = value
    return values


def config_value(key):
    if os.environ.get(key):
        return os.environ[key].strip()
    return read_env_file([key]).get(key, "").strip()


def default_shared_mailbox():
    return (
        config_value("REVIEW_EXPORT_SHARED_MAILBOX")
        or config_value("REVIEW_EXPORT_FROM_EMAIL")
    )


def forbidden_from_emails():
    raw = config_value("MSGRAPH_FORBIDDEN_FROM_EMAILS")
    return {addr.strip().lower() for addr in raw.split(",") if addr.strip()}


class GraphEmailSender:
    """Send emails via Microsoft Graph API."""

    GRAPH_BASE = "https://graph.microsoft.com/v1.0"

    def __init__(self):
        self.auth = MSGraphAuth()

    def send(self, to, subject, body, from_email=None, attachments=None, html=False):
        """Send email via Graph API."""
        shared_mailbox = default_shared_mailbox()
        from_email = (from_email or shared_mailbox).strip()
        if not shared_mailbox:
            print("Refusing to send without REVIEW_EXPORT_SHARED_MAILBOX configured", file=sys.stderr)
            return False
        if not from_email:
            print("Refusing to send without a shared mailbox sender", file=sys.stderr)
            return False
        if from_email.lower() != shared_mailbox.lower():
            print(f"Refusing to send from non-shared sender: {from_email}", file=sys.stderr)
            return False

        if from_email and from_email.strip().lower() in forbidden_from_emails():
            print(f"Refusing to send from forbidden sender: {from_email}", file=sys.stderr)
            return False

        try:
            token = self.auth.get_access_token()
        except Exception as e:
            print(f"Authentication failed: {e}", file=sys.stderr)
            return False

        message = {
            "subject": subject,
            "body": {
                "contentType": "HTML" if html else "Text",
                "content": body
            },
            "toRecipients": [
                {"emailAddress": {"address": addr.strip()}}
                for addr in to.split(",")
            ]
        }

        if from_email:
            message["from"] = {"emailAddress": {"address": from_email}}

        if attachments:
            message["attachments"] = []
            for filepath in attachments:
                filepath = os.path.expanduser(filepath)
                if not os.path.exists(filepath):
                    print(f"Attachment not found: {filepath}", file=sys.stderr)
                    continue
                filename = os.path.basename(filepath)
                try:
                    with open(filepath, "rb") as f:
                        content = base64.b64encode(f.read()).decode("utf-8")
                    message["attachments"].append({
                        "@odata.type": "#microsoft.graph.fileAttachment",
                        "name": filename,
                        "contentBytes": content
                    })
                except Exception as e:
                    print(f"Failed to attach {filepath}: {e}", file=sys.stderr)

        payload = {"message": message, "saveToSentItems": "true"}
        headers = {
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json"
        }

        try:
            endpoint = f"{self.GRAPH_BASE}/users/{quote(from_email)}/sendMail"
            resp = requests.post(endpoint, headers=headers, json=payload, timeout=10)
            if resp.status_code == 202:
                from_note = f" from {from_email}" if from_email else ""
                print(f"Email sent{from_note} to {to}")
                return True
            else:
                print(f"Send failed ({resp.status_code}): {resp.text}", file=sys.stderr)
                return False
        except requests.RequestException as e:
            print(f"Request error: {e}", file=sys.stderr)
            return False


def main():
    parser = argparse.ArgumentParser(description="Send email via Microsoft Graph")
    parser.add_argument("--to", required=True, help="Recipient(s), comma-separated")
    parser.add_argument("--subject", required=True, help="Email subject")
    parser.add_argument("--body", help="Email body text (or HTML if --html)")
    parser.add_argument("--body-file", help="Read body from file (use - for stdin)")
    parser.add_argument("--from", dest="from_email", help="From address")
    parser.add_argument("--attach", action="append", dest="attachments", help="Attachment file (repeatable)")
    parser.add_argument("--html", action="store_true", help="Body is HTML")
    args = parser.parse_args()

    sender = GraphEmailSender()

    if args.body_file:
        try:
            body = sys.stdin.read() if args.body_file == "-" else open(os.path.expanduser(args.body_file)).read()
        except Exception as e:
            print(f"Failed to read body file: {e}", file=sys.stderr)
            sys.exit(1)
        success = sender.send(args.to, args.subject, body, from_email=args.from_email, attachments=args.attachments, html=args.html)
        sys.exit(0 if success else 1)

    if args.body:
        success = sender.send(args.to, args.subject, args.body, from_email=args.from_email, attachments=args.attachments, html=args.html)
        sys.exit(0 if success else 1)

    print("Error: --body or --body-file required", file=sys.stderr)
    sys.exit(1)


if __name__ == "__main__":
    main()
