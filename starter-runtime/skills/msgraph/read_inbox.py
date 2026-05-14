#!/usr/bin/env python3
"""
read_inbox.py - List, search, and fetch messages from Outlook inbox.

Usage:
  list:    python3 read_inbox.py list [--folder inbox] [--top 10] [--unread-only] [--from foo@bar]
  search:  python3 read_inbox.py search "query terms" [--top 10]
  get:     python3 read_inbox.py get <message_id>          # full body + headers
  folders: python3 read_inbox.py folders                   # list mail folders

Output: JSON to stdout.
"""
import sys
import json
import argparse
from graph_client import GraphClient


SHORT_FIELDS = "id,subject,from,toRecipients,receivedDateTime,isRead,hasAttachments,bodyPreview,importance,flag"


def cmd_list(g: GraphClient, args):
    folder = args.folder or "inbox"
    params = {
        "$top": str(args.top),
        "$orderby": "receivedDateTime DESC",
        "$select": SHORT_FIELDS,
    }
    filters = []
    if args.unread_only:
        filters.append("isRead eq false")
    if args.from_:
        filters.append(f"from/emailAddress/address eq '{args.from_}'")
    if args.since:
        filters.append(f"receivedDateTime ge {args.since}")
    if filters:
        params["$filter"] = " and ".join(filters)

    path = f"/me/mailFolders/{folder}/messages"
    msgs = g.get(path, params=params).get("value", [])
    out = [_compact(m) for m in msgs]
    print(json.dumps(out, indent=2, default=str))


def cmd_search(g: GraphClient, args):
    # Graph $search requires ConsistencyLevel header for some scenarios; basic $search works on /me/messages
    params = {
        "$top": str(args.top),
        "$select": SHORT_FIELDS,
        "$search": f'"{args.query}"',
    }
    msgs = g.get("/me/messages", params=params).get("value", [])
    out = [_compact(m) for m in msgs]
    print(json.dumps(out, indent=2, default=str))


def cmd_get(g: GraphClient, args):
    m = g.get(f"/me/messages/{args.message_id}",
              params={"$select": "id,subject,from,toRecipients,ccRecipients,receivedDateTime,isRead,hasAttachments,body,internetMessageHeaders,conversationId"})
    m["body_text"] = m.get("body", {}).get("content", "")
    m["body_type"] = m.get("body", {}).get("contentType", "")
    m.pop("body", None)
    print(json.dumps(m, indent=2, default=str))


def cmd_folders(g: GraphClient, args):
    folders = g.get_all("/me/mailFolders", params={"$top": "100"})
    out = [{"id": f["id"], "displayName": f["displayName"], "unreadItemCount": f.get("unreadItemCount", 0), "totalItemCount": f.get("totalItemCount", 0)} for f in folders]
    print(json.dumps(out, indent=2))


def _compact(m: dict) -> dict:
    return {
        "id": m.get("id"),
        "subject": m.get("subject"),
        "from": (m.get("from") or {}).get("emailAddress", {}).get("address"),
        "from_name": (m.get("from") or {}).get("emailAddress", {}).get("name"),
        "to": [r.get("emailAddress", {}).get("address") for r in (m.get("toRecipients") or [])],
        "received": m.get("receivedDateTime"),
        "unread": not m.get("isRead", True),
        "has_attachments": m.get("hasAttachments", False),
        "preview": (m.get("bodyPreview") or "")[:300],
        "importance": m.get("importance"),
        "flagged": (m.get("flag") or {}).get("flagStatus") == "flagged",
    }


def main():
    p = argparse.ArgumentParser()
    sub = p.add_subparsers(dest="cmd", required=True)

    pl = sub.add_parser("list")
    pl.add_argument("--folder", default="inbox", help="Folder id or well-known name (inbox, sentitems, drafts, deleteditems, archive)")
    pl.add_argument("--top", type=int, default=10)
    pl.add_argument("--unread-only", action="store_true")
    pl.add_argument("--from", dest="from_", default=None)
    pl.add_argument("--since", default=None, help="ISO datetime, e.g. 2026-04-20T00:00:00Z")

    ps = sub.add_parser("search")
    ps.add_argument("query")
    ps.add_argument("--top", type=int, default=10)

    pg = sub.add_parser("get")
    pg.add_argument("message_id")

    sub.add_parser("folders")

    args = p.parse_args()
    g = GraphClient()
    {"list": cmd_list, "search": cmd_search, "get": cmd_get, "folders": cmd_folders}[args.cmd](g, args)


if __name__ == "__main__":
    main()
