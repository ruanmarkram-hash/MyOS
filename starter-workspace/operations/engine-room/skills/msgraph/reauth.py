#!/usr/bin/env python3
"""
Quick re-authorization script for MS Graph (your Microsoft app app).
Run this once when getting 'consent_required' or 'invalid_grant' errors.

Usage:
    python3 ~/workspace/operations/engine-room/skills/msgraph/reauth.py

A browser/device code prompt will appear. Follow the instructions to authorize.
The new refresh token is saved automatically to pass/env.
"""

import sys
import os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from graph_client import GraphClient

try:
    print("Initializing MS Graph client...")
    g = GraphClient()

    print("Attempting to get a valid token (will trigger device code flow if needed)...")
    token = g._ensure_token()

    print(f"\n✓ Authorization successful!")
    print(f"✓ Refresh token saved (valid for ~90 days)")
    print(f"✓ Scheduled tasks can now run again")
except Exception as e:
    print(f"\n✗ Authorization failed: {e}", file=sys.stderr)
    sys.exit(1)
