import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * Regression coverage for the marker-adjacency tightening (MEDIUM 2,
 * Codex 2026-05-04): a SAFE-SPAWN-EXEMPT marker hanging off the END of
 * a code line must NOT cover a raw spawn on the next line.
 *
 * Strategy: write a temp .ts file under src/ that exercises each shape,
 * run the actual guard script as a subprocess, then assert on its
 * exit code + output. We add the file under `src/__guard_fixtures__/`
 * so it is picked up by the recursive walk but lives in an obvious
 * sandbox dir.
 */
const ROOT = resolve(new URL('..', import.meta.url).pathname);
const SCRIPT = join(ROOT, 'scripts', 'check-no-raw-spawn.mjs');
const FIXTURE_DIR = join(ROOT, 'src', '__guard_fixtures__');

function runGuard(): { code: number; stderr: string } {
  const r = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' });
  return { code: r.status ?? -1, stderr: (r.stderr || '') + (r.stdout || '') };
}

let activeFixture: string | null = null;
function writeFixture(name: string, src: string): string {
  mkdirSync(FIXTURE_DIR, { recursive: true });
  const p = join(FIXTURE_DIR, name);
  writeFileSync(p, src, 'utf8');
  activeFixture = p;
  return p;
}

afterEach(() => {
  if (activeFixture) {
    try { unlinkSync(activeFixture); } catch { /* fine */ }
    activeFixture = null;
  }
});

describe('check-no-raw-spawn marker adjacency', () => {
  it('FLAGS a raw spawn when the marker is on a code line above', () => {
    // Adversarial pattern: the marker is dangling off the import line,
    // and the next line has a raw spawn(). The old guard treated this
    // as exempt; the tightened guard must flag it.
    writeFixture('marker_on_import_line.ts', [
      `import { spawn } from 'child_process'; // SAFE-SPAWN-EXEMPT: dangling`,
      `spawn('env');`,
      ``,
    ].join('\n'));
    const { code, stderr } = runGuard();
    expect(code).toBe(1);
    expect(stderr).toContain('marker_on_import_line.ts');
  });

  it('STILL exempts a raw spawn when the marker is on a comment-only line above', () => {
    writeFixture('marker_on_comment_line.ts', [
      `// SAFE-SPAWN-EXEMPT: legitimate justification`,
      `import { spawn } from 'child_process';`,
      `// SAFE-SPAWN-EXEMPT: legitimate justification`,
      `spawn('env');`,
      ``,
    ].join('\n'));
    const { code } = runGuard();
    expect(code).toBe(0);
  });

  it('STILL exempts when the marker is on the SAME line as the offending call', () => {
    writeFixture('marker_same_line.ts', [
      `// SAFE-SPAWN-EXEMPT: cover the import`,
      `import { spawn } from 'child_process';`,
      `spawn('env'); // SAFE-SPAWN-EXEMPT: same-line justification`,
      ``,
    ].join('\n'));
    const { code } = runGuard();
    expect(code).toBe(0);
  });
});
