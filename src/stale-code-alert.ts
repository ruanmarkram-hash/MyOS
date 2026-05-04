/**
 * stale-code-alert — push a stale-code warning through the durable
 * Telegram outbox, with a stderr fallback when the outbox itself is
 * broken.
 *
 * Why this exists: Mission A (yesterday's sprint) wired the periodic
 * stale-SHA tick to Telegram via `enqueueTelegramSend`. That closes the
 * b15c047 footgun for the common case (notify chat when running stale
 * code), but it has one residual blind spot — if the OUTBOX itself is
 * broken (DB locked, table missing, sender worker dead, schema
 * migration mid-flight), the alert is silently swallowed. The very
 * machinery we use to warn about a broken process can be the thing
 * that's broken.
 *
 * Defense in depth:
 *   1. enqueue throws → write `[STALE-CODE-FALLBACK]` line to stderr.
 *      launchctl captures stderr to logs, so the operator at least has
 *      a trail.
 *   2. enqueue succeeds but the row sits unsent for >fallbackMs (≈ 2x
 *      the worst-case outbox max-attempt window) → write the same
 *      stderr line on the next tick. Catches the case where enqueue
 *      worked but the worker is stuck / dead.
 *
 * We deliberately do NOT direct-send via bot.api.sendMessage. The
 * meta-recursion guard pattern (telegram-outbox.ts dead-letter alerts)
 * applies: we already KNOW Telegram path is unreliable in this
 * scenario; routing the meta-alert through the same broken path would
 * make it disappear too. stderr is the lowest-common-denominator
 * signal that survives any in-band failure.
 */

import type { TelegramOutboxRow } from './db.js';

export interface StaleCodeAlertOptions {
  /**
   * Enqueue function. Returns the outbox row id, or throws on DB /
   * schema / serialisation failure.
   */
  enqueue: (text: string) => number;
  /**
   * Look up an outbox row by id. Returns null when the row doesn't
   * exist (already pruned, never written, etc.). On DB failure, may
   * also throw — the caller treats throws as "outbox broken" too.
   */
  getRow: (id: number) => TelegramOutboxRow | null;
  /**
   * Threshold (ms) past which a still-pending outbox row is considered
   * stuck and triggers the stderr fallback. Default: 5min, which is
   * roughly 2x the worst-case dead-letter window for the default outbox
   * config (5 attempts × ~32s exponential backoff + lease).
   */
  fallbackMs?: number;
  /** Time source — overridable for tests. */
  now?: () => number;
  /** stderr writer — overridable for tests. Defaults to process.stderr.write. */
  stderr?: (line: string) => void;
}

interface PendingAlert {
  rowId: number;
  enqueuedAt: number;
  text: string;
  fallbackEmitted: boolean;
}

const DEFAULT_FALLBACK_MS = 5 * 60 * 1000;

function defaultStderr(line: string): void {
  // process.stderr.write doesn't append a newline; keep it explicit.
  process.stderr.write(line.endsWith('\n') ? line : line + '\n');
}

export interface StaleCodeAlerter {
  /**
   * Notify about a stale-code condition. Sweeps any prior tracked
   * pending row first (may emit fallback), then enqueues the new alert.
   * Returns the outbox row id on success, or null when enqueue threw
   * (caller already got the stderr fallback).
   */
  notify: (text: string) => number | null;
  /**
   * Independent sweep — check the currently-tracked pending row and
   * emit the stderr fallback if it's gone unsent past fallbackMs.
   * Call every tick of the periodic stale watcher, regardless of
   * whether shouldNotify was true. (Codex HIGH #2: the debounce inside
   * the watcher means notify() may not be called for many ticks, so a
   * stuck row would otherwise silently rot.)
   */
  sweep: () => void;
  /** @internal — for tests. */
  _pending: () => PendingAlert | null;
}

export function createStaleCodeAlerter(opts: StaleCodeAlertOptions): StaleCodeAlerter {
  const enqueue = opts.enqueue;
  const getRow = opts.getRow;
  // Codex MED #4: validate fallbackMs. parseInt of garbage env yields
  // NaN; negative values would invert the age comparison. Fall back to
  // the default in either case rather than running with a broken cap.
  const rawFallback = opts.fallbackMs;
  const fallbackMs = (typeof rawFallback === 'number' && Number.isFinite(rawFallback) && rawFallback > 0)
    ? rawFallback
    : DEFAULT_FALLBACK_MS;
  const now = opts.now ?? (() => Date.now());
  const stderr = opts.stderr ?? defaultStderr;

  let pending: PendingAlert | null = null;

  function emitFallback(reason: string, text: string): void {
    // Single tagged prefix per the brief; downstream log scrapers grep
    // on `[STALE-CODE-FALLBACK]`. Keep one-line for log-line atomicity.
    const safe = text.replace(/\s+/g, ' ').slice(0, 400);
    stderr(`[STALE-CODE-FALLBACK] reason=${reason} alert=${safe}`);
  }

  function checkPending(): void {
    if (!pending || pending.fallbackEmitted) return;
    const age = now() - pending.enqueuedAt;
    if (age < fallbackMs) return;
    let row: TelegramOutboxRow | null = null;
    try {
      row = getRow(pending.rowId);
    } catch (err) {
      // getRow itself failed — the outbox / db is so broken we can't
      // even read. Definitely fallback.
      emitFallback(
        `getRow_threw:${(err as Error)?.message ?? String(err)}`.slice(0, 100),
        pending.text,
      );
      pending.fallbackEmitted = true;
      return;
    }
    if (!row) {
      // Row vanished (pruned? wiped?). Treat as stuck — the alert
      // never reached Telegram in any observable way.
      emitFallback('row_missing', pending.text);
      pending.fallbackEmitted = true;
      return;
    }
    if (row.status === 'sent') {
      // Delivered — clear tracking.
      pending = null;
      return;
    }
    if (row.status === 'dead-lettered' || row.status === 'failed') {
      // Outbox already surfaced its own dead-letter alert via its own
      // path; we still emit a stale-code-tagged stderr line so log
      // greps for STALE-CODE-FALLBACK catch it without needing to
      // cross-correlate. One line, then stop tracking.
      emitFallback(`outbox_${row.status}`, pending.text);
      pending.fallbackEmitted = true;
      return;
    }
    // pending or in_flight, but elapsed > fallbackMs — stuck.
    emitFallback(`stuck_${row.status}_age_ms=${age}`, pending.text);
    pending.fallbackEmitted = true;
  }

  return {
    notify(text: string): number | null {
      // (1) Sweep prior tracked alert first. Emits fallback if stuck.
      checkPending();

      // (1b) Codex MED #3: if pending is still set after the sweep
      // (still inside the fallback window), promote-and-replace: emit
      // a "rotated" fallback for the original so its signal isn't
      // silently lost when we overwrite tracking. Cheap belt-and-braces;
      // in practice notify is debounced upstream so this rarely fires.
      if (pending && !pending.fallbackEmitted) {
        emitFallback('rotated_before_resolution', pending.text);
        pending.fallbackEmitted = true;
      }

      // (2) Try to enqueue.
      let rowId: number;
      try {
        rowId = enqueue(text);
      } catch (err) {
        const msg = (err as Error)?.message ?? String(err);
        emitFallback(`enqueue_threw:${msg.slice(0, 100)}`, text);
        // Drop tracking — there's no row id to follow up on.
        pending = null;
        return null;
      }

      pending = { rowId, enqueuedAt: now(), text, fallbackEmitted: false };
      return rowId;
    },
    sweep(): void {
      // Codex HIGH #2: independent sweep callable from the periodic
      // stale watcher tick. Without this, the watcher's debounce
      // (shouldNotify only fires once per stale window) means a stuck
      // row sitting unsent for hours never reaches stderr. Now every
      // tick checks pending, regardless of new-alert state.
      checkPending();
    },
    _pending(): PendingAlert | null {
      return pending;
    },
  };
}
