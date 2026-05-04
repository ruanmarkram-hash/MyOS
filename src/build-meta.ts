/**
 * build-meta — runtime snapshot + stale-code detection.
 *
 * The live process loads dist/.build-meta.json ONCE at startup into
 * RUNTIME_BUILD_META. A periodic check re-reads the same file from
 * disk and compares SHAs. If they differ, the running JS is stale
 * relative to the on-disk build — the b15c047 footgun.
 *
 * Why not just `process.uptime() < buildAge` heuristics: SHA is the
 * only reliable identity for "is this code byte-for-byte the build I
 * shipped". Timestamps drift; SHAs do not.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface BuildMeta {
  sha: string;
  branch: string;
  builtAt: string;
}

const UNKNOWN_META: BuildMeta = { sha: 'unknown', branch: 'unknown', builtAt: 'unknown' };

/**
 * Resolve dist/.build-meta.json relative to the compiled module
 * location. In dev (tsx) we fall back to <repo>/dist/.build-meta.json
 * so the same code path works in both modes.
 */
export function resolveBuildMetaPath(): string {
  try {
    const here = fileURLToPath(import.meta.url);
    // dist/build-meta.js -> dist/.build-meta.json
    return path.join(path.dirname(here), '.build-meta.json');
  } catch {
    return path.join(process.cwd(), 'dist', '.build-meta.json');
  }
}

export function readBuildMeta(filePath: string = resolveBuildMetaPath()): BuildMeta {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<BuildMeta>;
    return {
      sha: typeof parsed.sha === 'string' ? parsed.sha : 'unknown',
      branch: typeof parsed.branch === 'string' ? parsed.branch : 'unknown',
      builtAt: typeof parsed.builtAt === 'string' ? parsed.builtAt : 'unknown',
    };
  } catch {
    return { ...UNKNOWN_META };
  }
}

/** Snapshot loaded at module-load time. Module-scoped const, frozen. */
export const RUNTIME_BUILD_META: Readonly<BuildMeta> = Object.freeze(readBuildMeta());

/** Process start (used for uptime in /status). */
export const RUNTIME_STARTED_AT = Date.now();

export interface StaleResult {
  stale: boolean;
  runtimeSha: string;
  diskSha: string;
  diskMeta: BuildMeta;
}

export function checkStale(filePath?: string): StaleResult {
  const diskMeta = readBuildMeta(filePath);
  const runtimeSha = RUNTIME_BUILD_META.sha;
  // 'unknown' on either side: don't false-alarm. The build script
  // emits 'unknown' on detached-HEAD/missing-git; if we can't read
  // disk meta we also get 'unknown'. Treating those as stale would
  // spam every sub-agent that runs without a git checkout.
  //
  // Branch gate: fork uses a shared working tree across all agents
  // (sage, mason, charter, ember, marlow, warden), so any agent
  // checking out a feature/recovery branch + rebuilding clobbers
  // dist/.build-meta.json with that branch's SHA. Without this gate,
  // every other agent's stale-detector then false-alarms because
  // disk meta no longer reflects main. Only fire when disk meta is
  // built from main — that's the only case where /restart actually
  // picks up new deployment code. Mid-mission rebuilds on feature
  // branches are not "stale", they're "in flight on something else".
  // (2026-05-05 incident: 4 spurious stale alerts in <12h while Mason
  // was iterating on recovery/m1-stale-progress.)
  const onMain = diskMeta.branch === 'main';
  const stale =
    runtimeSha !== 'unknown'
    && diskMeta.sha !== 'unknown'
    && runtimeSha !== diskMeta.sha
    && onMain;
  return { stale, runtimeSha, diskSha: diskMeta.sha, diskMeta };
}

/**
 * Stateful stale-watch helper. Debounces notifications: fire once
 * per stale-window (i.e. once per disk-SHA we've already warned
 * about). When disk SHA changes again or matches runtime, the
 * window resets.
 */
export function createStaleWatcher(filePath?: string) {
  let lastWarnedDiskSha: string | null = null;
  return {
    /**
     * Run one tick. Returns the StaleResult plus `shouldNotify`:
     * true exactly once per new stale disk-SHA observed.
     */
    tick(): StaleResult & { shouldNotify: boolean } {
      const result = checkStale(filePath);
      let shouldNotify = false;
      if (result.stale) {
        if (lastWarnedDiskSha !== result.diskSha) {
          shouldNotify = true;
          lastWarnedDiskSha = result.diskSha;
        }
      } else {
        // Reset so a future stale window re-notifies.
        lastWarnedDiskSha = null;
      }
      return { ...result, shouldNotify };
    },
    /** Test helper: peek at internal debounce state. */
    _lastWarned(): string | null { return lastWarnedDiskSha; },
  };
}

export function shortSha(sha: string): string {
  return sha === 'unknown' ? 'unknown' : sha.slice(0, 7);
}

export function formatRelative(iso: string): string {
  if (iso === 'unknown') return 'unknown';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const secs = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.round(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.round(secs / 3600)}h ago`;
  return `${Math.round(secs / 86400)}d ago`;
}

export function formatUptime(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  if (h < 24) return `${h}h${rem}m`;
  const d = Math.floor(h / 24);
  return `${d}d${h % 24}h`;
}
