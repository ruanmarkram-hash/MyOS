import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  readBuildMeta,
  shortSha,
  formatRelative,
  formatUptime,
} from './build-meta.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'build-meta-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function fixture(meta: unknown): string {
  const p = path.join(tmpDir, '.build-meta.json');
  fs.writeFileSync(p, JSON.stringify(meta));
  return p;
}

describe('readBuildMeta', () => {
  it('parses a valid fixture', () => {
    const p = fixture({ sha: 'abc1234567890', branch: 'main', builtAt: '2026-05-04T16:50:00Z' });
    const m = readBuildMeta(p);
    expect(m.sha).toBe('abc1234567890');
    expect(m.branch).toBe('main');
    expect(m.builtAt).toBe('2026-05-04T16:50:00Z');
  });

  it('returns unknown on missing file', () => {
    const m = readBuildMeta(path.join(tmpDir, 'does-not-exist.json'));
    expect(m).toEqual({ sha: 'unknown', branch: 'unknown', builtAt: 'unknown' });
  });

  it('returns unknown on malformed JSON', () => {
    const p = path.join(tmpDir, '.build-meta.json');
    fs.writeFileSync(p, 'not-json{{');
    const m = readBuildMeta(p);
    expect(m.sha).toBe('unknown');
  });

  it('coerces missing fields to unknown', () => {
    const p = fixture({ sha: 'abc' });
    const m = readBuildMeta(p);
    expect(m.sha).toBe('abc');
    expect(m.branch).toBe('unknown');
    expect(m.builtAt).toBe('unknown');
  });
});

describe('formatters', () => {
  it('shortSha truncates to 7', () => {
    expect(shortSha('abcdef1234567890')).toBe('abcdef1');
    expect(shortSha('unknown')).toBe('unknown');
  });

  it('formatRelative handles unknown and ISO', () => {
    expect(formatRelative('unknown')).toBe('unknown');
    const recent = new Date(Date.now() - 30_000).toISOString();
    expect(formatRelative(recent)).toMatch(/s ago$/);
  });

  it('formatUptime scales', () => {
    expect(formatUptime(5_000)).toBe('5s');
    expect(formatUptime(120_000)).toMatch(/m$/);
    expect(formatUptime(3 * 3600 * 1000)).toMatch(/h/);
  });
});
