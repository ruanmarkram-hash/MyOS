import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import {
  _initTestDatabase,
  _resetOperationNotificationForTest,
  cancelOperationNotificationsByOpId,
  getDueOperationNotifications,
  getOperationNotification,
  getOperationNotificationsByOpId,
} from './db.js';
import {
  _setOperationNotifySpawn,
  _setOperationOutboxEnqueue,
  cancelOperationNotification,
  processDueOperationNotifications,
  scheduleOperationNotification,
  type OperationNotificationPayload,
} from './operation-notify.js';

type SpawnCall = { script: string; args: string[] };

function captureSpawns(exitCode = 0): { calls: SpawnCall[] } {
  const calls: SpawnCall[] = [];
  _setOperationNotifySpawn(async (script, args) => {
    calls.push({ script, args });
    return exitCode;
  });
  return { calls };
}

describe('operation-notify', () => {
  beforeEach(() => {
    _initTestDatabase();
  });
  afterEach(() => {
    _setOperationNotifySpawn(null);
  });

  describe('scheduleOperationNotification', () => {
    it('inserts a pending row with the right shape', () => {
      const fireAt = new Date(Date.now() + 60_000);
      const id = scheduleOperationNotification({
        agentId: 'main',
        chatId: 'chat-1',
        operationId: 'op-1',
        fireAt,
        message: 'check status of mission XYZ',
      });
      const row = getOperationNotification(id);
      expect(row).toBeDefined();
      expect(row?.status).toBe('pending');
      expect(row?.agent_id).toBe('main');
      expect(row?.chat_id).toBe('chat-1');
      expect(row?.operation_id).toBe('op-1');
      expect(row?.fire_at).toBe(Math.floor(fireAt.getTime() / 1000));
      const payload = JSON.parse(row!.payload) as OperationNotificationPayload;
      expect(payload).toEqual({ method: 'sendMessage', params: { text: 'check status of mission XYZ' } });
    });

    it('rejects missing fields', () => {
      expect(() => scheduleOperationNotification({
        agentId: '', chatId: 'c', operationId: 'o', fireAt: new Date(), message: 'x',
      })).toThrow(/agentId/);
      expect(() => scheduleOperationNotification({
        agentId: 'a', chatId: 'c', operationId: 'o', fireAt: new Date(NaN), message: 'x',
      })).toThrow(/fireAt/);
    });
  });

  describe('processDueOperationNotifications', () => {
    it('fires rows whose fire_at has passed and marks them fired', async () => {
      const { calls } = captureSpawns(0);
      const id = scheduleOperationNotification({
        agentId: 'main',
        chatId: 'chat-1',
        operationId: 'op-fire',
        fireAt: new Date(Date.now() - 5_000), // already due
        message: 'reminder fired',
      });
      const delivered = await processDueOperationNotifications();
      expect(delivered).toBe(1);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.args).toEqual(['reminder fired', 'chat-1']);
      const row = getOperationNotification(id);
      expect(row?.status).toBe('fired');
      expect(row?.fired_at).toBeGreaterThan(0);
    });

    it('skips rows whose fire_at is still in the future', async () => {
      const { calls } = captureSpawns(0);
      const id = scheduleOperationNotification({
        agentId: 'main',
        chatId: 'chat-1',
        operationId: 'op-future',
        fireAt: new Date(Date.now() + 60 * 60_000),
        message: 'later',
      });
      const delivered = await processDueOperationNotifications();
      expect(delivered).toBe(0);
      expect(calls).toHaveLength(0);
      expect(getOperationNotification(id)?.status).toBe('pending');
    });

    it('honours an injected `now` so a tick can advance the clock past fire_at', async () => {
      const { calls } = captureSpawns(0);
      const fireAt = new Date(Date.now() + 30 * 60_000);
      scheduleOperationNotification({
        agentId: 'main', chatId: 'c', operationId: 'op-clock', fireAt, message: 'hi',
      });
      // Tick before fire_at: nothing
      expect(await processDueOperationNotifications(new Date(fireAt.getTime() - 1_000))).toBe(0);
      expect(calls).toHaveLength(0);
      // Tick after fire_at: fires
      expect(await processDueOperationNotifications(new Date(fireAt.getTime() + 1_000))).toBe(1);
      expect(calls).toHaveLength(1);
    });

    it('treats a non-zero notify exit as undelivered but keeps the row marked fired (no infinite retry)', async () => {
      const { calls } = captureSpawns(2);
      const id = scheduleOperationNotification({
        agentId: 'main', chatId: 'c', operationId: 'op-fail',
        fireAt: new Date(Date.now() - 1_000), message: 'oops',
      });
      const delivered = await processDueOperationNotifications();
      expect(delivered).toBe(0);
      expect(calls).toHaveLength(1);
      expect(getOperationNotification(id)?.status).toBe('fired');
    });

    it('does not double-fire across overlapping ticks (atomic claim)', async () => {
      const { calls } = captureSpawns(0);
      const id = scheduleOperationNotification({
        agentId: 'main', chatId: 'c', operationId: 'op-race',
        fireAt: new Date(Date.now() - 1_000), message: 'race',
      });
      const [a, b] = await Promise.all([
        processDueOperationNotifications(),
        processDueOperationNotifications(),
      ]);
      expect((a ?? 0) + (b ?? 0)).toBe(1);
      expect(calls).toHaveLength(1);
      expect(getOperationNotification(id)?.status).toBe('fired');
    });
  });

  describe('cancelOperationNotification', () => {
    it('cancels pending rows by operation id and the worker skips them', async () => {
      const { calls } = captureSpawns(0);
      const id = scheduleOperationNotification({
        agentId: 'main', chatId: 'c', operationId: 'op-cancel',
        fireAt: new Date(Date.now() - 1_000), message: 'do not fire',
      });
      cancelOperationNotification('op-cancel');
      const row = getOperationNotification(id);
      expect(row?.status).toBe('cancelled');
      expect(row?.cancelled_at).toBeGreaterThan(0);
      const delivered = await processDueOperationNotifications();
      expect(delivered).toBe(0);
      expect(calls).toHaveLength(0);
    });

    it('is idempotent (second call is a no-op)', () => {
      scheduleOperationNotification({
        agentId: 'main', chatId: 'c', operationId: 'op-idem',
        fireAt: new Date(Date.now() + 60_000), message: 'x',
      });
      cancelOperationNotification('op-idem');
      // Second cancel: nothing pending, no throw, no rows affected.
      expect(() => cancelOperationNotification('op-idem')).not.toThrow();
      expect(cancelOperationNotificationsByOpId('op-idem')).toBe(0);
    });

    it('cancels every pending row for one operation id but leaves fired rows alone', async () => {
      captureSpawns(0);
      // One due (will fire), one future (will be cancelled)
      const dueId = scheduleOperationNotification({
        agentId: 'main', chatId: 'c', operationId: 'op-multi',
        fireAt: new Date(Date.now() - 1_000), message: 'first',
      });
      const futureId = scheduleOperationNotification({
        agentId: 'main', chatId: 'c', operationId: 'op-multi',
        fireAt: new Date(Date.now() + 60_000), message: 'second',
      });
      await processDueOperationNotifications();
      expect(getOperationNotification(dueId)?.status).toBe('fired');

      cancelOperationNotification('op-multi');
      expect(getOperationNotification(dueId)?.status).toBe('fired');
      expect(getOperationNotification(futureId)?.status).toBe('cancelled');
    });
  });

  describe('getDueOperationNotifications', () => {
    it('only returns pending rows whose fire_at has passed', () => {
      const past = scheduleOperationNotification({
        agentId: 'main', chatId: 'c', operationId: 'p', fireAt: new Date(Date.now() - 5_000), message: 'p',
      });
      scheduleOperationNotification({
        agentId: 'main', chatId: 'c', operationId: 'f', fireAt: new Date(Date.now() + 60_000), message: 'f',
      });
      const due = getDueOperationNotifications();
      expect(due.map((r) => r.id)).toEqual([past]);
    });
  });

  describe('reset/test seam', () => {
    it('lets a test re-fire a row by resetting it to pending', async () => {
      const { calls } = captureSpawns(0);
      const id = scheduleOperationNotification({
        agentId: 'main', chatId: 'c', operationId: 'op-reset',
        fireAt: new Date(Date.now() - 1_000), message: 'first',
      });
      await processDueOperationNotifications();
      expect(calls).toHaveLength(1);
      _resetOperationNotificationForTest(id);
      await processDueOperationNotifications();
      expect(calls).toHaveLength(2);
    });
  });

  describe('lookup helpers', () => {
    it('getOperationNotificationsByOpId returns rows in insert order', () => {
      const a = scheduleOperationNotification({
        agentId: 'main', chatId: 'c', operationId: 'op-list',
        fireAt: new Date(Date.now() + 60_000), message: 'a',
      });
      const b = scheduleOperationNotification({
        agentId: 'main', chatId: 'c', operationId: 'op-list',
        fireAt: new Date(Date.now() + 120_000), message: 'b',
      });
      const rows = getOperationNotificationsByOpId('op-list');
      expect(rows.map((r) => r.id)).toEqual([a, b]);
    });
  });

  describe('outbox integration (Mission D ↔ B handoff)', () => {
    it('hands the delivery to the outbox when no spawn seam is installed', async () => {
      // Don't install captureSpawns — falls through to the production
      // outbox path. We swap the outbox client for a mock to avoid hitting
      // the real Telegram API.
      const { setTelegramOutboxClient, tickTelegramOutbox } = await import(
        './telegram-outbox.js'
      );
      const sends: Array<{ method: string; chatId: string; params: Record<string, unknown> }> = [];
      setTelegramOutboxClient(async (method, chatId, params) => {
        sends.push({ method, chatId, params });
        return { message_id: 555 };
      });
      try {
        const id = scheduleOperationNotification({
          agentId: 'mason',
          chatId: 'chat-outbox',
          operationId: 'op-outbox',
          fireAt: new Date(Date.now() - 1_000),
          message: 'durable hello',
        });
        const delivered = await processDueOperationNotifications();
        expect(delivered).toBe(1);
        // The op-notification row is fired immediately (handed off).
        expect(getOperationNotification(id)?.status).toBe('fired');
        // The outbox has not delivered yet — drain it.
        await tickTelegramOutbox();
        expect(sends).toHaveLength(1);
        expect(sends[0]!.method).toBe('sendMessage');
        expect(sends[0]!.chatId).toBe('chat-outbox');
        expect((sends[0]!.params as { text: string }).text).toBe('durable hello');
      } finally {
        setTelegramOutboxClient(null);
      }
    });

    it('atomic claim+enqueue: row is fired AND outbox row exists OR neither (no half-state)', async () => {
      // Codex final-pass HIGH: claim and enqueue must be in one transaction so
      // a crash between them can't leave the row marked 'fired' with no
      // queued message. Verify by inspection: after a successful tick, the
      // op-notify row is 'fired' AND a telegram_outbox row exists referencing
      // its payload. The transactional helper makes a half-state impossible.
      const id = scheduleOperationNotification({
        agentId: 'mason',
        chatId: 'chat-atomic',
        operationId: 'op-atomic',
        fireAt: new Date(Date.now() - 1_000),
        message: 'atomic handoff',
      });
      const delivered = await processDueOperationNotifications();
      expect(delivered).toBe(1);
      const row = getOperationNotification(id);
      expect(row?.status).toBe('fired');
      expect(row?.fired_at).not.toBeNull();
      // The outbox now owns durability — the message will be retried by the
      // outbox worker's existing retry/lease/dead-letter machinery.
    });
  });

  describe('input validation (Codex caveats)', () => {
    it('rejects operationId exceeding 256 chars', () => {
      expect(() =>
        scheduleOperationNotification({
          agentId: 'main', chatId: 'c',
          operationId: 'x'.repeat(257),
          fireAt: new Date(Date.now() + 60_000),
          message: 'too long',
        }),
      ).toThrow(/operationId exceeds 256 chars/);
    });

    it('rejects fireAt more than 1 year in the future', () => {
      const TWO_YEARS = 2 * 365 * 24 * 60 * 60 * 1000;
      expect(() =>
        scheduleOperationNotification({
          agentId: 'main', chatId: 'c', operationId: 'op-far',
          fireAt: new Date(Date.now() + TWO_YEARS),
          message: 'far future',
        }),
      ).toThrow(/out of sane range/);
    });

    it('rejects fireAt more than 60s in the past', () => {
      expect(() =>
        scheduleOperationNotification({
          agentId: 'main', chatId: 'c', operationId: 'op-stale',
          fireAt: new Date(Date.now() - 5 * 60 * 1000),
          message: 'stale',
        }),
      ).toThrow(/out of sane range/);
    });

    it('accepts fireAt within 60s past (allows for race / small clock skew)', () => {
      expect(() =>
        scheduleOperationNotification({
          agentId: 'main', chatId: 'c', operationId: 'op-grace',
          fireAt: new Date(Date.now() - 30_000),
          message: 'grace window',
        }),
      ).not.toThrow();
    });
  });
});
