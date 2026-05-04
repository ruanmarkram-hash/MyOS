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
  sweepStalledTelegramOutboxLeases,
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
/** Telegram occasionally returns retry_after values that are absurdly
 * long (24h has been observed when accounts are flagged). Clamp to a
 * sane upper bound — we'd rather poke the API again in 15min than sit
 * silent for a day. */
const MAX_RETRY_AFTER_SECONDS = 15 * 60;
/** Independent cap for 429-only dead-lettering. Real Telegram throttles
 * resolve in seconds-to-minutes; 10 retries with backoff buys us hours
 * of patience before we give up. Generic-error MAX_ATTEMPTS still
 * applies first (whichever fires earliest wins). */
const MAX_429_ATTEMPTS = 10;

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
      const raw = e.parameters?.retry_after;
      // Default to 30s if Telegram didn't say
      const requested = typeof raw === 'number' && raw > 0 ? raw : 30;
      const clamped = Math.min(requested, MAX_RETRY_AFTER_SECONDS);
      if (clamped !== requested) {
        logger.warn(
          { requestedRetryAfter: requested, clampedTo: clamped },
          'telegram-outbox: clamping absurd retry_after',
        );
      }
      return { retryAfterSeconds: clamped };
    }
  }
  return null;
}

function exponentialBackoffSeconds(attemptCount: number): number {
  // attemptCount is the count BEFORE this attempt. After a failure we'll
  // schedule using the new attempt count = attemptCount + 1, so use that
  // exponent. 2^1=2, 2^2=4, 2^3=8, 2^4=16, 2^5=32 ...
  // Guard against negative attempt_count (manually-set or corrupted).
  const safe = Math.max(0, attemptCount);
  const exp = Math.min(safe + 1, 12); // 2^12 = 4096s ≈ 68min, cap below
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

  // Recovery sweep: if a previous worker crashed mid-send, its claimed
  // rows sit in 'in_flight' with an expired lease. Reset them to
  // 'pending' so we re-attempt delivery on this tick.
  const recovered = sweepStalledTelegramOutboxLeases();
  if (recovered > 0) {
    logger.warn({ recovered }, 'telegram-outbox: recovered stalled in_flight rows');
  }

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

      const hitGenericCap = !rate && newAttemptCount >= MAX_ATTEMPTS;
      // Eventually dead-letter persistent 429s too: real throttles
      // resolve within minutes, but a bot that's been outright banned
      // or a malformed chat target can return 429 forever.
      const hit429Cap = !!rate && newAttemptCount >= MAX_429_ATTEMPTS;
      if (hitGenericCap || hit429Cap) {
        markTelegramOutboxDeadLettered(row.id, errMsg);
        emitDeadLetterMetaAlert(row, errMsg);
        logger.error(
          { rowId: row.id, agentId: row.agent_id, attempts: newAttemptCount, err: errMsg, rate429: !!rate },
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
 * Surface a dead-letter via three independent channels, in order of
 * how-likely-to-fail:
 *   1. stderr — always, unconditionally. If everything else is broken
 *      the operator still has a log line.
 *   2. structured logger — survives even if stderr is redirected.
 *   3. DIRECT bot.api send — bypasses the outbox so a broken outbox
 *      (DB write failure, bad CAS, etc.) can still produce an alert.
 *      If THIS fails too, we log the secondary failure and stop —
 *      we never re-queue a meta-alert through the outbox itself
 *      (would just dead-letter recursively).
 */
function emitDeadLetterMetaAlert(row: TelegramOutboxRow, lastError: string): void {
  // (1) Unconditional stderr — the lowest-common-denominator signal.
  // eslint-disable-next-line no-console
  console.error(
    `[telegram-outbox] DEAD-LETTER agent=${row.agent_id} row=${row.id} err=${lastError.slice(0, 200)}`,
  );

  // (2) Structured logger — visible in pino/JSON pipelines.
  logger.error(
    { rowId: row.id, agentId: row.agent_id, err: lastError.slice(0, 200) },
    'telegram-outbox: DEAD-LETTER',
  );

  if (!ALLOWED_CHAT_ID) return;

  // Suppress meta-meta-alert: if the dead-lettered row IS itself a
  // meta-alert we already failed to deliver, don't try again.
  if (row.payload.includes('"__meta_alert":true')) {
    logger.error({ rowId: row.id }, 'telegram-outbox: meta-alert itself dead-lettered, suppressing recursion');
    return;
  }

  // (3) Direct send — bypass the outbox entirely. If the outbox
  // machinery is what's broken (bad DB, schema mismatch, CAS bug),
  // routing the meta-alert through it would make it disappear too.
  const client = apiClient;
  if (!client) {
    logger.error({ rowId: row.id }, 'telegram-outbox: no client wired, cannot direct-send meta-alert');
    return;
  }
  const text = `⚠️ Outbox DEAD-LETTER agent=${row.agent_id} row=${row.id} err=${lastError.slice(0, 200)}`;
  // Fire-and-forget; we've already logged via (1) and (2) so even if
  // this rejects we lose nothing additional.
  void client('sendMessage', String(ALLOWED_CHAT_ID), { text, __meta_alert: true }).catch((err) => {
    logger.error({ err, rowId: row.id }, 'telegram-outbox: direct meta-alert send failed');
    // eslint-disable-next-line no-console
    console.error(`[telegram-outbox] meta-alert direct send FAILED row=${row.id}: ${errorMessage(err)}`);
  });
}

/** @internal — exposed for tests. */
export const _internals = {
  exponentialBackoffSeconds,
  detectRateLimit,
  MAX_ATTEMPTS,
  MAX_BACKOFF_SECONDS,
  MAX_RETRY_AFTER_SECONDS,
  MAX_429_ATTEMPTS,
};
