#!/usr/bin/env node
/**
 * ClaudeClaw Schedule CLI
 *
 * Used by your Claude assistant via the Bash tool to manage scheduled tasks.
 *
 * Usage:
 *   node dist/schedule-cli.js create "prompt text" "0 9 * * 1"
 *   node dist/schedule-cli.js list
 *   node dist/schedule-cli.js delete <id>
 *   node dist/schedule-cli.js pause <id>
 *   node dist/schedule-cli.js resume <id>
 */

import { randomBytes } from 'crypto';

import {
  initDatabase,
  createScheduledTask,
  getAllScheduledTasks,
  deleteScheduledTask,
  pauseScheduledTask,
  resumeScheduledTask,
  updateScheduledTaskModel,
  setScheduledTaskSilent,
} from './db.js';
import { computeNextRun } from './scheduler.js';
import { classifyTaskModel, modelTierLabel } from './task-model-classifier.js';

initDatabase();

// Parse --agent flag from anywhere in argv, fall back to CLAUDECLAW_AGENT_ID env var
const agentFlagIdx = process.argv.indexOf('--agent');
const cliAgentId = agentFlagIdx !== -1
  ? process.argv[agentFlagIdx + 1] ?? 'main'
  : process.env.CLAUDECLAW_AGENT_ID ?? 'main';

// Parse --silent flag
const silentFlagIdx = process.argv.indexOf('--silent');
const cliSilent = silentFlagIdx !== -1;

// Parse --model flag (haiku | sonnet | opus | auto | full model name)
const modelFlagIdx = process.argv.indexOf('--model');
const modelShortcuts: Record<string, string> = {
  haiku: 'claude-haiku-4-5',
  sonnet: 'claude-sonnet-4-5',
  opus: 'claude-opus-4-7',
};
const rawModelArg = modelFlagIdx !== -1 ? process.argv[modelFlagIdx + 1] ?? null : null;
const cliModel = rawModelArg === 'auto' ? null : (rawModelArg ? (modelShortcuts[rawModelArg] ?? rawModelArg) : null);

// Remove flag pairs from rest args
const flagIndices = new Set<number>();
[agentFlagIdx, modelFlagIdx].forEach(idx => {
  if (idx !== -1) { flagIndices.add(idx); flagIndices.add(idx + 1); }
});
// --silent is a boolean flag (no value after it)
if (silentFlagIdx !== -1) { flagIndices.add(silentFlagIdx); }
const cleanedArgv = process.argv.filter((_, i) => !flagIndices.has(i));
const [, , command, ...rest] = cleanedArgv;

function formatDate(unix: number | null): string {
  if (!unix) return 'never';
  return new Date(unix * 1000).toLocaleString('en-US', {
    month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true,
  });
}

switch (command) {
  case 'create': {
    const prompt = rest[0];
    const cron = rest[1];

    if (!prompt || !cron) {
      console.error('Usage: schedule-cli create "prompt" "cron expression"');
      console.error('Example: schedule-cli create "Summarise AI news" "0 9 * * 1"');
      process.exit(1);
    }

    let nextRun: number;
    try {
      nextRun = computeNextRun(cron);
    } catch {
      console.error(`Invalid cron expression: "${cron}"`);
      console.error('Examples: "0 9 * * 1" (Mon 9am)  "0 8 * * *" (daily 8am)  "0 */4 * * *" (every 4h)');
      process.exit(1);
    }

    const id = randomBytes(4).toString('hex');
    // Auto-classify model if not explicitly set
    const model = cliModel ?? classifyTaskModel(prompt);
    createScheduledTask(id, prompt, cron, nextRun, cliAgentId, model, cliSilent);

    console.log(`Task created: ${id}`);
    console.log(`Agent:        ${cliAgentId}`);
    console.log(`Model:        ${modelTierLabel(model)}${!cliModel ? ' (auto)' : ''}`);
    console.log(`Silent:       ${cliSilent ? 'yes (only sends on anomaly)' : 'no'}`);
    console.log(`Prompt:       ${prompt}`);
    console.log(`Schedule:     ${cron}`);
    console.log(`Next run:     ${formatDate(nextRun)}`);
    break;
  }

  case 'list': {
    const tasks = getAllScheduledTasks(cliAgentId === 'main' ? undefined : cliAgentId);
    if (tasks.length === 0) {
      console.log('No scheduled tasks.');
      break;
    }
    console.log(`${tasks.length} scheduled task${tasks.length === 1 ? '' : 's'}:\n`);
    for (const t of tasks) {
      const status = t.status === 'paused' ? ' [PAUSED]' : '';
      const silentLabel = t.silent ? ' [SILENT]' : '';
      console.log(`${t.id}${status}${silentLabel}`);
      console.log(`  Prompt:   ${t.prompt}`);
      console.log(`  Model:    ${modelTierLabel(t.model)}`);
      console.log(`  Schedule: ${t.schedule}`);
      console.log(`  Next run: ${formatDate(t.next_run)}`);
      console.log(`  Last run: ${formatDate(t.last_run)}`);
      console.log();
    }
    break;
  }

  case 'delete': {
    const id = rest[0];
    if (!id) { console.error('Usage: schedule-cli delete <id>'); process.exit(1); }
    deleteScheduledTask(id);
    console.log(`Deleted task: ${id}`);
    break;
  }

  case 'pause': {
    const id = rest[0];
    if (!id) { console.error('Usage: schedule-cli pause <id>'); process.exit(1); }
    pauseScheduledTask(id);
    console.log(`Paused task: ${id}`);
    break;
  }

  case 'resume': {
    const id = rest[0];
    if (!id) { console.error('Usage: schedule-cli resume <id>'); process.exit(1); }
    resumeScheduledTask(id);
    console.log(`Resumed task: ${id}`);
    break;
  }

  case 'set-model': {
    const id = rest[0];
    const modelArg = rest[1];
    if (!id || !modelArg) {
      console.error('Usage: schedule-cli set-model <id> <haiku|sonnet|opus|auto>');
      process.exit(1);
    }
    if (modelArg === 'auto') {
      // Re-classify from the task's prompt
      const tasks = getAllScheduledTasks();
      const task = tasks.find((t) => t.id === id);
      if (!task) { console.error(`Task not found: ${id}`); process.exit(1); }
      const autoModel = classifyTaskModel(task.prompt);
      updateScheduledTaskModel(id, autoModel);
      console.log(`Model set to ${modelTierLabel(autoModel)} (auto) for task: ${id}`);
    } else {
      const resolved = modelShortcuts[modelArg] ?? modelArg;
      updateScheduledTaskModel(id, resolved);
      console.log(`Model set to ${modelTierLabel(resolved)} for task: ${id}`);
    }
    break;
  }

  case 'auto-classify': {
    // Batch auto-classify all tasks that have no model set
    const tasks = getAllScheduledTasks(cliAgentId === 'main' ? undefined : cliAgentId);
    let updated = 0;
    for (const t of tasks) {
      const model = classifyTaskModel(t.prompt);
      updateScheduledTaskModel(t.id, model);
      console.log(`${t.id}: ${modelTierLabel(model)} — ${t.prompt.slice(0, 60)}`);
      updated++;
    }
    console.log(`\nClassified ${updated} task${updated === 1 ? '' : 's'}.`);
    break;
  }

  case 'set-silent': {
    const id = rest[0];
    const value = rest[1];
    if (!id || !value || !['on', 'off'].includes(value)) {
      console.error('Usage: schedule-cli set-silent <id> <on|off>');
      process.exit(1);
    }
    setScheduledTaskSilent(id, value === 'on');
    console.log(`Silent mode ${value === 'on' ? 'enabled' : 'disabled'} for task: ${id}`);
    break;
  }

  default:
    console.error('Commands: create | list | delete | pause | resume | set-model | set-silent | auto-classify');
    process.exit(1);
}
