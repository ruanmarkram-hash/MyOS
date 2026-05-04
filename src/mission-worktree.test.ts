/**
 * mission-worktree tests.
 *
 * These exercise the real filesystem + a real ephemeral git repo. The
 * helper module talks directly to `git worktree add/remove/prune` and
 * those interactions are the meat of the bug class — mocking the FS
 * would let us pass tests with broken git semantics.
 *
 * Each test gets a fresh temp clone with main + origin set up so
 * createMissionWorktree can branch from `origin/main`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

// We need to override PROJECT_ROOT to point at a fresh temp clone for each
// test. The module reads PROJECT_ROOT once at import time, so we vi.mock
// the config module before importing mission-worktree.
let TEST_PROJECT_ROOT = '';

vi.mock('./config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./config.js')>();
  return {
    ...actual,
    get PROJECT_ROOT() {
      return TEST_PROJECT_ROOT;
    },
  };
});

// Import AFTER mock so PROJECT_ROOT resolution sees the mocked getter.
const {
  createMissionWorktree,
  removeMissionWorktree,
  listMissionWorktrees,
  cleanupAllMissionWorktrees,
  MAX_STALE_WORKTREES,
  _activeMissionIdsForTest,
  _clearActiveForTest,
} = await import('./mission-worktree.js');

function makeRepoWithOrigin(): { local: string; origin: string } {
  // Bare origin
  const origin = mkdtempSync(path.join(tmpdir(), 'mwt-origin-'));
  execSync('git init --bare -q', { cwd: origin });

  // Local clone with a seed commit on main so origin/main resolves.
  const local = mkdtempSync(path.join(tmpdir(), 'mwt-local-'));
  execSync('git init -q -b main', { cwd: local });
  execSync('git config user.email test@example.com', { cwd: local });
  execSync('git config user.name Test', { cwd: local });
  execSync(`git remote add origin ${origin}`, { cwd: local });
  writeFileSync(path.join(local, 'README.md'), 'seed\n');
  execSync('git add . && git commit -q -m seed', { cwd: local });
  execSync('git push -q origin main', { cwd: local });
  // Ensure origin/main ref exists locally
  execSync('git fetch -q origin main', { cwd: local });
  return { local, origin };
}

describe('mission-worktree', () => {
  let local: string;
  let origin: string;

  beforeEach(() => {
    const r = makeRepoWithOrigin();
    local = r.local;
    origin = r.origin;
    TEST_PROJECT_ROOT = local;
  });

  afterEach(() => {
    rmSync(local, { recursive: true, force: true });
    rmSync(origin, { recursive: true, force: true });
    TEST_PROJECT_ROOT = '';
  });

  it('creates an isolated worktree on a mission-<id> branch off origin/main', () => {
    const wt = createMissionWorktree('abc123');
    expect(wt.cwd).toBe(path.join(local, '.worktrees', 'mission-abc123'));
    expect(wt.branch).toBe('mission-abc123');
    expect(existsSync(wt.cwd)).toBe(true);

    // The worktree is on its own branch, not on main.
    const branches = execSync('git branch --list', { cwd: local, encoding: 'utf-8' });
    expect(branches).toMatch(/mission-abc123/);

    // The seed commit is present (we branched from origin/main, which has it).
    expect(existsSync(path.join(wt.cwd, 'README.md'))).toBe(true);
  });

  it('does not move the shared HEAD when the mission worktree commits', () => {
    const before = execSync('git rev-parse HEAD', { cwd: local, encoding: 'utf-8' }).trim();
    const wt = createMissionWorktree('mv01');
    writeFileSync(path.join(wt.cwd, 'mission.txt'), 'work');
    execSync('git config user.email test@example.com', { cwd: wt.cwd });
    execSync('git config user.name Test', { cwd: wt.cwd });
    execSync('git add . && git commit -q -m "mission work"', { cwd: wt.cwd });

    const after = execSync('git rev-parse HEAD', { cwd: local, encoding: 'utf-8' }).trim();
    expect(after).toBe(before); // shared HEAD must NOT have moved
  });

  it('removes the worktree dir AND the branch on cleanup', () => {
    const wt = createMissionWorktree('rm01');
    expect(existsSync(wt.cwd)).toBe(true);

    removeMissionWorktree('rm01');

    expect(existsSync(wt.cwd)).toBe(false);
    const branches = execSync('git branch --list', { cwd: local, encoding: 'utf-8' });
    expect(branches).not.toMatch(/mission-rm01/);
  });

  it('listMissionWorktrees enumerates every active mission dir', () => {
    createMissionWorktree('a1');
    createMissionWorktree('b2');
    const all = listMissionWorktrees();
    expect(all.map((w) => w.missionId).sort()).toEqual(['a1', 'b2']);
  });

  it('cleanupAllMissionWorktrees nukes every leftover (recovery sweep, post-crash)', () => {
    createMissionWorktree('s1');
    createMissionWorktree('s2');
    expect(listMissionWorktrees()).toHaveLength(2);

    // Simulate post-crash state: dirs survive on disk but the active
    // in-memory set is empty (fresh process). Clear via test helper.
    _clearActiveForTest();
    expect(_activeMissionIdsForTest()).toEqual([]);

    const cleaned = cleanupAllMissionWorktrees();
    expect(cleaned).toBe(2);
    expect(listMissionWorktrees()).toHaveLength(0);
  });

  it('cleanupAllMissionWorktrees skips worktrees still active in-process (Codex HIGH #4)', () => {
    createMissionWorktree('alive1');
    createMissionWorktree('alive2');
    expect(_activeMissionIdsForTest().sort()).toEqual(['alive1', 'alive2']);
    // Recovery sweep called while these missions are still in flight
    // (e.g. initScheduler called twice in same process). Must NOT nuke
    // them — the running mission subprocess still has cwd inside.
    const cleaned = cleanupAllMissionWorktrees();
    expect(cleaned).toBe(0);
    expect(listMissionWorktrees()).toHaveLength(2);
  });

  it('refuses to create a worktree when the leak guard cap is hit', () => {
    for (let i = 0; i < MAX_STALE_WORKTREES; i++) {
      createMissionWorktree(`leak${i}`);
    }
    expect(() => createMissionWorktree('overflow')).toThrow(/leak guard/i);
  });

  it('rejects unsafe mission ids (path traversal / shell metacharacters)', () => {
    expect(() => createMissionWorktree('../etc/passwd')).toThrow(/unsafe/i);
    expect(() => createMissionWorktree('a;rm -rf /')).toThrow(/unsafe/i);
    expect(() => createMissionWorktree('')).toThrow(/unsafe/i);
  });

  it('idempotent recreate: stale leftover dir gets torn down before recreate', () => {
    const wt = createMissionWorktree('idem');
    writeFileSync(path.join(wt.cwd, 'leftover.txt'), 'stale');
    // Simulate scheduler crash: the dir is still on disk but we want to
    // dispatch the same mission id again.
    const wt2 = createMissionWorktree('idem');
    expect(wt2.cwd).toBe(wt.cwd);
    // Stale leftover wiped
    expect(existsSync(path.join(wt2.cwd, 'leftover.txt'))).toBe(false);
  });

  it('removeMissionWorktree is idempotent (safe to call when nothing exists)', () => {
    expect(() => removeMissionWorktree('nope')).not.toThrow();
  });
});
