#!/usr/bin/env python3
"""
heartbeat.py — Quick-cycle agent + memory-extraction health check.

Replaces the LLM-driven dabacfee task with a deterministic check so the
scheduler shell-bypass fast path can run it directly.

Two responsibilities:

  1) Agent presence + health: every label in EXPECTED_AGENTS must be loaded
     by launchctl AND have last-exit 0. Missing labels OR non-zero exits
     flag CRITICAL. (A persistent service that has unloaded entirely
     produces a missing-label finding — exactly the case the previous
     version silently passed.)

  2) Memory-extraction freshness: warn ONLY if BOTH
        a) > 360 minutes since last OB1 thought (mcp/claude_code/hq-local-bge source) AND
        b) > 5 real user turns in conversation_log in that same window
            (excludes "[Scheduled task]:%" traffic).
     User-idle stays silent; only real outages trip the warning.
     If the OB1 probe itself fails (psql missing, auth, timeout, malformed
     env), surface a WARNING — silence on probe failure was a known
     false-green path in the v1 script.

Output contract (silent-mode safe):
  - stdout = "OK"        → all green; scheduler stays silent
  - stdout = "CRITICAL: ..." or "WARNING: ..."  → telegram surfaces it
  - non-zero exit on hard structural failure (unable to read launchctl etc)
"""
from __future__ import annotations

import os
import sqlite3
import subprocess
import sys
import time
from dataclasses import dataclass

ENV_FILE = os.path.expanduser("~/HQ/.env")
SQLITE_DB = os.path.expanduser("~/HQ/store/myos.db")
PSQL = "/opt/homebrew/opt/libpq/bin/psql"

EXTRACTION_STALE_MIN = 360
REAL_TURN_THRESHOLD = 5

# MyOS services split by lifecycle. Both groups MUST be loaded; the
# difference is how we interpret pid="-" / last_exit="-" between runs.
#
# PERSISTENT: KeepAlive=true, RunAtLoad=true. Should be running continuously.
# pid="-" AND last_exit="-" = never started = CRITICAL.
#
# SCHEDULED: RunAtLoad=false + StartInterval or StartCalendarInterval. May
# legitimately show "-/-" between runs (e.g. immediately after reboot, or
# after a successful exit while waiting for next trigger). Only flag when
# last_exit is a non-zero numeric value — that's a real crash.
PERSISTENT_AGENTS = (
    "com.myos.main",
    "com.myos.warden",
    "com.myos.charter",
    "com.myos.ember",
    "com.myos.marlow",
    "com.myos.mason",
)
SCHEDULED_AGENTS = (
    "com.myos.brain-watcher",     # StartInterval 600s
    "com.myos.brain-monitor",     # StartInterval 21600s
    "com.myos.entity-worker",     # StartInterval 180s
    "com.myos.brain-backup",      # StartCalendarInterval
    "com.myos.brain-drift",       # StartCalendarInterval
)
EXPECTED_AGENTS = PERSISTENT_AGENTS + SCHEDULED_AGENTS


# ---- helpers ---------------------------------------------------------------

def _load_env() -> dict[str, str]:
    """Read .env values without sourcing the shell. Robust to common edge cases.

    Handles: surrounding single/double quotes, trailing comments after a
    quoted value, BOM at start of file, blank lines, # comment lines.
    Skips: keys that look multi-line (heredoc-style) — we only consume the
    first KEY=VALUE line and ignore continuation lines, which would never be
    a single-line scalar like OB1_SUPABASE_DB_URL.
    """
    env: dict[str, str] = {}
    if not os.path.exists(ENV_FILE):
        return env
    with open(ENV_FILE, "rb") as f:
        raw = f.read()
    if raw.startswith(b"\xef\xbb\xbf"):
        raw = raw[3:]  # strip UTF-8 BOM
    text = raw.decode("utf-8", errors="replace")
    for line in text.splitlines():
        s = line.strip()
        if not s or s.startswith("#") or "=" not in s:
            continue
        k, _, v = s.partition("=")
        k = k.strip()
        v = v.strip()
        # Strip matched surrounding quotes; keep inner content as-is.
        if len(v) >= 2 and ((v[0] == v[-1] == '"') or (v[0] == v[-1] == "'")):
            v = v[1:-1]
        env[k] = v
    return env


@dataclass
class LaunchctlReport:
    failures: list[str]    # crash-looping or non-zero exit labels
    missing: list[str]     # expected labels not present at all
    parse_error: str | None = None


def _process_uptime_seconds(pid: str) -> float:
    """Return how long PID has been alive in seconds. -1 if unknown / not running.

    Uses `ps -o etime=`. macOS doesn't ship `etimes` (the GNU extension that
    returns raw seconds), so we parse the `[[dd-]hh:]mm:ss` format directly.
    Returns -1 on any error so callers treat it as "young / can't suppress",
    which is the safe default — false negatives (flag a real crash) beat
    false positives (suppress a real crash loop).
    """
    if not pid or pid == "-":
        return -1.0
    try:
        out = subprocess.check_output(
            ["ps", "-o", "etime=", "-p", pid],
            text=True,
            stderr=subprocess.DEVNULL,
            timeout=5,
        ).strip()
        if not out:
            return -1.0
        # Format variants:
        #   "MM:SS"
        #   "HH:MM:SS"
        #   "DD-HH:MM:SS"
        days = 0
        if "-" in out:
            day_part, _, out = out.partition("-")
            days = int(day_part)
        parts = [int(p) for p in out.split(":")]
        if len(parts) == 2:
            hours, minutes, seconds = 0, parts[0], parts[1]
        elif len(parts) == 3:
            hours, minutes, seconds = parts[0], parts[1], parts[2]
        else:
            return -1.0
        return float(days * 86400 + hours * 3600 + minutes * 60 + seconds)
    except Exception:
        return -1.0


def _check_launchctl() -> LaunchctlReport:
    try:
        out = subprocess.check_output(
            ["launchctl", "list"],
            text=True,
            stderr=subprocess.DEVNULL,
            timeout=15,
        )
    except subprocess.TimeoutExpired:
        return LaunchctlReport([], [], parse_error="launchctl timed out")
    except Exception as exc:
        return LaunchctlReport([], [], parse_error=f"launchctl failed: {exc}")

    seen: dict[str, tuple[str, str]] = {}  # label -> (pid, last_exit)
    for line in out.splitlines():
        if "com.myos" not in line:
            continue
        # `launchctl list` columns are tab/space separated; first three are
        # PID, LastExitStatus, Label. Labels never contain whitespace today,
        # but split on the first two whitespace runs to stay robust.
        parts = line.split(None, 2)
        if len(parts) < 3:
            continue
        pid, last_exit, label = parts[0], parts[1], parts[2].strip()
        # `launchctl list` can produce trailing junk (e.g. inherited args)
        # only on user-launched daemons; .partition(' ') guards that.
        label = label.split()[0]
        seen[label] = (pid, last_exit)

    failures: list[str] = []
    missing: list[str] = []
    persistent_set = set(PERSISTENT_AGENTS)
    for expected in EXPECTED_AGENTS:
        if expected not in seen:
            missing.append(expected)
            continue
        pid, last_exit = seen[expected]
        # Non-zero numeric last_exit = potentially a real crash (both groups).
        # "-" means never recorded.
        #
        # Caveat: launchctl's `last exit` is the exit code of the PRIOR run.
        # `safe-launchctl kickstart -k` (the standard agent restart procedure)
        # SIGKILLs the old instance before launchd spawns a new one, leaving
        # last_exit=-9 sticky in launchctl's memory for the lifetime of the
        # new healthy process. Without an uptime check, this caused a
        # 9-hour stream of false-positive CRITICAL crash-loop alerts every
        # 30 minutes after every restart (witnessed 2026-05-04 night).
        #
        # Real crash loop signature: pid keeps churning, current pid is
        # young, last_exit non-zero. Sticky-from-restart signature: pid is
        # alive AND has been up for many minutes. Use a 5-minute floor.
        if last_exit not in ("0", "-"):
            if pid == "-" or _process_uptime_seconds(pid) < 300:
                failures.append(f"{expected}(exit={last_exit})")
                continue
            # Old exit, current pid healthy and stable — suppress.
        # PID handling diverges by lifecycle:
        #   PERSISTENT (KeepAlive=true): pid must be a real PID. pid="-"
        #     means the service is not currently running — for a KeepAlive
        #     daemon that's a CRITICAL even with last_exit=0 (KeepAlive
        #     throttle, plist disabled, or unloaded mid-flight).
        #   SCHEDULED: pid="-" between runs is normal; only raise on
        #     non-zero last_exit (already handled above).
        if expected in persistent_set and pid == "-":
            reason = "never-run" if last_exit == "-" else f"not-running(last_exit={last_exit})"
            failures.append(f"{expected}({reason})")
    return LaunchctlReport(failures=failures, missing=missing)


@dataclass
class ProbeResult:
    minutes: int | None
    error: str | None  # None on success; populated on probe failure


def _minutes_since_last_thought(db_url: str) -> ProbeResult:
    """Probe OB1. Distinguishes 'no data' (None, no error) from 'probe broke'."""
    if not db_url:
        return ProbeResult(None, "OB1_SUPABASE_DB_URL missing from env")
    if not os.path.exists(PSQL):
        return ProbeResult(None, f"psql not found at {PSQL}")
    sql = (
        "SELECT EXTRACT(epoch FROM (now() - max(created_at)))::int / 60 "
        "FROM thoughts WHERE metadata->>'source' IN ('mcp','claude_code','hq-local-bge');"
    )
    try:
        proc = subprocess.run(
            [PSQL, db_url, "-t", "-A", "-c", sql],
            capture_output=True,
            text=True,
            timeout=20,
        )
    except subprocess.TimeoutExpired:
        return ProbeResult(None, "psql probe timed out (20s)")
    except Exception as exc:
        return ProbeResult(None, f"psql probe spawn failed: {exc}")
    if proc.returncode != 0:
        err = (proc.stderr or "").strip().splitlines()[-1:] or ["unknown"]
        return ProbeResult(None, f"psql probe rc={proc.returncode}: {err[0]}")
    out = (proc.stdout or "").strip()
    if not out:
        # No rows yet — distinguish from probe failure: this is data-empty.
        return ProbeResult(None, None)
    try:
        return ProbeResult(int(out), None)
    except ValueError:
        return ProbeResult(None, f"psql probe non-int output: {out[:60]!r}")


def _real_user_turns_in_window(minutes: int) -> int:
    if minutes <= 0 or not os.path.exists(SQLITE_DB):
        return 0
    cutoff = int(time.time()) - minutes * 60
    db = sqlite3.connect(SQLITE_DB)
    try:
        row = db.execute(
            "SELECT COUNT(*) FROM conversation_log "
            "WHERE role='user' "
            "AND content NOT LIKE '[Scheduled task]:%' "
            "AND created_at > ?",
            (cutoff,),
        ).fetchone()
        return int(row[0]) if row else 0
    finally:
        db.close()


# ---- main ------------------------------------------------------------------

def main() -> int:
    report = _check_launchctl()
    if report.parse_error:
        print(f"CRITICAL: {report.parse_error}")
        return 0
    if report.missing:
        print(f"CRITICAL: agents not loaded: {', '.join(report.missing)}")
        return 0
    if report.failures:
        print(f"CRITICAL: agents crash-looping: {', '.join(report.failures)}")
        return 0

    # OB1 freshness probe. Distinguish probe failure from true freshness.
    env = _load_env()
    probe = _minutes_since_last_thought(env.get("OB1_SUPABASE_DB_URL", ""))
    if probe.error:
        print(f"WARNING: OB1 freshness probe failed: {probe.error}")
        return 0
    if probe.minutes is not None and probe.minutes > EXTRACTION_STALE_MIN:
        turns = _real_user_turns_in_window(probe.minutes)
        if turns > REAL_TURN_THRESHOLD:
            print(
                f"WARNING: memory-extraction stalled "
                f"({probe.minutes} mins since last OB1 capture, "
                f"{turns} real user turns in that window)"
            )
            return 0
        # User idle — silent.

    print("OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
