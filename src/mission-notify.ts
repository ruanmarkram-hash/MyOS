/**
 * Mission task completion notifier.
 *
 * When a mission task is created with `--notify-on-done`, the scheduler
 * fires a Telegram ping via scripts/notify.sh once the task transitions
 * to a terminal state (completed | failed | timed_out). The DB column
 * `mission_tasks.notified_at` provides the idempotency guard.
 *
 * Durability rules (locked 2026-05-04):
 *   1. notified_at is set BEFORE spawn (claim) and CLEARED on non-zero exit
 *      so the recovery sweep can retry.
 *   2. spawn is awaited with a 10s timeout; the scheduler does not block
 *      indefinitely on a hung curl.
 *   3. Untrusted task fields (title, result, error) are HTML-escaped because
 *      notify.sh sends with parse_mode=HTML.
 *   4. Missing chat_id is logged and the task is marked notified to prevent
 *      a tight retry loop. Trade-off: the user does not see the message,
 *      but `unrouted_at` semantics live in the log only (no schema bloat).
 */
// SAFE-SPAWN-EXEMPT: notify.sh operator script. KNOWN LEAK — inherits process.env to bash. Args are server-controlled (notify-on-done state machine), not LLM-controlled. Scheduled for Part-3 migration via safeSpawn(envClass: 'shell-task').
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

import {
  type MissionTask,
  getLatestChatIdForAgent,
  markMissionNotified,
  resetMissionNotified,
} from './db.js';
import { logger } from './logger.js';

export type MissionTerminalState = 'completed' | 'failed' | 'timed_out';

const STATE_EMOJI: Record<MissionTerminalState, string> = {
  completed: '✓',
  failed: '✗',
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
): string {
  const emoji = STATE_EMOJI[state];
  const rawSnippet = (detail ?? task.result ?? task.error ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
  const title = escapeTelegramHtml(task.title);
  const snippet = escapeTelegramHtml(rawSnippet);
  const createdBy = escapeTelegramHtml(task.created_by);
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
 *   - task.notified_at was already set (markMissionNotified returns false)
 *   - getLatestChatIdForAgent returns null (we mark notified to break the
 *     retry loop, since we have no destination)
 *
 * Returns true iff a ping was actually delivered (notify.sh exit 0).
 */
export async function notifyMissionDone(
  task: MissionTask,
  state: MissionTerminalState,
  detail?: string,
): Promise<boolean> {
  if (!task.notify_on_done) return false;
  if (task.notified_at) return false;

  const chatId = getLatestChatIdForAgent(task.created_by);
  if (chatId === null) {
    // No session ever recorded for this agent ⇒ no chat to deliver to.
    // Mark the task notified to stop the recovery sweep from looping forever
    // on a permanently undeliverable row. Trade-off documented at top of file.
    if (markMissionNotified(task.id)) {
      logger.warn(
        { missionId: task.id, agent: task.created_by },
        'notify: no chat_id for agent, skipping delivery and marking notified',
      );
    }
    return false;
  }

  // Conditional UPDATE is the real idempotency guard — wins races with
  // the in-memory check above. We claim the slot, then release it on
  // delivery failure so the recovery sweep can retry.
  if (!markMissionNotified(task.id)) return false;

  const message = formatNotifyMessage(task, state, detail);
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
      'notifyMissionDone: notify.sh failed, releasing claim for retry',
    );
    resetMissionNotified(task.id);
    return false;
  }

  logger.info(
    { missionId: task.id, state, agent: task.created_by },
    'Mission notify delivered',
  );
  return true;
}
