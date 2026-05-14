import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * HIGH 2 regression: notify.sh must exit NON-ZERO when Telegram returns
 * anything other than HTTP 200 + ok:true. The previous version used
 * `curl -s ... > /dev/null` which exited 0 on HTTP 4xx/5xx, so the
 * caller (mission-notify.ts) thought delivery had succeeded when in
 * reality the message was rejected (bad token, bad chat_id, malformed
 * HTML, rate limit).
 *
 * We exercise this end-to-end: write a fake .env to a temp project
 * root with an obviously bogus bot token (ensures Telegram returns
 * 401 Unauthorized + ok:false) and run notify.sh with that .env. Test
 * is skipped if there is no network so CI without egress doesn't fail.
 */
const ROOT = resolve(new URL('..', import.meta.url).pathname);
const SCRIPT = join(ROOT, 'scripts', 'notify.sh');

let tmp: string | null = null;
afterEach(() => {
  if (tmp) {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* fine */ }
    tmp = null;
  }
});

function isOnline(): boolean {
  // Quick probe; the actual test takes ~1s if online and ~5s if offline.
  const r = spawnSync('curl', ['-s', '-o', '/dev/null', '-w', '%{http_code}', '-m', '3', 'https://api.telegram.org'], { encoding: 'utf8' });
  return r.status === 0 && /^[2345]\d\d$/.test(r.stdout.trim());
}

describe('notify.sh durability', () => {
  it('exits non-zero when Telegram rejects the request', () => {
    if (!isOnline()) {
      // No network; the script will still exit non-zero (curl error)
      // which is also acceptable behavior for our caller. We assert
      // non-zero either way.
    }
    // Build a fake project root so notify.sh resolves a bogus token.
    tmp = mkdtempSync(join(tmpdir(), 'notify-sh-'));
    const scriptsDir = join(tmp, 'scripts');
    mkdirSync(scriptsDir, { recursive: true });
    copyFileSync(SCRIPT, join(scriptsDir, 'notify.sh'));
    chmodSync(join(scriptsDir, 'notify.sh'), 0o755);
    writeFileSync(join(tmp, '.env'), 'TELEGRAM_BOT_TOKEN=000:DEFINITELY_INVALID\nALLOWED_CHAT_ID=1\n');
    const r = spawnSync('bash', [join(scriptsDir, 'notify.sh'), 'hi', '1'], { encoding: 'utf8' });
    expect(r.status).not.toBe(0);
    // Confirm we surfaced an error message (telegram-side or curl-side).
    expect((r.stderr || '').length).toBeGreaterThan(0);
  }, 15_000);

  it('exits non-zero when .env is missing', () => {
    tmp = mkdtempSync(join(tmpdir(), 'notify-sh-'));
    const scriptsDir = join(tmp, 'scripts');
    mkdirSync(scriptsDir, { recursive: true });
    copyFileSync(SCRIPT, join(scriptsDir, 'notify.sh'));
    chmodSync(join(scriptsDir, 'notify.sh'), 0o755);
    // No .env written.
    const r = spawnSync('bash', [join(scriptsDir, 'notify.sh'), 'hi', '1'], { encoding: 'utf8' });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('.env');
  });
});
