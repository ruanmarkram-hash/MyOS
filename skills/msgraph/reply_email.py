#!/usr/bin/env python3
"""
reply_email.py - Reply, reply-all, or forward an Outlook message.

Usage:
  reply:     python3 reply_email.py reply <message_id> --body "text"
  reply_all: python3 reply_email.py reply-all <message_id> --body "text"
  forward:   python3 reply_email.py forward <message_id> --to a@x.com,b@y.com --body "text"

Optional:
  --html              Treat --body as HTML (default plain text)
  --comment           For forward, send body as a "comment" prepended to the original

Sends immediately (no draft).
"""
import sys
import argparse
from graph_client import GraphClient


def _content(body, is_html):
    return {"contentType": "html" if is_html else "text", "content": body}


def cmd_reply(g: GraphClient, args):
    payload = {"comment": args.body} if not args.html else {
        "message": {"body": _content(args.body, True)}
    }
    g.post(f"/me/messages/{args.message_id}/reply", body=payload)
    print('{"ok": true, "action": "reply"}')


def cmd_reply_all(g: GraphClient, args):
    payload = {"comment": args.body} if not args.html else {
        "message": {"body": _content(args.body, True)}
    }
    g.post(f"/me/messages/{args.message_id}/replyAll", body=payload)
    print('{"ok": true, "action": "reply-all"}')


def cmd_forward(g: GraphClient, args):
    to = [{"emailAddress": {"address": a.strip()}} for a in args.to.split(",") if a.strip()]
    payload = {
        "comment": args.body,
        "toRecipients": to,
    }
    if args.html:
        payload = {
            "message": {"body": _content(args.body, True), "toRecipients": to}
        }
    g.post(f"/me/messages/{args.message_id}/forward", body=payload)
    print('{"ok": true, "action": "forward"}')


def main():
    p = argparse.ArgumentParser()
    sub = p.add_subparsers(dest="cmd", required=True)

    for name in ("reply", "reply-all"):
        sp = sub.add_parser(name)
        sp.add_argument("message_id")
        sp.add_argument("--body", required=True)
        sp.add_argument("--html", action="store_true")

    pf = sub.add_parser("forward")
    pf.add_argument("message_id")
    pf.add_argument("--to", required=True, help="comma-separated emails")
    pf.add_argument("--body", required=True)
    pf.add_argument("--html", action="store_true")

    args = p.parse_args()
    g = GraphClient()
    {
        "reply": cmd_reply,
        "reply-all": cmd_reply_all,
        "forward": cmd_forward,
    }[args.cmd](g, args)


if __name__ == "__main__":
    main()
