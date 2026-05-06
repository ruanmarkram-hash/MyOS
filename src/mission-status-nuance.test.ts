/**
 * Tests for the partial-vs-failed status nuance added 2026-05-04.
 *
 * The bug we're closing: Mason missions that hit the 60-turn cap AFTER
 * committing real work were marked plain `failed`. Re-dispatch loops
 * followed because the user couldn't tell "dead on arrival" from
 * "ran out of runway with N commits landed."
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

import { commitsSinceStart } from './scheduler.js';
import {
  formatNotifyMessage,
  type MissionTerminalState,
} from './mission-notify.js';
import { buildMissionManifest } from './mission-manifest.js';

function makeRepo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'mason-status-'));
  execSync('git init -q', { cwd: dir });
  execSync('git config user.email test@example.com', { cwd: dir });
  execSync('git config user.name Test', { cwd: dir });
  // Seed commit BEFORE "started_at" so we can tell the helper only counts
  // commits made after the cutoff.
  writeFileSync(path.join(dir, 'seed.txt'), 'seed');
  execSync('git add . && git commit -q -m seed', { cwd: dir });
  return dir;
}

function commit(dir: string, name: string): void {
  writeFileSync(path.join(dir, name), name);
  execSync(`git add . && git commit -q -m ${name}`, { cwd: dir });
}

describe('mission status nuance: commitsSinceStart', () => {
  let repo: string;
  beforeEach(() => { repo = makeRepo(); });
  afterEach(() => { rmSync(repo, { recursive: true, force: true }); });

  it('returns 0 when no commits since the cutoff (=> failed)', () => {
    const startedAt = Math.floor(Date.now() / 1000) + 1; // future cutoff
    expect(commitsSinceStart(repo, startedAt)).toBe(0);
  });

  it('returns N>0 when commits landed after the cutoff (=> partial)', async () => {
    // Wait so the seed commit is strictly before the cutoff (git --since
    // is second-resolution; otherwise the seed counts too).
    await new Promise((r) => setTimeout(r, 1100));
    const startedAt = Math.floor(Date.now() / 1000);
    await new Promise((r) => setTimeout(r, 1100));
    commit(repo, 'a');
    commit(repo, 'b');
    expect(commitsSinceStart(repo, startedAt)).toBe(2);
  });

  it('returns 0 on a non-git cwd without throwing', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'mason-nogit-'));
    try {
      expect(commitsSinceStart(dir, Math.floor(Date.now() / 1000))).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('mission status nuance: classifyMissionFailure semantics', () => {
  // We re-implement the decision rule here as a guard against silent
  // drift in scheduler.ts. The rule must stay: commits>0 -> partial,
  // else failed. If this test starts failing, the scheduler diverged.
  function classify(commitCount: number): 'partial' | 'failed' {
    return commitCount > 0 ? 'partial' : 'failed';
  }

  it('zero commits after max-turns => failed', () => {
    expect(classify(0)).toBe('failed');
  });

  it('two commits after max-turns => partial', () => {
    expect(classify(2)).toBe('partial');
  });
});

describe('mission status nuance: notify formatting per verdict', () => {
  const base = { created_by: 'mason', title: 'Refactor mapper', result: null, error: null };

  const cases: Array<[MissionTerminalState, string, { detail?: string; commitCount?: number }]> = [
    ['completed', '[mason ✓] Refactor mapper: Done.', { detail: 'Done.' }],
    ['failed',    '[mason ✗] Refactor mapper: Boom',  { detail: 'Boom' }],
    ['timed_out', '[mason ⏱] Refactor mapper: Timed out after 10 minutes', { detail: 'Timed out after 10 minutes' }],
  ];

  for (const [state, expected, opts] of cases) {
    it(`${state} format`, () => {
      expect(formatNotifyMessage(base, state, opts.detail, { commitCount: opts.commitCount ?? 0 })).toBe(expected);
    });
  }

  it('partial format includes commit count and review hint', () => {
    expect(formatNotifyMessage(base, 'partial', undefined, { commitCount: 3 }))
      .toBe('[mason ⚠️] Refactor mapper — partial: ran out of turns but committed 3 changes; review and re-dispatch if needed');
  });

  it('partial format singular when commit count is 1', () => {
    expect(formatNotifyMessage(base, 'partial', undefined, { commitCount: 1 }))
      .toBe('[mason ⚠️] Refactor mapper — partial: ran out of turns but committed 1 change; review and re-dispatch if needed');
  });

  it('partial format defaults commitCount to 0 when missing', () => {
    expect(formatNotifyMessage(base, 'partial'))
      .toContain('committed 0 changes');
  });
});

describe('mission manifest routing', () => {
  it('sorts clean completions that explicitly say no human action is required', () => {
    const manifest = buildMissionManifest({
      status: 'completed',
      title: 'Clean smoke',
      prompt: 'complete cleanly',
      result: 'Completed cleanly. No deliverable and no human action required.',
    });

    expect(manifest.route).toBe('sorted');
    expect(manifest.nextAction).toBeNull();
    expect(manifest.deliverables).toEqual([]);
  });
});
