import { CronExpressionParser } from 'cron-parser';

import { AGENT_ID, ALLOWED_CHAT_ID, PROJECT_ROOT, agentCwd, agentMcpAllowlist, agentSystemPrompt } from './config.js';
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
import type { ScheduledTask } from './db.js';
import type { MissionTerminalState } from './mission-notify.js';
import { logger } from './logger.js';
import { messageQueue } from './message-queue.js';
import { getActiveProviderName, runAgentWithRetry } from './agent.js';
import { formatForTelegram, splitMessage } from './bot.js';
import { classifyTaskModel, modelTierLabel } from './task-model-classifier.js';
import { tryExtractShellCommand, runShellCommand } from './shell-task.js';
import { notifyMissionDone } from './mission-notify.js';
import { tickTelegramOutbox } from './telegram-outbox.js';
import { processDueOperationNotifications } from './operation-notify.js';
import {
  createMissionWorktree,
  removeMissionWorktree,
  cleanupAllMissionWorktrees,
  pushMissionBranch,
  fastForwardMainTo,
  type MissionWorktree,
} from './mission-worktree.js';
import { runAttentionAutofixSweep } from './attention-autofix.js';

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

  // Worktree recovery sweep. If the process died mid-mission, the
  // worktree dir + mission-<id> branch are leftover. Clean them up so
  // (a) disk doesn't leak and (b) a fresh dispatch of the same mission
  // id never inherits stale state. Only Mason currently runs missions
  // through worktrees; non-mission agents (sage etc.) skip this entirely.
  if (agentId === 'mason') {
    try {
      const cleaned = cleanupAllMissionWorktrees();
      if (cleaned > 0) {
        logger.warn({ cleaned, agentId }, 'mission-worktree: recovery sweep cleaned stale worktrees');
      }
    } catch (err) {
      logger.warn({ err, agentId }, 'mission-worktree: recovery sweep failed');
    }
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

  if (agentId === 'main' && process.env.VITEST !== 'true' && process.env.NODE_ENV !== 'test') {
    const attentionSweep = setInterval(() => {
      try {
        const result = runAttentionAutofixSweep(50);
        if (result.routed > 0 || result.archived > 0) {
          logger.info(result, 'attention-autofix sweep completed');
        }
      } catch (err) {
        logger.warn({ err }, 'attention-autofix sweep failed');
      }
    }, 5 * 60_000);
    attentionSweep.unref?.();
  }

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
function classifyMissionFailure(
  startedAt: number | null,
  missionCwd?: string,
): {
  status: 'partial' | 'failed';
  commitCount: number;
} {
  if (!startedAt) return { status: 'failed', commitCount: 0 };
  // Mission commits land in the per-mission worktree, NOT the shared
  // PROJECT_ROOT tree. Pre-worktree, the shared tree was authoritative;
  // now we must inspect the worktree or we'll always count zero commits
  // and mark every aborted mission as 'failed'.
  const cwd = missionCwd ?? agentCwd ?? PROJECT_ROOT;
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

    const chatId = ALLOWED_CHAT_ID || 'scheduler';
    const isSilent = !!task.silent;
    const bypass = isSilent ? tryExtractShellCommand(task.prompt) : null;
    if (!bypass && messageQueue.queuedFor(chatId) > 0) {
      logger.info({ taskId: task.id, queued: messageQueue.queuedFor(chatId) }, 'Scheduled task deferred until message queue is free');
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

    if (bypass) {
      await runShellBypassTask(task, nextRun, bypass);
      continue;
    }

    // Route through the message queue so scheduled tasks wait for any
    // in-flight user message to finish before running. This prevents
    // two Claude processes from hitting the same session simultaneously.
    messageQueue.enqueue(chatId, async () => {
      const abortController = new AbortController();
      const timeout = setTimeout(() => abortController.abort(), TASK_TIMEOUT_MS);

      try {
        if (!isSilent) {
          await sender(`Scheduled task running [${modelTierLabel(taskModel)}]: "${task.prompt.slice(0, 70)}${task.prompt.length > 70 ? '...' : ''}"`);
        }

        // Run as a fresh agent call (no session — scheduled tasks are autonomous).
        // Use runAgentWithRetry so transient failures (auth refresh, rate limits)
        // get retried with backoff instead of immediately failing.
        const scheduledPrompt = isSilent ? task.prompt : withScheduledTaskContract(task.prompt);
        const result = await runAgentWithRetry(scheduledPrompt, undefined, () => {}, undefined, taskModel, abortController, undefined, undefined, undefined, agentMcpAllowlist, undefined, agentSystemPrompt);
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
          // Strip ATTENTION_ACTIONS marker before sending to Telegram
          // (actions are extracted separately by the dashboard from DB)
          const cleanText = stripAttentionActionsMarker(text);
          for (const chunk of splitMessage(formatForTelegram(cleanText))) {
            await sender(chunk);
          }
        } else {
          logger.info({ taskId: task.id }, 'Silent task returned OK, suppressing Telegram');
        }

        // Inject task output into the active chat session so user replies have context
        if (ALLOWED_CHAT_ID) {
          const activeSession = getSession(ALLOWED_CHAT_ID, schedulerAgentId, getActiveProviderName());
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

async function runShellBypassTask(
  task: ScheduledTask,
  nextRun: number,
  bypass: NonNullable<ReturnType<typeof tryExtractShellCommand>>,
): Promise<void> {
  try {
    logger.info({ taskId: task.id, kind: bypass.kind, cmd: bypass.command.slice(0, 80) }, 'Shell-bypass: running scheduled task without agent');
    const shell = await runShellCommand(bypass.command);

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
    if (!task.silent || !isOkOutput) {
      for (const chunk of splitMessage(formatForTelegram(text))) {
        await sender(chunk);
      }
    } else {
      logger.info({ taskId: task.id }, 'Shell-bypass returned OK, suppressing Telegram');
    }

    if (ALLOWED_CHAT_ID) {
      const activeSession = getSession(ALLOWED_CHAT_ID, schedulerAgentId, getActiveProviderName());
      logConversationTurn(ALLOWED_CHAT_ID, 'user', `[Scheduled task]: ${task.prompt}`, activeSession ?? undefined, schedulerAgentId);
      logConversationTurn(ALLOWED_CHAT_ID, 'assistant', text, activeSession ?? undefined, schedulerAgentId);
    }

    updateTaskAfterRun(task.id, nextRun, text.slice(0, 500), status);
    logger.info({ taskId: task.id, nextRun, status }, 'Shell-bypass complete, next run scheduled');
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    updateTaskAfterRun(task.id, nextRun, errMsg.slice(0, 500), 'failed');
    logger.error({ err, taskId: task.id }, 'Shell-bypass scheduled task failed');
    try {
      await sender(`❌ Task failed: "${task.prompt.slice(0, 60)}..." — ${errMsg.slice(0, 200)}`);
    } catch {
      // ignore send failure
    }
  } finally {
    runningTaskIds.delete(task.id);
  }
}

async function runDueMissionTasks(): Promise<void> {
  const chatId = ALLOWED_CHAT_ID || 'mission';
  if (messageQueue.queuedFor(chatId) > 0) {
    logger.info({ queued: messageQueue.queuedFor(chatId), agentId: schedulerAgentId }, 'Mission claim deferred until message queue is free');
    return;
  }

  const mission = claimNextMissionTask(schedulerAgentId);
  if (!mission) return;

  const missionKey = 'mission-' + mission.id;
  if (runningTaskIds.has(missionKey)) return;
  runningTaskIds.add(missionKey);

  // Resolve model: use stored model, or auto-classify from prompt
  const missionModel = mission.model ?? classifyTaskModel(mission.prompt);
  logger.info({ missionId: mission.id, title: mission.title, model: missionModel }, 'Running mission task');

  // Per-mission worktree isolation. Only Mason runs missions through
  // worktrees today (other agents either don't dispatch missions or
  // don't run git commands during normal flow). If creation fails (leak
  // guard, network blip on fetch, branch-name collision), bail the
  // mission as failed BEFORE entering the message queue — running it
  // in the shared tree would re-introduce the bug class.
  let worktree: MissionWorktree | null = null;
  if (schedulerAgentId === 'mason') {
    try {
      worktree = createMissionWorktree(mission.id);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.error({ err, missionId: mission.id }, 'mission-worktree: create failed; aborting mission');
      completeMissionTask(mission.id, null, 'failed', `worktree setup failed: ${errMsg.slice(0, 400)}`);
      try {
        await sender(`❌ Mission "${mission.title}" could not start — worktree setup failed: ${errMsg.slice(0, 200)}`);
      } catch (sendErr) {
        logger.warn({ err: sendErr, missionId: mission.id }, 'failed to send worktree-setup error');
      }
      runningTaskIds.delete(missionKey);
      return;
    }
  }

  // Codex HIGH #2: if anything between createMissionWorktree and the
  // enqueue throws, the cleanup in the inner `finally` never runs and
  // the worktree leaks on disk. Wrap the enqueue setup in try/catch so
  // synchronous failures here also tear down the worktree.
  let missionCwd: string | undefined;
  let promptToSend: string;
  try {
    missionCwd = worktree?.cwd;
    const missionPrompt = withMissionResultContract(mission.prompt);
    promptToSend = worktree
      ? buildWorktreePromptHeader(worktree, mission.id) + missionPrompt
      : missionPrompt;
  } catch (setupErr) {
    logger.error({ err: setupErr, missionId: mission.id }, 'mission setup post-worktree-create threw; cleaning up worktree');
    if (worktree) {
      try { removeMissionWorktree(mission.id); }
      catch (cleanupErr) { logger.warn({ err: cleanupErr, missionId: mission.id }, 'mission-worktree: cleanup after setup-throw failed'); }
    }
    runningTaskIds.delete(missionKey);
    completeMissionTask(mission.id, null, 'failed', `mission setup error: ${(setupErr as Error)?.message ?? String(setupErr)}`.slice(0, 400));
    return;
  }

  messageQueue.enqueue(chatId, async () => {
    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), MISSION_TIMEOUT_MS);

    try {
      const result = await runAgentWithRetry(promptToSend, undefined, () => {}, undefined, missionModel, abortController, undefined, undefined, undefined, agentMcpAllowlist, missionCwd, agentSystemPrompt);
      clearTimeout(timeout);

      if (result.aborted) {
        if (worktree) snapshotAndPushMissionBranch(worktree);
        const verdict = classifyMissionFailure(mission.started_at, missionCwd);
        // Partial-with-commits: try to push the branch so the operator can
        // see the work even though the wall-clock budget ran out. Best
        // effort — a push failure here doesn't change the verdict.
        if (verdict.status === 'partial' && worktree) {
          pushMissionBranch(worktree);
        }
        const detail = verdict.status === 'partial'
          ? `Hit timeout after committing ${verdict.commitCount} change(s). Review branch: ${worktree?.branch || 'mission branch'}.`
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

        // Merge strategy (locked decision): mission commits + pushes its
        // feature branch from inside the worktree. Scheduler then pushes
        // the branch sha to origin/main as a server-side fast-forward
        // (no local checkout, shared HEAD never moves). If the branch
        // diverged from main (someone landed work concurrently) we
        // demote to 'partial' so the human can resolve.
        let mergeStatus: 'ok' | 'non-ff' | 'error' | 'skipped' = 'skipped';
        if (worktree) {
          if (pushMissionBranch(worktree)) {
            mergeStatus = fastForwardMainTo(worktree.branch);
          } else {
            mergeStatus = 'error';
          }
        }

        // Merge-status mapping (locked post-Codex review 2026-05-05):
        //   ok       -> mission completed, main is up to date
        //   skipped  -> non-mason agent path; nothing to merge, completed
        //   non-ff   -> branch diverged from main; demote to partial,
        //               operator merges manually. Branch is preserved on
        //               origin so no work is lost.
        //   error    -> push or fetch broke (network/auth). Original review
        //               flagged this falling through to 'completed' which
        //               silently dropped work. Now demoted to partial so the
        //               operator can re-run merge or investigate.
        if (mergeStatus === 'non-ff' || mergeStatus === 'error') {
          const reason = mergeStatus === 'non-ff'
            ? `branch ${worktree?.branch} could not fast-forward main; review manually`
            : `branch ${worktree?.branch} push/merge failed; branch is on origin, retry merge manually`;
          const notifyMsg = mergeStatus === 'non-ff'
            ? `Branch diverged from main; review and merge manually.`
            : `Push/merge failed (network or auth); branch on origin, please merge manually.`;
          completeMissionTask(mission.id, text, 'partial', reason);
          logger.warn({ missionId: mission.id, branch: worktree?.branch, mergeStatus }, 'mission completed but merge to main did not land; marked partial');
          await notifyMissionDone(
            { ...mission, result: text, status: 'partial' },
            'partial',
            notifyMsg,
            { commitCount: 1 },
          );
        } else {
          completeMissionTask(mission.id, text, 'completed');
          logger.info({ missionId: mission.id, mergeStatus }, 'Mission task completed');
          await notifyMissionDone({ ...mission, result: text, status: 'completed' }, 'completed', text);
        }

        // Send result to Telegram
        for (const chunk of splitMessage(formatForTelegram(text))) {
          await sender(chunk);
        }

        // Inject into conversation context so agent can reference it
        if (ALLOWED_CHAT_ID) {
          const activeSession = getSession(ALLOWED_CHAT_ID, schedulerAgentId, getActiveProviderName());
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
      if (worktree) snapshotAndPushMissionBranch(worktree);
      const verdict = classifyMissionFailure(mission.started_at, missionCwd);
      if (verdict.status === 'partial' && worktree) {
        // Preserve any committed work for human review even though the
        // mission errored out before we could merge.
        pushMissionBranch(worktree);
      }
      const detail = verdict.status === 'partial'
        ? `${errMsg.slice(0, 360)}\nPartial work was preserved on branch: ${worktree?.branch || 'mission branch'}`
        : errMsg.slice(0, 500);
      completeMissionTask(mission.id, null, verdict.status, detail);
      logger.error(
        { err, missionId: mission.id, status: verdict.status, commitCount: verdict.commitCount },
        `mission ${mission.id} errored; ${verdict.commitCount} commits since dispatch -> status=${verdict.status}`,
      );
      await notifyMissionDone(
        { ...mission, error: errMsg.slice(0, 500), status: verdict.status },
        verdict.status,
        detail,
        { commitCount: verdict.commitCount },
      );
    } finally {
      // Forensics: before tearing down the worktree, capture any
      // uncommitted Mason work as a snapshot commit and push the branch.
      // Without this, a max-turns failure with 0 commits leaves NOTHING
      // for the operator to inspect — the worktree gets nuked and the
      // branch (with no commits past origin/main) carries no signal.
      // With it, even a max-turns death preserves the partial state.
      // Best-effort: any failure here just logs and continues to cleanup.
      if (worktree) {
        try {
          const snapshotted = snapshotAndPushMissionBranch(worktree);
          if (snapshotted) {
            logger.info({ missionId: mission.id, branch: worktree.branch }, 'mission-worktree: snapshotted uncommitted work to origin for forensics');
          }
        } catch (snapErr) {
          logger.warn({ err: snapErr, missionId: mission.id }, 'mission-worktree: forensic snapshot failed (non-fatal)');
        }
      }

      // Tear down the worktree on every terminal path (success, partial,
      // failed, error). The branch is preserved on origin already; the
      // local worktree dir is disposable. If cleanup throws, log but
      // don't surface — the leak guard on the next dispatch will catch
      // accumulated stragglers.
      if (worktree) {
        try {
          removeMissionWorktree(mission.id);
        } catch (cleanupErr) {
          logger.warn({ err: cleanupErr, missionId: mission.id }, 'mission-worktree: cleanup failed');
        }
      }
      runningTaskIds.delete(missionKey);
    }
  });
}

/**
 * Best-effort: if the mission worktree has uncommitted work (Mason
 * hit max-turns mid-edit, threw mid-mission, etc.), commit it as a
 * snapshot and push the branch to origin so an operator can inspect
 * what Mason was doing. Returns true if a snapshot was committed.
 *
 * Skips silently when the working tree is clean (no uncommitted state)
 * or when the git commands fail (network/auth). Never throws.
 */
function snapshotAndPushMissionBranch(wt: MissionWorktree): boolean {
  try {
    const status = safeSpawnSync(
      'git',
      ['status', '--porcelain'],
      { envClass: 'system-tool', cwd: wt.cwd, encoding: 'utf-8', timeout: 5_000 },
    );
    const out = (typeof status.stdout === 'string' ? status.stdout : status.stdout?.toString('utf8') ?? '').trim();
    if (!out) return false; // clean tree, nothing to snapshot

    // Codex CRITICAL: `git add -A` would stage .env / .env.local if
    // .gitignore got corrupted in the worktree (Mason edit, branch
    // weirdness, etc.). Hard-exclude env files via pathspec so the
    // snapshot push CANNOT leak credentials regardless of gitignore
    // state. The exclusion is belt-and-braces — gitignore should
    // already cover this — but a single mishap on a published branch
    // is a credential incident, so defense in depth wins.
    safeSpawnSync(
      'git',
      ['add', '-A', '--', ':!.env', ':!.env.local', ':!.env.*'],
      { envClass: 'system-tool', cwd: wt.cwd, timeout: 5_000 },
    );
    const commitRes = safeSpawnSync(
      'git',
      ['commit', '-m', `snapshot(mission ${wt.missionId}): uncommitted state captured before worktree cleanup`],
      { envClass: 'system-tool', cwd: wt.cwd, encoding: 'utf-8', timeout: 10_000 },
    );
    // status !== 0 also covers the "nothing to commit" case (which can
    // happen if the only dirty entry was an excluded env file). That's
    // the desired no-op.
    if (commitRes.status !== 0) return false;

    pushMissionBranch(wt);
    return true;
  } catch (err) {
    logger.warn({ err, branch: wt.branch }, 'snapshotAndPushMissionBranch: failed');
    return false;
  }
}

/**
 * Prefix injected at the top of every mission prompt that runs inside a
 * worktree. Tells the agent (a) where it's running, (b) which branch its
 * commits go on, and (c) NOT to cd back to <project-root> — that would
 * defeat the isolation. The merge step is handled by the scheduler.
 */
function buildWorktreePromptHeader(wt: MissionWorktree, missionId: string): string {
  return [
    `IMPORTANT — MISSION ISOLATION:`,
    `You are running in an isolated git worktree at:`,
    `  ${wt.cwd}`,
    `On branch:`,
    `  ${wt.branch}`,
    `Rules:`,
    `  • Do NOT cd to <project-root> or any other path. Stay in this worktree.`,
    `  • Commit your work to this branch. Do NOT push — the scheduler pushes and fast-forwards main after you finish.`,
    `  • The shared <project-root> tree is read by 5 other agents simultaneously; moving its HEAD breaks them.`,
    `  • Mission id: ${missionId}`,
    ``,
    `Mission brief follows:`,
    ``,
    ``,
  ].join('\n');
}

const MISSION_RESULT_CONTRACT = `

Mission Control result contract:
At the end of your final response, include a fenced JSON block labelled MISSION_RESULT_JSON. The JSON must be valid and match this shape:
{
  "status": "completed|partial|failed",
  "summary": "one concise operator-facing summary",
  "deliverables": [{"kind":"file|url","target":"absolute path or URL","label":"human label"}],
  "source_files": ["absolute paths or URLs you used/changed"],
  "blockers": ["specific blocker, if any"],
  "next_action": "specific follow-up, or null",
  "follow_up_needed": false,
  "review_required": false
}
Use absolute file paths for real deliverables. If a promised file was not created, put that in blockers, not deliverables.
`.trim();

const ATTENTION_ACTIONS_CONTRACT = `

Attention action contract:
If this output contains items the user or another agent needs to act on, include one line near the end:
ATTENTION_ACTIONS: [{"title":"short action","detail":"full action and context","severity":"high|medium|low","sourceCategory":"brief|calendar|inbox|mission|runtime|reliability","suggested_agent":"main|charter|ember|marlow|mason|warden|null","due":"ISO date/time or natural due text, or null","requires_human":true|false,"confidence":0.0}]
If there are no action items, include exactly:
ATTENTION_ACTIONS: []
`.trim();

export function withMissionResultContract(prompt: string): string {
  if (/MISSION_RESULT_JSON/i.test(prompt)) return prompt;
  return `${prompt.trim()}\n\n${MISSION_RESULT_CONTRACT}\n`;
}

export function withScheduledTaskContract(prompt: string): string {
  if (/ATTENTION_ACTIONS/i.test(prompt)) return prompt;
  return `${prompt.trim()}\n\n${ATTENTION_ACTIONS_CONTRACT}\n`;
}

/**
 * Strip ATTENTION_ACTIONS markers from response text before sending to Telegram.
 * Removes both fenced-block and bare forms.
 */
export function stripAttentionActionsMarker(text: string): string {
  let cleaned = text;
  // Remove fenced blocks: ```ATTENTION_ACTIONS ... ```
  cleaned = cleaned.replace(/```(?:json)?\s*ATTENTION_ACTIONS\s*[\s\S]*?```/gi, '');
  // Remove bare form: ATTENTION_ACTIONS: [...]
  cleaned = cleaned.replace(/ATTENTION_ACTIONS\s*:\s*\[[\s\S]*?\]/gi, '');
  // Clean up trailing whitespace
  return cleaned.trim();
}

export function computeNextRun(cronExpression: string): number {
  const interval = CronExpressionParser.parse(cronExpression);
  return Math.floor(interval.next().getTime() / 1000);
}
