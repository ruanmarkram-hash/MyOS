#!/usr/bin/env node
/**
 * ClaudeClaw Mission CLI
 *
 * Used by Claude assistants to create and manage one-shot mission tasks
 * that are picked up and executed by the target agent's scheduler.
 *
 * Usage:
 *   node dist/mission-cli.js create --agent research --title "Label" "Full prompt"
 *   node dist/mission-cli.js create --agent research --notify-on-done "Full prompt"
 *   node dist/mission-cli.js list [--status queued]
 *   node dist/mission-cli.js result <id>
 *   node dist/mission-cli.js cancel <id>
 */

import { randomBytes } from 'crypto';

import {
  initDatabase,
  createMissionTask,
  getMissionTasks,
  getMissionTask,
  cancelMissionTask,
} from './db.js';
import { classifyTaskModel, modelTierLabel } from './task-model-classifier.js';

initDatabase();

// Parse --agent flag (null = unassigned, use auto-assign on dashboard)
const agentFlagIdx = process.argv.indexOf('--agent');
const targetAgent = agentFlagIdx !== -1
  ? process.argv[agentFlagIdx + 1] ?? null
  : null;

// Parse --title flag
const titleFlagIdx = process.argv.indexOf('--title');
const titleArg = titleFlagIdx !== -1
  ? process.argv[titleFlagIdx + 1] ?? ''
  : '';

// Parse --status flag
const statusFlagIdx = process.argv.indexOf('--status');
const statusFilter = statusFlagIdx !== -1
  ? process.argv[statusFlagIdx + 1] ?? undefined
  : undefined;

// Parse --priority flag
const priorityFlagIdx = process.argv.indexOf('--priority');
const priorityArg = priorityFlagIdx !== -1
  ? parseInt(process.argv[priorityFlagIdx + 1] ?? '0', 10)
  : 5;

// Parse --model flag (haiku | sonnet | opus | auto | full model name)
const modelFlagIdx = process.argv.indexOf('--model');
const modelShortcuts: Record<string, string> = {
  haiku: 'claude-haiku-4-5',
  sonnet: 'claude-sonnet-4-5',
  opus: 'claude-opus-4-7',
};
const rawModelArg = modelFlagIdx !== -1 ? process.argv[modelFlagIdx + 1] ?? null : null;
const cliModel = rawModelArg === 'auto' ? null : (rawModelArg ? (modelShortcuts[rawModelArg] ?? rawModelArg) : null);

// --notify-on-done is a boolean toggle; ping the creating agent's chat when done.
const notifyOnDoneIdx = process.argv.indexOf('--notify-on-done');
const notifyOnDone = notifyOnDoneIdx !== -1;

// Who created this task
const createdBy = process.env.CLAUDECLAW_AGENT_ID ?? 'main';

// Clean argv: remove all flag pairs (and the standalone --notify-on-done)
const flagIndices = new Set<number>();
[agentFlagIdx, titleFlagIdx, statusFlagIdx, priorityFlagIdx, modelFlagIdx].forEach(idx => {
  if (idx !== -1) { flagIndices.add(idx); flagIndices.add(idx + 1); }
});
if (notifyOnDoneIdx !== -1) flagIndices.add(notifyOnDoneIdx);
const cleanedArgv = process.argv.filter((_, i) => !flagIndices.has(i));
const [, , command, ...rest] = cleanedArgv;

/**
 * ANSI-color a status pill. We distinguish 'partial' (yellow ⚠) from
 * 'failed' (red ✗) so the user can see at a glance which terminal rows
 * actually need re-dispatch versus which already landed work but ran
 * out of budget. NO_COLOR / non-TTY callers see plain text.
 */
function formatStatusPill(status: string): string {
  const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
  const SYMBOLS: Record<string, string> = {
    completed: '✓',
    failed:    '✗',
    partial:   '⚠',
    cancelled: '⊘',
    running:   '▶',
    queued:    '·',
  };
  const COLORS: Record<string, string> = {
    completed: '\x1b[32m', // green
    failed:    '\x1b[31m', // red
    partial:   '\x1b[33m', // yellow
    cancelled: '\x1b[90m', // grey
    running:   '\x1b[36m', // cyan
    queued:    '\x1b[37m', // white
  };
  const sym = SYMBOLS[status] ?? '?';
  const text = `${sym} ${status}`;
  if (!useColor) return text;
  const color = COLORS[status] ?? '';
  return `${color}${text}\x1b[0m`;
}

function formatDate(unix: number | null): string {
  if (!unix) return '-';
  return new Date(unix * 1000).toLocaleString('en-US', {
    month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true,
  });
}

switch (command) {
  case 'create': {
    const prompt = rest[0];
    if (!prompt) {
      console.error('Usage: mission-cli create --agent <id> --title "Label" "Full prompt text"');
      process.exit(1);
    }
    const title = titleArg || prompt.slice(0, 60);
    const id = randomBytes(4).toString('hex');
    // Auto-classify model if not explicitly set
    const model = cliModel ?? classifyTaskModel(prompt);
    createMissionTask(id, title, prompt, targetAgent ?? null, createdBy, priorityArg, model, notifyOnDone);

    console.log(`Mission task created: ${id}`);
    console.log(`  Title:    ${title}`);
    console.log(`  Agent:    ${targetAgent || 'unassigned (use dashboard to assign)'}`);
    console.log(`  Model:    ${modelTierLabel(model)}${!cliModel ? ' (auto)' : ''}`);
    console.log(`  Priority: ${priorityArg}`);
    if (notifyOnDone) console.log(`  Notify:   on completion (Telegram ping to ${createdBy})`);
    console.log(`  Prompt:   ${prompt.slice(0, 100)}${prompt.length > 100 ? '...' : ''}`);
    break;
  }

  case 'list': {
    const tasks = getMissionTasks(undefined, statusFilter);
    if (tasks.length === 0) {
      console.log('No mission tasks' + (statusFilter ? ` with status "${statusFilter}"` : '') + '.');
      break;
    }
    console.log(`${tasks.length} mission task${tasks.length === 1 ? '' : 's'}:\n`);
    for (const t of tasks) {
      console.log(`${t.id} [${formatStatusPill(t.status)}] @${t.assigned_agent}`);
      console.log(`  Title:   ${t.title}`);
      console.log(`  Model:   ${modelTierLabel(t.model)}`);
      console.log(`  Created: ${formatDate(t.created_at)}`);
      if (t.completed_at) console.log(`  Done:    ${formatDate(t.completed_at)}`);
      console.log();
    }
    break;
  }

  case 'result': {
    const id = rest[0];
    if (!id) { console.error('Usage: mission-cli result <id>'); process.exit(1); }
    const task = getMissionTask(id);
    if (!task) { console.error(`Task not found: ${id}`); process.exit(1); }
    console.log(`Task:   ${task.id} [${formatStatusPill(task.status)}]`);
    console.log(`Title:  ${task.title}`);
    console.log(`Agent:  ${task.assigned_agent}`);
    if (task.result) {
      console.log(`\nResult:\n${task.result}`);
    } else if (task.error) {
      console.log(`\nError: ${task.error}`);
    } else {
      console.log('\nNo result yet.');
    }
    break;
  }

  case 'cancel': {
    const id = rest[0];
    if (!id) { console.error('Usage: mission-cli cancel <id>'); process.exit(1); }
    const ok = cancelMissionTask(id);
    console.log(ok ? `Cancelled task: ${id}` : `Could not cancel (may already be completed): ${id}`);
    break;
  }

  default:
    console.error('Commands: create | list | result | cancel');
    process.exit(1);
}
