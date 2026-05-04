import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getScrubbedSdkEnv } from './security.js';

// Snapshot + restore process.env around each case so we can plant
// arbitrary harness state without polluting the test runner.
const ENV_BACKUP = { ...process.env };

function resetEnv(): void {
  for (const k of Object.keys(process.env)) {
    if (!(k in ENV_BACKUP)) delete process.env[k];
  }
  for (const [k, v] of Object.entries(ENV_BACKUP)) {
    if (v !== undefined) process.env[k] = v;
  }
}

describe('getScrubbedSdkEnv', () => {
  beforeEach(() => {
    resetEnv();
  });
  afterEach(() => {
    resetEnv();
  });

  // HIGH-1 regression: a harness-injected CLAUDE_CODE_OAUTH_TOKEN
  // must not survive the scrub. Previously the natural pass-through
  // allowlist `continue`d before the CLAUDE_CODE_* prefix sweep, so
  // the parent's session token leaked into spawned subprocesses.
  it('drops CLAUDE_CODE_OAUTH_TOKEN from process.env', () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'planted-harness-token';
    const env = getScrubbedSdkEnv();
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
  });

  it('drops both CLAUDE_CODE_OAUTH_TOKEN and ANTHROPIC_API_KEY from raw process.env', () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'planted-harness-token';
    process.env.ANTHROPIC_API_KEY = 'sk-ant-real';
    const env = getScrubbedSdkEnv();
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    // Round-4: ANTHROPIC_API_KEY no longer rides along. Caller must
    // explicitly re-inject via authSecrets if the child needs it.
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it('re-injects CLAUDE_CODE_OAUTH_TOKEN only when caller passes it via authSecrets', () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'planted-harness-token';
    const env = getScrubbedSdkEnv({ CLAUDE_CODE_OAUTH_TOKEN: 'from-dotenv' });
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('from-dotenv');
  });

  // HIGH-2 regression: structural denylist gaps. The previous
  // explicit drop list missed MCP_ACCESS_KEY, *_PASSWORD, *_CREDENTIAL,
  // *_PRIVATE, and any *_KEY that wasn't *_API_KEY. The pattern sweep
  // must catch every secret-shaped name.
  it('drops MCP_ACCESS_KEY (was not in the explicit list)', () => {
    process.env.MCP_ACCESS_KEY = 'mcp-secret';
    const env = getScrubbedSdkEnv();
    expect(env.MCP_ACCESS_KEY).toBeUndefined();
  });

  it('drops PIPELINE_SUPABASE_SERVICE_ROLE_KEY', () => {
    process.env.PIPELINE_SUPABASE_SERVICE_ROLE_KEY = 'service-role';
    const env = getScrubbedSdkEnv();
    expect(env.PIPELINE_SUPABASE_SERVICE_ROLE_KEY).toBeUndefined();
  });

  it('drops generic *_KEY vars not previously enumerated', () => {
    process.env.SOMETHING_PRIVATE_KEY = 'pk';
    process.env.WIDGET_PASSWORD = 'pw';
    process.env.VENDOR_CREDENTIAL = 'creds';
    process.env.RANDOM_PRIVATE = 'priv';
    process.env.SECRET_FOO = 'foo';
    const env = getScrubbedSdkEnv();
    expect(env.SOMETHING_PRIVATE_KEY).toBeUndefined();
    expect(env.WIDGET_PASSWORD).toBeUndefined();
    expect(env.VENDOR_CREDENTIAL).toBeUndefined();
    expect(env.RANDOM_PRIVATE).toBeUndefined();
    expect(env.SECRET_FOO).toBeUndefined();
  });

  // Round-4 structural fix: SDK_NATURAL_PASS_VARS is gone. A bare
  // process.env.ANTHROPIC_API_KEY must NOT survive the scrub — callers
  // who want it in the child must explicitly re-inject via authSecrets.
  // This forces a clear failure (auth fails) instead of a silent ride-
  // along, matching the HIGH-1 (CLAUDE_CODE_OAUTH_TOKEN) fix shape.
  it('drops ANTHROPIC_API_KEY from process.env (no natural pass-through)', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-from-shell';
    const env = getScrubbedSdkEnv();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it('re-injects ANTHROPIC_API_KEY only when caller passes it via authSecrets', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-from-shell';
    const env = getScrubbedSdkEnv({ ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY });
    expect(env.ANTHROPIC_API_KEY).toBe('sk-ant-from-shell');
  });

  it('keeps CLAUDECLAW_AGENT_ID despite secret-shaped neighbours', () => {
    process.env.CLAUDECLAW_AGENT_ID = 'mason';
    const env = getScrubbedSdkEnv();
    expect(env.CLAUDECLAW_AGENT_ID).toBe('mason');
  });

  it('drops CLAUDE_CODE_* prefix vars (session state) other than auth slots', () => {
    process.env.CLAUDE_CODE_ENTRYPOINT = 'cli';
    process.env.CLAUDE_CODE_SSE_PORT = '12345';
    process.env.CLAUDECODE = '1';
    const env = getScrubbedSdkEnv();
    expect(env.CLAUDE_CODE_ENTRYPOINT).toBeUndefined();
    expect(env.CLAUDE_CODE_SSE_PORT).toBeUndefined();
    expect(env.CLAUDECODE).toBeUndefined();
  });

  it('re-injects extra non-Anthropic auth secrets (e.g. OPENAI_API_KEY for codex)', () => {
    process.env.OPENAI_API_KEY = 'leaked-from-process-env';
    const env = getScrubbedSdkEnv({ OPENAI_API_KEY: 'sk-from-dotenv' });
    // process.env value got swept by the explicit drop list, but
    // the .env-supplied value survives via re-injection.
    expect(env.OPENAI_API_KEY).toBe('sk-from-dotenv');
  });

  // Codex round-4 spawn-site shape regression. Mirrors the auth shapes
  // used by meet-cli runPikaScript / cmdJoinDaily, dashboard meet spawn,
  // and index.ts warroom spawn. Ensures the scrubbed env returned for a
  // spawn site contains ONLY the explicitly-injected keys (plus
  // CLAUDECLAW_AGENT_ID and non-secret PATH-style vars), never raw
  // process.env secrets.
  it('spawn-site shape: only explicit-injected auth survives next to PATH', () => {
    process.env.DASHBOARD_TOKEN = 'leaked';
    process.env.MCP_ACCESS_KEY = 'leaked';
    process.env.OPENAI_API_KEY = 'leaked-from-shell';
    process.env.PIKA_DEV_KEY = 'leaked-from-shell';
    process.env.DAILY_API_KEY = 'leaked-from-shell';
    process.env.GOOGLE_API_KEY = 'leaked-from-shell';
    process.env.ANTHROPIC_API_KEY = 'leaked-from-shell';
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'leaked-from-shell';
    process.env.PATH = '/usr/bin:/bin';
    process.env.CLAUDECLAW_AGENT_ID = 'mason';

    // Caller passes only the keys it explicitly intends to forward.
    const env = getScrubbedSdkEnv({
      PIKA_DEV_KEY: 'from-dotenv',
      DAILY_API_KEY: 'from-dotenv',
    });

    // Explicit re-injection survives.
    expect(env.PIKA_DEV_KEY).toBe('from-dotenv');
    expect(env.DAILY_API_KEY).toBe('from-dotenv');
    // Non-secret keep-list survives.
    expect(env.PATH).toBe('/usr/bin:/bin');
    expect(env.CLAUDECLAW_AGENT_ID).toBe('mason');
    // Everything else from process.env is gone.
    expect(env.DASHBOARD_TOKEN).toBeUndefined();
    expect(env.MCP_ACCESS_KEY).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.GOOGLE_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
  });

  it('does not inject empty-string auth secrets', () => {
    const env = getScrubbedSdkEnv({ ANTHROPIC_API_KEY: '' });
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  // Codex re-review 2026-05-04 (HIGH-2 still open): denylist gaps.
  describe('HIGH-2 denylist gaps (codex re-review 2026-05-04)', () => {
    it('drops bare SECRET=...', () => {
      process.env.SECRET = 'bare-secret';
      const env = getScrubbedSdkEnv();
      expect(env.SECRET).toBeUndefined();
    });

    it('drops *_PRIV (no _ATE suffix)', () => {
      process.env.SIGNING_PRIV = 'priv';
      process.env.foo_priv = 'priv2';
      const env = getScrubbedSdkEnv();
      expect(env.SIGNING_PRIV).toBeUndefined();
      expect(env.foo_priv).toBeUndefined();
    });

    it('drops *_PASS (no _WORD suffix)', () => {
      process.env.DB_PASS = 'pw';
      process.env.SMTP_PASS = 'pw2';
      const env = getScrubbedSdkEnv();
      expect(env.DB_PASS).toBeUndefined();
      expect(env.SMTP_PASS).toBeUndefined();
    });

    it('drops BEARER / JWT in any position', () => {
      process.env.BEARER = 't';
      process.env.MY_BEARER_TOKEN = 't';
      process.env.SOME_BEARER = 't';
      process.env.JWT = 'j';
      process.env.MY_JWT = 'j';
      process.env.JWT_PUBLIC = 'j';
      const env = getScrubbedSdkEnv();
      expect(env.BEARER).toBeUndefined();
      expect(env.MY_BEARER_TOKEN).toBeUndefined();
      expect(env.SOME_BEARER).toBeUndefined();
      expect(env.JWT).toBeUndefined();
      expect(env.MY_JWT).toBeUndefined();
      expect(env.JWT_PUBLIC).toBeUndefined();
    });

    it('drops DATABASE_URL and *_DATABASE_URL', () => {
      process.env.DATABASE_URL = 'postgres://...';
      process.env.OB1_DATABASE_URL = 'postgres://...';
      const env = getScrubbedSdkEnv();
      expect(env.DATABASE_URL).toBeUndefined();
      expect(env.OB1_DATABASE_URL).toBeUndefined();
    });

    it('drops DSN and *_DSN (Sentry-style)', () => {
      process.env.DSN = 'https://a@b/1';
      process.env.SENTRY_DSN = 'https://a@b/1';
      const env = getScrubbedSdkEnv();
      expect(env.DSN).toBeUndefined();
      expect(env.SENTRY_DSN).toBeUndefined();
    });

    it('drops common DB / queue / cache connection-string URLs', () => {
      process.env.POSTGRES_URL = 'postgres://...';
      process.env.REDIS_URL = 'redis://...';
      process.env.AMQP_URL = 'amqp://...';
      process.env.MONGODB_URL = 'mongodb://...';
      process.env.MYSQL_URL = 'mysql://...';
      process.env.SHARD_REDIS_URL = 'redis://...';
      const env = getScrubbedSdkEnv();
      expect(env.POSTGRES_URL).toBeUndefined();
      expect(env.REDIS_URL).toBeUndefined();
      expect(env.AMQP_URL).toBeUndefined();
      expect(env.MONGODB_URL).toBeUndefined();
      expect(env.MYSQL_URL).toBeUndefined();
      expect(env.SHARD_REDIS_URL).toBeUndefined();
    });

    it('keeps CLAUDECLAW_AGENT_ID; ANTHROPIC_API_KEY only via re-injection', () => {
      process.env.ANTHROPIC_API_KEY = 'sk-ant';
      process.env.CLAUDECLAW_AGENT_ID = 'mason';
      // Plant a few new-pattern secrets alongside.
      process.env.SECRET = 'x';
      process.env.DATABASE_URL = 'postgres://...';
      const env = getScrubbedSdkEnv({ ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY });
      expect(env.ANTHROPIC_API_KEY).toBe('sk-ant');
      expect(env.CLAUDECLAW_AGENT_ID).toBe('mason');
      expect(env.SECRET).toBeUndefined();
      expect(env.DATABASE_URL).toBeUndefined();
    });
  });
});
