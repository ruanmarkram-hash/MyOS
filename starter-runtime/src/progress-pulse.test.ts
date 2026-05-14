import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createProgressPulse, readProgressPulseDefaults } from './progress-pulse.js';

describe('createProgressPulse', () => {
  let nowMs: number;
  let emitted: string[];

  beforeEach(() => {
    nowMs = 1_000_000;
    emitted = [];
  });

  function makePulse(opts: { everyNTools?: number; everyMs?: number } = {}) {
    return createProgressPulse({
      everyNTools: opts.everyNTools ?? 8,
      everyMs: opts.everyMs ?? 45_000,
      now: () => nowMs,
      emit: (d) => emitted.push(d),
    });
  }

  it('emits after N tool calls', () => {
    const p = makePulse({ everyNTools: 3 });
    p.onTool('Bash');
    p.onTool('Read');
    expect(emitted).toEqual([]);
    p.onTool('Edit');
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toContain('3 tool calls');
    expect(emitted[0]).toContain('Edit');
  });

  it('emits after M ms even when tool count below threshold', () => {
    const p = makePulse({ everyNTools: 100, everyMs: 1000 });
    p.onTool('Bash');
    expect(emitted).toEqual([]);
    nowMs += 1500;
    p.onTool('Read');
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toContain('active');
  });

  it('whichever fires first wins', () => {
    const p = makePulse({ everyNTools: 3, everyMs: 1000 });
    // Time wins.
    nowMs += 2000;
    p.onTool('Bash');
    expect(emitted).toHaveLength(1);
    // After fire, both counters reset. Need 3 more calls to fire by count.
    p.onTool('Bash');
    p.onTool('Bash');
    p.onTool('Bash'); // 3rd since reset
    expect(emitted).toHaveLength(2);
  });

  it('onUserVisibleEvent resets both counters', () => {
    const p = makePulse({ everyNTools: 3, everyMs: 1000 });
    p.onTool('Bash');
    p.onTool('Read');
    nowMs += 800;
    p.onUserVisibleEvent();
    // Counters reset; this single tool should not trip count(=3) nor
    // time(=1000ms since reset means we need >=1000ms further).
    p.onTool('Edit');
    expect(emitted).toEqual([]);
    p.onTool('Edit');
    expect(emitted).toEqual([]);
    p.onTool('Edit'); // now 3 since reset
    expect(emitted).toHaveLength(1);
  });

  it('does not emit on the very first tool when fresh', () => {
    const p = makePulse({ everyNTools: 8, everyMs: 45_000 });
    p.onTool('Bash');
    expect(emitted).toEqual([]);
  });

  it('readProgressPulseDefaults honours env vars', () => {
    const orig = { ...process.env };
    try {
      process.env.PROGRESS_PULSE_EVERY_N_TOOLS = '5';
      process.env.PROGRESS_PULSE_EVERY_MS = '10000';
      const d = readProgressPulseDefaults();
      expect(d.everyNTools).toBe(5);
      expect(d.everyMs).toBe(10_000);
    } finally {
      process.env = orig;
    }
  });

  it('readProgressPulseDefaults falls back when env unset/invalid', () => {
    const orig = { ...process.env };
    try {
      delete process.env.PROGRESS_PULSE_EVERY_N_TOOLS;
      process.env.PROGRESS_PULSE_EVERY_MS = 'not-a-number';
      const d = readProgressPulseDefaults();
      expect(d.everyNTools).toBe(8);
      expect(d.everyMs).toBe(45_000);
    } finally {
      process.env = orig;
    }
  });
});
