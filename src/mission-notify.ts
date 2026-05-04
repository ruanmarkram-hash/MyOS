/**
 * Mission task completion notifier.
 *
 * When a mission task is created with `--notify-on-done`, the scheduler
 * fires a Telegram ping via scripts/notify.sh once the task transitions
 * to a terminal state (completed | failed | timed_out). The DB column
 * `mission_tasks.notified_at` provides the idempotency guard.
 */
// SAFE-SPAWN-EXEMPT: notify.sh operator script. KNOWN LEAK — inherits process.env to bash. Args are server-controlled (notify-on-done state machine), not LLM-controlled. Scheduled for Part-3 migration via safeSpawn(envClass: 'shell-task').
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

import {
  type MissionTask,
  getLatestChatIdForAgent,
  markMissionNotified,
} from './db.js';
import { logger } from './logger.js';

export type MissionTerminalState = 'completed' | 'failed' | 'timed_out';

const STATE_EMOJI: Record<MissionTerminalState, string> = {
  completed: '✓',
  failed: '✗',
  timed_out: '⏱',
};

/** Build the one-liner shipped to Telegram. Exported for unit testing. */
export function formatNotifyMessage(
  task: Pick<MissionTask, 'created_by' | 'title' | 'result' | 'error'>,
  state: MissionTerminalState,
  detail?: string,
): string {
  const emoji = STATE_EMOJI[state];
  const snippet = (detail ?? task.result ?? task.error ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
  const tail = snippet ? `: ${snippet}` : '';
  return `[${task.created_by} ${emoji}] ${task.title}${tail}`;
}

/**
 * Locate scripts/notify.sh relative to this module.
 * dist/mission-notify.js → ../scripts/notify.sh
 */
function resolveNotifyScript(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '..', 'scripts', 'notify.sh');
}

/** Indirection to allow tests to swap the spawn behaviour. */
export type NotifySpawn = (script: string, args: string[]) => void;

const defaultSpawn: NotifySpawn = (script, args) => {
  // SAFE-SPAWN-EXEMPT: notify.sh dispatch — TODO Part-3 migrate to safeSpawn with shell-task env scrub.
  const child = spawn('bash', [script, ...args], { stdio: 'ignore', detached: true });
  child.on('error', (err) => logger.warn({ err }, 'notify.sh spawn failed'));
  child.unref();
};

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
 *
 * Returns true iff a ping was actually dispatched.
 */
export function notifyMissionDone(
  task: MissionTask,
  state: MissionTerminalState,
  detail?: string,
): boolean {
  if (!task.notify_on_done) return false;
  if (task.notified_at) return false;
  // Conditional UPDATE is the real idempotency guard — wins races with
  // the in-memory check above.
  if (!markMissionNotified(task.id)) return false;

  const message = formatNotifyMessage(task, state, detail);
  const chatId = getLatestChatIdForAgent(task.created_by);
  const args = chatId ? [message, chatId] : [message];
  try {
    spawnImpl(resolveNotifyScript(), args);
  } catch (err) {
    logger.warn({ err, missionId: task.id }, 'notifyMissionDone: spawn threw');
    return false;
  }
  logger.info({ missionId: task.id, state, agent: task.created_by, hasChatId: chatId !== null }, 'Mission notify dispatched');
  return true;
}
