import crypto from 'crypto';

import {
  createMissionTask,
  getMissionTask,
  listOpenAttentionItems,
  markAttentionAssigned,
  updateAttentionStatus,
  type AttentionItem,
} from './db.js';
import { listAgentIds } from './agent-config.js';
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

function validAgentIds(): Set<string> {
  try {
    return new Set([...BUILTIN_AGENTS, ...listAgentIds()]);
  } catch {
    return BUILTIN_AGENTS;
  }
}

function hasHumanBlocker(text: string): boolean {
  return /\b(?:requires ruan:\s*yes|ruan(?:'s)?\s+(?:approval|review|decision|input|confirmation|call)|your\s+(?:approval|review|decision|input|confirmation|call)|approve|sign[- ]?off|confirm|choose|decide|send\s+(?:the|this|email|message)|external account|admin account|device code|log\s?in|login|re-?auth|authenticate|refresh token|mfa|2fa|consent|payment|billing|bank|manual permission|full disk access|system settings|keychain password)\b/i.test(text);
}

function isInformationalOnly(text: string): boolean {
  return /\b(?:no action required|no action needed|nothing to action|informational only|for info only|0 errors|zero errors|healthy|all clear|completed successfully|no blockers|overdue:\s*none|actions?:\s*none)\b/i.test(text);
}

function suggestedAgent(text: string): string | null {
  const match = text.match(/Suggested agent:\s*@?([a-z][a-z0-9_-]*)/i);
  return match?.[1]?.toLowerCase() ?? null;
}

function explicitlyNoRuan(text: string): boolean {
  return /\bRequires Ruan:\s*no\b/i.test(text);
}

function inferAgent(text: string): string | null {
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
  if (/\b(?:code|build|test|typescript|react|vite|api|endpoint|route|database|postgres|sqlite|supabase|module|dependency|script|caldav|imessage|digest|webhook|frontend|backend|bug|exception|stack trace|shell command)\b/i.test(text)) {
    return 'mason';
  }
  return null;
}

export function classifyAttentionItem(item: AttentionItem): AutofixDecision {
  const text = `${item.title}\n${item.detail}`.trim();

  if (isInformationalOnly(text)) {
    return { action: 'archive', reason: 'informational-only attention row' };
  }

  if (hasHumanBlocker(text)) {
    return { action: 'keep', reason: 'requires a human decision, credential, approval, or manual permission' };
  }

  const agents = validAgentIds();
  const hinted = suggestedAgent(text);
  if (hinted && agents.has(hinted) && explicitlyNoRuan(text)) {
    return { action: 'route', agentId: hinted, reason: 'structured action says the operator is not required and suggests an agent' };
  }

  const inferred = inferAgent(text);
  if (inferred && agents.has(inferred) && (item.source_kind === 'mission' || explicitlyNoRuan(text))) {
    return { action: 'route', agentId: inferred, reason: 'agent-owned issue with no human blocker detected' };
  }

  return { action: 'keep', reason: 'not safe to auto-route confidently' };
}

function missionTitleForAttention(item: AttentionItem): string {
  const source = item.source_kind === 'brief' ? item.detail : item.title;
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

  for (const item of listOpenAttentionItems(limit)) {
    const decision = classifyAttentionItem(item);

    if (decision.action === 'archive') {
      updateAttentionStatus(item.id, 'archived');
      result.archived++;
      logger.info({ attentionId: item.id, reason: decision.reason }, 'attention-autofix: archived item');
      continue;
    }

    if (decision.action === 'route') {
      const linkedMission = item.linked_mission_id ? getMissionTask(item.linked_mission_id) : null;
      if (linkedMission && !TERMINAL_MISSION_STATUSES.has(linkedMission.status)) {
        markAttentionAssigned(item.id, linkedMission.id, decision.agentId);
        result.routed++;
        continue;
      }

      const missionId = crypto.randomBytes(4).toString('hex');
      createMissionTask(
        missionId,
        missionTitleForAttention(item),
        missionPromptForAttention(item, decision.reason),
        decision.agentId,
        'autofix',
        priorityForAttention(item),
      );
      markAttentionAssigned(item.id, missionId, decision.agentId);
      result.routed++;
      logger.info({ attentionId: item.id, missionId, agentId: decision.agentId, reason: decision.reason }, 'attention-autofix: routed item');
      continue;
    }

    result.kept++;
  }

  return result;
}
