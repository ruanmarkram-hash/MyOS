/**
 * Durable Telegram outbox.
 *
 * Telegram sends are fire-and-forget by default: when delivery fails,
 * the message is dropped with no retry. mission-notify solved this for
 * mission notifications via a delivered_at column + recovery sweep.
 * This module generalises the same durability pattern to ALL Telegram
 * sends.
 *
 * Flow:
 *   1. Caller invokes enqueueTelegramSend({...}) → INSERT into
 *      telegram_outbox with status='pending', returns row id immediately.
 *   2. The outbox worker (tickTelegramOutbox) is run periodically by
 *      scheduler.ts (every 5s). On each tick it claims due pending rows
 *      and calls the actual Telegram API.
 *   3. On success: status='sent', telegram_message_id is captured.
 *   4. On 429: parse parameters.retry_after, set next_retry_at = now + N.
 *   5. On other failure: exponential backoff capped at 1h.
 *   6. After MAX_ATTEMPTS consecutive failures: status='dead-lettered'
 *      and a meta-alert is enqueued (so the failure surfaces).
 *
 * Crash recovery falls out for free: pending rows survive process
 * restart and the very first tick after re-init picks them up.
 */

import {
  insertTelegramOutbox,
  claimDueTelegramOutbox,
  markTelegramOutboxSent,
  scheduleTelegramOutboxRetry,
  markTelegramOutboxDeadLettered,
  type TelegramOutboxRow,
} from './db.js';
import { logger } from './logger.js';
import { ALLOWED_CHAT_ID } from './config.js';

export type TelegramOutboxMethod = 'sendMessage' | 'sendDocument' | 'sendPhoto';

export interface EnqueueOptions {
  agentId: string;
  chatId: string;
  method: TelegramOutboxMethod;
  params: Record<string, unknown>;
}

/**
 * Test seam: the function the worker calls to actually hit the Telegram
 * API. Default implementation is set via `setTelegramOutboxClient` (wired
 * to the grammy bot.api at startup). Tests can swap it for a mock.
 *
 * Must return the Telegram message_id on success (when the API response
 * includes one, e.g. sendMessage/sendDocument/sendPhoto), or null when
 * the response shape doesn't carry one.
 *
 * On failure must throw. For rate-limit errors, the thrown error must
 * carry an `error_code === 429` and `parameters.retry_after` so the
 * worker can honour Telegram's instruction.
 */
export type TelegramApiClient = (
  method: TelegramOutboxMethod,
  chatId: string,
  params: Record<string, unknown>,
) => Promise<{ message_id?: number } | null>;

let apiClient: TelegramApiClient | null = null;

/**
 * Wire the outbox to the real Telegram API. Call once at bot startup.
 * Until this is called, ticks will mark rows as transient failures
 * (so nothing is lost; sends are simply held until the bot is ready).
 */
export function setTelegramOutboxClient(client: TelegramApiClient | null): void {
  apiClient = client;
}

/** @internal — for tests. */
export function _getTelegramOutboxClient(): TelegramApiClient | null {
  return apiClient;
}

const MAX_ATTEMPTS = 5;
const MAX_BACKOFF_SECONDS = 60 * 60; // 1 hour cap

/**
 * Enqueue a send. Returns the outbox row id. Never throws on the
 * Telegram API path — the worker handles all delivery errors.
 */
export function enqueueTelegramSend(opts: EnqueueOptions): number {
  const payload = JSON.stringify({ method: opts.method, params: opts.params });
  return insertTelegramOutbox(opts.agentId, opts.chatId, payload);
}

interface ParsedPayload {
  method: TelegramOutboxMethod;
  params: Record<string, unknown>;
}

function parsePayload(row: TelegramOutboxRow): ParsedPayload | null {
  try {
    const j = JSON.parse(row.payload) as ParsedPayload;
    if (!j || typeof j.method !== 'string') return null;
    return j;
  } catch {
    return null;
  }
}

interface RateLimitInfo {
  retryAfterSeconds: number;
}

function detectRateLimit(err: unknown): RateLimitInfo | null {
  if (err && typeof err === 'object') {
    const e = err as { error_code?: number; parameters?: { retry_after?: number } };
    if (e.error_code === 429) {
      const ra = e.parameters?.retry_after;
      // Default to 30s if Telegram didn't say
      return { retryAfterSeconds: typeof ra === 'number' && ra > 0 ? ra : 30 };
    }
  }
  return null;
}

function exponentialBackoffSeconds(attemptCount: number): number {
  // attemptCount is the count BEFORE this attempt. After a failure we'll
  // schedule using the new attempt count = attemptCount + 1, so use that
  // exponent. 2^1=2, 2^2=4, 2^3=8, 2^4=16, 2^5=32 ...
  const exp = Math.min(attemptCount + 1, 12); // 2^12 = 4096s ≈ 68min, cap below
  return Math.min(2 ** exp, MAX_BACKOFF_SECONDS);
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try { return JSON.stringify(err); } catch { return String(err); }
}

/**
 * Process all currently-due pending rows. Designed to be called every
 * few seconds from the scheduler. Returns the number of rows processed
 * (sent + failed + dead-lettered).
 */
export async function tickTelegramOutbox(): Promise<number> {
  const client = apiClient;
  const due = claimDueTelegramOutbox(20);
  if (due.length === 0) return 0;

  let processed = 0;
  for (const row of due) {
    const parsed = parsePayload(row);
    if (!parsed) {
      // Permanently malformed row — dead-letter immediately. Don't
      // recurse on the meta-alert here; just log and move on.
      markTelegramOutboxDeadLettered(row.id, 'malformed payload');
      logger.error({ rowId: row.id }, 'telegram-outbox: malformed payload, dead-lettered');
      processed++;
      continue;
    }

    if (!client) {
      // Client not yet wired — defer with a short backoff so we don't
      // spin. attempt_count is incremented but capped via the same
      // dead-letter path; in practice the bot wires the client at
      // startup before the first tick.
      const nextRetry = Math.floor(Date.now() / 1000) + 5;
      scheduleTelegramOutboxRetry(row.id, nextRetry, 'outbox client not yet wired');
      processed++;
      continue;
    }

    try {
      const resp = await client(parsed.method, row.chat_id, parsed.params);
      const messageId = resp && typeof resp.message_id === 'number' ? resp.message_id : null;
      markTelegramOutboxSent(row.id, messageId);
      logger.info(
        { rowId: row.id, method: parsed.method, messageId, attempts: row.attempt_count + 1 },
        'telegram-outbox: delivered',
      );
    } catch (err) {
      const rate = detectRateLimit(err);
      const newAttemptCount = row.attempt_count + 1;
      const errMsg = errorMessage(err);

      if (newAttemptCount >= MAX_ATTEMPTS && !rate) {
        // Don't dead-letter on a 429 — those are throttling, not
        // permanent failures.
        markTelegramOutboxDeadLettered(row.id, errMsg);
        emitDeadLetterMetaAlert(row, errMsg);
        logger.error(
          { rowId: row.id, agentId: row.agent_id, attempts: newAttemptCount, err: errMsg },
          'telegram-outbox: dead-lettered after max attempts',
        );
      } else {
        const delaySeconds = rate
          ? rate.retryAfterSeconds
          : exponentialBackoffSeconds(row.attempt_count);
        const nextRetry = Math.floor(Date.now() / 1000) + delaySeconds;
        scheduleTelegramOutboxRetry(row.id, nextRetry, errMsg);
        logger.warn(
          { rowId: row.id, attempts: newAttemptCount, delaySeconds, rate429: !!rate, err: errMsg },
          'telegram-outbox: scheduling retry',
        );
      }
    }
    processed++;
  }

  return processed;
}

/**
 * Enqueue a meta-alert when a row hits dead-letter. Best-effort: if
 * ALLOWED_CHAT_ID is unset, we just log. Note the meta-alert ALSO goes
 * through the outbox, so if Telegram is genuinely down both messages
 * sit pending until it recovers. The point is to surface the failure
 * once, not to add a parallel emergency channel.
 */
function emitDeadLetterMetaAlert(row: TelegramOutboxRow, lastError: string): void {
  // Always log to console — a dead-letter is a real signal even if the
  // meta-alert itself never makes it out.
  // eslint-disable-next-line no-console
  console.error(
    `[telegram-outbox] DEAD-LETTER agent=${row.agent_id} row=${row.id} err=${lastError.slice(0, 200)}`,
  );

  if (!ALLOWED_CHAT_ID) return;

  // Avoid an infinite recursion on a bad ALLOWED_CHAT_ID: if a
  // meta-alert itself dead-letters we'll see it in logs but won't
  // enqueue another meta-meta-alert (the row's payload would already
  // be tagged below; check before enqueuing).
  try {
    const isMetaAlready = row.payload.includes('"__meta_alert":true');
    if (isMetaAlready) {
      logger.error({ rowId: row.id }, 'telegram-outbox: meta-alert itself dead-lettered, suppressing recursion');
      return;
    }

    enqueueTelegramSend({
      agentId: row.agent_id,
      chatId: String(ALLOWED_CHAT_ID),
      method: 'sendMessage',
      params: {
        text: `Outbox dead-letter for agent ${row.agent_id} / row ${row.id} / err ${lastError.slice(0, 200)}`,
        __meta_alert: true,
      },
    });
  } catch (err) {
    logger.error({ err, rowId: row.id }, 'telegram-outbox: failed to enqueue meta-alert');
  }
}

/** @internal — exposed for tests. */
export const _internals = {
  exponentialBackoffSeconds,
  detectRateLimit,
  MAX_ATTEMPTS,
  MAX_BACKOFF_SECONDS,
};
