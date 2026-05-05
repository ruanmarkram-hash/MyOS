/**
 * mission-worktree — per-mission git worktree isolation.
 *
 * THE PROBLEM (2026-05-04 — discovered overnight):
 * Every Mason mission used to run in /Users/sc/HQ as cwd. When a mission did
 * `git checkout feature-branch`, every other agent (sage, warden, charter,
 * ember, marlow) saw the new HEAD because they all share the same working
 * tree. That caused:
 *   - cross-agent outbox delivery via wrong bot (d7e5ba7)
 *   - 4 spurious stale-code alerts (e006d34)
 *   - sage's runtime drifting onto a recovery branch mid-conversation
 *   - dist/.build-meta.json clobber loops
 *
 * THE FIX (this module):
 * Each mission gets its own isolated git worktree at
 * /Users/sc/HQ/.worktrees/mission-<id>/, cut off the latest origin/main,
 * on a dedicated branch `mission-<id>`. The Mason runtime process keeps its
 * cwd at /Users/sc/HQ; only the mission's Claude Code subprocess sees the
 * worktree path. The shared HEAD never moves while a mission runs.
 *
 * Cleanup: removed (force) when the mission terminates (any status). A
 * recovery sweep on scheduler init nukes any stragglers from a previous
 * crash. A leak guard refuses new missions if >5 stale dirs accumulate.
 *
 * Operating principle #4: this is the central helper. Every caller routes
 * through {create,remove,list}MissionWorktree so the bug class can't
 * re-emerge from a different code path.
 */

import { existsSync, mkdirSync, rmSync, readdirSync, copyFileSync, chmodSync } from 'node:fs';
import path from 'node:path';

import { PROJECT_ROOT } from './config.js';
import { logger } from './logger.js';
import { safeSpawnSync } from './safe-spawn.js';

/**
 * Where worktrees live. Inside .worktrees/ at the repo root so .gitignore
 * can ignore them in one line and a recovery sweep finds them quickly.
 *
 * Computed lazily because PROJECT_ROOT is a live binding that some test
 * harnesses override via module mocks AFTER this module is imported. A
 * top-level const would freeze the wrong value.
 */
export function worktreesDir(): string {
  return path.join(PROJECT_ROOT, '.worktrees');
}

/**
 * Branch + dir prefix. Keep these in sync — listMissionWorktrees() relies
 * on the dir prefix; cleanupMissionBranch() relies on the branch prefix.
 */
const WORKTREE_DIR_PREFIX = 'mission-';
const WORKTREE_BRANCH_PREFIX = 'mission-';

/**
 * Hard cap on how many worktrees can exist before we refuse to create
 * more. Counts ALL worktrees (active + stale) — keep it well above the
 * realistic concurrent-mission ceiling so a normal burst doesn't deadlock.
 *
 * Original was 5, which Codex flagged as breaking 5+ concurrent missions:
 * all 5 would be active (not stale), the count would equal the cap, and
 * the 6th setup would fail. 25 is comfortably above any plausible burst
 * and still tight enough to surface a real cleanup leak.
 */
export const MAX_STALE_WORKTREES = 25;

/**
 * In-process registry of worktrees currently owned by a live mission.
 * Used by cleanupAllMissionWorktrees() so a second initScheduler() call
 * (hot-reload, future double-init) cannot nuke a worktree that's still
 * in flight. Set is safer than WeakSet here since we key by mission id
 * string, not object identity. (Codex HIGH #4.)
 */
const activeWorktreeMissionIds = new Set<string>();

/** Mark a worktree as active in this process. Internal — called by createMissionWorktree. */
function markActive(missionId: string): void {
  activeWorktreeMissionIds.add(missionId);
}

/** Mark a worktree as no longer active. Internal — called by removeMissionWorktree. */
function markInactive(missionId: string): void {
  activeWorktreeMissionIds.delete(missionId);
}

/** @internal exposed for tests. */
export function _activeMissionIdsForTest(): string[] {
  return [...activeWorktreeMissionIds];
}

/**
 * @internal Test-only: clear the active-worktree registry. Used to
 * simulate a fresh-process state where the on-disk worktrees survived
 * a crash but the in-memory active set is empty (the realistic recovery
 * sweep scenario).
 */
export function _clearActiveForTest(): void {
  activeWorktreeMissionIds.clear();
}

export interface MissionWorktree {
  /** Absolute path to the worktree dir. */
  cwd: string;
  /** Branch name checked out in the worktree. */
  branch: string;
  /** Mission id this worktree belongs to. */
  missionId: string;
}

/**
 * Run a git command at PROJECT_ROOT and return stdout. Throws on non-zero
 * exit so callers don't silently proceed on a half-broken worktree state.
 */
function git(args: string[], opts: { cwd?: string } = {}): string {
  const r = safeSpawnSync('git', args, {
    envClass: 'system-tool',
    cwd: opts.cwd ?? PROJECT_ROOT,
    encoding: 'utf-8',
    timeout: 30_000,
  });
  if (r.status !== 0) {
    const stderr = typeof r.stderr === 'string' ? r.stderr : r.stderr?.toString('utf8') ?? '';
    throw new Error(`git ${args.join(' ')} failed (exit ${r.status}): ${stderr.trim()}`);
  }
  return (typeof r.stdout === 'string' ? r.stdout : r.stdout?.toString('utf8') ?? '').trim();
}

/**
 * Best-effort git: returns null on failure instead of throwing. Use only
 * in cleanup paths where a missing branch / worktree is itself a success.
 */
function gitOrNull(args: string[], opts: { cwd?: string } = {}): string | null {
  try {
    return git(args, opts);
  } catch (err) {
    logger.debug({ err, args }, 'git command failed (best-effort)');
    return null;
  }
}

function dirForMission(missionId: string): string {
  return path.join(worktreesDir(), `${WORKTREE_DIR_PREFIX}${missionId}`);
}

function branchForMission(missionId: string): string {
  return `${WORKTREE_BRANCH_PREFIX}${missionId}`;
}

/**
 * Validate the mission id is safe for filesystem + git refs. We only
 * accept the shape mission-cli already produces (8 lowercase hex chars
 * via randomBytes(4).toString('hex')), but allow alphanum + dash for
 * forward-compat.
 */
function assertSafeMissionId(missionId: string): void {
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(missionId)) {
    throw new Error(`Refusing unsafe mission id: ${JSON.stringify(missionId)}`);
  }
}

/**
 * Create a fresh worktree for a mission. Steps:
 *   1. Ensure worktreesDir() exists.
 *   2. Refuse if MAX_STALE_WORKTREES already in flight (leak guard).
 *   3. `git fetch origin` so we branch off the latest main.
 *   4. `git worktree add -B <branch> <dir> origin/main` to create the
 *      branch + checkout in one step. -B forces the branch to point at
 *      origin/main even if a stale branch of the same name exists.
 *
 * Idempotent for recovery: if the worktree dir already exists from a
 * previous run, we remove + recreate to guarantee a clean origin/main
 * baseline.
 */
export function createMissionWorktree(missionId: string): MissionWorktree {
  assertSafeMissionId(missionId);

  if (!existsSync(worktreesDir())) {
    mkdirSync(worktreesDir(), { recursive: true });
  }

  const existing = listMissionWorktrees();
  if (existing.length >= MAX_STALE_WORKTREES) {
    throw new Error(
      `Worktree leak guard tripped: ${existing.length} stale mission worktrees in ${worktreesDir()}. ` +
      `Run cleanup before dispatching new missions. Current: ${existing.map((w) => w.missionId).join(', ')}`,
    );
  }

  const cwd = dirForMission(missionId);
  const branch = branchForMission(missionId);

  // Stale leftover from a crash: tear down before recreating.
  if (existsSync(cwd)) {
    logger.warn({ missionId, cwd }, 'mission-worktree: stale dir exists, tearing down before recreate');
    removeMissionWorktree(missionId);
  }

  // Fetch so we branch off the freshest origin/main. Failure here is
  // non-fatal (offline / transient network) — fall back to local main.
  gitOrNull(['fetch', 'origin', 'main', '--quiet']);

  const baseRef = gitOrNull(['rev-parse', '--verify', 'origin/main']) ? 'origin/main' : 'main';

  git(['worktree', 'add', '-B', branch, cwd, baseRef]);

  // Propagate runtime config that lives outside git into the worktree.
  // Without this, every Mason mission gets a fresh checkout with no
  // .env, and any test/code path that reads DB_ENCRYPTION_KEY,
  // ANTHROPIC_API_KEY, OB1_SUPABASE_DB_URL, GOOGLE_API_KEY etc. fails.
  // This is what caused the "3 pre-existing schedule-cli failures" in
  // every recent mission report — those tests spawn subprocesses that
  // can't decrypt fields without DB_ENCRYPTION_KEY.
  //
  // Best-effort: log on copy failure but don't abort the worktree
  // creation — a partially-broken worktree is still better than no
  // worktree (the mission will at least surface the missing env clearly).
  copyEnvFiles(cwd);

  markActive(missionId);
  logger.info({ missionId, cwd, branch, baseRef }, 'mission-worktree: created');
  return { cwd, branch, missionId };
}

/**
 * Copy runtime config files (`.env`, `.env.local` if present) from the
 * project root into the new worktree so missions inherit the operator's
 * encryption key + API credentials. These files are gitignored, so a
 * fresh worktree from origin/main otherwise has none of them.
 *
 * Skipped silently if the source file doesn't exist — keeps tests that
 * run on a stripped fixture happy.
 */
function copyEnvFiles(targetDir: string): void {
  const candidates = ['.env', '.env.local'];
  for (const name of candidates) {
    const src = path.join(PROJECT_ROOT, name);
    if (!existsSync(src)) continue;
    const dst = path.join(targetDir, name);
    try {
      copyFileSync(src, dst);
      // Enforce 0600 on the copy regardless of source mode. The .env
      // contains DB_ENCRYPTION_KEY, ANTHROPIC_API_KEY, OAuth refresh
      // tokens — must not be world-readable inside the worktree.
      // (Codex review of worktree-followup MED.)
      chmodSync(dst, 0o600);
    } catch (err) {
      logger.warn({ err, name, targetDir }, 'mission-worktree: env file copy failed (non-fatal)');
    }
  }
}

/**
 * Remove a mission's worktree + delete the branch. Force flags everywhere
 * because a half-finished mission may have uncommitted state we don't
 * want to preserve — terminal state already lives in mission_tasks.result
 * or the pushed branch on origin.
 *
 * Always best-effort: a partial failure (e.g. worktree dir already gone)
 * must not block the next mission. Logs every step for forensics.
 */
export function removeMissionWorktree(missionId: string): void {
  assertSafeMissionId(missionId);
  const cwd = dirForMission(missionId);
  const branch = branchForMission(missionId);

  // 1. git worktree remove --force (handles dir + git metadata in one shot)
  if (existsSync(cwd)) {
    gitOrNull(['worktree', 'remove', '--force', cwd]);
  }

  // 2. Belt-and-braces: rm the dir if step 1 left anything behind
  if (existsSync(cwd)) {
    try {
      rmSync(cwd, { recursive: true, force: true });
    } catch (err) {
      logger.warn({ err, cwd }, 'mission-worktree: rmSync fallback failed');
    }
  }

  // 3. Prune git's worktree registry (kills dangling .git/worktrees/<id> entries)
  gitOrNull(['worktree', 'prune']);

  // 4. Delete the local branch. Safe because the work was either pushed
  // to origin (success) or we already accepted the loss (failure).
  gitOrNull(['branch', '-D', branch]);

  markInactive(missionId);
  logger.info({ missionId, cwd, branch }, 'mission-worktree: removed');
}

/**
 * List active mission worktrees by scanning worktreesDir(). Used for the
 * startup recovery sweep and the leak guard. Tolerates a missing dir
 * (first-ever boot) by returning [].
 */
export function listMissionWorktrees(): MissionWorktree[] {
  if (!existsSync(worktreesDir())) return [];
  let entries: string[];
  try {
    entries = readdirSync(worktreesDir());
  } catch (err) {
    logger.warn({ err, dir: worktreesDir() }, 'mission-worktree: list failed');
    return [];
  }
  const result: MissionWorktree[] = [];
  for (const name of entries) {
    if (!name.startsWith(WORKTREE_DIR_PREFIX)) continue;
    const missionId = name.slice(WORKTREE_DIR_PREFIX.length);
    if (!missionId) continue;
    result.push({
      cwd: path.join(worktreesDir(), name),
      branch: branchForMission(missionId),
      missionId,
    });
  }
  return result;
}

/**
 * Recovery sweep: nuke every mission worktree NOT currently active in
 * this process. Called on scheduler init so a process restart never
 * inherits zombie worktrees from a previous crash.
 *
 * Codex HIGH #4 fix: skip worktrees whose missionId is in
 * activeWorktreeMissionIds. If initScheduler() is called twice in the
 * same process (hot-reload edge), the second call would otherwise nuke
 * worktrees still owned by live mission ticks — yanking the cwd out
 * from under a running Codex/Claude subprocess.
 */
export function cleanupAllMissionWorktrees(): number {
  const all = listMissionWorktrees();
  let cleaned = 0;
  for (const w of all) {
    if (activeWorktreeMissionIds.has(w.missionId)) {
      logger.debug({ missionId: w.missionId }, 'mission-worktree: skipping active worktree in cleanup sweep');
      continue;
    }
    try {
      removeMissionWorktree(w.missionId);
      cleaned++;
    } catch (err) {
      logger.warn({ err, missionId: w.missionId }, 'mission-worktree: cleanup failed');
    }
  }
  return cleaned;
}

/**
 * Push the mission branch to origin. Returns true on success, false on
 * any failure (network, auth, non-fast-forward race). Caller decides
 * whether to mark the mission partial.
 */
export function pushMissionBranch(wt: MissionWorktree): boolean {
  try {
    git(['push', '--force-with-lease', 'origin', `${wt.branch}:${wt.branch}`], { cwd: wt.cwd });
    return true;
  } catch (err) {
    logger.warn({ err, branch: wt.branch }, 'mission-worktree: push failed');
    return false;
  }
}

/**
 * Fast-forward main to the mission branch from PROJECT_ROOT, then push.
 * This is the post-mission merge step that runs in the SHARED tree —
 * but only briefly, and only if the merge is a clean fast-forward.
 *
 * Decision (locked): we use --ff-only. If the mission branch diverged
 * from main (someone else pushed), we refuse to merge and return
 * 'non-ff' so the mission is marked 'partial' for human review.
 *
 * Returns 'ok' on success, 'non-ff' on divergence, 'error' on anything else.
 */
export function fastForwardMainTo(branch: string): 'ok' | 'non-ff' | 'error' {
  try {
    git(['fetch', 'origin', 'main', '--quiet']);
    git(['fetch', 'origin', branch, '--quiet']);
  } catch (err) {
    logger.warn({ err, branch }, 'fastForwardMainTo: fetch failed');
    return 'error';
  }

  // Use a worktree-safe merge: never check out, never move HEAD on the
  // shared tree. update-ref with the FF check is the surgical move.
  // 1. Confirm branch is a descendant of main (FF possible).
  const mainSha = gitOrNull(['rev-parse', 'origin/main']);
  const branchSha = gitOrNull(['rev-parse', `origin/${branch}`]);
  if (!mainSha || !branchSha) return 'error';
  if (mainSha === branchSha) return 'ok'; // nothing to do

  const mergeBase = gitOrNull(['merge-base', mainSha, branchSha]);
  if (mergeBase !== mainSha) {
    logger.warn({ branch, mainSha, branchSha, mergeBase }, 'fastForwardMainTo: non-FF, refusing');
    return 'non-ff';
  }

  // 2. Push branch SHA to origin/main directly. This is server-side FF;
  // no local checkout needed.
  try {
    git(['push', 'origin', `${branchSha}:refs/heads/main`]);
    return 'ok';
  } catch (err) {
    logger.warn({ err, branch }, 'fastForwardMainTo: push to main failed');
    return 'error';
  }
}
