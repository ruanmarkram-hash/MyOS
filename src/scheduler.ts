import { CronExpressionParser } from 'cron-parser';

import { AGENT_ID, ALLOWED_CHAT_ID, agentMcpAllowlist } from './config.js';
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
} from './db.js';
import { logger } from './logger.js';
import { messageQueue } from './message-queue.js';
import { runAgentWithRetry } from './agent.js';
import { formatForTelegram, splitMessage } from './bot.js';
import { classifyTaskModel, modelTierLabel } from './task-model-classifier.js';
import { tryExtractShellCommand, runShellCommand } from './shell-task.js';

type Sender = (text: string) => Promise<void>;

/** Max time (ms) a scheduled task can run before being killed. */
const TASK_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

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

  setInterval(() => void runDueTasks(), 60_000);
  logger.info({ agentId }, 'Scheduler started (checking every 60s)');
}

async function runDueTasks(): Promise<void> {
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
    const timeout = setTimeout(() => abortController.abort(), TASK_TIMEOUT_MS);

    try {
      const result = await runAgentWithRetry(mission.prompt, undefined, () => {}, undefined, missionModel, abortController, undefined, undefined, undefined, agentMcpAllowlist);
      clearTimeout(timeout);

      if (result.aborted) {
        completeMissionTask(mission.id, null, 'failed', 'Timed out after 10 minutes');
        logger.warn({ missionId: mission.id }, 'Mission task timed out');
        try {
          await sender('Mission task timed out: "' + mission.title + '"');
        } catch (sendErr) {
          // Sender can fail for Telegram API blips or chat-not-found. We
          // still want to see it so the user isn't silently unnotified.
          logger.warn({ err: sendErr, missionId: mission.id }, 'Failed to send mission timeout notification');
        }
      } else {
        const text = result.text?.trim() || 'Task completed with no output.';
        completeMissionTask(mission.id, text, 'completed');
        logger.info({ missionId: mission.id }, 'Mission task completed');

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
      completeMissionTask(mission.id, null, 'failed', errMsg.slice(0, 500));
      logger.error({ err, missionId: mission.id }, 'Mission task failed');
    } finally {
      runningTaskIds.delete(missionKey);
    }
  });
}

export function computeNextRun(cronExpression: string): number {
  const interval = CronExpressionParser.parse(cronExpression);
  return Math.floor(interval.next().getTime() / 1000);
}
