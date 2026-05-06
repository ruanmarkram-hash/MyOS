// Unit tests for the brain-monitor growth classifier.
//
// Origin: 2026-05-07 — Warden's daily audit was firing CRITICAL "ob1-brain
// growth: +0" every morning at the start of Brisbane work hours, even when
// ingestion was healthy. The watcher only sees data when Claude Code or Codex
// sessions are active; an idle overnight period legitimately produces 0 new
// thoughts. This test locks the threshold logic in: growth=0 is only critical
// when there was upstream input that the watcher failed to convert.

import { describe, it, expect } from 'vitest';
// @ts-expect-error -- importing a .mjs module from TS; vitest resolves it fine.
import { classifyGrowth } from '../scripts/monitor-brain-classify.mjs';

describe('classifyGrowth', () => {
  it('treats growth=0 with no upstream input as INFO (no input arrived)', () => {
    const r = classifyGrowth({ recentThoughts: 0, newInputFiles: 0, windowHours: 4 });
    expect(r.level).toBe('info');
    expect(r.message).toMatch(/no input arrived/i);
    expect(r.message).toContain('4h');
  });

  it('treats growth=0 with upstream input as CRITICAL (watcher dropping data)', () => {
    const r = classifyGrowth({ recentThoughts: 0, newInputFiles: 3, windowHours: 4 });
    expect(r.level).toBe('critical');
    expect(r.message).toMatch(/watcher dropping data/i);
    expect(r.message).toContain('3 upstream jsonl');
  });

  it('treats any positive growth as OK regardless of input file count', () => {
    expect(classifyGrowth({ recentThoughts: 5, newInputFiles: 0, windowHours: 4 }).level).toBe('ok');
    expect(classifyGrowth({ recentThoughts: 1, newInputFiles: 7, windowHours: 6 }).level).toBe('ok');
  });
});
