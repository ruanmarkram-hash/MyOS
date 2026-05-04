import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkStale, createStaleWatcher, RUNTIME_BUILD_META } from './build-meta.js';

let tmpDir: string;
let metaPath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stale-'));
  metaPath = path.join(tmpDir, '.build-meta.json');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function writeMeta(sha: string, builtAt = '2026-05-04T00:00:00Z') {
  fs.writeFileSync(metaPath, JSON.stringify({ sha, branch: 'main', builtAt }));
}

describe('checkStale', () => {
  it('reports stale=false when disk SHA matches runtime', () => {
    writeMeta(RUNTIME_BUILD_META.sha);
    const r = checkStale(metaPath);
    expect(r.stale).toBe(false);
    expect(r.runtimeSha).toBe(RUNTIME_BUILD_META.sha);
    expect(r.diskSha).toBe(RUNTIME_BUILD_META.sha);
  });

  it('reports stale=true when disk SHA differs from runtime', () => {
    // Skip if runtime SHA itself is unknown (e.g. test env without git
    // build-meta) — the false-alarm guard would kick in.
    if (RUNTIME_BUILD_META.sha === 'unknown') return;
    writeMeta('different-sha-deadbeef');
    const r = checkStale(metaPath);
    expect(r.stale).toBe(true);
    expect(r.diskSha).toBe('different-sha-deadbeef');
  });

  it('does not false-alarm when either side is unknown', () => {
    writeMeta('unknown');
    const r = checkStale(metaPath);
    expect(r.stale).toBe(false);
  });

  it('does not false-alarm when meta file is missing', () => {
    const r = checkStale(path.join(tmpDir, 'nope.json'));
    expect(r.stale).toBe(false);
  });

  it('suppresses alert when build-meta branch is not main (shared-tree mid-mission)', () => {
    if (RUNTIME_BUILD_META.sha === 'unknown') return;
    // Simulate Mason rebuilding while checked out on a feature branch:
    // dist/.build-meta.json reflects the feature SHA, but that's not a
    // deployment-stale condition — it's another agent mid-flight.
    fs.writeFileSync(
      metaPath,
      JSON.stringify({
        sha: 'feature-sha-deadbeef',
        branch: 'recovery/m1-stale-progress',
        builtAt: '2026-05-04T00:00:00Z',
      }),
    );
    const r = checkStale(metaPath);
    expect(r.stale).toBe(false);
    expect(r.diskMeta.branch).toBe('recovery/m1-stale-progress');
  });
});

describe('createStaleWatcher', () => {
  it('shouldNotify fires once per stale window then debounces', () => {
    if (RUNTIME_BUILD_META.sha === 'unknown') return;
    const watcher = createStaleWatcher(metaPath);

    // Match — no notify.
    writeMeta(RUNTIME_BUILD_META.sha);
    expect(watcher.tick().shouldNotify).toBe(false);

    // First mismatch — notify.
    writeMeta('stale-sha-1');
    const t1 = watcher.tick();
    expect(t1.stale).toBe(true);
    expect(t1.shouldNotify).toBe(true);

    // Same stale SHA — debounced, no notify.
    const t2 = watcher.tick();
    expect(t2.stale).toBe(true);
    expect(t2.shouldNotify).toBe(false);

    // New stale SHA — notify again.
    writeMeta('stale-sha-2');
    const t3 = watcher.tick();
    expect(t3.shouldNotify).toBe(true);

    // Disk catches up — reset, no notify.
    writeMeta(RUNTIME_BUILD_META.sha);
    const t4 = watcher.tick();
    expect(t4.stale).toBe(false);
    expect(t4.shouldNotify).toBe(false);

    // Stale again later — fresh window, notify.
    writeMeta('stale-sha-3');
    expect(watcher.tick().shouldNotify).toBe(true);
  });
});
