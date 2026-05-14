import crypto from 'crypto';

import {
  archiveOpenAttentionItem,
  claimOpenAttentionItem,
  clearScheduledTaskAttention,
  createMissionTask,
  getAllScheduledTasks,
  getMissionReview,
  getMissionTask,
  listOpenAttentionItems,
  markAttentionAssigned,
  releaseAutofixAttentionClaim,
  updateAttentionStatus,
  upsertAttentionItem,
  upsertMissionReview,
  type AttentionItem,
  type ScheduledTask,
} from './db.js';
import { listAgentIds } from './agent-config.js';
import { isEnabled } from './kill-switches.js';
import { logger } from './logger.js';

type AutofixDecision =
  | { action: 'keep'; reason: string }
  | { action: 'archive'; reason: string }
  | { action: 'route'; agentId: string; reason: string };

export interface AttentionAutofixSweepResult {
  routed: number;
  archived: number;
  kept: number;
}

const BUILTIN_AGENTS = new Set(['main', 'charter', 'ember', 'marlow', 'mason', 'warden']);
const TERMINAL_MISSION_STATUSES = new Set(['completed', 'failed', 'partial', 'cancelled']);

function attentionSourceKey(sourceKind: string, sourceId: string, text: string): string {
  const normalized = text.replace(/\s+/g, ' ').trim().toLowerCase();
  const hash = crypto.createHash('sha1').update(normalized).digest('hex').slice(0, 16);
  return `${sourceKind}:${sourceId}:${hash}`;
}

function compactCommandTitle(command: string): string {
  const cleaned = command.replace(/^python3\s+/, '').replace(/^bash\s+/, '').trim();
  const parts = cleaned.split('/');
  const file = parts[parts.length - 1] || cleaned;
  return file.replace(/\.(py|sh)$/i, '').replace(/[-_]/g, ' ');
}

function scheduleTitle(prompt: string): string {
  const firstLine = prompt.split(/\r?\n/).map((line) => line.trim()).find(Boolean) || prompt.trim();
  const beforeMode = firstLine.split('--- SILENT MODE:')[0].trim();
  const execute = beforeMode.match(/Execute exactly:\s*(.+)$/i);
  if (execute?.[1]) return compactCommandTitle(execute[1]);
  const run = beforeMode.match(/Run:\s*(.+)$/i);
  if (run?.[1]) return compactCommandTitle(run[1]);
  return beforeMode.length > 180 ? beforeMode.slice(0, 177) + '...' : beforeMode;
}

export function syncScheduledAttentionItems(tasks: ScheduledTask[] = getAllScheduledTasks()): void {
  const now = Math.floor(Date.now() / 1000);
  const currentSourceKeys = new Set<string>();

  for (const task of tasks) {
    const isStuckRunning = task.status === 'running' && (task.started_at || 0) < now - 30 * 60;
    if (isStuckRunning) {
      const sourceKey = attentionSourceKey('schedule', task.id, `stuck:${task.started_at || 0}`);
      currentSourceKeys.add(sourceKey);
      upsertAttentionItem({
        sourceKind: 'schedule',
        sourceId: task.id,
        sourceKey,
        title: scheduleTitle(task.prompt),
        detail: `Scheduled job still running after ${Math.floor((now - (task.started_at || now)) / 60)}m`,
        severity: 'high',
        href: '/scheduled',
      });
    } else if (task.last_status === 'failed' || task.last_status === 'timeout') {
      const sourceKey = attentionSourceKey('schedule', task.id, `last-status:${task.last_run || 0}:${task.last_status}`);
      currentSourceKeys.add(sourceKey);
      upsertAttentionItem({
        sourceKind: 'schedule',
        sourceId: task.id,
        sourceKey,
        title: scheduleTitle(task.prompt),
        detail: `Last run ${task.last_status}${task.last_result ? `: ${task.last_result.slice(0, 180)}` : ''}`,
        severity: 'high',
        href: '/scheduled',
      });
    }
  }

  for (const stale of listOpenAttentionItems(200)) {
    if (stale.source_kind !== 'schedule') continue;
    if (!currentSourceKeys.has(stale.source_key)) updateAttentionStatus(stale.id, 'archived');
  }
}

function validAgentIds(): Set<string> {
  try {
    return new Set([...BUILTIN_AGENTS, ...listAgentIds()]);
  } catch {
    return BUILTIN_AGENTS;
  }
}

function hasExplicitUserFlag(text: string): boolean {
  return /\bRequires user:\s*yes\b/i.test(text);
}

function hasHardHumanBlocker(text: string): boolean {
  return /\b(?:user(?:'s)?\s+(?:approval|review|decision|input|confirmation|call)|user\s+(?:to|needs? to|must|should)\s+(?:reply|send|call|review|decide|approve|confirm|choose|log\s?in|login|re-?auth|authenticate|inspect|check)|needs?\s+(?:your\s+|user\s+)?review|your\s+(?:approval|review|decision|input|confirmation|call)|approve|sign[- ]?off|confirm(?:\s+approach)?|choose|decide|decision(?:\s+needed|\s+deferred)?|send\s+(?:the|this|email|message)|external account|admin account|device code|log\s?in|login|re-?auth|authenticate|refresh token|mfa|2fa|consent|payment|billing|bank|manual permission|full disk access|system settings|keychain password)\b/i.test(text);
}

function hasActionableSignal(text: string): boolean {
  return /\b(?:has(?: not|n't) been actioned|needs|action|follow.?up|awaiting|blocked|review|approve|failed|missing|error|permission|auth|expired|lapsed|due|overdue|unavailable|re-auth|fix|export|upload|update|build|install|restart|deploy|rerun|retry)\b/i.test(text);
}

function hasExplicitHumanReviewBlocker(text: string): boolean {
  return /\b(?:review|requires review|approval required|requires approval)\b/i.test(text);
}

function hasExternalActionBlocker(text: string): boolean {
  return /\b(?:reply|respond|email|sms|text\s+message|text\s+(?:the|client|participant|family|provider|contact|person|parent|guardian)|message\s+(?:the|client|participant|family|provider|contact|person|parent|guardian)|phone|call|publish|submit|share|post|send\s+(?:reply|response|email|message|sms|text|to|the|this))\b/i.test(text);
}

function isInformationalOnly(text: string): boolean {
  if (/\bno urgent\b/i.test(text) && /\b(?:mostly system notifications|system notifications|marketing)\b/i.test(text) && !hasActionableSignal(text)) return true;
  return /\b(?:no action required|no action needed|nothing to action|informational only|for info only|0 errors|zero errors|healthy|all clear|completed successfully|no blockers|overdue:\s*none|actions?:\s*none)\b/i.test(text);
}

function suggestedAgent(text: string): string | null {
  const match = text.match(/Suggested agent:\s*@?([a-z][a-z0-9_-]*)/i);
  return match?.[1]?.toLowerCase() ?? null;
}

function explicitlyNoUser(text: string): boolean {
  return /\bRequires user:\s*no\b/i.test(text);
}

function hasAgentExecutableWork(text: string): boolean {
  return /\b(?:load|pull|export|upload|update|build|fix|prepare|create|write|run|wire|implement|sync|convert|generate|install|rerun|retry|restart|deploy|test)\b/i.test(text);
}

function isSystemFixRecommendation(text: string): boolean {
  const hasSystemHealthSignal = /\b(?:monitor-brain|brain-watcher|jsonl processing|upstream jsonl|thoughts ingested|ingestion path|ob1-brain-health|imessage|digest|caldav|reminders|database|postgres|sqlite|module|dependency|script|runtime|scheduled job)\b/i.test(text);
  const hasFailureOrFixSignal = /\b(?:fix recommendation|returned exit \d+|exit code \d+|failed|failure|error|unavailable|missing|blocked|0 thoughts ingested)\b/i.test(text);
  return hasSystemHealthSignal && hasFailureOrFixSignal;
}

function inferAgent(text: string): string | null {
  if (isSystemFixRecommendation(text)) {
    return 'mason';
  }
  if (/\b(?:ndis|compliance|audit|ca-0?5|ca-?10|restrictive practice|support plan|charter|policy|behaviour support|regulated)\b/i.test(text)) {
    return 'charter';
  }
  if (/\b(?:draft|reply|email|message|comms|content|brand|copy|social|newsletter|web inquiry|contact form|lucas)\b/i.test(text)) {
    return 'ember';
  }
  if (/\b(?:market|research|strategy|opportunity|competitor|regulatory scan|trend|intel)\b/i.test(text)) {
    return 'marlow';
  }
  if (/\b(?:runtime|stale|worker|dead-?letter|telegram send|notification|provider health|restart|health audit|credential drift|config drift|scheduled job|service health|outbox|watchdog)\b/i.test(text)) {
    return 'warden';
  }
  if (/\b(?:code|build|test|typescript|react|vite|api|endpoint|route|database|postgres|sqlite|supabase|module|dependency|script|caldav|imessage|digest|webhook|frontend|backend|bug|exception|stack trace|shell command|monitor-brain|brain-watcher|jsonl|ingestion path|thoughts ingested)\b/i.test(text)) {
    return 'mason';
  }
  return null;
}

export function classifyAttentionItem(item: AttentionItem): AutofixDecision {
  const text = `${item.title}\n${item.detail}`.trim();

  if (isInformationalOnly(text)) {
    return { action: 'archive', reason: 'informational-only attention row' };
  }

  const agents = validAgentIds();
  const hinted = suggestedAgent(text);
  const hardHumanBlocker = hasHardHumanBlocker(text);

  if (hardHumanBlocker || hasExternalActionBlocker(text) || (hasExplicitUserFlag(text) && hasExplicitHumanReviewBlocker(text))) {
    return { action: 'keep', reason: 'requires a human decision, credential, approval, or manual permission' };
  }

  if (hinted && agents.has(hinted) && explicitlyNoUser(text)) {
    return { action: 'route', agentId: hinted, reason: 'structured action says the operator is not required and suggests an agent' };
  }
  if (hinted && agents.has(hinted) && hasExplicitUserFlag(text) && hasAgentExecutableWork(text)) {
    return { action: 'route', agentId: hinted, reason: 'suggested agent can execute the work without a hard human blocker' };
  }

  const inferred = inferAgent(text);
  if (inferred && agents.has(inferred) && (item.source_kind === 'mission' || item.source_kind === 'schedule' || explicitlyNoUser(text) || isSystemFixRecommendation(text))) {
    return { action: 'route', agentId: inferred, reason: 'agent-owned issue with no human blocker detected' };
  }

  return { action: 'keep', reason: 'not safe to auto-route confidently' };
}

function missionTitleForAttention(item: AttentionItem): string {
  const source = item.title && !/^(morning|midday|evening|other)\s+brief$/i.test(item.title)
    ? item.title
    : item.detail;
  return source
    .replace(/^action needed:\s*/i, '')
    .replace(/^follow up:\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180) || item.title.slice(0, 180);
}

function missionPromptForAttention(item: AttentionItem, reason: string): string {
  return [
    'Auto-routed Needs Attention item.',
    `Auto-route reason: ${reason}`,
    `Attention item: ${item.id}`,
    `Source: ${item.source_kind}:${item.source_id}`,
    `Title: ${item.title}`,
    `Detail: ${item.detail}`,
    item.href ? `Source link: ${item.href}` : '',
    '',
    'Handle this without involving the operator unless you hit a real blocker requiring approval, credential access, account access, or manual action. Report the blocker clearly if that happens.',
  ].filter(Boolean).join('\n');
}

function priorityForAttention(item: AttentionItem): number {
  if (item.severity === 'high') return 9;
  if (item.severity === 'medium') return 6;
  return 3;
}

export function runAttentionAutofixSweep(limit = 50): AttentionAutofixSweepResult {
  const result: AttentionAutofixSweepResult = { routed: 0, archived: 0, kept: 0 };
  if (!isEnabled('DASHBOARD_MUTATIONS_ENABLED')) return result;
  syncScheduledAttentionItems();

  for (const item of listOpenAttentionItems(limit)) {
    const decision = classifyAttentionItem(item);

    if (decision.action === 'archive') {
      if (archiveOpenAttentionItem(item.id)) {
        result.archived++;
        logger.info({ attentionId: item.id, reason: decision.reason }, 'attention-autofix: archived item');
      } else {
        result.kept++;
      }
      continue;
    }

    if (decision.action === 'route') {
      const linkedMission = item.linked_mission_id ? getMissionTask(item.linked_mission_id) : null;
      if (linkedMission && !TERMINAL_MISSION_STATUSES.has(linkedMission.status)) {
        markAttentionAssigned(item.id, linkedMission.id, decision.agentId);
        result.routed++;
        continue;
      }

      if (item.source_kind === 'mission') {
        const existingReview = getMissionReview(item.source_id);
        if (existingReview?.review_status === 'waiting_followup' && existingReview.followup_task_id) {
          const existingFollowup = getMissionTask(existingReview.followup_task_id);
          if (existingFollowup && !TERMINAL_MISSION_STATUSES.has(existingFollowup.status)) {
            markAttentionAssigned(item.id, existingFollowup.id, existingFollowup.assigned_agent ?? decision.agentId);
            result.routed++;
            continue;
          }
        }
      }

      const claim = claimOpenAttentionItem(item.id);
      if (!claim) {
        result.kept++;
        continue;
      }

      const missionId = crypto.randomBytes(4).toString('hex');
      try {
        createMissionTask(
          missionId,
          missionTitleForAttention(item),
          missionPromptForAttention(item, decision.reason),
          decision.agentId,
          'autofix',
          priorityForAttention(item),
        );
        markAttentionAssigned(item.id, missionId, decision.agentId);
        if (item.source_kind === 'mission' && getMissionTask(item.source_id)) {
          upsertMissionReview({
            taskId: item.source_id,
            reviewStatus: 'waiting_followup',
            resolution: 'delegated',
            followupTaskId: missionId,
          });
        }
        if (item.source_kind === 'schedule') {
          clearScheduledTaskAttention(item.source_id, `Assigned auto-fix mission ${missionId} from Needs Attention.`, true);
        }
        result.routed++;
        logger.info({ attentionId: item.id, missionId, agentId: decision.agentId, reason: decision.reason }, 'attention-autofix: routed item');
      } catch (err) {
        releaseAutofixAttentionClaim(item.id);
        throw err;
      }
      continue;
    }

    result.kept++;
  }

  return result;
}
