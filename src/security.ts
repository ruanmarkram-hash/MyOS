/**
 * Security module for MyOS.
 *
 * Layers:
 * 1. PIN lock + idle auto-lock: session must be unlocked before commands execute
 * 2. Emergency kill switch: a phrase that shuts down the process immediately
 * 3. Audit logging: every action is recorded to SQLite + structured logger
 *
 * All layers are optional and zero-friction when not configured.
 */

import crypto from 'crypto';
import { execSync } from 'child_process';
import os from 'os';

import { logger } from './logger.js';

// ── Configuration (set via initSecurity) ─────────────────────────────

let _pinHash = '';           // salted SHA-256 hash of the PIN
let _pinSalt = '';           // salt prefix extracted from the stored hash
let _idleLockMinutes = 0;   // 0 = disabled
let _killPhrase = '';        // empty = disabled

export function initSecurity(opts: {
  pinHash?: string;
  idleLockMinutes?: number;
  killPhrase?: string;
}): void {
  if (opts.pinHash) {
    // Format: "salt:hash" or legacy bare hash (no salt)
    const parts = opts.pinHash.split(':');
    if (parts.length === 2) {
      _pinSalt = parts[0];
      _pinHash = opts.pinHash; // store full "salt:hash"
    } else {
      // Legacy format (bare hash, no salt). Still works but less secure.
      _pinHash = opts.pinHash;
      _pinSalt = '';
    }
    _locked = true;
    logger.info('Security: PIN lock enabled, bot starts locked');
  }
  _idleLockMinutes = opts.idleLockMinutes ?? 0;
  _killPhrase = opts.killPhrase || '';

  if (_idleLockMinutes > 0 && _pinHash) {
    logger.info({ minutes: _idleLockMinutes }, 'Security: idle auto-lock enabled');
  }
  if (_killPhrase) {
    logger.info('Security: emergency kill phrase configured');
  }
}

/** Whether PIN lock is configured. */
export function isSecurityEnabled(): boolean {
  return !!_pinHash;
}

// ── PIN Lock ─────────────────────────────────────────────────────────

let _locked = false;
let _lastActivity = Date.now();

export function isLocked(): boolean {
  if (!_pinHash) return false;
  // Check idle timeout on every lock query (simpler than setInterval)
  if (!_locked && _idleLockMinutes > 0) {
    const idleMs = Date.now() - _lastActivity;
    if (idleMs >= _idleLockMinutes * 60 * 1000) {
      _locked = true;
      logger.info('Security: session auto-locked (idle timeout)');
    }
  }
  return _locked;
}

export function lock(): void {
  if (!_pinHash) return;
  _locked = true;
  logger.info('Security: session locked');
}

export function unlock(pin: string): boolean {
  if (!_pinHash) return true;
  if (verifyPin(pin, _pinHash)) {
    _locked = false;
    _lastActivity = Date.now();
    logger.info('Security: session unlocked');
    return true;
  }
  logger.warn('Security: incorrect PIN attempt');
  return false;
}

/** Record activity to reset idle timeout. */
export function touchActivity(): void {
  _lastActivity = Date.now();
}

/**
 * Hash a PIN with a random salt. Returns "salt:hash".
 * Used during setup to generate the value stored in .env.
 */
export function hashPin(pin: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.createHash('sha256').update(salt + pin.trim()).digest('hex');
  return `${salt}:${hash}`;
}

/** Verify a PIN against a stored "salt:hash" or legacy bare hash. */
function verifyPin(pin: string, stored: string): boolean {
  const trimmed = pin.trim();
  const parts = stored.split(':');
  if (parts.length === 2) {
    // Salted format
    const hash = crypto.createHash('sha256').update(parts[0] + trimmed).digest('hex');
    return hash === parts[1];
  }
  // Legacy bare hash (no salt)
  const hash = crypto.createHash('sha256').update(trimmed).digest('hex');
  return hash === stored;
}

// ── Emergency Kill ───────────────────────────────────────────────────

/** Check if the message is the emergency kill phrase. */
export function checkKillPhrase(message: string): boolean {
  if (!_killPhrase) return false;
  return message.trim().toLowerCase() === _killPhrase.toLowerCase();
}

/**
 * Execute the emergency shutdown.
 * Stops all MyOS services and force-exits after a brief timeout.
 */
export function executeEmergencyKill(): void {
  logger.warn('EMERGENCY KILL activated');

  // Force exit after 5s even if launchctl/systemctl hangs
  setTimeout(() => process.exit(1), 5000);

  try {
    if (os.platform() === 'darwin') {
      // Stop all MyOS launchd services
      try {
        const output = execSync('launchctl list 2>/dev/null', { encoding: 'utf-8', timeout: 3000 });
        for (const line of output.split('\n')) {
          const cols = line.trim().split(/\s+/);
          const label = cols[cols.length - 1]; // label is the last column
          if (label && (label.startsWith('com.myos.') || label.startsWith('com.claudeclaw.'))) {
            try { execSync(`launchctl stop "${label}"`, { stdio: 'ignore', timeout: 2000 }); } catch { /* ok */ }
          }
        }
      } catch { /* launchctl failed, still exit */ }
    } else if (os.platform() === 'linux') {
      try {
        execSync('systemctl --user stop "com.myos.*" "com.claudeclaw.*" 2>/dev/null', { stdio: 'ignore', timeout: 3000 });
      } catch { /* ok */ }
    }
  } catch { /* don't let anything prevent exit */ }

  process.exit(0);
}

// ── Audit Log ────────────────────────────────────────────────────────

export type AuditAction =
  | 'message'
  | 'command'
  | 'delegation'
  | 'unlock'
  | 'lock'
  | 'kill'
  | 'blocked';

export interface AuditEntry {
  agentId: string;
  chatId: string;
  action: AuditAction;
  detail: string;
  blocked: boolean;
}

let _auditCallback: ((entry: AuditEntry) => void) | null = null;

export function setAuditCallback(cb: (entry: AuditEntry) => void): void {
  _auditCallback = cb;
}

export function audit(entry: AuditEntry): void {
  if (_auditCallback) {
    try { _auditCallback(entry); } catch { /* don't let audit failures block operations */ }
  }
  logger.info({ audit: true, ...entry }, `Audit: ${entry.action}`);
}

// ── Status ───────────────────────────────────────────────────────────

// ── SDK subprocess env scrubbing ─────────────────────────────────────
//
// When we spawn an agent SDK subprocess via `query({ env, ... })`, by
// default the child inherits our entire process.env. That means
// DASHBOARD_TOKEN, DB_ENCRYPTION_KEY, third-party API keys, etc. are
// visible to the model and to whatever tools it runs. A prompt-injected
// agent can read them trivially.
//
// `getScrubbedSdkEnv` returns the env to pass to `query({ env, ... })`:
//   - Drops nested Claude-Code-session state so the child SDK process
//     doesn't try to attach to the parent's IPC socket / use an expired
//     session-scoped token / hit the anti-nesting guard.
//   - Drops every secret-shaped variable the SDK doesn't actually need.
//   - Preserves whichever of CLAUDE_CODE_OAUTH_TOKEN / ANTHROPIC_API_KEY
//     the caller passed (SDK auth requires one of them; without one, the
//     subprocess exits 1).
//
// Ported from upstream security hardening.
// Fork additions: drop CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST and any
// other CLAUDE_CODE_* prefix (except the auth tokens), and drop
// __CFBundleIdentifier — these matched the bespoke scrub the fork
// previously did inline at each call site.

const SDK_DROP_VARS_NESTED_CLAUDE = [
  'CLAUDECODE',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_SSE_PORT',
  'CLAUDE_CODE_IPC_PORT',
  'CLAUDE_CODE_MAX_OUTPUT_TOKENS',
  'CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS',
  'CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST',
  '__CFBundleIdentifier',
] as const;

// Exact secret env names we never want the SDK subprocess to see.
// Belt-and-braces alongside the pattern-based denylist below.
const SDK_DROP_VARS_SECRETS = [
  'DASHBOARD_TOKEN',
  'DB_ENCRYPTION_KEY',
  'DAILY_API_KEY',
  'GROQ_API_KEY',
  'OPENAI_API_KEY',
  'GOOGLE_API_KEY',
  'ELEVENLABS_API_KEY',
  'PIKA_DEV_KEY',
  'TELEGRAM_BOT_TOKEN',
  'SLACK_USER_TOKEN',
  'SLACK_BOT_TOKEN',
  'SLACK_APP_TOKEN',
  'RESEND_API_KEY',
  'GUMROAD_ACCESS_TOKEN',
  'STRIPE_SECRET_KEY',
  'STRIPE_PUBLISHABLE_KEY',
  'CLOUDFLARE_API_TOKEN',
  'GITHUB_TOKEN',
  'NOTION_API_KEY',
  'PIN_HASH',
  'DAILY_DOMAIN',
  'MCP_ACCESS_KEY',
  'PIPELINE_SUPABASE_SERVICE_ROLE_KEY',
] as const;

// Heuristic: any env var whose name matches one of these patterns is a
// likely secret (defense in depth for keys we haven't enumerated).
// Broadened from the original `_API_KEY$` to a full `_KEY$` sweep so
// vars like MCP_ACCESS_KEY / PIPELINE_SUPABASE_SERVICE_ROLE_KEY get
// caught — anything ending in _KEY/_TOKEN/_SECRET/_PASSWORD/_CREDENTIAL
// /_PRIVATE is dropped unless on the tiny allowlist.
//
// Codex re-review 2026-05-04 (HIGH-2 still open): extended to cover
// bare SECRET, *_PRIV, *_PASS (no _WORD/_ATE suffix), bearer tokens
// and JWTs in any position, DSNs (Sentry-style), and DB/queue/cache
// connection strings (DATABASE_URL, REDIS_URL, AMQP_URL, POSTGRES_URL,
// MONGODB_URL, MYSQL_URL — both bare and *_<name> suffixed forms).
const SDK_SECRET_NAME_PATTERNS = [
  /_KEY$/i,
  /_TOKEN$/i,
  /_SECRET$/i,
  /_PASSWORD$/i,
  /_CREDENTIAL$/i,
  /_PRIVATE$/i,
  /^SECRET_/i,
  /^PRIVATE_/i,
  /^SECRET$/i,                 // bare SECRET=...
  /_PRIV$/i,                   // *_PRIV (no _ATE)
  /_PASS$/i,                   // *_PASS (no _WORD)
  /(^|_)(BEARER|JWT)(_|$)/i,   // BEARER / JWT in any position
  /^DSN$/i,                    // bare DSN
  /_DSN$/i,                    // *_DSN (Sentry-style URLs)
  /^(DATABASE|POSTGRES|REDIS|AMQP|MONGODB|MYSQL)_URL$/i,
  /_(DATABASE|POSTGRES|REDIS|AMQP|MONGODB|MYSQL)_URL$/i,
] as const;

// Auth re-injection slots. Keys here can be passed via `authSecrets`
// (typically loaded from .env) and re-added to the scrubbed env after
// the sweep. Both CLAUDE_CODE_OAUTH_TOKEN and ANTHROPIC_API_KEY are
// intentionally re-injection-only — process.env may carry the harness
// session OAuth token or a caller-shadowed ANTHROPIC_API_KEY that we
// never want to silently forward to subprocesses. A caller that wants
// auth in the child must read the value out of .env (or out of
// process.env explicitly) and pass it via `authSecrets`.
//
// Codex round-4 structural fix: the previous SDK_NATURAL_PASS_VARS
// allowlist was the same shape as the HIGH-1 (CLAUDE_CODE_OAUTH_TOKEN)
// and round-4 ANTHROPIC_API_KEY ride-along bugs — an allowlisted var
// quietly survives the scrub from raw process.env without explicit
// caller intent. Removed entirely; callers now explicitly re-inject.
const SDK_AUTH_VARS = ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY'] as const;

// Fork-specific: vars that are safe (or required) to pass through
// despite matching one of the patterns above. Non-secret config only.
const SDK_KEEP_VARS = ['MYOS_AGENT_ID', 'CLAUDECLAW_AGENT_ID'] as const;

/**
 * Return a scrubbed env dict suitable for passing to `query({ env, ... })`
 * or to `spawn(..., { env })` for any subprocess we don't want to see
 * the parent's full secret set.
 *
 * Sweep order (HIGH-1 fix): drop dangerous vars FIRST, then re-inject
 * the caller's explicit auth secrets. Any earlier ordering risked
 * letting a process.env CLAUDE_CODE_OAUTH_TOKEN survive because the
 * allowlist branch short-circuited the prefix sweep.
 *
 * Pass `authSecrets` (loaded via readEnvFile) so secrets stripped from
 * process.env can still be re-injected for the subprocess to authenticate.
 * Extra non-SDK auth (e.g. OPENAI_API_KEY for codex) can be passed too —
 * any string-valued key in `authSecrets` is re-injected verbatim.
 */
export function getScrubbedSdkEnv(
  authSecrets?: Record<string, string | undefined>,
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env };

  // 1. Drop nested-Claude session vars unconditionally.
  for (const k of SDK_DROP_VARS_NESTED_CLAUDE) delete env[k];

  // 2. Drop the explicit secret list (belt-and-braces).
  for (const k of SDK_DROP_VARS_SECRETS) delete env[k];

  // 3. Pattern-based sweep. Walk a snapshot of keys so we can mutate
  //    the dict during iteration. CLAUDE_CODE_* vars get nuked here
  //    too — including any harness-injected CLAUDE_CODE_OAUTH_TOKEN —
  //    because the natural-pass allowlist below does NOT include them.
  for (const key of Object.keys(env)) {
    if ((SDK_KEEP_VARS as readonly string[]).includes(key)) continue;
    if (key.startsWith('CLAUDE_CODE_') || key === 'CLAUDECODE') {
      delete env[key];
      continue;
    }
    // Auth slots are scrubbed unconditionally here; callers must
    // explicitly re-inject via `authSecrets`. See SDK_AUTH_VARS comment.
    if ((SDK_AUTH_VARS as readonly string[]).includes(key)) {
      delete env[key];
      continue;
    }
    if (SDK_SECRET_NAME_PATTERNS.some((re) => re.test(key))) {
      delete env[key];
    }
  }

  // 4. Re-inject caller-supplied auth secrets LAST so they survive the
  //    sweep above. This is the only path by which CLAUDE_CODE_OAUTH_TOKEN
  //    or any other auth value can reach the subprocess.
  if (authSecrets) {
    for (const [k, v] of Object.entries(authSecrets)) {
      if (typeof v === 'string' && v.length > 0) env[k] = v;
    }
  }

  return env;
}

// Re-exported so tests / callers can introspect the auth slot list.
export const SDK_AUTH_VAR_NAMES: readonly string[] = SDK_AUTH_VARS;

/**
 * Shared secret-name heuristic. Returns true if the env var name
 * matches any of the secret-shaped patterns (or is on the explicit
 * SDK_DROP_VARS_SECRETS list).
 *
 * Exported so other env builders (e.g. buildShellTaskEnv) can share
 * the same denylist without duplicating the pattern set. Closes a
 * Codex round-3 finding where a prefix-allowed key like LC_FOO_SECRET
 * could survive the SHELL_TASK_ENV_ALLOW_PREFIXES sweep because no
 * denylist filter ran on prefix-matched keys.
 */
export function isLikelySecretEnvName(key: string): boolean {
  if ((SDK_DROP_VARS_SECRETS as readonly string[]).includes(key)) return true;
  if ((SDK_DROP_VARS_NESTED_CLAUDE as readonly string[]).includes(key)) return true;
  return SDK_SECRET_NAME_PATTERNS.some((re) => re.test(key));
}

// ── Status ───────────────────────────────────────────────────────────

export function getSecurityStatus(): {
  pinEnabled: boolean;
  locked: boolean;
  idleLockMinutes: number;
  killPhraseEnabled: boolean;
  lastActivity: number;
} {
  return {
    pinEnabled: !!_pinHash,
    locked: isLocked(), // also triggers idle check
    idleLockMinutes: _idleLockMinutes,
    killPhraseEnabled: !!_killPhrase,
    lastActivity: _lastActivity,
  };
}
