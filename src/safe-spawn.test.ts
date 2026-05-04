import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildEnv, safeSpawnSync } from './safe-spawn.js';

const ENV_BACKUP = { ...process.env };

function resetEnv(): void {
  for (const k of Object.keys(process.env)) {
    if (!(k in ENV_BACKUP)) delete process.env[k];
  }
  for (const [k, v] of Object.entries(ENV_BACKUP)) {
    if (v !== undefined) process.env[k] = v;
  }
}

describe('buildEnv (safe-spawn)', () => {
  beforeEach(resetEnv);
  afterEach(resetEnv);

  // ── envClass: 'sdk' ────────────────────────────────────────────────
  describe("envClass: 'sdk'", () => {
    it('returns a scrubbed env with parent secrets dropped', () => {
      process.env.CLAUDE_CODE_OAUTH_TOKEN = 'planted';
      process.env.ANTHROPIC_API_KEY = 'sk-ant-x';
      process.env.SOME_API_KEY = 'leak-me';
      const env = buildEnv('sdk');
      expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
      expect(env.ANTHROPIC_API_KEY).toBeUndefined();
      expect(env.SOME_API_KEY).toBeUndefined();
    });

    it('treats extraEnv as the authSecrets re-injection slot', () => {
      const env = buildEnv('sdk', { CLAUDE_CODE_OAUTH_TOKEN: 'from-dotenv' });
      expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('from-dotenv');
    });

    it('does NOT throw when extraEnv contains secret-shaped keys (auth slot)', () => {
      expect(() =>
        buildEnv('sdk', { OPENAI_API_KEY: 'sk-x', ANTHROPIC_API_KEY: 'sk-y' }),
      ).not.toThrow();
    });
  });

  // ── envClass: 'shell-task' ─────────────────────────────────────────
  describe("envClass: 'shell-task'", () => {
    it('returns the shell-task allowlisted env (PATH, HOME, etc.)', () => {
      process.env.PATH = '/usr/bin:/bin';
      process.env.HOME = '/Users/test';
      process.env.SOME_API_KEY = 'leak';
      const env = buildEnv('shell-task');
      expect(env.PATH).toBe('/usr/bin:/bin');
      expect(env.HOME).toBe('/Users/test');
      expect(env.SOME_API_KEY).toBeUndefined();
      // Generic process.env vars not on the allowlist must be absent.
      expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    });

    it('merges non-secret extraEnv on top', () => {
      const env = buildEnv('shell-task', { MY_FLAG: 'on' });
      expect(env.MY_FLAG).toBe('on');
    });

    it('throws when extraEnv contains a secret-shaped key without allow', () => {
      expect(() => buildEnv('shell-task', { GITHUB_TOKEN: 'ghp_x' })).toThrow(
        /secret-shaped/,
      );
    });

    it('allows a secret-shaped key when listed in allowSecretNames', () => {
      const env = buildEnv(
        'shell-task',
        { GITHUB_TOKEN: 'ghp_x' },
        ['GITHUB_TOKEN'],
      );
      expect(env.GITHUB_TOKEN).toBe('ghp_x');
    });
  });

  // ── envClass: 'system-tool' ────────────────────────────────────────
  describe("envClass: 'system-tool'", () => {
    it('returns only PATH from process.env', () => {
      process.env.PATH = '/usr/bin:/bin';
      process.env.HOME = '/Users/test';
      process.env.ANTHROPIC_API_KEY = 'sk-x';
      const env = buildEnv('system-tool');
      expect(env.PATH).toBe('/usr/bin:/bin');
      expect(env.HOME).toBeUndefined();
      expect(env.ANTHROPIC_API_KEY).toBeUndefined();
      // Single-key env: ensure no surprise extras.
      expect(Object.keys(env)).toEqual(['PATH']);
    });

    it('merges non-secret extraEnv', () => {
      const env = buildEnv('system-tool', { LANG: 'en_US.UTF-8' });
      expect(env.LANG).toBe('en_US.UTF-8');
    });

    it('throws on secret-shaped extraEnv without allow', () => {
      expect(() => buildEnv('system-tool', { AWS_SECRET_ACCESS_KEY: 'x' })).toThrow(
        /secret-shaped/,
      );
    });
  });

  // ── End-to-end: safeSpawnSync with system-tool runs cleanly ─────────
  describe('safeSpawnSync end-to-end', () => {
    it('runs /bin/sh -c "env" with system-tool and emits PATH but no secrets', () => {
      process.env.ANTHROPIC_API_KEY = 'sk-must-not-leak';
      const r = safeSpawnSync('/bin/sh', ['-c', 'env'], {
        envClass: 'system-tool',
      });
      expect(r.status).toBe(0);
      const out = r.stdout.toString();
      expect(out).toMatch(/^PATH=/m);
      expect(out).not.toMatch(/ANTHROPIC_API_KEY/);
    });
  });
});
