#!/usr/bin/env python3
"""
graph_client.py - Shared MS Graph HTTP client for read/write operations.

Standalone from msgraph_auth.py. Uses the same refresh token (stored in `pass`
at myos/ms-graph-refresh-token) but requests the broader scope set required
for inbox management and calendar operations.

Usage:
    from graph_client import GraphClient
    g = GraphClient()
    msgs = g.get("/me/messages", params={"$top": 10})
"""

import os
import sys
import json
import time
import subprocess
import urllib.parse
from typing import Optional

import requests

CLIENT_ID = os.environ.get("GRAPH_CLIENT_ID", "__GRAPH_CLIENT_ID__")
TENANT_ID = os.environ.get("GRAPH_TENANT_ID", "__GRAPH_TENANT_ID__")
PASS_KEY = "myos/ms-graph-refresh-token"

# Broad scope set covering email management + calendar + meetings.
# Grant was already done in Azure (admin consent click).
SCOPES = " ".join([
    "https://graph.microsoft.com/Mail.ReadWrite",
    "https://graph.microsoft.com/Mail.Send",
    "https://graph.microsoft.com/Calendars.ReadWrite",
    "https://graph.microsoft.com/MailboxSettings.Read",
    "https://graph.microsoft.com/OnlineMeetings.ReadWrite",
    "offline_access",
])

GRAPH_BASE = "https://graph.microsoft.com/v1.0"


def _load_refresh_token() -> Optional[str]:
    try:
        r = subprocess.run(["pass", "show", PASS_KEY], capture_output=True, text=True, timeout=10)
        if r.returncode == 0 and r.stdout.strip():
            return r.stdout.strip()
    except Exception:
        pass
    env = os.environ.get("GRAPH_REFRESH_TOKEN", "").strip()
    return env or None


def _save_refresh_token(token: str) -> None:
    subprocess.run(["pass", "insert", "-e", "-f", PASS_KEY],
                   input=token, capture_output=True, text=True, timeout=10)


class GraphClient:
    """Thin wrapper around the Graph HTTP API with auto-refresh."""

    def __init__(self):
        self._access_token: Optional[str] = None
        self._expires_at: float = 0.0
        self._refresh_token: Optional[str] = _load_refresh_token()
        if not self._refresh_token:
            raise RuntimeError("No refresh token in pass:%s or GRAPH_REFRESH_TOKEN env" % PASS_KEY)

    def _ensure_token(self) -> str:
        # Refresh if missing or within 5 min of expiry
        if self._access_token and time.time() < (self._expires_at - 300):
            return self._access_token

        url = f"https://login.microsoftonline.com/{TENANT_ID}/oauth2/v2.0/token"
        data = {
            "client_id": CLIENT_ID,
            "grant_type": "refresh_token",
            "refresh_token": self._refresh_token,
            "scope": SCOPES,
        }
        r = requests.post(url, data=data, timeout=30)
        body = r.json()
        if "access_token" not in body:
            raise RuntimeError(f"Token refresh failed: {body}")
        self._access_token = body["access_token"]
        self._expires_at = time.time() + int(body.get("expires_in", 3600))
        if body.get("refresh_token"):
            self._refresh_token = body["refresh_token"]
            try:
                _save_refresh_token(self._refresh_token)
            except Exception as e:
                print(f"warn: could not save refreshed token to pass: {e}", file=sys.stderr)
        return self._access_token

    def _headers(self, extra: Optional[dict] = None) -> dict:
        h = {
            "Authorization": f"Bearer {self._ensure_token()}",
            "Accept": "application/json",
        }
        if extra:
            h.update(extra)
        return h

    def get(self, path: str, params: Optional[dict] = None) -> dict:
        url = path if path.startswith("http") else f"{GRAPH_BASE}{path}"
        r = requests.get(url, headers=self._headers(), params=params, timeout=30)
        if r.status_code >= 400:
            raise RuntimeError(f"GET {path} -> {r.status_code}: {r.text[:500]}")
        if r.status_code == 204 or not r.text:
            return {}
        return r.json()

    def post(self, path: str, body: Optional[dict] = None, raw: bool = False) -> dict:
        url = path if path.startswith("http") else f"{GRAPH_BASE}{path}"
        r = requests.post(
            url,
            headers=self._headers({"Content-Type": "application/json"}),
            data=json.dumps(body) if body is not None else None,
            timeout=30,
        )
        if r.status_code >= 400:
            raise RuntimeError(f"POST {path} -> {r.status_code}: {r.text[:500]}")
        if r.status_code in (202, 204) or not r.text:
            return {}
        return r.json() if not raw else {"raw": r.text}

    def patch(self, path: str, body: dict) -> dict:
        url = f"{GRAPH_BASE}{path}"
        r = requests.patch(
            url, headers=self._headers({"Content-Type": "application/json"}),
            data=json.dumps(body), timeout=30,
        )
        if r.status_code >= 400:
            raise RuntimeError(f"PATCH {path} -> {r.status_code}: {r.text[:500]}")
        return r.json() if r.text else {}

    def delete(self, path: str) -> None:
        url = f"{GRAPH_BASE}{path}"
        r = requests.delete(url, headers=self._headers(), timeout=30)
        if r.status_code >= 400:
            raise RuntimeError(f"DELETE {path} -> {r.status_code}: {r.text[:500]}")

    # Convenience: paginate $top results across @odata.nextLink
    def get_all(self, path: str, params: Optional[dict] = None, max_pages: int = 5) -> list:
        items = []
        page = self.get(path, params=params)
        items.extend(page.get("value", []))
        next_url = page.get("@odata.nextLink")
        pages = 1
        while next_url and pages < max_pages:
            page = self.get(next_url)
            items.extend(page.get("value", []))
            next_url = page.get("@odata.nextLink")
            pages += 1
        return items


if __name__ == "__main__":
    # Quick self-test: fetch profile
    g = GraphClient()
    me = g.get("/me", params={"$select": "displayName,mail,userPrincipalName"})
    print(json.dumps(me, indent=2))
