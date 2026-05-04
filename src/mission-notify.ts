/**
 * Mission task completion notifier.
 *
 * When a mission task is created with `--notify-on-done`, the scheduler
 * fires a Telegram ping via scripts/notify.sh once the task transitions
 * to a terminal state (completed | failed | timed_out). The DB column
 * `mission_tasks.notified_at` provides the idempotency guard.
 *
 * Durability rules (locked 2026-05-04, hardened post-Codex 2026-05-04,
 * contract clarified 2026-05-05 after Mason's M2 chain-test review):
 *   1. Two timestamps split the lifecycle:
 *        notified_at  = claim (set before spawn, prevents concurrent re-fire)
 *        delivered_at = HANDED OFF TO DURABLE TELEGRAM OUTBOX. Originally
 *                       this meant "Telegram acked HTTP 200 + ok:true",
 *                       but since the outbox migration (098768e), durable
 *                       delivery is the OUTBOX's responsibility. We stamp
 *                       delivered_at when enqueueTelegramSend succeeds —
 *                       i.e. when the row is in telegram_outbox with
 *                       status='pending'. From there the outbox worker
 *                       handles retries, dead-letters, and the meta-alert
 *                       on failure. The outbox is the source of truth for
 *                       actual Telegram delivery; this column means
 *                       "successfully handed off to durable storage".
 *      This is still recoverable across crashes: the sweep filters on
 *      `delivered_at IS NULL`, so a row whose enqueue threw (DB locked,
 *      table missing) is replayed by the next sweep. The narrower window
 *      it no longer covers — outbox accepted the row but worker never
 *      drained — is covered by the outbox's own dead-letter alert path.
 *   2. spawn is awaited with a 10s timeout; the scheduler does not block
 *      indefinitely on a hung curl. (notify.sh is now a fallback path
 *      only, used when the outbox enqueue itself throws.)
 *   3. Untrusted task fields (title, result, error) are HTML-escaped because
 *      notify.sh sends with parse_mode=HTML.
 *   4. Missing chat_id is logged and the task is marked DELIVERED to prevent
 *      a tight retry loop. Trade-off: the user does not see the message,
 *      but `unrouted_at` semantics live in the log only (no schema bloat).
 *   5. Bounded retry: notify_attempt_count is incremented on every claim;
 *      the sweep stops re-claiming once it crosses the cap (5 by default).
 */
// SAFE-SPAWN-EXEMPT: notify.sh operator script. KNOWN LEAK — inherits process.env to bash. Args are server-controlled (notify-on-done state machine), not LLM-controlled. Scheduled for Part-3 migration via safeSpawn(envClass: 'shell-task').
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

import {
  type MissionTask,
  getLatestChatIdForAgent,
  markMissionDelivered,
  markMissionNotified,
  resetMissionNotified,
} from './db.js';
import { logger } from './logger.js';
import { enqueueTelegramSend } from './telegram-outbox.js';

export type MissionTerminalState = 'completed' | 'failed' | 'partial' | 'timed_out';

const STATE_EMOJI: Record<MissionTerminalState, string> = {
  completed: '✓',
  failed: '✗',
  partial: '⚠️',
  timed_out: '⏱',
};

/** Cap on how long we'll wait for notify.sh to finish before killing it. */
const NOTIFY_TIMEOUT_MS = 10_000;

/**
 * Escape the five characters Telegram's HTML parse mode treats as markup.
 * Without this, a task title or result containing `<a href="evil">click</a>`
 * renders as a real link in Ruan's chat.
 *
 * Telegram only requires `&`, `<`, `>` to be escaped in text bodies; quotes
 * are escaped defensively to keep the output safe if the message is ever
 * embedded inside an attribute (e.g. for inline keyboard captions).
 */
export function escapeTelegramHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Build the one-liner shipped to Telegram. Exported for unit testing. */
export function formatNotifyMessage(
  task: Pick<MissionTask, 'created_by' | 'title' | 'result' | 'error'>,
  state: MissionTerminalState,
  detail?: string,
  opts?: { commitCount?: number },
): string {
  const emoji = STATE_EMOJI[state];
  const title = escapeTelegramHtml(task.title);
  const createdBy = escapeTelegramHtml(task.created_by);

  // Partial uses a distinct body that surfaces the commit count so the
  // user immediately knows real work landed before the agent ran out of
  // turns. Avoids the failure-loop confusion of marking "ran out of
  // budget but committed N changes" as a flat 'failed'.
  if (state === 'partial') {
    const n = opts?.commitCount ?? 0;
    const verb = n === 1 ? 'change' : 'changes';
    return `[${createdBy} ${emoji}] ${title} — partial: ran out of turns but committed ${n} ${verb}; review and re-dispatch if needed`;
  }

  const rawSnippet = (detail ?? task.result ?? task.error ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
  const snippet = escapeTelegramHtml(rawSnippet);
  const tail = snippet ? `: ${snippet}` : '';
  return `[${createdBy} ${emoji}] ${title}${tail}`;
}

/**
 * Locate scripts/notify.sh relative to this module.
 * dist/mission-notify.js → ../scripts/notify.sh
 */
function resolveNotifyScript(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '..', 'scripts', 'notify.sh');
}

/**
 * Test seam: spawn notify.sh and resolve with the exit code (or a
 * synthetic non-zero code on error/timeout).
 */
export type NotifySpawn = (script: string, args: string[]) => Promise<number>;

const defaultSpawn: NotifySpawn = (script, args) =>
  new Promise<number>((resolve) => {
    // SAFE-SPAWN-EXEMPT: notify.sh dispatch — TODO Part-3 migrate to safeSpawn with shell-task env scrub.
    const child = spawn('bash', [script, ...args], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
      // Cap accumulated stderr so a chatty failure doesn't OOM us.
      if (stderr.length > 4000) stderr = stderr.slice(0, 4000);
    });
    let resolved = false;
    const finish = (code: number, reason?: string): void => {
      if (resolved) return;
      resolved = true;
      if (code !== 0) {
        logger.warn({ code, reason, stderr }, 'notify.sh exited non-zero');
      }
      resolve(code);
    };
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* already dead */ }
      finish(124, 'timeout');
    }, NOTIFY_TIMEOUT_MS);
    child.on('error', (err) => {
      clearTimeout(timer);
      logger.warn({ err }, 'notify.sh spawn failed');
      finish(127, 'spawn-error');
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      finish(code ?? 1);
    });
  });

let spawnImpl: NotifySpawn = defaultSpawn;

/** @internal — test seam. */
export function _setNotifySpawn(impl: NotifySpawn | null): void {
  spawnImpl = impl ?? defaultSpawn;
}

/**
 * Fire a Telegram ping for a finished mission task.
 *
 * No-op when:
 *   - task.notify_on_done is falsy
 *   - task.delivered_at was already set (durable success)
 *   - markMissionNotified loses the claim race
 *   - getLatestChatIdForAgent returns null (we mark delivered to break the
 *     retry loop, since we have no destination)
 *
 * Returns true iff a ping was actually delivered (notify.sh exit 0 AND
 * Telegram returned ok:true).
 */
export async function notifyMissionDone(
  task: MissionTask,
  state: MissionTerminalState,
  detail?: string,
  opts?: { commitCount?: number },
): Promise<boolean> {
  if (!task.notify_on_done) return false;
  // delivered_at is the durable success marker. notified_at by itself is
  // only a claim — a row with notified_at set but delivered_at NULL is a
  // crash-mid-spawn that we want to recover.
  if (task.delivered_at) return false;

  const chatId = getLatestChatIdForAgent(task.created_by);
  if (chatId === null) {
    // No session ever recorded for this agent ⇒ no chat to deliver to.
    // Stamp delivered_at directly so the recovery sweep stops looping on
    // a permanently undeliverable row. Trade-off documented at top of file.
    markMissionDelivered(task.id);
    logger.warn(
      { missionId: task.id, agent: task.created_by },
      'notify: no chat_id for agent, marking delivered to stop retry loop',
    );
    return false;
  }

  // Claim filter is `delivered_at IS NULL`, so the recovery sweep can
  // re-claim a row whose previous claim never reached delivery. The
  // attempt counter bumps on every claim and caps unbounded retries.
  if (!markMissionNotified(task.id)) return false;

  const message = formatNotifyMessage(task, state, detail, opts);

  // Primary path: enqueue into the durable Telegram outbox. The outbox
  // worker handles retries, 429 backoff, and dead-letter alerts — so we
  // can stamp delivered_at as soon as the row is queued. If the bot
  // process dies before the worker drains the queue, the row survives
  // restart and the worker's first tick picks it up.
  //
  // notify.sh remains as a fallback for the rare case where DB writes
  // fail (e.g. disk full mid-INSERT). It is no longer the primary path.
  try {
    enqueueTelegramSend({
      agentId: task.created_by,
      chatId,
      method: 'sendMessage',
      params: { text: message, parse_mode: 'HTML' },
    });
    markMissionDelivered(task.id);
    logger.info(
      { missionId: task.id, state, agent: task.created_by },
      'Mission notify enqueued to durable outbox',
    );
    return true;
  } catch (err) {
    logger.warn(
      { err, missionId: task.id },
      'notifyMissionDone: outbox enqueue failed, falling back to notify.sh',
    );
  }

  // Fallback: legacy notify.sh spawn. Kept for systems without DB access
  // mid-flight (e.g. WAL contention, disk pressure). Will be retired
  // once outbox proves itself in production.
  let exitCode: number;
  try {
    exitCode = await spawnImpl(resolveNotifyScript(), [message, chatId]);
  } catch (err) {
    logger.warn({ err, missionId: task.id }, 'notifyMissionDone: spawn threw');
    resetMissionNotified(task.id);
    return false;
  }

  if (exitCode !== 0) {
    logger.warn(
      { missionId: task.id, exitCode, agent: task.created_by },
      'notifyMissionDone: notify.sh fallback failed, releasing claim for retry',
    );
    resetMissionNotified(task.id);
    return false;
  }

  markMissionDelivered(task.id);
  logger.info(
    { missionId: task.id, state, agent: task.created_by },
    'Mission notify delivered via notify.sh fallback',
  );
  return true;
}
