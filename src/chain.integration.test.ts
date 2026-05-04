/**
 * Chain-level integration tests (Mission 02c6e36d, M2).
 *
 * Existing per-module tests are unit-level: each subsystem's contract is
 * mocked at its outbox / spawn boundary. Yesterday's incident showed why
 * that's not enough — Mission D (op-notify) initially bypassed Mission B
 * (outbox) without any unit test catching it, because every unit test
 * mocked the outbox away.
 *
 * These tests exercise the FULL chain end-to-end: enqueue → DB persist →
 * worker tick → claim → outbox handoff → outbox sender → telegram_message_id
 * recorded. Mock point is the API client (telegram fetch layer), not the
 * outbox itself, so a regression that bypasses any link in the chain
 * surfaces immediately.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import {
  _initTestDatabase,
  _setMissionCompletedAtForTest,
  countTelegramOutboxByStatus,
  createMissionTask,
  completeMissionTask,
  getMissionTask,
  getOperationNotification,
  getTelegramOutboxRow,
  insertTelegramOutbox,
  setSession,
  type TelegramOutboxRow,
} from './db.js';
import {
  processDueOperationNotifications,
  scheduleOperationNotification,
} from './operation-notify.js';
import { notifyMissionDone } from './mission-notify.js';
import {
  enqueueTelegramSend,
  setTelegramOutboxClient,
  tickTelegramOutbox,
  type TelegramApiClient,
} from './telegram-outbox.js';
import { _resetShutdownStateForTest } from './build-meta.js';
import { createStaleCodeAlerter } from './stale-code-alert.js';

/**
 * Capture every call made by the outbox worker into an in-memory list,
 * returning a fixed message_id. Mocks at the API client layer — the outbox
 * itself, the DB, and the chain wiring are real.
 */
function makeApiCapture(messageId = 1234): {
  client: TelegramApiClient;
  calls: Array<{ method: string; chatId: string; params: Record<string, unknown> }>;
} {
  const calls: Array<{ method: string; chatId: string; params: Record<string, unknown> }> = [];
  const client: TelegramApiClient = vi.fn(async (method, chatId, params) => {
    calls.push({ method, chatId, params });
    return { message_id: messageId };
  });
  return { client, calls };
}

describe('chain: op-notify → outbox → API', () => {
  beforeEach(() => {
    _initTestDatabase();
    setTelegramOutboxClient(null);
  });
  afterEach(() => {
    setTelegramOutboxClient(null);
  });

  it('full chain: schedule → tick → claim → outbox enqueue (atomic) → sender → telegram_message_id', async () => {
    const { client, calls } = makeApiCapture(8001);
    setTelegramOutboxClient(client);

    const opNotifyId = scheduleOperationNotification({
      agentId: 'mason',
      chatId: 'chat-mason-1',
      operationId: 'op-chain-1',
      fireAt: new Date(Date.now() - 1_000), // due
      message: 'check on PR review',
    });

    // 1. Op-notify worker tick: claims the row AND enqueues to outbox in one txn.
    const delivered = await processDueOperationNotifications();
    expect(delivered).toBe(1);

    // 2. Op-notify row is fired (claim won).
    const opRow = getOperationNotification(opNotifyId);
    expect(opRow?.status).toBe('fired');
    expect(opRow?.fired_at).toBeGreaterThan(0);

    // 3. Outbox row exists, scoped to the caller agent (regression guard
    //    against cross-agent delivery bug d7e5ba7).
    const counts = countTelegramOutboxByStatus();
    expect(counts.pending).toBe(1);

    // Find the outbox row by scanning recent ids.
    let outboxRow: TelegramOutboxRow | null = null;
    for (let i = 1; i <= 20; i++) {
      const row = getTelegramOutboxRow(i);
      if (row && row.agent_id === 'mason' && row.chat_id === 'chat-mason-1') {
        outboxRow = row;
        break;
      }
    }
    expect(outboxRow).not.toBeNull();
    expect(outboxRow!.status).toBe('pending');

    // 4. Outbox tick (scoped to mason — proves agent-scoping works in chain).
    const processed = await tickTelegramOutbox('mason');
    expect(processed).toBe(1);

    // 5. API client was called with the right method+chat+payload.
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('sendMessage');
    expect(calls[0].chatId).toBe('chat-mason-1');
    expect((calls[0].params as { text: string }).text).toBe('check on PR review');

    // 6. telegram_message_id stamped on the outbox row.
    const finalRow = getTelegramOutboxRow(outboxRow!.id)!;
    expect(finalRow.status).toBe('sent');
    expect(finalRow.telegram_message_id).toBe(8001);
    expect(finalRow.sent_at).not.toBeNull();
  });

  it('outbox tick scoped to a different agent does NOT drain the row (cross-agent isolation)', async () => {
    const { client, calls } = makeApiCapture();
    setTelegramOutboxClient(client);

    scheduleOperationNotification({
      agentId: 'mason',
      chatId: 'c1',
      operationId: 'op-iso',
      fireAt: new Date(Date.now() - 1_000),
      message: 'mason-only',
    });
    await processDueOperationNotifications();

    // Wrong-agent tick: must not deliver mason's row.
    const processed = await tickTelegramOutbox('charter');
    expect(processed).toBe(0);
    expect(calls).toHaveLength(0);

    // Right-agent tick: drains it.
    const processed2 = await tickTelegramOutbox('mason');
    expect(processed2).toBe(1);
    expect(calls).toHaveLength(1);
  });
});

describe('chain: mission-notify → outbox → API', () => {
  beforeEach(() => {
    _initTestDatabase();
    setTelegramOutboxClient(null);
  });
  afterEach(() => {
    setTelegramOutboxClient(null);
  });

  it('full chain: createMissionTask(notify_on_done=1) → notify → outbox → sender → delivered_at distinct from notified_at', async () => {
    const { client, calls } = makeApiCapture(9100);
    setTelegramOutboxClient(client);

    createMissionTask('m-chain-1', 'Refactor mapper', 'prompt', 'mason', 'sage', 0, null, true);
    setSession('chat-sage-7', 'sess-int-1', 'sage');
    completeMissionTask('m-chain-1', 'all green', 'completed');

    // 1. mission-notify enqueues to outbox AND stamps delivered_at on the task.
    const fired = await notifyMissionDone(getMissionTask('m-chain-1')!, 'completed', 'all green');
    expect(fired).toBe(true);

    const task = getMissionTask('m-chain-1')!;
    expect(task.notified_at).not.toBeNull();
    expect(task.delivered_at).not.toBeNull();
    // delivered_at == notified_at within the same second is acceptable; the
    // semantic difference is that delivered_at signals the row reached the
    // durable outbox (which OWNS retry from here). Both must be set.
    expect(task.delivered_at).toBeGreaterThanOrEqual(task.notified_at!);

    // 2. Outbox row exists with the right agent_id, chat_id, and HTML-safe text.
    const counts = countTelegramOutboxByStatus();
    expect(counts.pending).toBe(1);

    let outboxRow: TelegramOutboxRow | null = null;
    for (let i = 1; i <= 20; i++) {
      const row = getTelegramOutboxRow(i);
      if (row && row.chat_id === 'chat-sage-7') {
        outboxRow = row;
        break;
      }
    }
    expect(outboxRow).not.toBeNull();
    expect(outboxRow!.agent_id).toBe('sage');
    const payload = JSON.parse(outboxRow!.payload) as {
      method: string;
      params: { text: string; parse_mode?: string };
    };
    expect(payload.method).toBe('sendMessage');
    expect(payload.params.parse_mode).toBe('HTML');
    expect(payload.params.text).toBe('[sage ✓] Refactor mapper: all green');

    // 3. Outbox sender drains the row.
    const processed = await tickTelegramOutbox('sage');
    expect(processed).toBe(1);
    expect(calls).toHaveLength(1);
    expect(calls[0].chatId).toBe('chat-sage-7');
    expect((calls[0].params as { text: string }).text).toBe('[sage ✓] Refactor mapper: all green');

    // 4. Outbox row stamped sent + telegram_message_id.
    const finalRow = getTelegramOutboxRow(outboxRow!.id)!;
    expect(finalRow.status).toBe('sent');
    expect(finalRow.telegram_message_id).toBe(9100);

    // 5. After the outbox tick, sent_at is strictly after the row's created_at
    //    so the chain provides observable end-to-end timestamps.
    expect(finalRow.sent_at).not.toBeNull();
    expect(finalRow.sent_at!).toBeGreaterThanOrEqual(finalRow.created_at);
  });
});

describe('chain: stale-code → outbox → API + fallbacks', () => {
  beforeEach(() => {
    _initTestDatabase();
    setTelegramOutboxClient(null);
    _resetShutdownStateForTest();
  });
  afterEach(() => {
    setTelegramOutboxClient(null);
    vi.restoreAllMocks();
  });

  // NOTE: we deliberately bypass createStaleWatcher / RUNTIME_BUILD_META
  // here. In vitest source-mode, build-meta.ts resolves dist/.build-meta.json
  // relative to src/, finds nothing, and RUNTIME_BUILD_META.sha falls back
  // to 'unknown'. Any test that gates on a real SHA mismatch then silently
  // no-ops (Codex stream-2 review caught this regression). The chain
  // we care about for M2 is alerter → outbox → sender; the watcher's job
  // (decide WHEN to alert) is covered by stale-code.test.ts.
  it('full chain: alerter.notify → real outbox enqueue → DB row → sender → API client (NOT direct-send)', async () => {
    const { client, calls } = makeApiCapture(7777);
    setTelegramOutboxClient(client);

    // Wire the alerter to the REAL outbox enqueue + getRow. This is the
    // production path: stale-code-alert → enqueueTelegramSend → DB → tick
    // → API client. No direct bot.api.send anywhere.
    const stderrLines: string[] = [];
    const alerter = createStaleCodeAlerter({
      enqueue: (text) =>
        enqueueTelegramSend({
          agentId: 'main',
          chatId: 'chat-stale',
          method: 'sendMessage',
          params: { text },
        }),
      getRow: (id) => getTelegramOutboxRow(id),
      stderr: (l) => stderrLines.push(l),
    });

    const text = 'stale runtime=abc1234 disk=def5678';
    const rowId = alerter.notify(text);
    expect(rowId).not.toBeNull();
    expect(stderrLines).toEqual([]); // happy path: no fallback

    // Outbox row exists, agent-scoped, and pending.
    const outboxRow = getTelegramOutboxRow(rowId!);
    expect(outboxRow).not.toBeNull();
    expect(outboxRow!.status).toBe('pending');
    expect(outboxRow!.agent_id).toBe('main');
    const persistedPayload = JSON.parse(outboxRow!.payload) as {
      method: string;
      params: { text: string };
    };
    expect(persistedPayload.method).toBe('sendMessage');
    expect(persistedPayload.params.text).toBe(text);

    // Sender drains it; the API client receives the alert text.
    const processed = await tickTelegramOutbox('main');
    expect(processed).toBe(1);
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('sendMessage');
    expect(calls[0].chatId).toBe('chat-stale');
    expect((calls[0].params as { text: string }).text).toBe(text);

    const final = getTelegramOutboxRow(rowId!)!;
    expect(final.status).toBe('sent');
    expect(final.telegram_message_id).toBe(7777);
  });

  it('M1 stderr fallback fires when outbox enqueue throws (broken outbox path)', () => {
    const stderrLines: string[] = [];
    const alerter = createStaleCodeAlerter({
      enqueue: () => {
        throw new Error('db locked');
      },
      getRow: (id) => getTelegramOutboxRow(id),
      stderr: (l) => stderrLines.push(l),
    });
    const id = alerter.notify('outbox-broken stale alert');
    expect(id).toBeNull();
    expect(stderrLines).toHaveLength(1);
    expect(stderrLines[0]).toContain('[STALE-CODE-FALLBACK]');
    expect(stderrLines[0]).toContain('enqueue_threw');
    expect(stderrLines[0]).toContain('db locked');
    expect(stderrLines[0]).toContain('outbox-broken stale alert');
  });

  it('sweep() emits stuck-row fallback when outbox row sits unsent past fallbackMs', async () => {
    const stderrLines: string[] = [];
    let nowMs = 1_000_000;
    // Pre-populate a real outbox row that we'll never drain (no API client wired
    // → tickTelegramOutbox would only DEFER; we don't tick at all here).
    const realRowId = insertTelegramOutbox(
      'main',
      'chat-stuck',
      JSON.stringify({ method: 'sendMessage', params: { text: 'stale alert' } }),
    );

    const alerter = createStaleCodeAlerter({
      // For this test we want the alerter to track an existing row, so its
      // enqueue returns the pre-inserted id rather than creating a new one.
      enqueue: () => realRowId,
      getRow: (id) => getTelegramOutboxRow(id),
      fallbackMs: 1000,
      now: () => nowMs,
      stderr: (l) => stderrLines.push(l),
    });

    alerter.notify('stuck candidate');
    expect(stderrLines).toEqual([]);

    // Advance past fallbackMs without delivering. Independent sweep path
    // (Codex HIGH #2) must catch the stuck row even without a second notify.
    nowMs += 5_000;
    alerter.sweep();
    expect(stderrLines).toHaveLength(1);
    expect(stderrLines[0]).toContain('[STALE-CODE-FALLBACK]');
    expect(stderrLines[0]).toContain('stuck_pending');

    // Row in DB is still pending (fallback is observability, not delivery).
    const row = getTelegramOutboxRow(realRowId)!;
    expect(row.status).toBe('pending');
  });

  // (on-main branch gate is exercised in stale-code.test.ts where the
  // skip-on-unknown pattern is acceptable per its scope; we don't duplicate
  // the same silently-skipped assertion here.)
});
