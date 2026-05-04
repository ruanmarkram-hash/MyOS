import { CronExpressionParser } from 'cron-parser';

import { AGENT_ID, ALLOWED_CHAT_ID, PROJECT_ROOT, agentCwd, agentMcpAllowlist } from './config.js';
import { safeSpawnSync } from './safe-spawn.js';
import {
  getDueTasks,
  getSession,
  logConversationTurn,
  markTaskRunning,
  updateTaskAfterRun,
  resetStuckTasks,
  claimNextMissionTask,
  completeMissionTask,
  resetStuckMissionTasks,
  getMissionTasksNeedingNotificationRecovery,
} from './db.js';
import type { MissionTerminalState } from './mission-notify.js';
import { logger } from './logger.js';
import { messageQueue } from './message-queue.js';
import { runAgentWithRetry } from './agent.js';
import { formatForTelegram, splitMessage } from './bot.js';
import { classifyTaskModel, modelTierLabel } from './task-model-classifier.js';
import { tryExtractShellCommand, runShellCommand } from './shell-task.js';
import { notifyMissionDone } from './mission-notify.js';
import { tickTelegramOutbox } from './telegram-outbox.js';
import { processDueOperationNotifications } from './operation-notify.js';

type Sender = (text: string) => Promise<void>;

/**
 * Max time (ms) a SCHEDULED task can run before being killed. Scheduled
 * tasks are short-lived heartbeats / health-checks / cron jobs by design;
 * if one hangs past 10 minutes it's broken.
 */
const TASK_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Max time (ms) a MISSION task can run before being killed. Missions
 * are full coding sessions (multi-file edits, tests, Codex adversarial
 * review) and routinely take 20-40 minutes of wall-clock time. The
 * historical 10-min cap (inherited from scheduled tasks) was killing
 * non-trivial work mid-flight before commit. Env-tunable for ops.
 */
const MISSION_TIMEOUT_MS = (() => {
  const raw = process.env.MISSION_TIMEOUT_MS;
  const parsed = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 45 * 60 * 1000;
})();
const MISSION_TIMEOUT_MIN = Math.round(MISSION_TIMEOUT_MS / 60_000);

let sender: Sender;

/**
 * In-memory set of task IDs currently being executed.
 * Acts as a fast-path guard alongside the DB-level lock in markTaskRunning.
 */
const runningTaskIds = new Set<string>();

/**
 * Initialise the scheduler. Call once after the Telegram bot is ready.
 * @param send  Function that sends a message to the user's Telegram chat.
 */
let schedulerAgentId = 'main';

export function initScheduler(send: Sender, agentId = 'main'): void {
  if (!ALLOWED_CHAT_ID) {
    logger.warn('ALLOWED_CHAT_ID not set — scheduler will not send results');
  }
  sender = send;
  schedulerAgentId = agentId;

  // Recover tasks stuck in 'running' from a previous crash
  const recovered = resetStuckTasks(agentId);
  if (recovered > 0) {
    logger.warn({ recovered, agentId }, 'Reset stuck tasks from previous crash');
  }
  const recoveredMission = resetStuckMissionTasks(agentId);
  if (recoveredMission > 0) {
    logger.warn({ recovered: recoveredMission, agentId }, 'Reset stuck mission tasks from previous crash');
  }

  // Recovery sweep: if the process died between completeMissionTask() and
  // notifyMissionDone() on a previous run, the row is in a terminal state
  // with delivered_at = NULL and the user never saw the message. Catch up.
  void recoverMissedMissionNotifications();
  lastRecoverySweep = Date.now();

  setInterval(() => void runDueTasks(), 60_000);

  // Telegram durable outbox worker. Runs more frequently than the task
  // tick because the user-facing latency budget is much tighter (a
  // dropped message that retries in 60s feels broken). 5s is the
  // recommended cadence; the worker is cheap when there's nothing due.
  setInterval(() => void runOutboxTick(), 5_000);

  // Operation notifications run on a tighter cadence (30s). They're a
  // user-promised "I'll check back in X minutes" — letting them slip a full
  // minute past fire_at would be noticeable.
  setInterval(() => {
    void processDueOperationNotifications().catch((err) => {
      logger.warn({ err }, 'operation-notify tick failed');
    });
  }, 30_000);

  logger.info({ agentId }, 'Scheduler started (tasks 60s, outbox 5s, op-notifications 30s)');
}

async function runOutboxTick(): Promise<void> {
  try {
    // Pass schedulerAgentId so the outbox claim scopes to THIS agent's
    // pending rows. Without it, every agent process races every other
    // for any pending row and delivers via the wrong bot token.
    await tickTelegramOutbox(schedulerAgentId);
  } catch (err) {
    logger.error({ err }, 'telegram-outbox tick failed');
  }
}

/** @internal — exposed for tests so they can drive a tick deterministically. */
export async function _runOutboxTickForTest(): Promise<void> {
  await runOutboxTick();
}

/**
 * Periodic recovery sweep cadence. Long-running processes need a within-run
 * retry path: if notify.sh fails after startup (e.g. transient Telegram
 * outage), the startup-only sweep wouldn't re-fire until the next process
 * restart. Five minutes is a balance between user latency and not hammering
 * a flapping API.
 */
const RECOVERY_SWEEP_INTERVAL_MS = 5 * 60 * 1000;
let lastRecoverySweep = 0;

/**
 * Map a persisted mission_tasks.status string onto the notify-state enum.
 * The DB writes 'completed', 'failed', or 'partial' today (timeouts are
 * collapsed into 'failed'/'partial' depending on commits), but we accept
 * 'timed_out' for forward-compat in case a future writer starts using it.
 */
function statusToNotifyState(status: string): MissionTerminalState {
  if (status === 'completed') return 'completed';
  if (status === 'partial') return 'partial';
  if (status === 'timed_out') return 'timed_out';
  return 'failed';
}

/**
 * Count git commits made in the agent's working tree since `startedAt`
 * (unix seconds). Used to distinguish "agent hit max-turns/timeout but
 * landed real work" (=> 'partial') from "agent failed with zero progress"
 * (=> 'failed'). Failures and non-git cwds return 0 — we never block a
 * terminal state on a git lookup.
 */
export function commitsSinceStart(cwd: string, startedAt: number): number {
  try {
    const r = safeSpawnSync(
      'git',
      ['rev-list', '--count', 'HEAD', `--since=${startedAt}`],
      { envClass: 'system-tool', cwd, timeout: 5_000, encoding: 'utf-8' },
    );
    if (r.status !== 0) return 0;
    const out = (typeof r.stdout === 'string' ? r.stdout : r.stdout?.toString('utf8') ?? '').trim();
    const n = parseInt(out, 10);
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

/**
 * Decide whether a max-turns / timeout / error should be persisted as
 * 'partial' (work landed) or 'failed' (zero progress). Centralises the
 * git-lookup so both the timeout path and the catch path converge on
 * one rule.
 */
function classifyMissionFailure(startedAt: number | null): {
  status: 'partial' | 'failed';
  commitCount: number;
} {
  if (!startedAt) return { status: 'failed', commitCount: 0 };
  const cwd = agentCwd ?? PROJECT_ROOT;
  const n = commitsSinceStart(cwd, startedAt);
  return { status: n > 0 ? 'partial' : 'failed', commitCount: n };
}

export async function _recoverMissedMissionNotificationsForTest(): Promise<void> {
  return recoverMissedMissionNotifications();
}

async function recoverMissedMissionNotifications(): Promise<void> {
  let pending;
  try {
    pending = getMissionTasksNeedingNotificationRecovery();
  } catch (err) {
    logger.warn({ err }, 'notify recovery sweep: query failed');
    return;
  }
  if (pending.length === 0) return;
  logger.warn({ count: pending.length }, 'notify recovery sweep: replaying missed notifications');
  for (const task of pending) {
    logger.info({ missionId: task.id, status: task.status }, 'recovering missed notification for task');
    const detail = task.error ?? task.result ?? undefined;
    try {
      await notifyMissionDone(task, statusToNotifyState(task.status), detail ?? undefined);
    } catch (err) {
      logger.warn({ err, missionId: task.id }, 'notify recovery: notifyMissionDone threw');
    }
  }
}

async function runDueTasks(): Promise<void> {
  // Periodic recovery sweep: replay any mission notifications whose
  // delivery never landed (post-startup notify.sh failures, Telegram
  // blips). Gated by RECOVERY_SWEEP_INTERVAL_MS so the per-tick cost
  // is amortised. Bounded by notify_attempt_count in the underlying
  // query so a permanently broken row stops retrying.
  if (Date.now() - lastRecoverySweep >= RECOVERY_SWEEP_INTERVAL_MS) {
    lastRecoverySweep = Date.now();
    void recoverMissedMissionNotifications();
  }

  const tasks = getDueTasks(schedulerAgentId);

  if (tasks.length > 0) {
    logger.info({ count: tasks.length }, 'Running due scheduled tasks');
  }

  for (const task of tasks) {
    // In-memory guard: skip if already running in this process
    if (runningTaskIds.has(task.id)) {
      logger.warn({ taskId: task.id }, 'Task already running, skipping duplicate fire');
      continue;
    }

    // Compute next occurrence BEFORE executing so we can lock the task
    // in the DB immediately, preventing re-fire on subsequent ticks.
    const nextRun = computeNextRun(task.schedule);
    runningTaskIds.add(task.id);
    markTaskRunning(task.id, nextRun);

    // Resolve model: use stored model, or auto-classify from prompt
    const taskModel = task.model ?? classifyTaskModel(task.prompt);
    logger.info({ taskId: task.id, prompt: task.prompt.slice(0, 60), model: taskModel }, 'Firing task');

    // Route through the message queue so scheduled tasks wait for any
    // in-flight user message to finish before running. This prevents
    // two Claude processes from hitting the same session simultaneously.
    const chatId = ALLOWED_CHAT_ID || 'scheduler';
    messageQueue.enqueue(chatId, async () => {
      const abortController = new AbortController();
      const timeout = setTimeout(() => abortController.abort(), TASK_TIMEOUT_MS);

      try {
        const isSilent = !!task.silent;

        // Fast path: silent shell-only tasks bypass the agent entirely.
        // Avoids the LLM-spawn fragility that was killing overnight heartbeats.
        // See src/shell-task.ts for the rationale and bypass criteria.
        const bypass = isSilent ? tryExtractShellCommand(task.prompt) : null;
        if (bypass) {
          clearTimeout(timeout);
          logger.info({ taskId: task.id, kind: bypass.kind, cmd: bypass.command.slice(0, 80) }, 'Shell-bypass: running scheduled task without agent');
          const shell = await runShellCommand(bypass.command);

          // Compose the "text" the rest of the pipeline expects. On success
          // we emit stdout (or "OK" if nothing printed). On failure we emit
          // a clear error so the user sees it on Telegram.
          let text: string;
          let status: 'success' | 'failed' | 'timeout';
          if (shell.timedOut) {
            text = `⏱ Shell command timed out (60s): ${bypass.command}\n${shell.stderr}`.trim();
            status = 'timeout';
          } else if (shell.exitCode !== 0) {
            text = `❌ Shell command exit ${shell.exitCode}: ${bypass.command}\n${shell.stderr || shell.stdout}`.trim();
            status = 'failed';
          } else {
            text = shell.stdout.length > 0 ? shell.stdout : 'OK';
            status = 'success';
          }

          const isOkOutput = /^OK\.?$/i.test(text);
          if (!isSilent || !isOkOutput) {
            for (const chunk of splitMessage(formatForTelegram(text))) {
              await sender(chunk);
            }
          } else {
            logger.info({ taskId: task.id }, 'Shell-bypass returned OK, suppressing Telegram');
          }

          if (ALLOWED_CHAT_ID) {
            const activeSession = getSession(ALLOWED_CHAT_ID, schedulerAgentId);
            logConversationTurn(ALLOWED_CHAT_ID, 'user', `[Scheduled task]: ${task.prompt}`, activeSession ?? undefined, schedulerAgentId);
            logConversationTurn(ALLOWED_CHAT_ID, 'assistant', text, activeSession ?? undefined, schedulerAgentId);
          }

          updateTaskAfterRun(task.id, nextRun, text.slice(0, 500), status);
          logger.info({ taskId: task.id, nextRun, status }, 'Shell-bypass complete, next run scheduled');
          return;
        }

        if (!isSilent) {
          await sender(`Scheduled task running [${modelTierLabel(taskModel)}]: "${task.prompt.slice(0, 70)}${task.prompt.length > 70 ? '...' : ''}"`);
        }

        // Run as a fresh agent call (no session — scheduled tasks are autonomous).
        // Use runAgentWithRetry so transient failures (auth refresh, rate limits)
        // get retried with backoff instead of immediately failing.
        const result = await runAgentWithRetry(task.prompt, undefined, () => {}, undefined, taskModel, abortController, undefined, undefined, undefined, agentMcpAllowlist);
        clearTimeout(timeout);

        if (result.aborted) {
          updateTaskAfterRun(task.id, nextRun, 'Timed out after 10 minutes', 'timeout');
          await sender(`⏱ Task timed out after 10m: "${task.prompt.slice(0, 60)}..." — killed.`);
          logger.warn({ taskId: task.id }, 'Task timed out');
          return;
        }

        const text = result.text?.trim() || 'Task completed with no output.';

        // Silent tasks only send to Telegram when there's something worth
        // reporting (i.e. output is NOT just "OK" or empty).
        const isOkOutput = /^OK\.?$/i.test(text);
        if (!isSilent || !isOkOutput) {
          for (const chunk of splitMessage(formatForTelegram(text))) {
            await sender(chunk);
          }
        } else {
          logger.info({ taskId: task.id }, 'Silent task returned OK, suppressing Telegram');
        }

        // Inject task output into the active chat session so user replies have context
        if (ALLOWED_CHAT_ID) {
          const activeSession = getSession(ALLOWED_CHAT_ID, schedulerAgentId);
          logConversationTurn(ALLOWED_CHAT_ID, 'user', `[Scheduled task]: ${task.prompt}`, activeSession ?? undefined, schedulerAgentId);
          logConversationTurn(ALLOWED_CHAT_ID, 'assistant', text, activeSession ?? undefined, schedulerAgentId);
        }

        updateTaskAfterRun(task.id, nextRun, text, 'success');

        logger.info({ taskId: task.id, nextRun }, 'Task complete, next run scheduled');
      } catch (err) {
        clearTimeout(timeout);
        const errMsg = err instanceof Error ? err.message : String(err);
        updateTaskAfterRun(task.id, nextRun, errMsg.slice(0, 500), 'failed');

        logger.error({ err, taskId: task.id }, 'Scheduled task failed');
        try {
          await sender(`❌ Task failed: "${task.prompt.slice(0, 60)}..." — ${errMsg.slice(0, 200)}`);
        } catch {
          // ignore send failure
        }
      } finally {
        runningTaskIds.delete(task.id);
      }
    });
  }

  // Also check for queued mission tasks (one-shot async tasks from Mission Control)
  await runDueMissionTasks();
}

async function runDueMissionTasks(): Promise<void> {
  const mission = claimNextMissionTask(schedulerAgentId);
  if (!mission) return;

  const missionKey = 'mission-' + mission.id;
  if (runningTaskIds.has(missionKey)) return;
  runningTaskIds.add(missionKey);

  // Resolve model: use stored model, or auto-classify from prompt
  const missionModel = mission.model ?? classifyTaskModel(mission.prompt);
  logger.info({ missionId: mission.id, title: mission.title, model: missionModel }, 'Running mission task');

  const chatId = ALLOWED_CHAT_ID || 'mission';
  messageQueue.enqueue(chatId, async () => {
    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), MISSION_TIMEOUT_MS);

    try {
      const result = await runAgentWithRetry(mission.prompt, undefined, () => {}, undefined, missionModel, abortController, undefined, undefined, undefined, agentMcpAllowlist);
      clearTimeout(timeout);

      if (result.aborted) {
        const verdict = classifyMissionFailure(mission.started_at);
        const detail = verdict.status === 'partial'
          ? `Hit timeout after committing ${verdict.commitCount} change(s)`
          : `Timed out after ${MISSION_TIMEOUT_MIN} minutes`;
        completeMissionTask(mission.id, null, verdict.status, detail);
        logger.warn(
          { missionId: mission.id, status: verdict.status, commitCount: verdict.commitCount },
          `mission ${mission.id} timed out; ${verdict.commitCount} commits since dispatch -> status=${verdict.status}`,
        );
        try {
          if (verdict.status === 'partial') {
            await sender(`Mission "${mission.title}" hit timeout but committed ${verdict.commitCount} changes — review and re-dispatch if needed.`);
          } else {
            await sender('Mission task timed out: "' + mission.title + '"');
          }
        } catch (sendErr) {
          // Sender can fail for Telegram API blips or chat-not-found. We
          // still want to see it so the user isn't silently unnotified.
          logger.warn({ err: sendErr, missionId: mission.id }, 'Failed to send mission timeout notification');
        }
        const notifyState: MissionTerminalState = verdict.status === 'partial' ? 'partial' : 'timed_out';
        await notifyMissionDone(mission, notifyState, detail, { commitCount: verdict.commitCount });
      } else {
        const text = result.text?.trim() || 'Task completed with no output.';
        completeMissionTask(mission.id, text, 'completed');
        logger.info({ missionId: mission.id }, 'Mission task completed');
        await notifyMissionDone({ ...mission, result: text, status: 'completed' }, 'completed', text);

        // Send result to Telegram
        for (const chunk of splitMessage(formatForTelegram(text))) {
          await sender(chunk);
        }

        // Inject into conversation context so agent can reference it
        if (ALLOWED_CHAT_ID) {
          const activeSession = getSession(ALLOWED_CHAT_ID, schedulerAgentId);
          logConversationTurn(ALLOWED_CHAT_ID, 'user', '[Mission task: ' + mission.title + ']: ' + mission.prompt, activeSession ?? undefined, schedulerAgentId);
          logConversationTurn(ALLOWED_CHAT_ID, 'assistant', text, activeSession ?? undefined, schedulerAgentId);
        }
      }
    } catch (err) {
      clearTimeout(timeout);
      const errMsg = err instanceof Error ? err.message : String(err);
      // Same partial vs failed split as the timeout path: if the agent
      // committed work before erroring out (e.g. max-turns surfacing as
      // a thrown classified error), preserve that signal as 'partial'
      // so the user doesn't waste a re-dispatch on already-landed work.
      const verdict = classifyMissionFailure(mission.started_at);
      completeMissionTask(mission.id, null, verdict.status, errMsg.slice(0, 500));
      logger.error(
        { err, missionId: mission.id, status: verdict.status, commitCount: verdict.commitCount },
        `mission ${mission.id} errored; ${verdict.commitCount} commits since dispatch -> status=${verdict.status}`,
      );
      await notifyMissionDone(
        { ...mission, error: errMsg.slice(0, 500), status: verdict.status },
        verdict.status,
        errMsg,
        { commitCount: verdict.commitCount },
      );
    } finally {
      runningTaskIds.delete(missionKey);
    }
  });
}

export function computeNextRun(cronExpression: string): number {
  const interval = CronExpressionParser.parse(cronExpression);
  return Math.floor(interval.next().getTime() / 1000);
}
