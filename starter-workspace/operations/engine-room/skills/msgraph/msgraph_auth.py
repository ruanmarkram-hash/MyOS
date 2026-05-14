#!/usr/bin/env python3
"""
MS Graph Authentication Handler with Persistent Token Management.

Provides token lifecycle management:
- Refresh tokens stored in pass (GPG-encrypted, CLI-accessible, no GUI prompts)
- Access tokens cached in memory for the session duration
- Automatic refresh on expiry (within 5 min of expiry, refresh silently)
- Device code fallback for initial auth or refresh failure

Ported from OpenClaw (2026-04-16). Now reads CLIENT_ID/TENANT_ID from env
with hardcoded fallbacks.

Usage:
    from msgraph_auth import MSGraphAuth

    auth = MSGraphAuth()
    token = auth.get_access_token()  # Returns valid token, refreshes if needed
"""

import subprocess
import json
import time
import sys
import os
import msal
import requests
from datetime import datetime, timedelta
from pathlib import Path


class MSGraphAuth:
    """Persistent MS Graph authentication handler with pass (GPG) token storage."""

    # Azure app config (env vars override hardcoded defaults)
    CLIENT_ID = os.environ.get("GRAPH_CLIENT_ID", "")
    TENANT_ID = os.environ.get("GRAPH_TENANT_ID", "common")
    AUTHORITY = f"https://login.microsoftonline.com/{TENANT_ID}"
    SCOPES = [
        "https://graph.microsoft.com/Mail.Send",
        "https://graph.microsoft.com/Mail.ReadWrite"
    ]

    # Credential store (pass, GPG-encrypted CLI)
    PASS_KEY = "msgraph/refresh-token"

    # Token refresh buffer (refresh if expiry < 5 min away)
    REFRESH_BUFFER_SECONDS = 300

    def __init__(self):
        """Initialize auth handler. Load refresh token from pass or init fresh."""
        self.access_token = None
        self.access_token_expiry = None
        self.refresh_token = None

        # Try to load refresh token from pass
        self.refresh_token = self._load_refresh_token()

        # Fallback: try env var if pass didn't have it
        if not self.refresh_token:
            env_token = os.environ.get("GRAPH_REFRESH_TOKEN", "").strip()
            if env_token:
                self.refresh_token = env_token

    def get_access_token(self):
        """Return a valid access token (auto-refresh if needed)."""
        if self.access_token and self._is_token_valid(self.access_token_expiry):
            return self.access_token

        if self.refresh_token:
            try:
                self._refresh_access_token()
                if self.access_token:
                    return self.access_token
            except Exception as e:
                print(f"Refresh failed ({e}), falling back to device code...", file=sys.stderr)

        try:
            self._device_code_flow()
            if not self.access_token:
                raise RuntimeError("Device code flow did not produce access token")
            return self.access_token
        except Exception as e:
            raise RuntimeError(f"Authentication failed: {e}")

    def set_refresh_token(self, token):
        """Store refresh token in pass (GPG-encrypted)."""
        self._write_refresh_token(token)
        self.refresh_token = token

    def refresh_access_token(self):
        """Refresh access token using stored refresh token."""
        if not self.refresh_token:
            raise RuntimeError("No refresh token available")
        self._refresh_access_token()
        if not self.access_token:
            raise RuntimeError("Refresh failed to produce access token")
        return self.access_token

    def device_code_flow(self):
        """Trigger device code auth flow interactively."""
        self._device_code_flow()
        if not self.access_token:
            raise RuntimeError("Device code flow failed")
        return self.access_token

    def check_health(self):
        """Check token health without triggering auth flows."""
        status = {
            "refresh_token": bool(self.refresh_token),
            "refresh_token_source": None,
            "access_token": bool(self.access_token),
            "access_token_valid": self._is_token_valid(self.access_token_expiry),
            "expiry": str(self.access_token_expiry) if self.access_token_expiry else None
        }

        # Determine refresh token source — probe each in priority order
        pass_token = None
        try:
            r = subprocess.run(["pass", "show", self.PASS_KEY],
                               capture_output=True, text=True, timeout=10)
            if r.returncode == 0 and r.stdout.strip():
                pass_token = r.stdout.strip()
        except Exception:
            pass
        env_token = os.environ.get("GRAPH_REFRESH_TOKEN", "").strip()
        env_file_token = None
        try:
            with open(os.path.expanduser("~/HQ/.env"), "r") as f:
                for line in f:
                    if line.strip().startswith("GRAPH_REFRESH_TOKEN="):
                        env_file_token = line.split("=", 1)[1].strip()
                        break
        except Exception:
            pass

        if pass_token:
            status["refresh_token_source"] = "pass"
        elif env_token:
            status["refresh_token_source"] = "env"
        elif env_file_token:
            status["refresh_token_source"] = "env_file"
        else:
            status["refresh_token_source"] = "none"

        return status

    # -- Private: Token lifecycle --

    def _refresh_access_token(self):
        if not self.refresh_token:
            raise RuntimeError("No refresh token available")

        app = msal.PublicClientApplication(self.CLIENT_ID, authority=self.AUTHORITY)

        result = app.acquire_token_by_refresh_token(self.refresh_token, self.SCOPES)

        if "access_token" in result:
            self.access_token = result["access_token"]
            expires_in = result.get("expires_in", 3600)
            self.access_token_expiry = datetime.utcnow() + timedelta(seconds=expires_in)
            if "refresh_token" in result:
                self.set_refresh_token(result["refresh_token"])
            return

        if "error" in result:
            error = result.get("error", "unknown")
            desc = result.get("error_description", "")
            raise RuntimeError(f"Refresh failed: {error} -- {desc}")

        raise RuntimeError("Refresh returned no access token")

    def _device_code_flow(self):
        app = msal.PublicClientApplication(self.CLIENT_ID, authority=self.AUTHORITY)

        flow = app.initiate_device_flow(self.SCOPES)
        if "user_code" not in flow:
            raise RuntimeError(f"Device flow initiation failed: {flow}")

        print(f"\n{flow['message']}\n", file=sys.stderr)
        result = app.acquire_token_by_device_flow(flow)

        if "access_token" in result:
            self.access_token = result["access_token"]
            expires_in = result.get("expires_in", 3600)
            self.access_token_expiry = datetime.utcnow() + timedelta(seconds=expires_in)
            if "refresh_token" in result:
                self.set_refresh_token(result["refresh_token"])
            print("Authentication successful", file=sys.stderr)
            return

        error = result.get("error", "unknown")
        desc = result.get("error_description", "")
        raise RuntimeError(f"Device code auth failed: {error} -- {desc}")

    # -- Private: pass store --

    def _load_refresh_token(self):
        # 1. pass (preferred, encrypted)
        try:
            result = subprocess.run(
                ["pass", "show", self.PASS_KEY],
                capture_output=True, text=True, timeout=10
            )
            if result.returncode == 0:
                token = result.stdout.strip()
                if token:
                    return token
        except (subprocess.TimeoutExpired, FileNotFoundError, Exception):
            pass
        # 2. ~/HQ/.env fallback (subprocesses spawned by Claude SDK don't
        # inherit GRAPH_REFRESH_TOKEN from the parent process env).
        env_path = os.path.expanduser("~/HQ/.env")
        try:
            with open(env_path, "r") as f:
                for line in f:
                    line = line.strip()
                    if line.startswith("GRAPH_REFRESH_TOKEN="):
                        val = line.split("=", 1)[1].strip()
                        if (val.startswith('"') and val.endswith('"')) or (val.startswith("'") and val.endswith("'")):
                            val = val[1:-1]
                        if val:
                            return val
        except Exception:
            pass
        return None

    def _write_refresh_token(self, token):
        # Try pass first
        try:
            result = subprocess.run(
                ["pass", "insert", "-e", self.PASS_KEY],
                input=token, capture_output=True, text=True, timeout=10
            )
            if result.returncode == 0:
                return
        except FileNotFoundError:
            pass
        except Exception:
            pass
        # Fall back to rewriting GRAPH_REFRESH_TOKEN in ~/HQ/.env (atomic)
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
            tmp_path = env_path + ".tmp"
            with open(tmp_path, "w") as f:
                f.writelines(lines)
            os.replace(tmp_path, env_path)
        except Exception as e:
            raise RuntimeError(f"Could not persist refresh token (pass unavailable, .env write failed: {e})")

    def _clear_refresh_token(self):
        try:
            subprocess.run(["pass", "rm", "-f", self.PASS_KEY], capture_output=True, timeout=10)
            self.refresh_token = None
        except Exception:
            pass

    def _is_token_valid(self, expiry):
        if not expiry:
            return False
        buffer_time = datetime.utcnow() + timedelta(seconds=self.REFRESH_BUFFER_SECONDS)
        return expiry > buffer_time


if __name__ == "__main__":
    import json as _json

    if "--health" in sys.argv:
        auth = MSGraphAuth()
        print(_json.dumps(auth.check_health(), indent=2))
        sys.exit(0)

    force_device_flow = "--force-device-flow" in sys.argv

    try:
        auth = MSGraphAuth()
        if force_device_flow:
            token = auth.device_code_flow()
        else:
            token = auth.get_access_token()

        print(f"Token acquired ({len(token)} chars, expires {auth.access_token_expiry})")
    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)
