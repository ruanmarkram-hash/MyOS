/**
 * Operation notifications: durable replacement for ScheduleWakeup.
 *
 * The problem: Sage and other agents repeatedly promise "I'll check back in
 * X minutes" using ScheduleWakeup. ScheduleWakeup is cancelled the instant
 * the user replies, so those check-backs never fire. Anything self-paced
 * across more than one user turn is structurally unreliable.
 *
 * The fix: persist the intent as a DB row in `operation_notifications`. The
 * main scheduler tick reads pending rows whose fire_at has passed, dispatches
 * the message via Telegram, and stamps status='fired'. The row survives the
 * agent's session ending, the bot restarting, and arbitrary user replies.
 *
 * Cancellation is keyed on a caller-supplied `operationId` so the originator
 * can drop the reminder when the operation it was watching completes early.
 *
 * Delivery channel: today we shell out to scripts/notify.sh (same path as
 * mission-notify). When Mission B's telegram-outbox lands it can be swapped
 * in here without changing the public API or schema — payload is already
 * stored as a JSON `{ method, params }` envelope to match the outbox shape.
 */
// SAFE-SPAWN-EXEMPT: notify.sh operator script. Args are server-controlled
// (text we composed from a stored payload) — not LLM-controlled at fire time.
// Tracked alongside mission-notify for the Part-3 safeSpawn migration.
// SAFE-SPAWN-EXEMPT: see file header — same operator-script dispatch as mission-notify.
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

import {
  cancelOperationNotificationsByOpId,
  claimOperationNotification,
  getDueOperationNotifications,
  insertOperationNotification,
  type OperationNotificationRow,
} from './db.js';
import { logger } from './logger.js';

/** Wire-format stored in `operation_notifications.payload`. */
export interface OperationNotificationPayload {
  /** Telegram Bot API method. Today only sendMessage is used. */
  method: 'sendMessage';
  params: {
    text: string;
  };
}

const NOTIFY_TIMEOUT_MS = 10_000;

export type NotifySpawn = (script: string, args: string[]) => Promise<number>;

const defaultSpawn: NotifySpawn = (script, args) =>
  new Promise<number>((resolve) => {
    // SAFE-SPAWN-EXEMPT: see file header.
    const child = spawn('bash', [script, ...args], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
      if (stderr.length > 4000) stderr = stderr.slice(0, 4000);
    });
    let resolved = false;
    const finish = (code: number, reason?: string): void => {
      if (resolved) return;
      resolved = true;
      if (code !== 0) {
        logger.warn({ code, reason, stderr }, 'operation-notify: notify.sh exited non-zero');
      }
      resolve(code);
    };
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* already dead */ }
      finish(124, 'timeout');
    }, NOTIFY_TIMEOUT_MS);
    child.on('error', (err) => {
      clearTimeout(timer);
      logger.warn({ err }, 'operation-notify: notify.sh spawn failed');
      finish(127, 'spawn-error');
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      finish(code ?? 1);
    });
  });

let spawnImpl: NotifySpawn = defaultSpawn;

/** @internal — test seam. */
export function _setOperationNotifySpawn(impl: NotifySpawn | null): void {
  spawnImpl = impl ?? defaultSpawn;
}

function resolveNotifyScript(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '..', 'scripts', 'notify.sh');
}

/**
 * Enqueue a durable notification. Returns the new row id.
 *
 * `operationId` is a caller-supplied scoping key. Multiple rows can share an
 * operationId (e.g. a chain of progressive reminders); cancelling the id
 * cancels all pending rows for it in one shot.
 *
 * The function is intentionally synchronous: it's a single INSERT, and
 * callers commonly fire-and-forget right before the agent yields its turn.
 */
export function scheduleOperationNotification(opts: {
  agentId: string;
  chatId: string;
  operationId: string;
  fireAt: Date;
  message: string;
}): number {
  if (!opts.agentId) throw new Error('scheduleOperationNotification: agentId required');
  if (!opts.chatId) throw new Error('scheduleOperationNotification: chatId required');
  if (!opts.operationId) throw new Error('scheduleOperationNotification: operationId required');
  if (opts.operationId.length > 256) {
    throw new Error('scheduleOperationNotification: operationId exceeds 256 chars');
  }
  if (!(opts.fireAt instanceof Date) || Number.isNaN(opts.fireAt.getTime())) {
    throw new Error('scheduleOperationNotification: fireAt must be a valid Date');
  }
  // Reject absurd timestamps. fireAt must be in the next 1 year window
  // (negative or >1y future is almost certainly a caller bug, not a valid
  // long-running schedule). Past timestamps within 60s of now are ok —
  // those fire on the next worker tick.
  const fireAtSec = Math.floor(opts.fireAt.getTime() / 1000);
  const nowSec = Math.floor(Date.now() / 1000);
  const ONE_YEAR = 365 * 24 * 60 * 60;
  if (fireAtSec < nowSec - 60 || fireAtSec > nowSec + ONE_YEAR) {
    throw new Error(
      `scheduleOperationNotification: fireAt out of sane range (now+0..1y), got ${fireAtSec - nowSec}s offset`,
    );
  }
  const payload: OperationNotificationPayload = {
    method: 'sendMessage',
    params: { text: opts.message },
  };
  return insertOperationNotification({
    agentId: opts.agentId,
    chatId: opts.chatId,
    operationId: opts.operationId,
    fireAt: Math.floor(opts.fireAt.getTime() / 1000),
    payload: JSON.stringify(payload),
  });
}

/**
 * Cancel every pending notification for this operationId. Idempotent — a
 * second call is a no-op. Already-fired rows are not touched.
 */
export function cancelOperationNotification(operationId: string): void {
  const cancelled = cancelOperationNotificationsByOpId(operationId);
  if (cancelled > 0) {
    logger.info({ operationId, cancelled }, 'operation-notify: cancelled pending rows');
  }
}

/**
 * Worker tick. Fires every pending row whose fire_at has passed.
 *
 * Concurrency: the claim is atomic via UPDATE ... WHERE status='pending', so
 * two overlapping ticks cannot deliver the same row twice. A row that fails
 * to deliver stays in status='fired' (we already won the claim) and is
 * logged — we do NOT retry, because the caller's intent was time-sensitive
 * and a stale ping hours later is worse than no ping. Mission B's outbox
 * will provide its own retry layer when wired in.
 */
export async function processDueOperationNotifications(now?: Date): Promise<number> {
  const cutoff = now ? Math.floor(now.getTime() / 1000) : Math.floor(Date.now() / 1000);
  const rows = getDueOperationNotifications(cutoff);
  if (rows.length === 0) return 0;
  let delivered = 0;
  for (const row of rows) {
    if (!claimOperationNotification(row.id)) continue; // lost the race
    const ok = await deliverOperationNotification(row);
    if (ok) delivered += 1;
  }
  return delivered;
}

async function deliverOperationNotification(row: OperationNotificationRow): Promise<boolean> {
  let payload: OperationNotificationPayload;
  try {
    payload = JSON.parse(row.payload) as OperationNotificationPayload;
  } catch (err) {
    logger.warn({ err, id: row.id }, 'operation-notify: payload JSON parse failed, dropping');
    return false;
  }
  if (payload.method !== 'sendMessage' || typeof payload.params?.text !== 'string') {
    logger.warn({ id: row.id, method: payload.method }, 'operation-notify: unsupported payload shape');
    return false;
  }
  if (!row.chat_id) {
    logger.warn({ id: row.id }, 'operation-notify: row missing chat_id, dropping');
    return false;
  }

  let exitCode: number;
  try {
    exitCode = await spawnImpl(resolveNotifyScript(), [payload.params.text, row.chat_id]);
  } catch (err) {
    logger.warn({ err, id: row.id }, 'operation-notify: spawn threw');
    return false;
  }

  if (exitCode !== 0) {
    logger.warn({ id: row.id, exitCode }, 'operation-notify: notify.sh failed (row stays fired, no retry)');
    return false;
  }
  logger.info(
    { id: row.id, opId: row.operation_id, agent: row.agent_id },
    'operation-notify: delivered',
  );
  return true;
}
