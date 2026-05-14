"""
Configuration loader for the War Room voice server.

Resolves the project root, loads agent voice mappings, and exposes
environment variable helpers.
"""

import json
import os
import subprocess
from pathlib import Path


def get_project_root() -> Path:
    """Resolve the MyOS project root via git or file path fallback."""
    try:
        result = subprocess.run(
            ["git", "rev-parse", "--show-toplevel"],
            capture_output=True, text=True, check=True,
            cwd=Path(__file__).parent,
        )
        return Path(result.stdout.strip())
    except (subprocess.CalledProcessError, FileNotFoundError):
        # Fallback: warroom/ sits one level below project root
        return Path(__file__).resolve().parent.parent


PROJECT_ROOT = get_project_root()
WARROOM_DIR = PROJECT_ROOT / "warroom"
TEMPLATE_VOICES_FILE = WARROOM_DIR / "voices.json"


def _expand_home(value: str) -> Path:
    if value == "~" or value.startswith("~/"):
        return Path.home() / value[2:]
    return Path(value)


def _read_project_env() -> dict[str, str]:
    env_path = PROJECT_ROOT / ".env"
    values: dict[str, str] = {}
    if not env_path.exists():
        return values
    for raw in env_path.read_text().splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.split("#", 1)[0].strip().strip('"').strip("'")
        if key:
            values[key] = value
    return values


_PROJECT_ENV = _read_project_env()
CONFIG_DIR = _expand_home(os.environ.get("MYOS_CONFIG") or _PROJECT_ENV.get("MYOS_CONFIG") or "~/.myos")
VOICES_FILE = _expand_home(
    os.environ.get("WARROOM_VOICES_PATH")
    or _PROJECT_ENV.get("WARROOM_VOICES_PATH")
    or str(CONFIG_DIR / "warroom" / "voices.json")
)


def load_voices() -> dict:
    """Load agent voice configs from voices.json.

    Returns a dict mapping agent_id to {voice_id, gemini_voice, name}.

    The repository file is a generic template. If an external config file is
    present under MYOS_CONFIG, it overlays the template so personal
    ElevenLabs voice IDs never need to be committed.
    """
    configured = {}
    if TEMPLATE_VOICES_FILE.exists():
        with open(TEMPLATE_VOICES_FILE, "r") as f:
            configured.update(json.load(f))
    if VOICES_FILE.exists():
        with open(VOICES_FILE, "r") as f:
            personal = json.load(f)
        for agent_id, entry in personal.items():
            if isinstance(entry, dict):
                configured[agent_id] = {
                    **(configured.get(agent_id) or {}),
                    **entry,
                }
            else:
                configured[agent_id] = entry
    if not configured:
        raise FileNotFoundError(
            f"Voice config not found at {VOICES_FILE} or {TEMPLATE_VOICES_FILE}"
        )
    return configured


# Pre-load at import time so other modules can use it directly
AGENT_VOICES = load_voices()

# Default agent if routing can't determine who should respond
DEFAULT_AGENT = "main"
