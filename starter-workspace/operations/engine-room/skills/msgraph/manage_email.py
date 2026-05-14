#!/usr/bin/env python3
"""
manage_email.py - Mark, flag, move, archive, and delete Outlook messages.

Usage:
  read:      python3 manage_email.py read <message_id>           # mark as read
  unread:    python3 manage_email.py unread <message_id>
  flag:      python3 manage_email.py flag <message_id>
  unflag:    python3 manage_email.py unflag <message_id>
  move:      python3 manage_email.py move <message_id> --folder <folder_id_or_well_known>
  archive:   python3 manage_email.py archive <message_id>        # alias for move --folder archive
  delete:    python3 manage_email.py delete <message_id>         # moves to Deleted Items
  purge:     python3 manage_email.py purge <message_id>          # permanent delete
"""
import sys
import argparse
from graph_client import GraphClient


def _set_read(g, mid, is_read):
    g.patch(f"/me/messages/{mid}", {"isRead": is_read})
    print(f'{{"ok": true, "id": "{mid}", "isRead": {str(is_read).lower()}}}')


def _set_flag(g, mid, status):
    g.patch(f"/me/messages/{mid}", {"flag": {"flagStatus": status}})
    print(f'{{"ok": true, "id": "{mid}", "flag": "{status}"}}')


def _move(g, mid, folder):
    res = g.post(f"/me/messages/{mid}/move", body={"destinationId": folder})
    print(f'{{"ok": true, "id": "{mid}", "moved_to": "{folder}", "new_id": "{res.get("id","")}"}}')


def main():
    p = argparse.ArgumentParser()
    sub = p.add_subparsers(dest="cmd", required=True)

    for name in ("read", "unread", "flag", "unflag", "archive", "delete", "purge"):
        sp = sub.add_parser(name)
        sp.add_argument("message_id")

    pm = sub.add_parser("move")
    pm.add_argument("message_id")
    pm.add_argument("--folder", required=True, help="Folder id or well-known name (archive, deleteditems, junkemail, etc.)")

    args = p.parse_args()
    g = GraphClient()
    mid = args.message_id

    if args.cmd == "read":     _set_read(g, mid, True)
    elif args.cmd == "unread": _set_read(g, mid, False)
    elif args.cmd == "flag":   _set_flag(g, mid, "flagged")
    elif args.cmd == "unflag": _set_flag(g, mid, "notFlagged")
    elif args.cmd == "archive":_move(g, mid, "archive")
    elif args.cmd == "move":   _move(g, mid, args.folder)
    elif args.cmd == "delete": _move(g, mid, "deleteditems")
    elif args.cmd == "purge":
        g.delete(f"/me/messages/{mid}")
        print(f'{{"ok": true, "id": "{mid}", "purged": true}}')


if __name__ == "__main__":
    main()
