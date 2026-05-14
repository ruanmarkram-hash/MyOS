#!/usr/bin/env python3
"""
Auto-route supplier/billing invoice emails into the Invoices folder.

Scope:
  - Subject matches invoice/billing patterns
  - Sender is NOT a K-tagged personal contact (we never hide real people)
  - Subject does NOT match error/rejection patterns (those stay visible)
  - Skip anything already handled by route_remittances.py (subject contains "Remittance")

Error-pattern emails stay in inbox so [YOUR NAME] sees disputes, failed payments, etc.
"""
import os, re, sys, json
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from graph_client import GraphClient

INVOICES_FOLDER = 'AAMkAGY2YmZhZGZmLTkzYjktNDc2Ni1iOGY4LWRlYzFlZDNmMzJjYwAuAAAAAAAqZpVMP6z0S6PTJbal0Tv9AQBgzOm1hBosTKxOGuG5-ovlAABQFlxaAAA='
CONTACTS_JSON = os.path.expanduser('~/workspace/operations/email-triage/contacts-master.json')

# Subject triggers
INVOICE_SUBJ = re.compile(
    r'(\binvoice\b|your (monthly )?(bill|receipt|statement)|billing statement|payment (confirmation|receipt|due)|subscription renew|tax invoice|your order is ready|receipt for|your .* invoice)',
    re.I
)
# If any of these appear in subject, LEAVE IT in inbox
ERROR_PATTERNS = re.compile(
    r'(invalid|incorrect|error|reject|resubmit|issue with|wrong|problem|unable to|bounc|failed|missing|overdue|dispute|unpaid|past due|final notice)',
    re.I
)
# Remittance handled by the other script
REMITTANCE_SUBJ = re.compile(r'remittance', re.I)

def load_k_tagged():
    """Return set of K-tagged email addresses (lowercase)."""
    k = set()
    if not os.path.exists(CONTACTS_JSON):
        return k
    try:
        with open(CONTACTS_JSON) as f:
            data = json.load(f)
        entries = data.get('contacts') if isinstance(data, dict) else data
        for c in (entries or []):
            tag = c.get('tag') or c.get('category')
            if tag == 'K':
                e = c.get('email')
                if e: k.add(e.lower())
    except Exception:
        pass
    return k

def main():
    g = GraphClient()
    k_senders = load_k_tagged()
    msgs = g.get('/me/mailFolders/inbox/messages', params={
        '$top': '100',
        '$orderby': 'receivedDateTime DESC',
        '$select': 'id,subject,from,receivedDateTime,isRead',
    }).get('value', [])

    moved = []
    left_error = []
    left_k = []
    for m in msgs:
        frm = ((m.get('from') or {}).get('emailAddress', {}).get('address') or '').lower()
        subj = m.get('subject') or ''
        if REMITTANCE_SUBJ.search(subj): continue  # handled elsewhere
        if not INVOICE_SUBJ.search(subj): continue
        if ERROR_PATTERNS.search(subj):
            left_error.append((frm, subj))
            continue
        if frm in k_senders:
            left_k.append((frm, subj))
            continue
        try:
            g.post(f'/me/messages/{m["id"]}/move', body={'destinationId': INVOICES_FOLDER})
            moved.append((frm, subj))
        except Exception as e:
            print(f'FAIL: {frm} | {subj[:60]} -> {e}', file=sys.stderr)

    if not moved and not left_error:
        print('OK')
        return
    if moved:
        print(f'Routed {len(moved)} invoice(s) to Invoices folder:')
        for frm, subj in moved:
            print(f'  {frm} | {subj[:80]}')
    if left_error:
        print(f'LEFT IN INBOX ({len(left_error)} possible billing issues):')
        for frm, subj in left_error:
            print(f'  ⚠️  {frm} | {subj[:80]}')

if __name__ == '__main__':
    main()
