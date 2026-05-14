import { describe, it, expect, beforeEach } from 'vitest';
import { createStaleCodeAlerter } from './stale-code-alert.js';
import type { TelegramOutboxRow } from './db.js';

function makeRow(id: number, status: TelegramOutboxRow['status']): TelegramOutboxRow {
  return {
    id,
    agent_id: 'main',
    chat_id: '1',
    payload: '{}',
    status,
    attempt_count: 0,
    last_error: null,
    last_attempt_at: null,
    next_retry_at: null,
    lease_expires_at: null,
    telegram_message_id: null,
    created_at: 0,
    sent_at: null,
  };
}

describe('createStaleCodeAlerter', () => {
  let stderrLines: string[];
  let nowMs: number;
  let nextRowId: number;
  const enqueueOk = (rows: Map<number, TelegramOutboxRow>) => (text: string) => {
    const id = ++nextRowId;
    rows.set(id, { ...makeRow(id, 'pending'), payload: JSON.stringify({ text }) });
    return id;
  };

  beforeEach(() => {
    stderrLines = [];
    nowMs = 0;
    nextRowId = 0;
  });

  it('happy path: enqueue succeeds, no stderr', () => {
    const rows = new Map<number, TelegramOutboxRow>();
    const a = createStaleCodeAlerter({
      enqueue: enqueueOk(rows),
      getRow: (id) => rows.get(id) ?? null,
      now: () => nowMs,
      stderr: (l) => stderrLines.push(l),
    });
    const id = a.notify('alert one');
    expect(id).toBe(1);
    expect(stderrLines).toEqual([]);
  });

  it('enqueue throws → stderr fallback with [STALE-CODE-FALLBACK] prefix', () => {
    const a = createStaleCodeAlerter({
      enqueue: () => { throw new Error('db locked'); },
      getRow: () => null,
      now: () => nowMs,
      stderr: (l) => stderrLines.push(l),
    });
    const id = a.notify('alert one');
    expect(id).toBeNull();
    expect(stderrLines).toHaveLength(1);
    expect(stderrLines[0]).toContain('[STALE-CODE-FALLBACK]');
    expect(stderrLines[0]).toContain('enqueue_threw');
    expect(stderrLines[0]).toContain('db locked');
    expect(stderrLines[0]).toContain('alert one');
  });

  it('row stuck pending past fallbackMs → stderr fallback on next tick', () => {
    const rows = new Map<number, TelegramOutboxRow>();
    const a = createStaleCodeAlerter({
      enqueue: enqueueOk(rows),
      getRow: (id) => rows.get(id) ?? null,
      fallbackMs: 1000,
      now: () => nowMs,
      stderr: (l) => stderrLines.push(l),
    });
    a.notify('alert one');
    expect(stderrLines).toEqual([]);

    // Advance well past fallbackMs; row is still pending.
    nowMs = 5000;
    a.notify('alert two');
    expect(stderrLines).toHaveLength(1);
    expect(stderrLines[0]).toContain('stuck_pending');
    expect(stderrLines[0]).toContain('alert one');
  });

  it('row sent in time → no fallback, tracking cleared', () => {
    const rows = new Map<number, TelegramOutboxRow>();
    const a = createStaleCodeAlerter({
      enqueue: enqueueOk(rows),
      getRow: (id) => rows.get(id) ?? null,
      fallbackMs: 1000,
      now: () => nowMs,
      stderr: (l) => stderrLines.push(l),
    });
    const id = a.notify('alert one')!;
    rows.set(id, { ...rows.get(id)!, status: 'sent' });
    nowMs = 5000;
    a.notify('alert two');
    expect(stderrLines).toEqual([]);
  });

  it('rotates pending tracking when notify fires before resolution (Codex MED #3)', () => {
    // Pre-fix behavior: notify silently overwrote pending without emitting,
    // letting the original alert's signal disappear.
    // Post-fix: rotation emits a 'rotated_before_resolution' fallback so
    // each tracked alert's status reaches stderr exactly once.
    const rows = new Map<number, TelegramOutboxRow>();
    const a = createStaleCodeAlerter({
      enqueue: enqueueOk(rows),
      getRow: (id) => rows.get(id) ?? null,
      fallbackMs: 1000,
      now: () => nowMs,
      stderr: (l) => stderrLines.push(l),
    });
    a.notify('alert one');                    // tracks row 1
    nowMs = 5000;
    a.notify('alert two');                    // row 1 aged → fallback (1)
    nowMs = 5500;                             // row 2 not aged
    a.notify('alert three');                  // rotation fires fallback for row 2 (2)
    expect(stderrLines).toHaveLength(2);
    expect(stderrLines[1]).toContain('rotated_before_resolution');
  });

  it('sweep() emits stuck-row fallback even without a notify call (Codex HIGH #2)', () => {
    const rows = new Map<number, TelegramOutboxRow>();
    const a = createStaleCodeAlerter({
      enqueue: enqueueOk(rows),
      getRow: (id) => rows.get(id) ?? null,
      fallbackMs: 1000,
      now: () => nowMs,
      stderr: (l) => stderrLines.push(l),
    });
    a.notify('only alert');
    nowMs = 5000;
    // No second notify fires (debounced upstream). Sweep is the
    // independent path that catches the stuck row anyway.
    a.sweep();
    expect(stderrLines).toHaveLength(1);
    expect(stderrLines[0]).toContain('stuck_pending');
  });

  it('dead-lettered row → tagged stderr fallback', () => {
    const rows = new Map<number, TelegramOutboxRow>();
    const a = createStaleCodeAlerter({
      enqueue: enqueueOk(rows),
      getRow: (id) => rows.get(id) ?? null,
      fallbackMs: 1000,
      now: () => nowMs,
      stderr: (l) => stderrLines.push(l),
    });
    const id = a.notify('alert one')!;
    rows.set(id, { ...rows.get(id)!, status: 'dead-lettered' });
    nowMs = 5000;
    a.notify('alert two');
    expect(stderrLines).toHaveLength(1);
    expect(stderrLines[0]).toContain('outbox_dead-lettered');
  });

  it('getRow throwing → stderr fallback', () => {
    const rows = new Map<number, TelegramOutboxRow>();
    const a = createStaleCodeAlerter({
      enqueue: enqueueOk(rows),
      getRow: () => { throw new Error('table missing'); },
      fallbackMs: 1000,
      now: () => nowMs,
      stderr: (l) => stderrLines.push(l),
    });
    a.notify('alert one');
    nowMs = 5000;
    a.notify('alert two');
    expect(stderrLines).toHaveLength(1);
    expect(stderrLines[0]).toContain('getRow_threw');
    expect(stderrLines[0]).toContain('table missing');
  });

  it('row missing on follow-up → stderr fallback', () => {
    const rows = new Map<number, TelegramOutboxRow>();
    const a = createStaleCodeAlerter({
      enqueue: enqueueOk(rows),
      getRow: (id) => rows.get(id) ?? null,
      fallbackMs: 1000,
      now: () => nowMs,
      stderr: (l) => stderrLines.push(l),
    });
    const id = a.notify('alert one')!;
    rows.delete(id);
    nowMs = 5000;
    a.notify('alert two');
    expect(stderrLines).toHaveLength(1);
    expect(stderrLines[0]).toContain('row_missing');
  });
});
