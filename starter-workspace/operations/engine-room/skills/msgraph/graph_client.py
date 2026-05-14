#!/usr/bin/env python3
"""
graph_client.py - Shared MS Graph HTTP client for read/write operations.

Standalone from msgraph_auth.py. Uses the same refresh token (stored in `pass`
at msgraph/refresh-token) but requests the broader scope set required
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
from datetime import datetime, timedelta

import requests
import msal

CLIENT_ID = os.environ.get("GRAPH_CLIENT_ID", "")
TENANT_ID = os.environ.get("GRAPH_TENANT_ID", "common")
PASS_KEY = "msgraph/refresh-token"

# Broad scope set covering email management + calendar + meetings + tasks.
# Grant was already done in Azure (admin consent click).
#
# Resource scopes (Graph API permissions). Used for both OAuth2 raw refresh
# and MSAL device flow.
RESOURCE_SCOPES = [
    "https://graph.microsoft.com/Mail.ReadWrite",
    "https://graph.microsoft.com/Mail.Send",
    "https://graph.microsoft.com/Calendars.ReadWrite",
    "https://graph.microsoft.com/MailboxSettings.Read",
    "https://graph.microsoft.com/OnlineMeetings.ReadWrite",
    "https://graph.microsoft.com/Tasks.ReadWrite",
]
# OAuth2 raw token endpoint requires offline_access for refresh tokens.
# MSAL forbids reserved scopes (profile/openid/offline_access) in the
# scope list — it injects them automatically. Keep the two call sites
# converged on RESOURCE_SCOPES so adding a new scope works in both paths.
SCOPES = " ".join(RESOURCE_SCOPES + ["offline_access"])
MSAL_SCOPES = list(RESOURCE_SCOPES)

GRAPH_BASE = "https://graph.microsoft.com/v1.0"


def _load_refresh_token() -> Optional[str]:
    # 1. Try pass (GPG-encrypted CLI secret store) — preferred when available
    try:
        r = subprocess.run(["pass", "show", PASS_KEY], capture_output=True, text=True, timeout=10)
        if r.returncode == 0 and r.stdout.strip():
            return r.stdout.strip()
    except Exception:
        pass
    # 2. Fall back to env var
    env = os.environ.get("GRAPH_REFRESH_TOKEN", "").strip()
    if env:
        return env
    # 3. Fall back to reading .env directly (subprocesses spawned by the
    # Claude SDK don't inherit GRAPH_REFRESH_TOKEN — env.ts strips it).
    env_path = os.path.expanduser("~/HQ/.env")
    try:
        with open(env_path, "r") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#"):
                    continue
                if line.startswith("GRAPH_REFRESH_TOKEN="):
                    val = line.split("=", 1)[1].strip()
                    if (val.startswith('"') and val.endswith('"')) or (val.startswith("'") and val.endswith("'")):
                        val = val[1:-1]
                    if val:
                        return val
    except Exception:
        pass
    return None


def _save_refresh_token(token: str) -> None:
    # Try pass first
    try:
        r = subprocess.run(["pass", "insert", "-e", "-f", PASS_KEY],
                       input=token, capture_output=True, text=True, timeout=10)
        if r.returncode == 0:
            return
    except Exception:
        pass
    # Fall back to rewriting GRAPH_REFRESH_TOKEN in ~/HQ/.env so the rotated
    # token persists for the next run. MS Graph rotates the refresh token on
    # every refresh — if we don't persist the new one we lose access when the
    # current one expires.
    env_path = os.path.expanduser("~/HQ/.env")
    try:
        with open(env_path, "r") as f:
            lines = f.readlines()
        found = False
        for i, line in enumerate(lines):
            if line.strip().startswith("GRAPH_REFRESH_TOKEN="):
                lines[i] = f"GRAPH_REFRESH_TOKEN={token}\n"
                found = True
                break
        if not found:
            lines.append(f"GRAPH_REFRESH_TOKEN={token}\n")
        # Atomic write: tmp + rename so a crash mid-write doesn't corrupt .env
        tmp_path = env_path + ".tmp"
        with open(tmp_path, "w") as f:
            f.writelines(lines)
        os.replace(tmp_path, env_path)
    except Exception as e:
        raise RuntimeError(f"Could not persist refresh token (pass unavailable, .env write failed: {e})")


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

        # Try OAuth2 refresh endpoint first
        if self._refresh_token:
            try:
                token = self._refresh_via_oauth()
                if token:
                    return token
            except Exception as e:
                # Log but don't crash — fall through to device code
                print(f"warn: OAuth2 refresh failed ({e}), trying device code flow...", file=sys.stderr)

        # Fallback: device code flow for expired/invalid tokens or consent_required
        try:
            token = self._device_code_flow()
            if token:
                return token
        except Exception as e:
            raise RuntimeError(f"Token refresh failed (OAuth2) and device code auth failed: {e}")

    def _refresh_via_oauth(self) -> str:
        """Attempt OAuth2 refresh token grant."""
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
            raise RuntimeError(f"OAuth2 refresh failed: {body.get('error_description', body)}")
        self._access_token = body["access_token"]
        self._expires_at = time.time() + int(body.get("expires_in", 3600))
        if body.get("refresh_token"):
            self._refresh_token = body["refresh_token"]
            try:
                _save_refresh_token(self._refresh_token)
            except Exception as e:
                print(f"warn: could not save refreshed token to pass: {e}", file=sys.stderr)
        return self._access_token

    def _device_code_flow(self) -> str:
        """Device code auth flow for interactive re-authorization."""
        app = msal.PublicClientApplication(CLIENT_ID, authority=f"https://login.microsoftonline.com/{TENANT_ID}")

        flow = app.initiate_device_flow(MSAL_SCOPES)
        if "user_code" not in flow:
            raise RuntimeError(f"Device flow initiation failed: {flow}")

        print(f"\n{flow['message']}\n", file=sys.stderr)
        result = app.acquire_token_by_device_flow(flow)

        if "access_token" not in result:
            error = result.get("error", "unknown")
            desc = result.get("error_description", "")
            raise RuntimeError(f"Device code auth failed: {error} -- {desc}")

        self._access_token = result["access_token"]
        expires_in = result.get("expires_in", 3600)
        self._expires_at = time.time() + expires_in
        if result.get("refresh_token"):
            self._refresh_token = result["refresh_token"]
            try:
                _save_refresh_token(self._refresh_token)
            except Exception as e:
                print(f"warn: could not save new refresh token: {e}", file=sys.stderr)
        print("Authentication successful", file=sys.stderr)
        return self._access_token

    def _headers(self, extra: Optional[dict] = None) -> dict:
        h = {
            "Authorization": f"Bearer {self._ensure_token()}",
            "Accept": "application/json",
            # Force MS Graph to return calendar event dateTime values in
            # Brisbane local time. Without this, /me/calendarView and
            # /me/events default to UTC, which makes downstream agents
            # double-handle the conversion (and misreport "tonight" when
            # the UTC time crosses midnight). Ignored on non-calendar
            # endpoints.
            "Prefer": 'outlook.timezone="Australia/Brisbane"',
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
