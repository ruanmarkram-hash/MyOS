#!/usr/bin/env python3
"""
Auto-route remittance emails from plan managers into the Remittances folder.

Matches: subject contains "Remittance" (case-insensitive) AND sender is in the
known plan-manager allowlist AND subject does NOT match error/rejection patterns.

Error patterns are intentionally left in the inbox so [YOUR NAME] sees them — plan
managers use different subject lines when there's a problem with an invoice.
"""
import os, re, sys, json, subprocess
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from graph_client import GraphClient

REMITTANCES_FOLDER = 'AAMkAGY2YmZhZGZmLTkzYjktNDc2Ni1iOGY4LWRlYzFlZDNmMzJjYwAuAAAAAAAqZpVMP6z0S6PTJbal0Tv9AQBgzOm1hBosTKxOGuG5-ovlAAFYdl-YAAA='

# Plan manager senders (domains or full addresses, substring match)
PLAN_MANAGER_SENDERS = (
    'accounts@sunshinecoastplanmanager',
    'accounts@planforme',
    'leapin.com.au',
    'mycarespace.com.au',
    'leisurenetworks.org',
    'mypmgr.com.au',
)

REMIT_SUBJ = re.compile(r'remittance', re.I)
# If any of these appear in subject, LEAVE IT in inbox (could be an issue with an invoice)
ERROR_PATTERNS = re.compile(r'(invalid|incorrect|error|reject|resubmit|issue with|wrong|problem|unable to|bounc|failed|missing)', re.I)

def main():
    g = GraphClient()
    # Pull recent inbox items (last 50 unread + read, recent enough to catch anything we missed)
    msgs = g.get('/me/mailFolders/inbox/messages', params={
        '$top': '100',
        '$orderby': 'receivedDateTime DESC',
        '$select': 'id,subject,from,receivedDateTime,isRead',
    }).get('value', [])

    moved = []
    skipped_error = []
    for m in msgs:
        frm = ((m.get('from') or {}).get('emailAddress', {}).get('address') or '').lower()
        subj = m.get('subject') or ''
        if not any(s in frm for s in PLAN_MANAGER_SENDERS): continue
        if not REMIT_SUBJ.search(subj): continue
        if ERROR_PATTERNS.search(subj):
            skipped_error.append((frm, subj))
            continue
        # Move it
        try:
            g.post(f'/me/messages/{m["id"]}/move', body={'destinationId': REMITTANCES_FOLDER})
            moved.append((frm, subj))
        except Exception as e:
            print(f'FAIL: {frm} | {subj[:60]} -> {e}', file=sys.stderr)

    # Output: if nothing to say, say OK
    if not moved and not skipped_error:
        print('OK')
        return
    if moved:
        print(f'Routed {len(moved)} remittance(s) to Remittances folder:')
        for frm, subj in moved:
            print(f'  {frm} | {subj[:80]}')
    if skipped_error:
        print(f'LEFT IN INBOX ({len(skipped_error)} possible invoice errors):')
        for frm, subj in skipped_error:
            print(f'  ⚠️  {frm} | {subj[:80]}')

if __name__ == '__main__':
    main()
