import { Api, RawApi } from 'grammy';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { serve } from '@hono/node-server';

import fs from 'fs';
import path from 'path';
import { AGENT_ID, ALLOWED_CHAT_ID, DASHBOARD_PORT, DASHBOARD_TOKEN, PROJECT_ROOT, STORE_DIR, WHATSAPP_ENABLED, SLACK_USER_TOKEN, CONTEXT_LIMIT, MISSION_CONTROL_V2, agentDefaultModel, LLM_PROVIDER, BRAIN, OB1_SUPABASE_URL, MCP_ACCESS_KEY, OB1_BRAIN_FUNCTION } from './config.js';
import crypto from 'crypto';
import {
  getAllScheduledTasks,
  deleteScheduledTask,
  pauseScheduledTask,
  resumeScheduledTask,
  clearScheduledTaskAttention,
  getAttentionItem,
  getAttentionItemBySourceKey,
  listOpenAttentionItems,
  markAttentionAssigned,
  updateAttentionStatus,
  upsertAttentionItem,
  getConversationPage,
  getDashboardMemoryStats,
  getDashboardPinnedMemories,
  getDashboardLowSalienceMemories,
  getDashboardTopAccessedMemories,
  getDashboardMemoryTimeline,
  getDashboardConsolidations,
  getDashboardMemoriesList,
  getDashboardTokenStats,
  getDashboardCostTimeline,
  getDashboardRecentTokenUsage,
  getSession,
  getSessionTokenUsage,
  getHiveMindEntries,
  getAgentTokenStats,
  getAgentRecentConversation,
  getMissionTasks,
  getMissionTask,
  getMissionReview,
  createMissionTask,
  completeMissionTask,
  cancelMissionTask,
  deleteMissionTask,
  reassignMissionTask,
  assignMissionTask,
  getUnassignedMissionTasks,
  getMissionTaskHistory,
  upsertMissionReview,
  updateMissionReviewState,
  getAuditLog,
  getAuditLogCount,
  getRecentBlockedActions,
  listActiveMeetSessions,
  listRecentMeetSessions,
  getMeetSession,
  type MeetSession,
  createWarRoomMeeting,
  endWarRoomMeeting,
  addWarRoomTranscript,
  getWarRoomMeetings,
  getWarRoomTranscript,
  type MissionTask,
  type MissionReview,
  type MissionReviewStatus,
  type ScheduledTask,
  type AttentionItem,
} from './db.js';
import { generateContent, parseJsonResponse } from './gemini.js';
import { getSecurityStatus, getScrubbedSdkEnv } from './security.js';
import { readEnvFile } from './env.js';
import { listAgentIds, loadAgentConfig, setAgentModel } from './agent-config.js';
import {
  listTemplates,
  validateAgentId,
  validateBotToken,
  createAgent,
  activateAgent,
  deactivateAgent,
  restartAgent,
  deleteAgent,
  suggestBotNames,
  isAgentRunning,
} from './agent-create.js';
import { processMessageFromDashboard } from './bot.js';
import { getDashboardHtml } from './dashboard-html.js';
import {
  listEditableFiles,
  readEditableFile,
  saveEditableFile,
  listHistory,
  isEditableFileId,
  EditorError,
  MAX_AGENT_FILE_BYTES,
} from './agent-files.js';
import { getWarRoomHtml } from './warroom-html.js';
import { WARROOM_ENABLED, WARROOM_PORT } from './config.js';
import { logger } from './logger.js';
import { getTelegramConnected, getBotInfo, chatEvents, getIsProcessing, abortActiveQuery, ChatEvent } from './state.js';
import {
  getLlmProvider,
  getSupportedLlmProviders,
  normalizeLlmProvider,
  type LlmProviderName,
} from './llm-provider.js';
import { resolveModelForProvider } from './model-router.js';
import { buildAgentRuntimePrompt } from './agent-runtime.js';
import { captureThought, searchThoughts } from './brain/client.js';
import { parseSearchText } from './brain/adapter.js';

const MAIN_AGENT_MODEL = 'claude-opus-4-7';
const DASHBOARD_AUTH_COOKIE = 'claudeclaw_dashboard';

function dashboardCookieValue(): string {
  return crypto.createHash('sha256').update(DASHBOARD_TOKEN).digest('hex');
}

function parseCookieHeader(header: string | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header || '').split(';')) {
    const [rawKey, ...rest] = part.trim().split('=');
    if (!rawKey || rest.length === 0) continue;
    out[rawKey] = decodeURIComponent(rest.join('='));
  }
  return out;
}

function setDashboardAuthCookie(c: any): void {
  c.header(
    'Set-Cookie',
    `${DASHBOARD_AUTH_COOKIE}=${dashboardCookieValue()}; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400`,
  );
}

function dashboardChatId(c: any): string {
  return c.req.query('chatId') || ALLOWED_CHAT_ID || '';
}

function configuredProviderValue(): string {
  return process.env.LLM_PROVIDER || readEnvFile(['LLM_PROVIDER']).LLM_PROVIDER || LLM_PROVIDER;
}

function writeEnvValue(key: string, value: string): void {
  const envPath = path.join(PROJECT_ROOT, '.env');
  let content = '';
  try {
    content = fs.readFileSync(envPath, 'utf-8');
  } catch {
    content = '';
  }

  const lines = content.split('\n');
  let found = false;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim().startsWith(`${key}=`)) {
      lines[i] = `${key}=${value}`;
      found = true;
      break;
    }
  }

  if (!found) {
    if (content.length > 0 && !content.endsWith('\n')) lines.push('');
    lines.push(`${key}=${value}`);
  }

  fs.writeFileSync(envPath, lines.join('\n'), { encoding: 'utf-8', mode: 0o600 });
}

const REVIEW_FILE_MAX_BYTES = 50 * 1024 * 1024;
const REVIEW_EXPORT_DIR = path.join('/tmp', 'claudeclaw-review-exports');
const MSGRAPH_SEND_SCRIPT = path.join(PROJECT_ROOT, 'skills', 'msgraph', 'send_graph_email.py');
const MSGRAPH_CALENDAR_SCRIPT = path.join(PROJECT_ROOT, 'skills', 'msgraph', 'calendar_ops.py');

type ReviewDeliverable = {
  id: string;
  kind: 'file' | 'url' | 'text';
  label: string;
  target: string;
  href: string | null;
  exists: boolean;
  sizeBytes: number | null;
};

type GraphCalendarEvent = {
  id?: string;
  subject?: string;
  start?: string;
  start_tz?: string;
  end?: string;
  end_tz?: string;
  location?: string;
  organizer?: string;
  preview?: string;
};

function userHomeDir(): string {
  return path.dirname(PROJECT_ROOT);
}

function expandUserPath(raw: string): string {
  if (raw.startsWith('~/')) return path.join(userHomeDir(), raw.slice(2));
  return raw;
}

function isPathInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}

function resolveReviewFilePath(raw: string): string | null {
  if (!raw || raw.length > 2000) return null;
  const expanded = expandUserPath(raw.trim());
  if (!path.isAbsolute(expanded)) return null;

  const resolved = path.resolve(expanded);
  const workspaceRoot = path.join(userHomeDir(), 'workspace');
  const allowedRoots = [PROJECT_ROOT, workspaceRoot, '/tmp', '/private/tmp'];
  if (!allowedRoots.some((root) => isPathInside(resolved, root))) return null;

  const deniedRoots = [
    path.join(PROJECT_ROOT, 'store'),
    path.join(PROJECT_ROOT, '.git'),
    path.join(PROJECT_ROOT, '.env'),
  ];
  if (deniedRoots.some((root) => isPathInside(resolved, root))) return null;
  if (/\.(?:db|db-wal|db-shm|sqlite|sqlite3)$/i.test(resolved)) return null;

  try {
    const real = fs.realpathSync(resolved);
    if (!allowedRoots.some((root) => isPathInside(real, root))) return null;
    if (deniedRoots.some((root) => isPathInside(real, root))) return null;
    return real;
  } catch {
    return resolved;
  }
}

function sanitizeExportSlug(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 72) || 'mission-deliverable';
}

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function maskEmail(email: string): string {
  const [name, domain] = email.split('@');
  if (!domain) return 'configured owner';
  const visible = name.length <= 2 ? name[0] || '*' : `${name[0]}***${name[name.length - 1]}`;
  return `${visible}@${domain}`;
}

function safeEmailExportError(err: any): string {
  const raw = String(err?.stderr || err?.message || err || '');
  if (/device code|login\.microsoft|authenticate|Authentication failed/i.test(raw)) {
    return 'Microsoft Graph email authentication failed. Refresh the Graph token, then try again.';
  }
  if (/Mail\.Send|Authorization|Unauthorized|Forbidden|InvalidAuthenticationToken/i.test(raw)) {
    return 'Microsoft Graph rejected the email send. Check Mail.Send consent and the stored Graph refresh token.';
  }
  if (/Attachment not found/i.test(raw)) return 'The export was created but the attachment could not be found.';
  if (/Request error|timeout|ETIMEDOUT|ECONNRESET/i.test(raw)) return 'Microsoft Graph email send timed out or hit a network error.';
  return 'Email export failed. Check the Sage logs for the detailed MS Graph error.';
}

export function configuredReviewExportEmail(
  runtimeEnv: Record<string, string | undefined> = process.env,
  fileEnv: Record<string, string> = readEnvFile(['REVIEW_EXPORT_EMAIL']),
): string | null {
  return runtimeEnv.REVIEW_EXPORT_EMAIL || fileEnv.REVIEW_EXPORT_EMAIL || null;
}

export function configuredReviewExportFromEmail(
  runtimeEnv: Record<string, string | undefined> = process.env,
  fileEnv: Record<string, string> = readEnvFile(['REVIEW_EXPORT_SHARED_MAILBOX', 'REVIEW_EXPORT_FROM_EMAIL']),
): string | null {
  return runtimeEnv.REVIEW_EXPORT_SHARED_MAILBOX
    || runtimeEnv.REVIEW_EXPORT_FROM_EMAIL
    || fileEnv.REVIEW_EXPORT_SHARED_MAILBOX
    || fileEnv.REVIEW_EXPORT_FROM_EMAIL
    || null;
}

function emailEquals(a: string | null | undefined, b: string | null | undefined): boolean {
  return !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase();
}

function reviewFileHref(filePath: string): string {
  return `/api/review/file?path=${encodeURIComponent(filePath)}`;
}

function extractMissionDeliverables(task: MissionTask): ReviewDeliverable[] {
  const text = [task.result || '', task.error || ''].filter(Boolean).join('\n');
  const deliverables: ReviewDeliverable[] = [];
  const seen = new Set<string>();

  const addFile = (rawPath: string) => {
    const clean = rawPath.replace(/[),.;:]+$/g, '');
    const filePath = resolveReviewFilePath(clean);
    if (!filePath || seen.has(`file:${filePath}`)) return;
    seen.add(`file:${filePath}`);
    let exists = false;
    let sizeBytes: number | null = null;
    try {
      const stat = fs.statSync(filePath);
      exists = stat.isFile();
      sizeBytes = stat.size;
    } catch {
      exists = false;
    }
    deliverables.push({
      id: crypto.createHash('sha1').update(`file:${filePath}`).digest('hex').slice(0, 12),
      kind: 'file',
      label: path.basename(filePath),
      target: filePath,
      href: exists ? reviewFileHref(filePath) : null,
      exists,
      sizeBytes,
    });
  };

  const addUrl = (rawUrl: string) => {
    const clean = rawUrl.replace(/[),.;]+$/g, '');
    if (seen.has(`url:${clean}`)) return;
    seen.add(`url:${clean}`);
    deliverables.push({
      id: crypto.createHash('sha1').update(`url:${clean}`).digest('hex').slice(0, 12),
      kind: 'url',
      label: clean.replace(/^https?:\/\//, '').slice(0, 80),
      target: clean,
      href: clean,
      exists: true,
      sizeBytes: null,
    });
  };

  const sendFileRe = /\[SEND_(?:FILE|PHOTO):([^\]|]+)(?:\|[^\]]*)?\]/g;
  let match: RegExpExecArray | null;
  while ((match = sendFileRe.exec(text))) addFile(match[1]);

  const pathRe = /(?:^|[\s("'`])((?:~\/|\/Users\/|\/tmp\/|\/private\/tmp\/)[^\s"'`<>]+(?:\.[A-Za-z0-9]{1,12})?)/g;
  while ((match = pathRe.exec(text))) addFile(match[1]);

  const urlRe = /https?:\/\/[^\s"'`<>]+/g;
  while ((match = urlRe.exec(text))) addUrl(match[0]);

  if (deliverables.length === 0 && (task.result || task.error)) {
    deliverables.push({
      id: 'mission-result',
      kind: 'text',
      label: 'Mission result',
      target: task.id,
      href: null,
      exists: true,
      sizeBytes: null,
    });
  }

  return deliverables;
}

const OPEN_REVIEW_STATUSES = new Set<MissionReviewStatus>(['needs_review', 'needs_triage', 'waiting_followup', 'snoozed']);

// Sorted (Category B) items are FYI only — they age out after 7 days so the
// inbox doesn't accumulate stale heads-up notifications.
const SORTED_DECAY_SECONDS = 7 * 24 * 60 * 60;

function isStaleSortedItem(task: MissionTask, kind: 'needs_action' | 'sorted'): boolean {
  if (kind !== 'sorted') return false;
  const ts = task.completed_at || task.created_at || 0;
  if (!ts) return false;
  return (Math.floor(Date.now() / 1000) - ts) > SORTED_DECAY_SECONDS;
}

function reviewTaskText(task: MissionTask): string {
  return `${task.title}\n${task.prompt}\n${task.result || ''}\n${task.error || ''}`;
}

function reviewOutcomeText(task: MissionTask): string {
  return `${task.title}\n${task.result || ''}\n${task.error || ''}`;
}

function missionAgeHours(task: MissionTask): number {
  const t = task.completed_at || task.created_at || Math.floor(Date.now() / 1000);
  return (Date.now() / 1000 - t) / 3600;
}

function isReviewSpawnedTask(task: MissionTask): boolean {
  return task.created_by === 'review-inbox' || /^(retry|follow up):/i.test(task.title);
}

// Category A — anything that needs Ruan's hands or judgement.
// Broadened per 2026-05-06 spec: "anything with a deliverable that was asked
// for, or developed and needs my review, or is waiting for me to send".
// Keep the regex permissive; Category C (auto-hide) is handled by the
// completedMissionHasFollowUp suppression and lineage gate, not by being
// picky here.
const HUMAN_ACTION_PATTERN = new RegExp([
  // Direct asks for action / decision
  'needs? (?:your|ruan)',
  'requires? (?:your|ruan|approval|review|sign[- ]?off|input|decision|attention|confirmation|authori[sz]ation)',
  'awaiting (?:you|your|ruan|review|approval|sign[- ]?off|decision|confirmation|input|response)',
  'waiting (?:on|for) (?:you|ruan|your)',
  'blocked (?:on|by) (?:you|ruan)',
  'pending (?:your|ruan|approval|review|sign[- ]?off|decision|confirmation)',
  // Verbs Ruan must perform
  'please (?:review|send|sign|approve|confirm|decide|choose|grant|authori[sz]e|check|provide)',
  'ready (?:for you|to send|to sign|for review|for approval|for your review|for ruan)',
  '(?:^|\\s|: )(?:review|send|sign|approve|decide|grant|authori[sz]e|choose|confirm)\\s+(?:and|the|this|these|attached|draft|email|message|document|deliverable|pack|file|response|invoice|reply)',
  // Sign-off / approval framings
  'sign[- ]?off (?:required|needed|please)',
  'approval (?:required|needed|please)',
  'action required',
  'action needed',
  'manual (?:step|action|fix|refresh|intervention)',
  'requires? manual',
  // Auth + credential rotation patterns (Warden territory)
  'full disk access',
  'app[- ]?specific password',
  'credentials?\\b.*(?:refresh|rotate|expired|invalid)',
  'password refresh',
  'grant permission',
  // "Your X" patterns
  'your (?:input|decision|approval|review|sign[- ]?off|attention|confirmation|authori[sz]ation|hands?|call)',
  // Ready-for-Ruan-to-send patterns
  'ready to (?:send|sign|email|publish|share|deliver|submit)',
  'draft (?:ready|prepared|complete|done)',
  // Deliverable-handoff phrasing
  'deliverable (?:ready|prepared|landed|attached|for review)',
  'handoff (?:ready|prepared|for review)',
  'review pack',
  'what you need to do',
  // Restart / system hand
  'send /restart',
].join('|'), 'i');

function containsHumanActionSignal(task: MissionTask): boolean {
  return HUMAN_ACTION_PATTERN.test(reviewOutcomeText(task));
}

// Intent-based deliverable detector. No agent exclusion — a mason or warden
// completion that produced a deliverable Ruan needs to review still counts.
// (2026-05-06: removed the hard mason/warden exclusion that was filtering
// 32/34 completions out of the inbox.)
function isNonDevDeliverable(task: MissionTask): boolean {
  return /(deliverable|handoff|review pack|prepared|draft (?:ready|complete|done)?|response (?:ready|drafted|prepared)|audit|compliance|support plan|restrictive practice|charter|inquiry)/i
    .test(reviewOutcomeText(task));
}

// Category B — "you asked for this and it's sorted" framing.
//
// True when the mission's lineage traces back to a Ruan-facing surface:
//   - mission-cli invocation by Sage (created_by='main') — Ruan asked Sage on Telegram
//   - dashboard Home/Needs-Attention assignment (created_by='dashboard')
//   - review-inbox follow-up (created_by='review-inbox')
//   - prompt explicitly cites a morning-brief / Warden / Home-attention origin
//   - parent mission (via "Source mission:" / "Parent mission:" reference) was Ruan-originated
//
// Internal agent-to-agent chatter (created_by=<specialist>, no Ruan-facing
// breadcrumb in the prompt) returns false.
// `created_by` values that *prove* a Ruan-facing origin. 'dashboard' is
// excluded because it's the generic default for any mission_cli call from
// the dashboard surface, including internal cron + agent-to-agent traffic;
// dashboard-originated Home/Needs-Attention follow-ups are detected via the
// explicit prompt breadcrumbs in RUAN_ORIGIN_PROMPT_HINTS instead.
const RUAN_FACING_CREATORS = new Set(['main', 'review-inbox', 'telegram', 'cli']);
const RUAN_ORIGIN_PROMPT_HINTS = /(needs attention item from home dashboard|scheduled needs attention follow-up|action needed|morning brief|warden alert|warden report|imessage|whatsapp|telegram message|slack message|asked by ruan|requested by ruan|from ruan)/i;

function parentMissionIdFromPrompt(prompt: string): string | null {
  const m = prompt.match(/(?:Source mission|Parent mission):\s*([A-Za-z0-9_-]+)/i);
  return m ? m[1] : null;
}

function originatedFromUser(task: MissionTask, missions: MissionTask[], depth = 0): boolean {
  if (depth > 4) return false;
  if (RUAN_FACING_CREATORS.has(task.created_by)) return true;
  if (RUAN_ORIGIN_PROMPT_HINTS.test(task.prompt)) return true;
  const parentId = parentMissionIdFromPrompt(task.prompt);
  if (parentId) {
    const parent = missions.find((m) => m.id === parentId);
    if (parent) return originatedFromUser(parent, missions, depth + 1);
  }
  return false;
}

// True when this completed mission deserves a "sorted ✓" heads-up rather
// than an action prompt. Distinct from Category A — these don't need Ruan
// to do anything, but he asked for them so he wants to know they landed.
function isSortedCompletion(task: MissionTask, missions: MissionTask[]): boolean {
  if (task.status !== 'completed') return false;
  if (containsHumanActionSignal(task)) return false; // Category A wins
  if (isNonDevDeliverable(task)) return false;       // Category A wins
  return originatedFromUser(task, missions);
}

function isRecentActionableFailure(task: MissionTask): boolean {
  if (task.status !== 'failed' && task.status !== 'partial') return false;
  if (isReviewSpawnedTask(task)) return true;
  if (containsHumanActionSignal(task)) return true;
  return missionAgeHours(task) <= 6 && task.assigned_agent !== null;
}

function defaultReviewStatusForTask(task: MissionTask, missions: MissionTask[]): MissionReviewStatus | null {
  if (task.status === 'failed' || task.status === 'partial') {
    return isRecentActionableFailure(task) ? 'needs_triage' : null;
  }
  if (task.status === 'completed') {
    if (completedMissionHasFollowUp(task, missions)) return null;
    // Category A: anything that needs Ruan's hands or a deliverable he asked for.
    if (containsHumanActionSignal(task)) return 'needs_review';
    if (isNonDevDeliverable(task)) return 'needs_review';
    // Category B: Ruan-originated lineage — surface as a "sorted ✓" heads-up.
    if (isSortedCompletion(task, missions)) return 'needs_review';
    // Category C: routine internal chatter — auto-hide.
    return null;
  }
  return null;
}

function refreshReviewFromFollowup(review: MissionReview): MissionReview {
  if (review.review_status !== 'waiting_followup' || !review.followup_task_id) return review;
  const followup = getMissionTask(review.followup_task_id);
  if (!followup || !TERMINAL_MISSION_STATUSES.has(followup.status)) return review;
  if (followup.status === 'completed') {
    return upsertMissionReview({
      taskId: review.task_id,
      reviewStatus: 'resolved',
      resolution: 'followup_completed',
      followupTaskId: followup.id,
      instruction: review.instruction,
    });
  }
  return upsertMissionReview({
    taskId: review.task_id,
    reviewStatus: 'needs_triage',
    resolution: 'retried',
    followupTaskId: followup.id,
    instruction: review.instruction,
  });
}

function effectiveMissionReview(task: MissionTask, missions: MissionTask[]): MissionReview | null {
  const existing = getMissionReview(task.id);
  if (existing) return refreshReviewFromFollowup(existing);

  const reviewStatus = defaultReviewStatusForTask(task, missions);
  if (!reviewStatus) return null;
  const now = Math.floor(Date.now() / 1000);
  return {
    task_id: task.id,
    review_status: reviewStatus,
    resolution: null,
    followup_task_id: null,
    instruction: null,
    snoozed_until: null,
    reviewed_at: null,
    created_at: task.completed_at || task.created_at || now,
    updated_at: task.completed_at || task.created_at || now,
  };
}

function shouldShowReview(review: MissionReview): boolean {
  if (!OPEN_REVIEW_STATUSES.has(review.review_status)) return false;
  if (review.review_status === 'snoozed' && review.snoozed_until && review.snoozed_until > Math.floor(Date.now() / 1000)) return false;
  return true;
}

// `kind` distinguishes Category A (action) from Category B (sorted heads-up)
// so the frontend can render them in separate groups.
function reviewItemKind(task: MissionTask, missions: MissionTask[]): 'needs_action' | 'sorted' {
  if (task.status === 'failed' || task.status === 'partial') return 'needs_action';
  if (task.status === 'completed') {
    if (containsHumanActionSignal(task)) return 'needs_action';
    if (isNonDevDeliverable(task)) return 'needs_action';
    if (isSortedCompletion(task, missions)) return 'sorted';
  }
  return 'needs_action';
}

function buildReviewItem(task: MissionTask, review: MissionReview, missions: MissionTask[]) {
  const text = task.result || task.error || '';
  return {
    id: task.id,
    title: task.title,
    agentId: task.assigned_agent,
    status: task.status,
    priority: task.priority,
    createdAt: task.created_at,
    completedAt: task.completed_at,
    summary: text.replace(/\s+/g, ' ').trim().slice(0, 260),
    result: task.result,
    error: task.error,
    kind: reviewItemKind(task, missions),
    deliverables: extractMissionDeliverables(task),
    review: {
      status: review.review_status,
      resolution: review.resolution,
      followupTaskId: review.followup_task_id,
      instruction: review.instruction,
      snoozedUntil: review.snoozed_until,
      reviewedAt: review.reviewed_at,
      updatedAt: review.updated_at,
    },
  };
}

function buildReviewFollowupPrompt(task: MissionTask, instructions: string): string {
  return [
    `This is a follow-up mission created from Review Inbox.`,
    `Parent mission: ${task.id}`,
    `Parent title: ${task.title}`,
    `Parent status: ${task.status}`,
    '',
    `Original prompt:`,
    task.prompt,
    '',
    `Previous result/error:`,
    task.result || task.error || 'No result text was recorded.',
    '',
    `Ruan's instructions for this pass:`,
    instructions || 'Review the previous result, close the loop, and return a clear deliverable or blocker.',
    '',
    `Expected output: return the deliverable, exact file/link if one is created, and any remaining blocker.`,
  ].join('\n');
}

function missionTaskExportHtml(task: MissionTask): string {
  const when = task.completed_at ? new Date(task.completed_at * 1000).toLocaleString('en-AU') : 'not completed';
  const body = task.result || task.error || 'No result content was recorded for this mission task.';
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>${escapeHtml(task.title)}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #111827; line-height: 1.5; }
    h1 { font-size: 24px; margin: 0 0 8px; }
    .meta { color: #6b7280; font-size: 12px; margin-bottom: 24px; }
    pre { white-space: pre-wrap; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; background: #f3f4f6; padding: 16px; border-radius: 6px; }
  </style>
</head>
<body>
  <h1>${escapeHtml(task.title)}</h1>
  <div class="meta">Mission ${escapeHtml(task.id)} · ${escapeHtml(task.assigned_agent || 'unassigned')} · ${escapeHtml(task.status)} · ${escapeHtml(when)}</div>
  <pre>${escapeHtml(body)}</pre>
</body>
</html>`;
}

async function createMissionTaskExport(task: MissionTask, format: 'docx' | 'html' = 'docx'): Promise<{ path: string; format: string }> {
  fs.mkdirSync(REVIEW_EXPORT_DIR, { recursive: true, mode: 0o700 });
  const slug = sanitizeExportSlug(task.title);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const htmlPath = path.join(REVIEW_EXPORT_DIR, `${slug}-${task.id}-${stamp}.html`);
  fs.writeFileSync(htmlPath, missionTaskExportHtml(task), { encoding: 'utf-8', mode: 0o600 });

  if (format === 'html') return { path: htmlPath, format: 'html' };

  const docxPath = htmlPath.replace(/\.html$/, '.docx');
  try {
    const { safeExecFileAsync } = await import('./safe-spawn.js');
    await safeExecFileAsync('textutil', ['-convert', 'docx', '-output', docxPath, htmlPath], {
      envClass: 'system-tool',
      timeout: 30_000,
    });
    if (fs.existsSync(docxPath)) return { path: docxPath, format: 'docx' };
  } catch {
    // Fall back to HTML on systems without textutil conversion support.
  }

  return { path: htmlPath, format: 'html' };
}

async function sendMissionTaskExportEmail(task: MissionTask, to: string, from: string, attachmentPath: string): Promise<void> {
  const graphEnv = readEnvFile([
    'GRAPH_CLIENT_ID',
    'GRAPH_TENANT_ID',
    'GRAPH_CLIENT_SECRET',
    'GRAPH_REFRESH_TOKEN',
    'MSGRAPH_FORBIDDEN_FROM_EMAILS',
  ]);
  const bodyPath = attachmentPath.replace(/\.[^.]+$/, '.email.html');
  const body = `<p>Attached is the exported deliverable from Mission Control.</p>
<p><strong>${escapeHtml(task.title)}</strong><br>
Mission ${escapeHtml(task.id)} · ${escapeHtml(task.assigned_agent || 'unassigned')} · ${escapeHtml(task.status)}</p>`;
  fs.writeFileSync(bodyPath, body, { encoding: 'utf-8', mode: 0o600 });

  const { safeExecFileAsync } = await import('./safe-spawn.js');
  await safeExecFileAsync('python3', [
    MSGRAPH_SEND_SCRIPT,
    '--to', to,
    '--from', from,
    '--subject', `Mission deliverable: ${task.title}`,
    '--body-file', bodyPath,
    '--html',
    '--attach', attachmentPath,
  ], {
    envClass: 'sdk',
    extraEnv: graphEnv,
    cwd: PROJECT_ROOT,
    timeout: 60_000,
  });
}

function openBrainConfigured(): boolean {
  return BRAIN === 'ob1' && !!OB1_SUPABASE_URL && !!MCP_ACCESS_KEY && !!OB1_BRAIN_FUNCTION;
}

function currentProvider(): LlmProviderName {
  return normalizeLlmProvider(LLM_PROVIDER);
}

function currentProviderStatus(): { provider: LlmProviderName; providerError: string | null } {
  try {
    return { provider: currentProvider(), providerError: null };
  } catch (err: any) {
    return {
      provider: 'claude',
      providerError: err?.recovery?.userMessage || err?.message || 'Unsupported LLM provider',
    };
  }
}

function shortenSessionId(sessionId: string | undefined): string | null {
  if (!sessionId) return null;
  if (sessionId.length <= 16) return sessionId;
  return `${sessionId.slice(0, 8)}...${sessionId.slice(-4)}`;
}

function killSwitchFlag(name: string, dflt: boolean): boolean {
  const v = process.env[name];
  if (v === undefined) return dflt;
  return v !== 'false' && v !== '0';
}

type BriefSlot = 'morning' | 'midday' | 'evening' | 'other';
type AttentionSeverity = 'high' | 'medium' | 'low';

const TERMINAL_MISSION_STATUSES = new Set(['completed', 'failed', 'partial', 'cancelled']);

function scheduleTitle(prompt: string): string {
  const firstLine = prompt.split(/\r?\n/).map((line) => line.trim()).find(Boolean) || prompt.trim();
  const beforeMode = firstLine.split('--- SILENT MODE:')[0].trim();
  const execute = beforeMode.match(/Execute exactly:\s*(.+)$/i);
  if (execute?.[1]) return compactCommandTitle(execute[1]);
  const run = beforeMode.match(/Run:\s*(.+)$/i);
  if (run?.[1]) return compactCommandTitle(run[1]);
  return beforeMode.length > 180 ? beforeMode.slice(0, 177) + '...' : beforeMode;
}

function compactCommandTitle(command: string): string {
  const cleaned = command.replace(/^python3\s+/, '').replace(/^bash\s+/, '').trim();
  const parts = cleaned.split('/');
  const file = parts[parts.length - 1] || cleaned;
  return file.replace(/\.(py|sh)$/i, '').replace(/[-_]/g, ' ');
}

function briefSlot(task: ScheduledTask): BriefSlot | null {
  const prompt = task.prompt;
  if (!/morning|mid.?day|afternoon|evening|daily|brief|wrap|pulse|shutdown/i.test(prompt)) return null;
  if (/morning/i.test(prompt)) return 'morning';
  if (/mid.?day|afternoon|pulse/i.test(prompt)) return 'midday';
  if (/evening|wrap|shutdown/i.test(prompt)) return 'evening';
  return 'other';
}

function briefLabel(slot: BriefSlot): string {
  if (slot === 'morning') return 'Morning';
  if (slot === 'midday') return 'Midday';
  if (slot === 'evening') return 'Evening';
  return 'Other';
}

function isMeaningfulBriefResult(result: string | null): result is string {
  if (!result) return false;
  const cleaned = result.trim();
  return cleaned.length > 0 && !/^OK$/i.test(cleaned);
}

function extractAttentionItems(text: string, limit = 4): string[] {
  const out: string[] = [];
  const seen = new Set<string>();

  for (const line of text.split(/\r?\n/)) {
    const cleaned = line
      .replace(/^[-*•☐\d.)\s]+/, '')
      .replace(/\*\*/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!cleaned || /^OK$/i.test(cleaned)) continue;
    if (/^(action needed|blocked on you|open threads|stale|breakdown|notes|projects|compliance|calendar|inbox|today|tomorrow top 3):?$/i.test(cleaned)) continue;
    if (/^(items blocked\/awaiting|total unread|after triage|skipped):/i.test(cleaned)) continue;
    if (!/urgent|overdue|blocked|awaiting|needs|action|failed|missing|error|risk|review|approve|follow.?up|due|tomorrow top|open threads|auth|expired|lapsed|consent|unavailable|re-auth|permission/i.test(cleaned)) continue;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(cleaned.length > 260 ? `${cleaned.slice(0, 257)}...` : cleaned);
    if (out.length >= limit) break;
  }

  return out;
}

function buildHomeBriefs(tasks: ScheduledTask[]) {
  const candidates = tasks
    .filter((task) => isMeaningfulBriefResult(task.last_result))
    .map((task) => ({ task, slot: briefSlot(task) }))
    .filter((entry): entry is { task: ScheduledTask; slot: BriefSlot } => !!entry.slot)
    .sort((a, b) => (b.task.last_run || 0) - (a.task.last_run || 0));

  const bySlot = new Map<BriefSlot, ScheduledTask>();
  for (const entry of candidates) {
    if (!bySlot.has(entry.slot)) bySlot.set(entry.slot, entry.task);
  }

  const latestTaskId = candidates[0]?.task.id || null;
  return (['morning', 'midday', 'evening', 'other'] as BriefSlot[])
    .map((slot) => {
      const task = bySlot.get(slot);
      if (!task || !task.last_result) return null;
      return {
        slot,
        label: briefLabel(slot),
        taskId: task.id,
        title: scheduleTitle(task.prompt),
        agentId: task.agent_id,
        status: task.status,
        schedule: task.schedule,
        nextRun: task.next_run,
        lastRun: task.last_run,
        lastStatus: task.last_status,
        content: task.last_result,
        attentionItems: extractAttentionItems(task.last_result),
        primary: task.id === latestTaskId,
      };
    })
    .filter(Boolean);
}

function severityForText(text: string): AttentionSeverity {
  if (/urgent|overdue|blocked|failed|missing|error|risk|deadline/i.test(text)) return 'high';
  if (/awaiting|needs|action|review|approve|follow.?up|due/i.test(text)) return 'medium';
  return 'low';
}

function attentionSourceKey(sourceKind: string, sourceId: string, text: string): string {
  const normalized = text.replace(/\s+/g, ' ').trim().toLowerCase();
  const hash = crypto.createHash('sha1').update(normalized).digest('hex').slice(0, 16);
  return `${sourceKind}:${sourceId}:${hash}`;
}

function syncReportAttentionItems(tasks: ScheduledTask[], missions: MissionTask[]): void {
  for (const brief of buildHomeBriefs(tasks)) {
    if (!brief) continue;
    for (const detail of brief.attentionItems) {
      const sourceKey = attentionSourceKey('brief', brief.taskId, detail);
      if (briefDetailCoveredByMission(detail, missions)) {
        const existing = getAttentionItemBySourceKey(sourceKey);
        if (existing?.status === 'open') updateAttentionStatus(existing.id, 'assigned');
        continue;
      }

      upsertAttentionItem({
        sourceKind: 'brief',
        sourceId: brief.taskId,
        sourceKey,
        title: `${brief.label} brief`,
        detail,
        severity: severityForText(detail),
        href: '/home',
      });
    }
  }
}

function durableAttentionToHome(item: AttentionItem) {
  return {
    id: `attention:${item.id}`,
    source: item.source_kind,
    severity: item.severity,
    title: item.title,
    detail: item.detail,
    createdAt: item.updated_at || item.created_at,
    agentId: item.assigned_agent,
    taskId: item.source_id,
    href: item.href || '/home',
  };
}

function briefDetailCoveredByMission(detail: string, missions: MissionTask[]): boolean {
  const d = detail.toLowerCase();
  const missionTitles = missions.map((mission) => mission.title.toLowerCase());
  const hasMission = (patterns: RegExp[]) => missionTitles.some((title) => patterns.some((pattern) => pattern.test(title)));

  if (/(caldav|scripts unavailable|reminders)/i.test(d)) {
    return hasMission([/reminders/, /caldav/]);
  }
  if (/(imessage|digest unavailable|database access error)/i.test(d)) {
    return hasMission([/imessage/, /digest access/]);
  }
  if (/ca-05|support plans/i.test(d)) {
    return hasMission([/ca-05/, /support plans/]);
  }
  if (/ca-10|restrictive practices/i.test(d)) {
    return hasMission([/ca-10/, /restrictive practices/]);
  }
  if (/charter v3|sharepoint upload|external compliance review/i.test(d)) {
    return hasMission([/charter v3/]);
  }
  if (/lucas rigucini|web inquiry/i.test(d)) {
    return hasMission([/lucas/, /inquiry response/]);
  }

  return false;
}

function completedMissionNeedsAttention(mission: MissionTask, now: number): boolean {
  if (mission.status !== 'completed') return false;
  if ((mission.completed_at || 0) < now - 86400) return false;
  if (mission.assigned_agent !== 'warden') return false;
  if (!/reminders|caldav|imessage|digest|full disk access|tcc|keychain|auth/i.test(mission.title)) return false;
  const result = `${mission.result || ''}\n${mission.error || ''}`;
  return /critical|unauthorized|permission|full disk access|app-specific password|required|requires|blocked|needs? r(u|)an|manual/i.test(result);
}

function completedMissionDetail(mission: MissionTask): string {
  const result = (mission.result || mission.error || '').split(/\r?\n/).map((line) => line.replace(/\*\*/g, '').trim()).filter(Boolean);
  const useful = result.find((line) => /critical|root cause|unauthorized|permission|full disk access|app-specific password|required|requires|blocked|manual/i.test(line))
    || result[0]
    || 'Completed with follow-up required';
  return useful.length > 220 ? `${useful.slice(0, 217)}...` : useful;
}

function normalizedAttentionTitle(title: string): string {
  return title.replace(/^follow up:\s*/i, '').trim().toLowerCase();
}

function missionFollowUpSourceKey(mission: MissionTask): string | null {
  if (!/^follow up:/i.test(mission.title)) return null;
  const promptSource = mission.prompt.match(/Source mission:\s*([A-Za-z0-9_-]+)/i)?.[1];
  return promptSource || `title:${normalizedAttentionTitle(mission.title)}`;
}

function canonicalFollowUpIds(missions: MissionTask[]): Set<string> {
  const bySource = new Map<string, MissionTask>();
  for (const mission of missions) {
    if (TERMINAL_MISSION_STATUSES.has(mission.status)) continue;
    const source = missionFollowUpSourceKey(mission);
    if (!source) continue;
    const current = bySource.get(source);
    if (!current) {
      bySource.set(source, mission);
      continue;
    }
    const currentRank = current.status === 'running' ? 2 : 1;
    const nextRank = mission.status === 'running' ? 2 : 1;
    if (nextRank > currentRank || (nextRank === currentRank && mission.created_at > current.created_at)) {
      bySource.set(source, mission);
    }
  }
  return new Set([...bySource.values()].map((mission) => mission.id));
}

// Only suppress the parent when an ACTIVE follow-up exists. If the follow-up
// itself is already completed/failed/partial, the parent must remain visible
// so Ruan can review the result. (2026-05-06: this used to suppress
// regardless of follow-up status, which hid completions Ruan asked for.)
const ACTIVE_FOLLOWUP_STATUSES = new Set(['queued', 'running', 'assigned']);

function completedMissionHasFollowUp(mission: MissionTask, missions: MissionTask[]): boolean {
  const titleKey = `title:${normalizedAttentionTitle(mission.title)}`;
  return missions.some((candidate) => {
    if (!ACTIVE_FOLLOWUP_STATUSES.has(candidate.status)) return false;
    const source = missionFollowUpSourceKey(candidate);
    return source === mission.id || source === titleKey;
  });
}

function buildHomeAttention(tasks: ScheduledTask[], missions: MissionTask[]) {
  syncReportAttentionItems(tasks, missions);
  const canonicalFollowUps = canonicalFollowUpIds(missions);
  const items: Array<{
    id: string;
    source: 'brief' | 'mission' | 'schedule';
    severity: AttentionSeverity;
    title: string;
    detail: string;
    createdAt: number;
    agentId?: string | null;
    taskId?: string;
    href?: string;
  }> = [];

  items.push(...listOpenAttentionItems(50).map(durableAttentionToHome));

  for (const mission of missions) {
    const review = getMissionReview(mission.id);
    if (!TERMINAL_MISSION_STATUSES.has(mission.status)) {
      const followUpSource = missionFollowUpSourceKey(mission);
      if (followUpSource && !canonicalFollowUps.has(mission.id)) continue;
      const ageHours = (Date.now() / 1000 - mission.created_at) / 3600;
      if (mission.assigned_agent && mission.status === 'queued' && ageHours <= 12) continue;
      items.push({
        id: `mission:${mission.id}`,
        source: 'mission',
        severity: mission.status === 'running' || ageHours > 12 || !mission.assigned_agent ? 'medium' : 'low',
        title: mission.title,
        detail: `${mission.status}${mission.assigned_agent ? ` with @${mission.assigned_agent}` : ', unassigned'} · priority ${mission.priority}`,
        createdAt: mission.started_at || mission.created_at,
        agentId: mission.assigned_agent,
        taskId: mission.id,
        href: '/mission',
      });
    } else if (review && ['archived', 'resolved', 'waiting_followup'].includes(review.review_status)) {
      continue;
    } else if ((mission.status === 'failed' || mission.status === 'partial') && (mission.completed_at || 0) > Date.now() / 1000 - 8 * 3600) {
      items.push({
        id: `mission:${mission.id}:terminal`,
        source: 'mission',
        severity: mission.status === 'failed' ? 'high' : 'medium',
        title: mission.title,
        detail: mission.status === 'failed' ? (mission.error || 'Mission failed') : 'Mission landed partial work and needs review',
        createdAt: mission.completed_at || mission.created_at,
        agentId: mission.assigned_agent,
        taskId: mission.id,
        href: '/mission',
      });
    } else if (completedMissionNeedsAttention(mission, Math.floor(Date.now() / 1000)) && !completedMissionHasFollowUp(mission, missions)) {
      items.push({
        id: `mission:${mission.id}:follow-up`,
        source: 'mission',
        severity: 'medium',
        title: mission.title,
        detail: completedMissionDetail(mission),
        createdAt: mission.completed_at || mission.created_at,
        agentId: mission.assigned_agent,
        taskId: mission.id,
        href: '/mission',
      });
    }
  }

  const now = Math.floor(Date.now() / 1000);
  for (const task of tasks) {
    if (task.status === 'running' && (task.started_at || 0) < now - 30 * 60) {
      items.push({
        id: `schedule:${task.id}:stuck`,
        source: 'schedule',
        severity: 'high',
        title: scheduleTitle(task.prompt),
        detail: `Scheduled job still running after ${Math.floor((now - (task.started_at || now)) / 60)}m`,
        createdAt: task.started_at || task.created_at,
        agentId: task.agent_id,
        taskId: task.id,
        href: '/tasks',
      });
    }
    if (task.last_status === 'failed' || task.last_status === 'timeout') {
      items.push({
        id: `schedule:${task.id}:last-status`,
        source: 'schedule',
        severity: 'high',
        title: scheduleTitle(task.prompt),
        detail: `Last run ${task.last_status}${task.last_result ? `: ${task.last_result.slice(0, 180)}` : ''}`,
        createdAt: task.last_run || task.created_at,
        agentId: task.agent_id,
        taskId: task.id,
        href: '/tasks',
      });
    }
  }

  const rank = { high: 0, medium: 1, low: 2 } satisfies Record<AttentionSeverity, number>;
  return items
    .sort((a, b) => rank[a.severity] - rank[b.severity] || b.createdAt - a.createdAt)
    .slice(0, 12);
}

function describeCron(cron: string): string {
  if (cron === '0 9 * * *') return 'Daily at 9am';
  if (cron === '0 8 * * 1-5') return 'Weekdays at 8am';
  if (cron === '0 9 * * 1') return 'Mondays at 9am';
  if (cron === '0 18 * * 0') return 'Sundays at 6pm';
  const hourly = cron.match(/^0 \*\/(\d+) \* \* \*$/);
  if (hourly) return 'Every ' + hourly[1] + 'h';
  return cron;
}

function parseGraphCalendarTime(value: string | undefined): number | null {
  if (!value) return null;
  const normalized = /Z$|[+-]\d\d:\d\d$/.test(value) ? value : value + 'Z';
  const ms = Date.parse(normalized);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

function formatCalendarDetail(event: GraphCalendarEvent): string {
  const parts = [
    event.location?.trim(),
    event.organizer ? `organizer ${event.organizer}` : '',
    event.preview?.trim(),
  ].filter(Boolean);
  return parts.join(' · ');
}

async function fetchHomeCalendarItems() {
  if (process.env.NODE_ENV === 'test' || process.env.VITEST) {
    return {
      connected: false,
      items: [] as any[],
      note: 'Microsoft Graph calendar read disabled in tests.',
    };
  }

  const graphEnv = readEnvFile(['GRAPH_CLIENT_ID', 'GRAPH_TENANT_ID', 'GRAPH_CLIENT_SECRET', 'GRAPH_REFRESH_TOKEN']);
  if (!graphEnv.GRAPH_REFRESH_TOKEN) {
    return {
      connected: false,
      items: [] as any[],
      note: 'Microsoft Graph calendar refresh token is not configured.',
    };
  }

  const { safeExecFileAsync } = await import('./safe-spawn.js');
  try {
    const { stdout } = await safeExecFileAsync('python3', [
      MSGRAPH_CALENDAR_SCRIPT,
      'list',
      '--days',
      '1',
      '--top',
      '12',
    ], {
      envClass: 'sdk',
      extraEnv: graphEnv,
      cwd: PROJECT_ROOT,
      timeout: 30_000,
    });

    const events = JSON.parse(stdout || '[]') as GraphCalendarEvent[];
    const now = Math.floor(Date.now() / 1000);
    const items = events
      .map((event) => {
        const dueAt = parseGraphCalendarTime(event.start);
        if (!event.id || !dueAt) return null;
        return {
          id: event.id,
          source: 'calendar',
          title: event.subject || '(untitled calendar event)',
          agentId: null,
          status: 'active',
          dueAt,
          overdue: dueAt < now,
          detail: formatCalendarDetail(event),
        };
      })
      .filter((item): item is NonNullable<typeof item> => !!item)
      .sort((a, b) => a.dueAt - b.dueAt);

    return {
      connected: true,
      items,
      note: items.length ? 'Microsoft Graph calendar connected.' : 'Microsoft Graph calendar connected. No personal calendar items in the next 24 hours.',
    };
  } catch (err: any) {
    const raw = String(err?.stderr || err?.message || err || '');
    const note = /No refresh token|refresh|token|auth|login|device code/i.test(raw)
      ? 'Microsoft Graph calendar authentication needs attention.'
      : 'Microsoft Graph calendar read failed. Check Sage logs for details.';
    logger.warn({ err: raw.slice(0, 500) }, 'Home calendar read failed');
    return { connected: false, items: [] as any[], note };
  }
}

function buildHomeScheduleAgenda(tasks: ScheduledTask[]) {
  const now = Math.floor(Date.now() / 1000);
  const horizon = now + 24 * 60 * 60;
  return tasks
    .filter((task) => task.status !== 'paused')
    .filter((task) => task.next_run <= horizon || task.next_run < now)
    .sort((a, b) => a.next_run - b.next_run)
    .slice(0, 12)
    .map((task) => ({
      id: task.id,
      source: 'schedule',
      title: scheduleTitle(task.prompt),
      agentId: task.agent_id,
      status: task.status,
      dueAt: task.next_run,
      overdue: task.next_run < now,
      detail: describeCron(task.schedule),
    }));
}

function providerRuntime(provider: LlmProviderName, model: string | undefined, sessionId: string | undefined) {
  const configuredModel = model || MAIN_AGENT_MODEL;
  return {
    provider,
    configuredModel,
    resolvedModel: resolveModelForProvider(provider, configuredModel) || configuredModel,
    hasSession: !!sessionId,
    sessionShort: shortenSessionId(sessionId),
  };
}

async function classifyTaskAgent(prompt: string): Promise<string | null> {
  try {
    const agentIds = listAgentIds();
    const agentDescriptions = agentIds.map((id) => {
      try {
        const config = loadAgentConfig(id);
        return `- ${id}: ${config.description}`;
      } catch { return `- ${id}: (no description)`; }
    });

    const classificationPrompt = `Given these agents and their roles:
- main: Primary assistant, general tasks, anything that doesn't clearly fit another agent
${agentDescriptions.join('\n')}

Which ONE agent is best suited for this task?
Task: "${prompt.slice(0, 500)}"

Reply with JSON: {"agent": "agent_id"}`;

    const response = await generateContent(classificationPrompt);
    const parsed = parseJsonResponse<{ agent: string }>(response);
    if (parsed?.agent) {
      const validAgents = ['main', ...agentIds];
      if (validAgents.includes(parsed.agent)) return parsed.agent;
    }
    return 'main'; // fallback
  } catch (err) {
    logger.error({ err }, 'Auto-assign classification failed');
    return null;
  }
}

/**
 * Build the dashboard Hono app without binding it to a port. Exported for
 * contract tests so the route surface can be exercised via `app.request()`
 * without standing up a real server. Production callers should use
 * `startDashboard` instead, which builds the app then serves it.
 */
export function buildDashboardApp(botApi?: Api<RawApi>): Hono {
  const app = new Hono();

  // CORS headers for cross-origin access (Cloudflare tunnel, mobile browsers)
  app.use('*', async (c, next) => {
    c.header('Access-Control-Allow-Origin', '*');
    c.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, PATCH, OPTIONS');
    c.header('Access-Control-Allow-Headers', 'Content-Type');
    if (c.req.method === 'OPTIONS') return c.body(null, 204);
    await next();
  });

  // Security headers (defense-in-depth on top of token-in-URL auth).
  // Referrer-Policy: stops `?token=...` leaking via Referer when a user
  // clicks an external link from inside the dashboard.
  // X-Content-Type-Options: nosniff blocks MIME-sniff XSS on binary
  // routes (favicon, avatars).
  // X-Frame-Options: DENY because the dashboard should never be framed —
  // protects against clickjacking against the token-in-URL session.
  // Cache-Control: no-store on /api/* so memory contents and conversation
  // history can't get cached by shared proxies.
  app.use('*', async (c, next) => {
    c.header('Referrer-Policy', 'no-referrer');
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('X-Frame-Options', 'DENY');
    await next();
    const path = new URL(c.req.url).pathname;
    if (path.startsWith('/api/')) {
      c.header('Cache-Control', 'no-store');
    }
  });

  // Global error handler — prevents unhandled throws from killing the server
  app.onError((err, c) => {
    logger.error({ err: err.message }, 'Dashboard request error');
    return c.json({ error: 'Internal server error' }, 500);
  });

  // Token auth middleware. V2 static bundle assets (immutable, hashed, no
  // secrets) bypass the gate so the React app can boot without the token
  // appearing on every <script>/<link> URL. A successful tokenized request
  // also sets an HttpOnly cookie so SPA deep links and manual refreshes keep
  // working without exposing the token in the address bar forever.
  app.use('*', async (c, next) => {
    const reqPath = new URL(c.req.url).pathname;
    // Codex HIGH (A.3 review): decode the path BEFORE classifying as an
    // unauth asset. Otherwise `/assets/%2f..%2findex.html` slips past
    // the raw-prefix check, then `serveV2` decodes inside resolveV2Path
    // and serves the gated `index.html`. Decode here so traversal
    // sequences are visible to the classifier.
    let decodedReqPath: string;
    try {
      decodedReqPath = decodeURIComponent(reqPath);
    } catch {
      return c.json({ error: 'Bad request' }, 400);
    }
    // Reject any decoded path with traversal markers from the asset
    // bypass — belt-and-braces against alternate encodings.
    const looksTraversal = decodedReqPath.includes('..') || decodedReqPath.includes('\\');
    const isV2Asset =
      !looksTraversal && (
        decodedReqPath.startsWith('/assets/') ||
        decodedReqPath.startsWith('/v2/assets/') ||
        decodedReqPath === '/favicon.svg' ||
        decodedReqPath === '/favicon.ico'
      );
    if (isV2Asset) {
      await next();
      return;
    }
    const token = c.req.query('token');
    const cookies = parseCookieHeader(c.req.header('cookie'));
    const cookieOk = cookies[DASHBOARD_AUTH_COOKIE] === dashboardCookieValue();
    const tokenOk = !!DASHBOARD_TOKEN && !!token && token === DASHBOARD_TOKEN;
    if (!DASHBOARD_TOKEN || (!tokenOk && !cookieOk)) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    if (tokenOk) setDashboardAuthCookie(c);
    await next();
  });

  // ── Mission Control v2 (React/Vite) router shim ─────────────────────
  // The v2 frontend is built into `dist/web/` by the root postbuild step
  // (`npm run build` → `cd web && npm run build` → copy to `dist/web/`).
  // Routing rules:
  //   MISSION_CONTROL_V2=0 (default): legacy at `/`, v2 reachable at `/v2`.
  //   MISSION_CONTROL_V2=1:           v2 at `/`,    legacy reachable at `/legacy`.
  // Both UIs stay reachable during cutover so we can A/B compare.
  const V2_DIR = path.join(PROJECT_ROOT, 'dist', 'web');
  const V2_MIME: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.js':   'application/javascript; charset=utf-8',
    '.mjs':  'application/javascript; charset=utf-8',
    '.css':  'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.map':  'application/json; charset=utf-8',
    '.svg':  'image/svg+xml',
    '.png':  'image/png',
    '.jpg':  'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif':  'image/gif',
    '.ico':  'image/x-icon',
    '.woff': 'font/woff',
    '.woff2':'font/woff2',
    '.ttf':  'font/ttf',
    '.txt':  'text/plain; charset=utf-8',
  };

  // Resolve a request path inside V2_DIR, refusing traversal. Returns
  // null when the resolved file does not exist or escapes the root.
  function resolveV2Path(relativePath: string): string | null {
    // Strip query/hash defensively (Hono already does, belt-and-braces).
    const cleaned = relativePath.split('?')[0].split('#')[0];
    const decoded = (() => { try { return decodeURIComponent(cleaned); } catch { return cleaned; } })();
    // path.resolve() collapses `..` after joining, so traversal is rejected
    // by the prefix check below.
    const resolved = path.resolve(V2_DIR, '.' + (decoded.startsWith('/') ? decoded : '/' + decoded));
    if (resolved !== V2_DIR && !resolved.startsWith(V2_DIR + path.sep)) return null;
    if (!fs.existsSync(resolved)) return null;
    if (fs.statSync(resolved).isDirectory()) return null;
    // Codex MED (A.3 review): the lexical prefix check catches `..`
    // sequences, but a symlink inside V2_DIR pointing OUTSIDE the dir
    // would still pass and then statSync/readFileSync would follow it.
    // realpathSync resolves all symlinks; re-check the prefix after.
    let realPath: string;
    let realRoot: string;
    try {
      realPath = fs.realpathSync(resolved);
      // Compare against the realpath of V2_DIR so legitimate symlinked
      // installs (some test fixtures, exotic deploys) still match.
      realRoot = fs.realpathSync(V2_DIR);
    } catch { return null; }
    if (realPath !== realRoot && !realPath.startsWith(realRoot + path.sep)) return null;
    return realPath;
  }

  function serveV2(c: any, relativePath: string): Response {
    if (!fs.existsSync(V2_DIR)) {
      return c.text(
        'Mission Control v2 build not found. Run `npm run build` from the project root to produce dist/web/.',
        503,
      );
    }
    const file = resolveV2Path(relativePath) ?? path.join(V2_DIR, 'index.html');
    if (!fs.existsSync(file)) {
      return c.text('v2 index.html missing — rebuild required', 503);
    }
    const data = fs.readFileSync(file);
    const ext = path.extname(file).toLowerCase();
    const headers: Record<string, string> = {
      'Content-Type': V2_MIME[ext] || 'application/octet-stream',
    };
    // Hashed assets are immutable; cache them. Index HTML must always
    // re-fetch so a deploy is visible without a hard refresh.
    if (ext === '.html') {
      headers['Cache-Control'] = 'no-cache';
    } else {
      headers['Cache-Control'] = 'public, max-age=86400, immutable';
    }
    return new Response(data, { headers });
  }

  // Legacy renderer (extracted so both `/` and `/legacy` can call it).
  function renderLegacy(c: any): Response {
    const chatId = c.req.query('chatId') || ALLOWED_CHAT_ID || '';
    return c.html(getDashboardHtml(DASHBOARD_TOKEN, chatId, WARROOM_ENABLED, process.env.MAIN_AGENT_DISPLAY_NAME || 'Main'));
  }

  if (MISSION_CONTROL_V2) {
    // v2 owns root. Legacy reachable at /legacy for cutover comparison.
    app.get('/', (c) => serveV2(c, '/index.html'));
    app.get('/legacy', renderLegacy);
  } else {
    // Legacy owns root (default). v2 reachable at /v2 once built.
    app.get('/', renderLegacy);
    app.get('/v2', (c) => serveV2(c, '/index.html'));
    // SPA deep-link inside /v2 (e.g. /v2/agents) — Vite-built assets are
    // referenced with absolute /assets/ paths regardless of mount point,
    // so we just need to return index.html for non-asset /v2/* lookups.
    app.get('/v2/*', (c) => {
      const sub = new URL(c.req.url).pathname.replace(/^\/v2/, '') || '/';
      // Direct file under web/dist (e.g. /v2/favicon.svg)? Serve it.
      const direct = resolveV2Path(sub);
      if (direct) return serveV2(c, sub);
      return serveV2(c, '/index.html');
    });
  }

  // Static asset routes are always mounted (the v2 bundle uses absolute
  // /assets/ URLs whether the SPA lives at `/` or `/v2`).
  app.get('/assets/*', (c) => {
    const reqPath = new URL(c.req.url).pathname;
    return serveV2(c, reqPath);
  });
  app.get('/favicon.svg', (c) => serveV2(c, '/favicon.svg'));
  app.get('/favicon.ico', (c) => serveV2(c, '/favicon.ico'));

  // War Room page
  app.get('/warroom', (c) => {
    const chatId = c.req.query('chatId') || ALLOWED_CHAT_ID || '';
    return c.html(getWarRoomHtml(DASHBOARD_TOKEN, chatId, WARROOM_PORT));
  });

  // Serve War Room background music (user's custom music.mp3 first, then bundled entrance.mp3)
  app.get('/warroom-music', (c) => {
    const musicPath = path.join(PROJECT_ROOT, 'warroom', 'music.mp3');
    if (!fs.existsSync(musicPath)) return c.text('', 404);
    const data = fs.readFileSync(musicPath);
    return new Response(data, {
      headers: { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'public, max-age=86400' },
    });
  });

  // Upload custom War Room entrance music from the dashboard
  app.post('/warroom-music-upload', async (c) => {
    const body = await c.req.parseBody();
    const file = body['file'];
    if (!file || typeof file === 'string') return c.json({ error: 'No file uploaded' }, 400);
    const buf = Buffer.from(await file.arrayBuffer());
    if (buf.length > 20 * 1024 * 1024) return c.json({ error: 'File too large (max 20MB)' }, 400);
    fs.writeFileSync(path.join(PROJECT_ROOT, 'warroom', 'music.mp3'), buf);
    return c.json({ ok: true });
  });

  // Serve War Room test audio for the browser-side autotest harness.
  // Used by the mock microphone in warroom browser tests; served only
  // when the dashboard token matches so it's not a public endpoint.
  app.get('/warroom-test-audio', (c) => {
    const audioPath = path.join(PROJECT_ROOT, 'warroom', 'test-audio.wav');
    if (!fs.existsSync(audioPath)) return c.text('', 404);
    const data = fs.readFileSync(audioPath);
    return new Response(data, {
      headers: { 'Content-Type': 'audio/wav', 'Cache-Control': 'no-store' },
    });
  });

  // Serve War Room Pipecat client bundle
  app.get('/warroom-client.js', (c) => {
    const bundlePath = path.join(PROJECT_ROOT, 'warroom', 'client.bundle.js');
    if (!fs.existsSync(bundlePath)) return c.text('// bundle not built', 404);
    const data = fs.readFileSync(bundlePath, 'utf-8');
    return new Response(data, {
      headers: { 'Content-Type': 'application/javascript', 'Cache-Control': 'public, max-age=3600' },
    });
  });

  // Serve War Room agent avatars
  app.get('/warroom-avatar/:id', (c) => {
    const agentId = c.req.param('id').replace(/[^a-z0-9_-]/g, '');
    const avatarPath = path.join(PROJECT_ROOT, 'warroom', 'avatars', `${agentId}.png`);
    if (!fs.existsSync(avatarPath)) return c.text('', 404);
    const data = fs.readFileSync(avatarPath);
    return new Response(data, {
      headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' },
    });
  });

  // War Room API: meeting state management.
  // We deliberately do NOT return a ws_url here. Older versions of this
  // route sent `ws://localhost:${WARROOM_PORT}`, which broke any
  // Cloudflare-tunneled access since the browser would try to connect to
  // its own localhost instead of the tunnel host. The client-side code
  // in src/warroom-html.ts always has a `window.location.hostname`
  // fallback, so just returning {ok:true} lets the browser build the
  // right WS url on its own.
  app.post('/api/warroom/start', async (c) => {
    if (!WARROOM_ENABLED) {
      return c.json({ error: 'War Room not enabled. Set WARROOM_ENABLED=true in .env with GOOGLE_API_KEY (for live mode) or DEEPGRAM_API_KEY + CARTESIA_API_KEY (for legacy mode).' }, 400);
    }
    // If the pin file was updated recently (agent switch while no meeting
    // was active), the running server has the wrong agent. Kill it so it
    // restarts with the correct persona/voice before we probe readiness.
    try {
      const pinStat = fs.statSync(WARROOM_PIN_PATH);
      const pinAge = Date.now() - pinStat.mtimeMs;
      if (pinAge < 30000) {
        // Pin changed in the last 30 seconds. Kill the server so it
        // picks up the new pin, then poll until it's ready.
        await killWarroomAsync('pin changed recently, restarting for Start Meeting');
        const net = await import('net');
        let serverReady = false;
        for (let attempt = 0; attempt < 15 && !serverReady; attempt++) {
          await new Promise((r) => setTimeout(r, 1000));
          serverReady = await new Promise<boolean>((resolve) => {
            const sock = new net.Socket();
            const t = setTimeout(() => { sock.destroy(); resolve(false); }, 1000);
            sock.connect(WARROOM_PORT, '127.0.0.1', () => { clearTimeout(t); sock.destroy(); resolve(true); });
            sock.on('error', () => { clearTimeout(t); sock.destroy(); resolve(false); });
          });
        }
        if (serverReady) {
          await new Promise((r) => setTimeout(r, 200));
          return c.json({ ok: true, status: 'ready' });
        }
        return c.json({ ok: false, status: 'starting', error: 'War Room server restarting, try again' }, 503);
      }
    } catch { /* pin file might not exist yet, that's fine */ }

    // Probe the Python WebSocket server to verify it's actually accepting
    // connections. Without this, the browser connects before the server is
    // ready and gets silent failures or "only one client allowed" errors.
    try {
      const net = await import('net');
      const ready = await new Promise<boolean>((resolve) => {
        const sock = new net.Socket();
        const timer = setTimeout(() => { sock.destroy(); resolve(false); }, 3000);
        sock.connect(WARROOM_PORT, '127.0.0.1', () => {
          clearTimeout(timer);
          sock.destroy();
          resolve(true);
        });
        sock.on('error', () => { clearTimeout(timer); sock.destroy(); resolve(false); });
      });
      if (!ready) {
        return c.json({ ok: false, status: 'starting', error: 'War Room server not ready yet' }, 503);
      }
      // Small delay after TCP success: the socket may be bound but the
      // Pipecat WebSocket upgrade handler might not be fully initialized.
      await new Promise((r) => setTimeout(r, 200));
    } catch {
      return c.json({ ok: false, status: 'starting', error: 'Could not probe War Room server' }, 503);
    }
    return c.json({ ok: true, status: 'ready' });
  });

  // Return the dynamic agent list for the War Room UI to render cards.
  // Includes main + all configured agents with their display names.
  app.get('/api/warroom/agents', (c) => {
    const ids = ['main', ...listAgentIds().filter((id) => id !== 'main')];
    const agents = ids.map((id) => {
      try {
        if (id === 'main') return { id: 'main', name: 'Main', description: 'General ops and triage' };
        const cfg = loadAgentConfig(id);
        return { id, name: cfg.name || id, description: cfg.description || '' };
      } catch {
        return { id, name: id, description: '' };
      }
    });
    return c.json({ agents });
  });

  // ── War Room meeting history & transcript persistence ──────────────
  app.post('/api/warroom/meeting/start', async (c) => {
    const body: { id?: string; mode?: string; agent?: string } = await c.req.json().catch(() => ({}));
    const id = body.id || crypto.randomUUID();
    createWarRoomMeeting(id, body.mode || 'direct', body.agent || 'main');
    return c.json({ ok: true, meetingId: id });
  });

  app.post('/api/warroom/meeting/end', async (c) => {
    const body: { id?: string; entryCount?: number } = await c.req.json().catch(() => ({}));
    if (body.id) endWarRoomMeeting(body.id, body.entryCount || 0);
    return c.json({ ok: true });
  });

  app.post('/api/warroom/meeting/transcript', async (c) => {
    const body: { meetingId?: string; speaker?: string; text?: string } = await c.req.json().catch(() => ({}));
    if (body.meetingId && body.speaker && body.text) {
      addWarRoomTranscript(body.meetingId, body.speaker, body.text);
    }
    return c.json({ ok: true });
  });

  app.get('/api/warroom/meetings', (c) => {
    const limit = parseInt(c.req.query('limit') || '20');
    return c.json({ meetings: getWarRoomMeetings(limit) });
  });

  app.get('/api/warroom/meeting/:id/transcript', (c) => {
    return c.json({ transcript: getWarRoomTranscript(c.req.param('id')) });
  });

  // ── War Room pin: route all voice utterances to a specific agent ──
  // Lives in /tmp so the Python Pipecat server (a separate process) can
  // read the state without needing an IPC bus. router.py checks this
  // file's mtime and reloads only when it changes. Spoken agent prefixes
  // (e.g. "research, find X") still take precedence over the pin.
  const WARROOM_PIN_PATH = '/tmp/warroom-pin.json';
  const VALID_PIN_AGENTS = new Set(['main', ...listAgentIds()]);
  const VALID_PIN_MODES = new Set(['direct', 'auto']);

  // Read current pin state from disk. Returns normalized defaults for
  // missing fields so callers can rely on both agent and mode being set.
  function readPinState(): { agent: string | null; mode: string } {
    try {
      if (fs.existsSync(WARROOM_PIN_PATH)) {
        const raw = JSON.parse(fs.readFileSync(WARROOM_PIN_PATH, 'utf-8'));
        const agent = (raw && typeof raw.agent === 'string' && VALID_PIN_AGENTS.has(raw.agent)) ? raw.agent : null;
        const mode = (raw && typeof raw.mode === 'string' && VALID_PIN_MODES.has(raw.mode)) ? raw.mode : 'direct';
        return { agent, mode };
      }
    } catch { /* fall through to defaults */ }
    return { agent: null, mode: 'direct' };
  }

  app.get('/api/warroom/pin', (c) => {
    const { agent, mode } = readPinState();
    return c.json({ ok: true, agent, mode });
  });

  // Kill the warroom Python subprocess so main's respawn logic in
  // src/index.ts brings up a fresh one with whatever config files
  // (voices.json, pin file, etc.) we just wrote. Runs in the background
  // so the HTTP response doesn't block on the respawn.
  async function killWarroomAsync(reason: string): Promise<number[]> {
    try {
      const { safeSpawn } = await import('./safe-spawn.js');
      // pgrep with a hardcoded pattern. OS tool, no agent-controlled
      // args, no LLM in the loop.
      const pids: number[] = await new Promise((resolve) => {
        const p = safeSpawn('pgrep', ['-f', 'warroom/server.py'], { envClass: 'system-tool' });
        let out = '';
        p.stdout?.on('data', (chunk) => { out += chunk.toString(); });
        p.on('close', () => {
          resolve(out.trim().split(/\s+/).map((s) => parseInt(s, 10)).filter((n) => Number.isFinite(n)));
        });
        p.on('error', () => resolve([]));
      });
      for (const pid of pids) {
        try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
      }
      if (pids.length > 0) {
        logger.info({ pids, reason }, 'Killed warroom subprocess for respawn');
      }
      return pids;
    } catch (err) {
      logger.warn({ err, reason }, 'killWarroomAsync failed');
      return [];
    }
  }

  app.post('/api/warroom/pin', async (c) => {
    let body: { agent?: string; mode?: string; restart?: boolean } = {};
    try { body = await c.req.json(); } catch { /* empty body */ }

    // Pin can update agent, mode, or both. Missing fields preserve
    // the current pin file value. An empty body is a noop but still
    // respawns so the caller can force a reload.
    const current = readPinState();
    const nextAgent = body.agent !== undefined ? body.agent : (current.agent ?? 'main');
    const nextMode = body.mode !== undefined ? body.mode : current.mode;

    if (!VALID_PIN_AGENTS.has(nextAgent)) {
      return c.json({ ok: false, error: 'invalid agent; must be one of main, research, comms, content, ops' }, 400);
    }
    if (!VALID_PIN_MODES.has(nextMode)) {
      return c.json({ ok: false, error: 'invalid mode; must be one of direct, auto' }, 400);
    }

    try {
      fs.writeFileSync(
        WARROOM_PIN_PATH,
        JSON.stringify({ agent: nextAgent, mode: nextMode, pinnedAt: Date.now() }),
        'utf-8',
      );
      // Only respawn the server if the caller says a meeting is active.
      // When no meeting is active, the server picks up the new pin on
      // the next Start Meeting click (the health probe triggers it).
      const needsRestart = body.restart !== false;
      if (needsRestart) {
        killWarroomAsync(`pin changed to agent=${nextAgent} mode=${nextMode}`);
      }
      return c.json({ ok: true, agent: nextAgent, mode: nextMode, respawning: needsRestart });
    } catch (err) {
      return c.json({ ok: false, error: String(err) }, 500);
    }
  });

  app.post('/api/warroom/unpin', async (c) => {
    try {
      if (fs.existsSync(WARROOM_PIN_PATH)) fs.unlinkSync(WARROOM_PIN_PATH);
      killWarroomAsync('unpin');
      return c.json({ ok: true, agent: null, mode: 'direct', respawning: true });
    } catch (err) {
      return c.json({ ok: false, error: String(err) }, 500);
    }
  });

  // ── War Room voice configuration ──
  // warroom/voices.json carries two voice identifiers per agent:
  //   - gemini_voice:     Gemini Live's built-in voice name (used in live mode)
  //   - voice_id:         Cartesia voice id (used in legacy stitched mode)
  // The Python server reads this file on startup. After editing via the
  // dashboard, POST /api/warroom/voices/apply kickstarts the main agent so
  // its child warroom process respawns with the new config.
  const WARROOM_VOICES_PATH = path.join(PROJECT_ROOT, 'warroom', 'voices.json');

  // Full Gemini Live voice catalog with one-word style descriptors. Matches
  // the 30 voices supported by the gemini-2.5-flash-native-audio-preview model
  // (and other Gemini TTS-capable models). Sourced from Google's docs.
  const GEMINI_VOICE_CATALOG: Array<{ name: string; style: string }> = [
    { name: 'Zephyr', style: 'Bright' },
    { name: 'Puck', style: 'Upbeat' },
    { name: 'Charon', style: 'Informative' },
    { name: 'Kore', style: 'Firm' },
    { name: 'Fenrir', style: 'Excitable' },
    { name: 'Leda', style: 'Youthful' },
    { name: 'Orus', style: 'Firm' },
    { name: 'Aoede', style: 'Breezy' },
    { name: 'Callirrhoe', style: 'Easy-going' },
    { name: 'Autonoe', style: 'Bright' },
    { name: 'Enceladus', style: 'Breathy' },
    { name: 'Iapetus', style: 'Clear' },
    { name: 'Umbriel', style: 'Easy-going' },
    { name: 'Algieba', style: 'Smooth' },
    { name: 'Despina', style: 'Smooth' },
    { name: 'Erinome', style: 'Clear' },
    { name: 'Algenib', style: 'Gravelly' },
    { name: 'Rasalgethi', style: 'Informative' },
    { name: 'Laomedeia', style: 'Upbeat' },
    { name: 'Achernar', style: 'Soft' },
    { name: 'Alnilam', style: 'Firm' },
    { name: 'Schedar', style: 'Even' },
    { name: 'Gacrux', style: 'Mature' },
    { name: 'Pulcherrima', style: 'Forward' },
    { name: 'Achird', style: 'Friendly' },
    { name: 'Zubenelgenubi', style: 'Casual' },
    { name: 'Vindemiatrix', style: 'Gentle' },
    { name: 'Sadachbia', style: 'Lively' },
    { name: 'Sadaltager', style: 'Knowledgeable' },
    { name: 'Sulafat', style: 'Warm' },
  ];
  const GEMINI_VOICE_NAMES = new Set(GEMINI_VOICE_CATALOG.map((v) => v.name));

  // Default voice assignments for agents that don't have an entry yet.
  // This is how a newly-spawned sub-agent gets a voice without any extra
  // setup. We skip Charon (reserved for main) so new agents always sound
  // distinct from the main voice.
  const NEW_AGENT_VOICE_POOL = [
    'Kore', 'Aoede', 'Leda', 'Alnilam', 'Puck',
    'Fenrir', 'Laomedeia', 'Achird', 'Sulafat', 'Vindemiatrix',
  ];

  function readVoicesFile(): Record<string, { voice_id?: string; gemini_voice?: string; name?: string }> {
    try {
      return JSON.parse(fs.readFileSync(WARROOM_VOICES_PATH, 'utf-8'));
    } catch {
      return {};
    }
  }

  function writeVoicesFile(obj: Record<string, unknown>) {
    fs.writeFileSync(WARROOM_VOICES_PATH, JSON.stringify(obj, null, 2) + '\n', 'utf-8');
  }

  function pickDefaultGeminiVoice(used: Set<string>): string {
    for (const v of NEW_AGENT_VOICE_POOL) {
      if (!used.has(v)) return v;
    }
    return NEW_AGENT_VOICE_POOL[0];
  }

  app.get('/api/warroom/voices', (c) => {
    const configured = readVoicesFile();
    // Return one row per known agent. Agents missing from voices.json get
    // a default Gemini voice suggestion from the pool so the UI can show
    // something reasonable without requiring the user to save first.
    const knownAgents = ['main', ...listAgentIds().filter((id) => id !== 'main')];
    const usedGeminiVoices = new Set(
      Object.values(configured)
        .map((v) => v && typeof v === 'object' ? (v as { gemini_voice?: string }).gemini_voice : undefined)
        .filter((v): v is string => typeof v === 'string'),
    );
    const rows = knownAgents.map((agent) => {
      const entry = configured[agent] || {};
      let geminiVoice = entry.gemini_voice;
      let isDefault = false;
      if (!geminiVoice) {
        geminiVoice = agent === 'main' ? 'Charon' : pickDefaultGeminiVoice(usedGeminiVoices);
        usedGeminiVoices.add(geminiVoice);
        isDefault = true;
      }
      return {
        agent,
        gemini_voice: geminiVoice,
        voice_id: entry.voice_id || '',
        name: entry.name || '',
        is_default: isDefault,
      };
    });
    return c.json({
      ok: true,
      voices: rows,
      gemini_catalog: GEMINI_VOICE_CATALOG,
    });
  });

  app.post('/api/warroom/voices', async (c) => {
    let body: { updates?: Array<{ agent: string; gemini_voice?: string; voice_id?: string; name?: string }> } = {};
    try { body = await c.req.json(); } catch { /* empty */ }
    const updates = body.updates;
    if (!Array.isArray(updates) || updates.length === 0) {
      return c.json({ ok: false, error: 'updates must be a non-empty array of {agent, gemini_voice?, voice_id?, name?}' }, 400);
    }

    const configured = readVoicesFile();
    const errors: string[] = [];
    for (const u of updates) {
      if (!u.agent || typeof u.agent !== 'string') {
        errors.push('each update must have an agent id');
        continue;
      }
      const entry = configured[u.agent] || {};
      if (u.gemini_voice !== undefined) {
        if (typeof u.gemini_voice !== 'string' || !GEMINI_VOICE_NAMES.has(u.gemini_voice)) {
          errors.push(`${u.agent}: invalid gemini_voice '${u.gemini_voice}' (must be one of the 30 Gemini voices)`);
          continue;
        }
        entry.gemini_voice = u.gemini_voice;
      }
      if (u.voice_id !== undefined) {
        if (typeof u.voice_id !== 'string') {
          errors.push(`${u.agent}: voice_id must be a string`);
          continue;
        }
        entry.voice_id = u.voice_id;
      }
      if (u.name !== undefined) {
        if (typeof u.name !== 'string') {
          errors.push(`${u.agent}: name must be a string`);
          continue;
        }
        entry.name = u.name;
      }
      configured[u.agent] = entry;
    }
    if (errors.length > 0) {
      return c.json({ ok: false, error: errors.join('; ') }, 400);
    }
    try {
      writeVoicesFile(configured);
      return c.json({ ok: true, voices: configured, applied: false });
    } catch (err) {
      return c.json({ ok: false, error: String(err) }, 500);
    }
  });

  app.post('/api/warroom/voices/apply', async (c) => {
    // Kill the warroom Python subprocess so main's respawn logic in
    // src/index.ts picks up a fresh one that re-reads voices.json.
    // IMPORTANT: we do NOT kickstart the main launchd service here,
    // because that would kill the dashboard process we're currently
    // running inside — the HTTP response would never be delivered.
    try {
      const { safeSpawn } = await import('./safe-spawn.js');
      // pgrep is simpler than parsing ps. Matches any python process
      // whose command line includes "warroom/server.py".
      const pids: number[] = await new Promise((resolve) => {
        const p = safeSpawn('pgrep', ['-f', 'warroom/server.py'], { envClass: 'system-tool' });
        let out = '';
        p.stdout?.on('data', (chunk) => { out += chunk.toString(); });
        p.on('close', () => {
          resolve(out.trim().split(/\s+/).map((s) => parseInt(s, 10)).filter((n) => Number.isFinite(n)));
        });
        p.on('error', () => resolve([]));
      });
      if (pids.length === 0) {
        return c.json({ ok: false, error: 'no warroom server process found' }, 500);
      }
      for (const pid of pids) {
        try { process.kill(pid, 'SIGTERM'); } catch { /* already dead */ }
      }
      logger.info({ pids }, 'Killed warroom subprocess for voice config reload');
      return c.json({
        ok: true,
        applied: true,
        killed_pids: pids,
        note: 'warroom server will be respawned by the main agent in ~0.5s with fresh voices.json',
      });
    } catch (err) {
      return c.json({ ok: false, error: String(err) }, 500);
    }
  });

  // Scheduled tasks
  app.get('/api/tasks', (c) => {
    const tasks = getAllScheduledTasks();
    return c.json({ tasks });
  });

  app.get('/api/home/briefs', (c) => {
    const tasks = getAllScheduledTasks();
    const briefs = buildHomeBriefs(tasks);
    return c.json({
      updatedAt: new Date().toISOString(),
      briefs,
      latest: briefs.find((brief) => brief?.primary) || null,
    });
  });

  app.get('/api/home/attention', (c) => {
    const tasks = getAllScheduledTasks();
    const missions = getMissionTasks();
    return c.json({
      updatedAt: new Date().toISOString(),
      items: buildHomeAttention(tasks, missions),
    });
  });

  app.post('/api/home/attention/assign', async (c) => {
    if (!killSwitchFlag('DASHBOARD_MUTATIONS_ENABLED', true)) {
      return c.json({ ok: false, error: 'Dashboard mutations are disabled.' }, 423);
    }

    let body: { itemId?: string; agentId?: string } = {};
    try { body = await c.req.json(); } catch { body = {}; }
    const itemId = String(body.itemId || '');
    const agentId = String(body.agentId || '').trim();
    const validAgents = ['main', ...listAgentIds()];
    if (!itemId || !agentId) return c.json({ ok: false, error: 'itemId and agentId are required.' }, 400);
    if (!validAgents.includes(agentId)) return c.json({ ok: false, error: `Unknown agent: ${agentId}. Valid: ${validAgents.join(', ')}` }, 400);

    const attentionMatch = itemId.match(/^attention:([^:]+)/);
    if (attentionMatch) {
      const attention = getAttentionItem(attentionMatch[1]);
      if (!attention) return c.json({ ok: false, error: 'Attention source not found.' }, 404);
      if (attention.linked_mission_id) {
        const linked = getMissionTask(attention.linked_mission_id);
        if (linked && !TERMINAL_MISSION_STATUSES.has(linked.status)) {
          reassignMissionTask(linked.id, agentId);
          markAttentionAssigned(attention.id, linked.id, agentId);
          return c.json({ ok: true, task: getMissionTask(linked.id), attention: getAttentionItem(attention.id) });
        }
      }

      const id = crypto.randomBytes(4).toString('hex');
      const missionTitle = (attention.source_kind === 'brief' ? attention.detail : attention.title)
        .replace(/^action needed:\s*/i, '')
        .replace(/^follow up:\s*/i, '')
        .slice(0, 180);
      createMissionTask(id, missionTitle, [
        'Needs Attention item from Home dashboard.',
        `Attention item: ${attention.id}`,
        `Source: ${attention.source_kind}:${attention.source_id}`,
        `Title: ${attention.title}`,
        `Detail: ${attention.detail}`,
        attention.href ? `Source link: ${attention.href}` : '',
      ].filter(Boolean).join('\n'), agentId, 'dashboard', attention.severity === 'high' ? 9 : attention.severity === 'medium' ? 6 : 3);
      markAttentionAssigned(attention.id, id, agentId);
      return c.json({ ok: true, task: getMissionTask(id), attention: getAttentionItem(attention.id) }, 201);
    }

    const missionMatch = itemId.match(/^mission:([^:]+)/);
    if (missionMatch) {
      const id = missionMatch[1];
      const task = getMissionTask(id);
      if (!task) return c.json({ ok: false, error: 'Mission source not found.' }, 404);
      if (!TERMINAL_MISSION_STATUSES.has(task.status)) {
        if (task.status === 'running' && task.assigned_agent && task.assigned_agent !== agentId) {
          return c.json({ ok: false, error: `Mission is already running with @${task.assigned_agent}.` }, 409);
        }
        reassignMissionTask(id, agentId);
        return c.json({ ok: true, task: getMissionTask(id) });
      }

      const followupId = crypto.randomBytes(4).toString('hex');
      const title = `Follow up: ${task.title.replace(/^follow up:\s*/i, '')}`.slice(0, 200);
      createMissionTask(followupId, title, [
        'Needs Attention follow-up from Home dashboard.',
        `Source mission: ${task.id}`,
        `Source status: ${task.status}`,
        task.result ? `Result:\n${task.result.slice(0, 2000)}` : '',
        task.error ? `Error:\n${task.error.slice(0, 2000)}` : '',
      ].filter(Boolean).join('\n'), agentId, 'dashboard', task.status === 'failed' ? 9 : 6);
      upsertMissionReview({
        taskId: task.id,
        reviewStatus: 'waiting_followup',
        resolution: 'delegated',
        followupTaskId: followupId,
      });
      return c.json({ ok: true, task: getMissionTask(followupId), review: getMissionReview(task.id) }, 201);
    }

    const scheduleMatch = itemId.match(/^(?:schedule|brief):([^:]+)/);
    if (scheduleMatch) {
      const id = scheduleMatch[1];
      const schedule = getAllScheduledTasks().find((task) => task.id === id);
      if (!schedule) return c.json({ ok: false, error: 'Scheduled source not found.' }, 404);
      const missionId = crypto.randomBytes(4).toString('hex');
      createMissionTask(missionId, `Follow up: ${scheduleTitle(schedule.prompt)}`.slice(0, 200), [
        'Scheduled Needs Attention follow-up from Home dashboard.',
        `Source schedule: ${schedule.id}`,
        `Last status: ${schedule.last_status || schedule.status}`,
        schedule.last_result ? `Last result:\n${schedule.last_result.slice(0, 2000)}` : '',
      ].filter(Boolean).join('\n'), agentId, 'dashboard', schedule.last_status === 'failed' ? 9 : 6);
      clearScheduledTaskAttention(id, `Assigned follow-up mission ${missionId} from Home Needs Attention.`);
      return c.json({ ok: true, task: getMissionTask(missionId) }, 201);
    }

    return c.json({ ok: false, error: 'Unsupported attention source.' }, 400);
  });

  app.post('/api/home/attention/resolve', async (c) => {
    if (!killSwitchFlag('DASHBOARD_MUTATIONS_ENABLED', true)) {
      return c.json({ ok: false, error: 'Dashboard mutations are disabled.' }, 423);
    }

    let body: { itemId?: string; action?: 'complete' | 'archive' } = {};
    try { body = await c.req.json(); } catch { body = {}; }
    const itemId = String(body.itemId || '');
    const action = body.action;
    if (!itemId || (action !== 'complete' && action !== 'archive')) {
      return c.json({ ok: false, error: 'itemId and action are required.' }, 400);
    }

    const attentionMatch = itemId.match(/^attention:([^:]+)/);
    if (attentionMatch) {
      const attention = getAttentionItem(attentionMatch[1]);
      if (!attention) return c.json({ ok: false, error: 'Attention source not found.' }, 404);
      const updated = updateAttentionStatus(attention.id, action === 'complete' ? 'resolved' : 'archived');
      return c.json({ ok: true, source: attention.source_kind, action, attention: updated });
    }

    const missionMatch = itemId.match(/^mission:([^:]+)/);
    if (missionMatch) {
      const id = missionMatch[1];
      const task = getMissionTask(id);
      if (!task) return c.json({ ok: false, error: 'Mission source not found.' }, 404);

      if (action === 'archive') {
        if (!TERMINAL_MISSION_STATUSES.has(task.status)) {
          cancelMissionTask(id);
        }
        const review = updateMissionReviewState(id, 'archived', 'ignored');
        return c.json({ ok: true, source: 'mission', action, review });
      }

      if (task.status === 'running') {
        return c.json({ ok: false, error: 'Running missions cannot be manually completed from Home. Archive cancels the source task instead.' }, 409);
      }
      if (!TERMINAL_MISSION_STATUSES.has(task.status)) {
        completeMissionTask(id, 'Manually marked complete from Home Needs Attention.', 'completed');
      }
      const review = updateMissionReviewState(id, 'resolved', 'approved');
      return c.json({ ok: true, source: 'mission', action, review });
    }

    const scheduleMatch = itemId.match(/^(?:schedule|brief):([^:]+)/);
    if (scheduleMatch) {
      const id = scheduleMatch[1];
      if (action === 'archive') {
        pauseScheduledTask(id);
        return c.json({ ok: true, source: itemId.startsWith('brief:') ? 'brief' : 'schedule', action });
      }
      const ok = clearScheduledTaskAttention(id);
      if (!ok) return c.json({ ok: false, error: 'Scheduled source not found.' }, 404);
      return c.json({ ok: true, source: itemId.startsWith('brief:') ? 'brief' : 'schedule', action });
    }

    return c.json({ ok: false, error: 'Unsupported attention source.' }, 400);
  });

  app.get('/api/home/agenda', async (c) => {
    const tasks = getAllScheduledTasks();
    const calendar = await fetchHomeCalendarItems();
    return c.json({
      updatedAt: new Date().toISOString(),
      externalCalendar: {
        connected: calendar.connected,
        provider: calendar.connected ? 'Microsoft Graph' : null,
        note: calendar.note,
      },
      items: calendar.connected ? calendar.items : buildHomeScheduleAgenda(tasks),
    });
  });

  // Delete a scheduled task
  app.delete('/api/tasks/:id', (c) => {
    const id = c.req.param('id');
    deleteScheduledTask(id);
    return c.json({ ok: true });
  });

  // Pause a scheduled task
  app.post('/api/tasks/:id/pause', (c) => {
    const id = c.req.param('id');
    pauseScheduledTask(id);
    return c.json({ ok: true });
  });

  // Resume a scheduled task
  app.post('/api/tasks/:id/resume', (c) => {
    const id = c.req.param('id');
    resumeScheduledTask(id);
    return c.json({ ok: true });
  });

  // ── Mission Control endpoints ────────────────────────────────────────

  app.get('/api/mission/tasks', (c) => {
    const agentId = c.req.query('agent') || undefined;
    const status = c.req.query('status') || undefined;
    const tasks = getMissionTasks(agentId, status);
    return c.json({ tasks });
  });

  app.get('/api/mission/tasks/:id', (c) => {
    const id = c.req.param('id');
    const task = getMissionTask(id);
    if (!task) return c.json({ error: 'Not found' }, 404);
    return c.json({ task });
  });

  app.post('/api/mission/tasks', async (c) => {
    const body = await c.req.json<{
      title?: string;
      prompt?: string;
      assigned_agent?: string;
      priority?: number;
    }>();

    const title = body?.title?.trim();
    const prompt = body?.prompt?.trim();
    const assignedAgent = body?.assigned_agent?.trim() || null;
    const priority = Math.max(0, Math.min(10, body?.priority ?? 0));

    if (!title || title.length > 200) return c.json({ error: 'title required (max 200 chars)' }, 400);
    if (!prompt || prompt.length > 10000) return c.json({ error: 'prompt required (max 10000 chars)' }, 400);

    // Validate agent if provided
    if (assignedAgent) {
      const validAgents = ['main', ...listAgentIds()];
      if (!validAgents.includes(assignedAgent)) {
        return c.json({ error: `Unknown agent: ${assignedAgent}. Valid: ${validAgents.join(', ')}` }, 400);
      }
    }

    const id = crypto.randomBytes(4).toString('hex');
    createMissionTask(id, title, prompt, assignedAgent, 'dashboard', priority);

    const task = getMissionTask(id);
    return c.json({ task }, 201);
  });

  app.post('/api/mission/tasks/:id/cancel', (c) => {
    const id = c.req.param('id');
    const ok = cancelMissionTask(id);
    return c.json({ ok });
  });

  // Auto-assign a single task via Gemini classification
  app.post('/api/mission/tasks/:id/auto-assign', async (c) => {
    const id = c.req.param('id');
    const task = getMissionTask(id);
    if (!task) return c.json({ error: 'Not found' }, 404);
    if (task.assigned_agent) return c.json({ error: 'Already assigned' }, 400);

    const agent = await classifyTaskAgent(task.prompt);
    if (!agent) return c.json({ error: 'Classification failed' }, 500);

    assignMissionTask(id, agent);
    return c.json({ ok: true, assigned_agent: agent });
  });

  // Auto-assign all unassigned tasks
  app.post('/api/mission/tasks/auto-assign-all', async (c) => {
    const tasks = getUnassignedMissionTasks();
    if (tasks.length === 0) return c.json({ assigned: 0 });

    const results: Array<{ id: string; agent: string }> = [];
    for (const task of tasks) {
      const agent = await classifyTaskAgent(task.prompt);
      if (agent && assignMissionTask(task.id, agent)) {
        results.push({ id: task.id, agent });
      }
    }
    return c.json({ assigned: results.length, results });
  });

  app.patch('/api/mission/tasks/:id', async (c) => {
    const id = c.req.param('id');
    const body = await c.req.json<{ assigned_agent?: string }>();
    const newAgent = body?.assigned_agent?.trim();
    if (!newAgent) return c.json({ error: 'assigned_agent required' }, 400);
    const validAgents = ['main', ...listAgentIds()];
    if (!validAgents.includes(newAgent)) return c.json({ error: 'Unknown agent' }, 400);
    const task = getMissionTask(id);
    if (!task) return c.json({ error: 'Not found' }, 404);
    if (task.status === 'running') return c.json({ ok: false, error: 'Running mission tasks cannot be reassigned.' }, 409);
    const ok = reassignMissionTask(id, newAgent);
    return c.json({ ok });
  });

  app.delete('/api/mission/tasks/:id', (c) => {
    const id = c.req.param('id');
    const ok = deleteMissionTask(id);
    return c.json({ ok });
  });

  app.get('/api/mission/history', (c) => {
    const limit = parseInt(c.req.query('limit') || '30', 10);
    const offset = parseInt(c.req.query('offset') || '0', 10);
    return c.json(getMissionTaskHistory(limit, offset));
  });

  // ── Review Inbox endpoints ───────────────────────────────────────────

  app.get('/api/review/inbox', (c) => {
    const limit = Math.max(1, Math.min(100, parseInt(c.req.query('limit') || '50', 10) || 50));
    const history = getMissionTaskHistory(limit, 0);
    const missions = getMissionTasks();
    const items = history.tasks
      .map((task) => {
        const review = effectiveMissionReview(task, missions);
        if (!review || !shouldShowReview(review)) return null;
        const item = buildReviewItem(task, review, missions);
        // Auto-decay sorted (Category B) items older than 7 days — they're
        // FYI heads-ups, not action items, so let them fall off automatically.
        if (isStaleSortedItem(task, item.kind)) return null;
        return item;
      })
      .filter(Boolean);
    return c.json({
      updatedAt: new Date().toISOString(),
      items,
      total: history.total,
      openTotal: items.length,
      exportEmailConfigured: !!configuredReviewExportEmail() && !!configuredReviewExportFromEmail(),
    });
  });

  app.post('/api/review/tasks/:id/archive', async (c) => {
    if (!killSwitchFlag('DASHBOARD_MUTATIONS_ENABLED', true)) {
      return c.json({ ok: false, error: 'Dashboard mutations are disabled.' }, 423);
    }
    const id = c.req.param('id');
    const task = getMissionTask(id);
    if (!task) return c.json({ ok: false, error: 'Not found' }, 404);
    const review = updateMissionReviewState(id, 'archived', 'ignored');
    return c.json({ ok: true, review });
  });

  // Bulk-archive every currently-surfaced sorted (Category B) item in one tap.
  // Used by the "Clear all" button on the FYI accordion.
  app.post('/api/review/sorted/clear', async (c) => {
    if (!killSwitchFlag('DASHBOARD_MUTATIONS_ENABLED', true)) {
      return c.json({ ok: false, error: 'Dashboard mutations are disabled.' }, 423);
    }
    const history = getMissionTaskHistory(100, 0);
    const missions = getMissionTasks();
    const archivedIds: string[] = [];
    for (const task of history.tasks) {
      const review = effectiveMissionReview(task, missions);
      if (!review || !shouldShowReview(review)) continue;
      if (reviewItemKind(task, missions) !== 'sorted') continue;
      updateMissionReviewState(task.id, 'archived', 'ignored');
      archivedIds.push(task.id);
    }
    return c.json({ ok: true, archived: archivedIds.length, ids: archivedIds });
  });

  app.post('/api/review/tasks/:id/approve', async (c) => {
    if (!killSwitchFlag('DASHBOARD_MUTATIONS_ENABLED', true)) {
      return c.json({ ok: false, error: 'Dashboard mutations are disabled.' }, 423);
    }
    const id = c.req.param('id');
    const task = getMissionTask(id);
    if (!task) return c.json({ ok: false, error: 'Not found' }, 404);
    const review = updateMissionReviewState(id, 'resolved', 'approved');
    return c.json({ ok: true, review });
  });

  app.post('/api/review/tasks/:id/follow-up', async (c) => {
    if (!killSwitchFlag('DASHBOARD_MUTATIONS_ENABLED', true)) {
      return c.json({ ok: false, error: 'Dashboard mutations are disabled.' }, 423);
    }

    const id = c.req.param('id');
    const task = getMissionTask(id);
    if (!task) return c.json({ ok: false, error: 'Not found' }, 404);

    let body: { assigned_agent?: string; instructions?: string; mode?: 'retry' | 'followup' } = {};
    try { body = await c.req.json(); } catch { body = {}; }
    const assignedAgent = body.assigned_agent?.trim();
    if (!assignedAgent) return c.json({ ok: false, error: 'assigned_agent required' }, 400);
    const validAgents = ['main', ...listAgentIds()];
    if (!validAgents.includes(assignedAgent)) return c.json({ ok: false, error: 'Unknown agent' }, 400);

    const existingReview = getMissionReview(id);
    if (existingReview?.review_status === 'waiting_followup' && existingReview.followup_task_id) {
      const existingFollowup = getMissionTask(existingReview.followup_task_id);
      if (existingFollowup && !TERMINAL_MISSION_STATUSES.has(existingFollowup.status)) {
        if (existingFollowup.status !== 'running' && existingFollowup.assigned_agent !== assignedAgent) {
          reassignMissionTask(existingFollowup.id, assignedAgent);
        }
        return c.json({ ok: true, task: getMissionTask(existingFollowup.id), review: existingReview, reused: true });
      }
    }

    const instructions = (body.instructions || '').trim().slice(0, 6000);
    const childId = crypto.randomBytes(4).toString('hex');
    const mode = body.mode === 'retry' ? 'Retry' : 'Follow up';
    createMissionTask(
      childId,
      `${mode}: ${task.title}`.slice(0, 200),
      buildReviewFollowupPrompt(task, instructions),
      assignedAgent,
      'review-inbox',
      task.status === 'failed' || task.status === 'partial' ? Math.max(task.priority, 7) : Math.max(task.priority, 5),
    );
    const childTask = getMissionTask(childId);
    const review = upsertMissionReview({
      taskId: task.id,
      reviewStatus: 'waiting_followup',
      resolution: body.mode === 'retry' ? 'retried' : 'delegated',
      followupTaskId: childId,
      instruction: instructions,
    });
    return c.json({ ok: true, task: childTask, review, reused: false }, 201);
  });

  app.get('/api/review/file', (c) => {
    const rawPath = c.req.query('path') || '';
    const filePath = resolveReviewFilePath(rawPath);
    if (!filePath) return c.json({ error: 'file path is not allowed' }, 400);
    if (!fs.existsSync(filePath)) return c.json({ error: 'file not found' }, 404);
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return c.json({ error: 'path is not a file' }, 400);
    if (stat.size > REVIEW_FILE_MAX_BYTES) return c.json({ error: 'file is too large to serve from dashboard' }, 413);

    const ext = path.extname(filePath).toLowerCase();
    const contentType = ext === '.pdf' ? 'application/pdf'
      : ext === '.docx' ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
        : ext === '.html' ? 'text/html; charset=utf-8'
          : ext === '.md' || ext === '.txt' ? 'text/plain; charset=utf-8'
            : 'application/octet-stream';
    return new Response(fs.readFileSync(filePath), {
      headers: {
        'content-type': contentType,
        'content-disposition': `inline; filename="${path.basename(filePath).replace(/"/g, '')}"`,
      },
    });
  });

  app.post('/api/review/tasks/:id/email', async (c) => {
    if (!killSwitchFlag('DASHBOARD_MUTATIONS_ENABLED', true)) {
      return c.json({ ok: false, error: 'Dashboard mutations are disabled.' }, 423);
    }

    const id = c.req.param('id');
    const task = getMissionTask(id);
    if (!task) return c.json({ ok: false, error: 'Not found' }, 404);
    if (!['completed', 'failed', 'partial'].includes(task.status)) {
      return c.json({ ok: false, error: 'Only completed, partial, or failed mission tasks can be exported.' }, 400);
    }

    const ownerEmail = configuredReviewExportEmail();
    if (!ownerEmail) return c.json({ ok: false, error: 'No review export email configured. Set REVIEW_EXPORT_EMAIL.' }, 400);
    const fromEmail = configuredReviewExportFromEmail();
    if (!fromEmail) return c.json({ ok: false, error: 'No review export sender configured. Set REVIEW_EXPORT_SHARED_MAILBOX to a shared mailbox.' }, 400);
    if (emailEquals(fromEmail, ownerEmail)) {
      return c.json({ ok: false, error: 'Review exports cannot send from the same mailbox they are sent to. Configure REVIEW_EXPORT_SHARED_MAILBOX to a shared mailbox.' }, 400);
    }

    let body: { format?: 'docx' | 'html' } = {};
    try { body = await c.req.json(); } catch { body = {}; }
    const exported = await createMissionTaskExport(task, body.format === 'html' ? 'html' : 'docx');
    try {
      await sendMissionTaskExportEmail(task, ownerEmail, fromEmail, exported.path);
    } catch (err: any) {
      return c.json({
        ok: false,
        error: safeEmailExportError(err),
        exported,
        to: maskEmail(ownerEmail),
        from: maskEmail(fromEmail),
      }, 502);
    }

    return c.json({
      ok: true,
      taskId: task.id,
      exported,
      emailed: true,
      to: maskEmail(ownerEmail),
      from: maskEmail(fromEmail),
    });
  });

  // ── Live Meetings (Pika meet-cli wrapper) ──────────────────────────
  // Three endpoints that shell out to dist/meet-cli.js. Actual join/leave
  // logic lives there so Telegram triggers and the dashboard go through
  // the same code path.

  const MEET_CLI = path.join(PROJECT_ROOT, 'dist', 'meet-cli.js');
  const MEET_URL_RE = /^https:\/\/meet\.google\.com\/[a-z0-9-]+/i;

  // Run meet-cli as a subprocess and parse its final JSON line from stdout.
  async function runMeetCli(args: string[], timeoutMs: number): Promise<{
    ok: boolean;
    data: Record<string, unknown>;
    stderr: string;
    code: number;
  }> {
    if (!fs.existsSync(MEET_CLI)) {
      return { ok: false, data: { error: 'meet-cli not built; run npm run build' }, stderr: '', code: -1 };
    }
    // SAFE-SPAWN-EXEMPT: meet-cli SDK spawn — getScrubbedSdkEnv with explicit auth re-injection. Pre-Part-3 migration.
    const { spawn } = await import('child_process');
    // SDK-CLASS spawn: meet-cli runs SDK queries internally (briefing
    // prompts, transcript synthesis) and consumes URL/agent args that
    // can be agent-controlled via dashboard input. Scrub env and
    // re-inject auth + Daily/Pika credentials the CLI itself needs.
    const meetAuth = readEnvFile([
      'CLAUDE_CODE_OAUTH_TOKEN',
      'ANTHROPIC_API_KEY',
      'DAILY_API_KEY',
      'PIKA_DEV_KEY',
      'PIKA_API_KEY',
      'GOOGLE_API_KEY',
    ]);
    // Round-4 structural fix: explicit re-injection (no
    // SDK_NATURAL_PASS_VARS). ANTHROPIC_API_KEY falls back to process.env
    // for shell-exported dev setups; OAuth token does not.
    const meetEnv = getScrubbedSdkEnv({
      ...meetAuth,
      ANTHROPIC_API_KEY: meetAuth.ANTHROPIC_API_KEY ?? process.env.ANTHROPIC_API_KEY,
    });
    // SAFE-SPAWN-EXEMPT: meet-cli SDK spawn, env = getScrubbedSdkEnv(meetAuth).
    const proc = spawn(process.execPath, [MEET_CLI, ...args], {
      cwd: PROJECT_ROOT,
      env: meetEnv as NodeJS.ProcessEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    proc.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });

    return await new Promise((resolve) => {
      const killTimer = setTimeout(() => {
        try { proc.kill('SIGTERM'); } catch { /* ok */ }
      }, timeoutMs);

      proc.on('close', (code: number | null) => {
        clearTimeout(killTimer);
        // meet-cli emits one JSON object on its final stdout line
        const lines = stdout.trim().split('\n').filter(Boolean);
        for (let i = lines.length - 1; i >= 0; i--) {
          try {
            const parsed = JSON.parse(lines[i]) as Record<string, unknown>;
            resolve({ ok: parsed.ok === true, data: parsed, stderr, code: code ?? 1 });
            return;
          } catch { /* try earlier line */ }
        }
        resolve({ ok: false, data: { error: 'no parseable output from meet-cli', stderr: stderr.slice(-400) }, stderr, code: code ?? 1 });
      });
    });
  }

  app.get('/api/meet/sessions', (c) => {
    const active = listActiveMeetSessions();
    const recent = listRecentMeetSessions(15).filter(
      (s: MeetSession) => s.status !== 'joining' && s.status !== 'live',
    );
    return c.json({ ok: true, active, recent });
  });

  app.post('/api/meet/join', async (c) => {
    let body: { agent?: string; meet_url?: string; auto_brief?: boolean; context?: string } = {};
    try { body = await c.req.json(); } catch { /* empty body */ }

    const agent = body.agent?.trim();
    const meetUrl = body.meet_url?.trim();
    const autoBrief = body.auto_brief !== false; // default true
    const context = body.context?.trim();

    if (!agent) return c.json({ ok: false, error: 'agent required' }, 400);
    if (!meetUrl || !MEET_URL_RE.test(meetUrl)) {
      return c.json({ ok: false, error: 'invalid meet_url (must match https://meet.google.com/...)' }, 400);
    }
    const validAgents = new Set(['main', ...listAgentIds()]);
    if (!validAgents.has(agent)) {
      return c.json({ ok: false, error: `unknown agent: ${agent}` }, 400);
    }

    const args = ['join', '--agent', agent, '--meet-url', meetUrl];
    if (autoBrief) args.push('--auto-brief');
    if (context) args.push('--context', context);

    // Budget: auto-brief (up to 75s) + Pika join (up to 120s) + slack = 220s
    const result = await runMeetCli(args, 220_000);
    return c.json(result.data, result.ok ? 200 : 500);
  });

  app.post('/api/meet/join-voice', async (c) => {
    let body: { agent?: string; meet_url?: string; auto_brief?: boolean; context?: string } = {};
    try { body = await c.req.json(); } catch { /* empty body */ }

    const agent = body.agent?.trim();
    const meetUrl = body.meet_url?.trim();
    const autoBrief = body.auto_brief !== false; // default true
    const context = body.context?.trim();

    if (!agent) return c.json({ ok: false, error: 'agent required' }, 400);
    if (!meetUrl || !MEET_URL_RE.test(meetUrl)) {
      return c.json({ ok: false, error: 'invalid meet_url (must match https://meet.google.com/...)' }, 400);
    }
    const validAgents = new Set(['main', ...listAgentIds()]);
    if (!validAgents.has(agent)) {
      return c.json({ ok: false, error: `unknown agent: ${agent}` }, 400);
    }

    const args = ['join-voice', '--agent', agent, '--meet-url', meetUrl];
    if (autoBrief) args.push('--auto-brief');
    if (context) args.push('--context', context);

    // Shorter budget than the avatar path since voice-only skips the
    // Pika upload + worker warmup. Still allows auto-brief to run.
    const result = await runMeetCli(args, 120_000);
    return c.json(result.data, result.ok ? 200 : 500);
  });

  app.post('/api/meet/join-daily', async (c) => {
    let body: { agent?: string; mode?: string; auto_brief?: boolean; context?: string; ttl_sec?: number } = {};
    try { body = await c.req.json(); } catch { /* empty body */ }

    const agent = body.agent?.trim();
    const mode = body.mode?.trim() || 'direct';
    const autoBrief = body.auto_brief !== false; // default true
    const context = body.context?.trim();
    const ttlSec = body.ttl_sec;

    if (!agent) return c.json({ ok: false, error: 'agent required' }, 400);
    if (mode !== 'direct' && mode !== 'auto') {
      return c.json({ ok: false, error: 'mode must be direct or auto' }, 400);
    }
    const validAgents = new Set(['main', ...listAgentIds()]);
    if (!validAgents.has(agent)) {
      return c.json({ ok: false, error: `unknown agent: ${agent}` }, 400);
    }

    const args = ['join-daily', '--agent', agent, '--mode', mode];
    if (autoBrief) args.push('--auto-brief');
    if (context) args.push('--context', context);
    if (typeof ttlSec === 'number' && ttlSec > 0) args.push('--ttl-sec', String(ttlSec));

    // Budget: briefing (~75s) + room creation (~2s) + agent spawn (~3s) = ~90s
    const result = await runMeetCli(args, 120_000);
    return c.json(result.data, result.ok ? 200 : 500);
  });

  app.post('/api/meet/leave', async (c) => {
    let body: { session_id?: string } = {};
    try { body = await c.req.json(); } catch { /* empty body */ }
    const sessionId = body.session_id?.trim();
    if (!sessionId) return c.json({ ok: false, error: 'session_id required' }, 400);
    if (!getMeetSession(sessionId)) {
      return c.json({ ok: false, error: 'session not found' }, 404);
    }
    const result = await runMeetCli(['leave', '--session-id', sessionId], 45_000);
    return c.json(result.data, result.ok ? 200 : 500);
  });

  // Memory stats
  app.get('/api/memories', (c) => {
    const chatId = dashboardChatId(c);
    const stats = getDashboardMemoryStats(chatId);
    const fading = getDashboardLowSalienceMemories(chatId, 10);
    const topAccessed = getDashboardTopAccessedMemories(chatId, 5);
    const timeline = getDashboardMemoryTimeline(chatId, 30);
    const consolidations = getDashboardConsolidations(chatId, 5);
    return c.json({ stats, fading, topAccessed, timeline, consolidations });
  });

  // Memory list (for drill-down drawer)
  app.get('/api/memories/pinned', (c) => {
    const chatId = dashboardChatId(c);
    const memories = getDashboardPinnedMemories(chatId);
    return c.json({ memories });
  });

  app.get('/api/memories/list', (c) => {
    const chatId = dashboardChatId(c);
    const limit = parseInt(c.req.query('limit') || '50', 10);
    const offset = parseInt(c.req.query('offset') || '0', 10);
    const sortBy = (c.req.query('sort') || 'importance') as 'importance' | 'salience' | 'recent';
    const result = getDashboardMemoriesList(chatId, limit, offset, sortBy);
    return c.json({ ...result, chatId });
  });

  app.get('/api/brain/status', (c) => {
    const chatId = dashboardChatId(c);
    const stats = getDashboardMemoryStats(chatId);
    return c.json({
      backend: BRAIN,
      openBrain: {
        enabled: BRAIN === 'ob1',
        configured: openBrainConfigured(),
        functionName: OB1_BRAIN_FUNCTION,
        supabaseConfigured: !!OB1_SUPABASE_URL,
        accessKeyConfigured: !!MCP_ACCESS_KEY,
      },
      mutationsEnabled: killSwitchFlag('DASHBOARD_MUTATIONS_ENABLED', true),
      sqlite: {
        enabled: true,
        chatId,
        totalMemories: stats.total,
        pinned: stats.pinned,
        avgSalience: stats.avgSalience,
      },
      notes: BRAIN === 'ob1'
        ? 'OpenBrain is the active capture/retrieval backend. SQLite remains visible for local history and fallback.'
        : 'SQLite is the active memory backend. OpenBrain/OB1 is configured by BRAIN=ob1 plus OB1_SUPABASE_URL and MCP_ACCESS_KEY.',
    });
  });

  app.get('/api/brain/search', async (c) => {
    const query = (c.req.query('query') || c.req.query('q') || '').trim();
    if (!query) return c.json({ ok: false, error: 'query required', results: [], raw: '' }, 400);
    if (!openBrainConfigured()) {
      return c.json({
        ok: false,
        error: 'OpenBrain search is not configured. Set BRAIN=ob1, OB1_SUPABASE_URL, MCP_ACCESS_KEY, and OB1_BRAIN_FUNCTION.',
        results: [],
        raw: '',
      }, 400);
    }

    const parsedLimit = parseInt(c.req.query('limit') || '8', 10);
    const limit = Number.isFinite(parsedLimit) ? Math.max(1, Math.min(20, parsedLimit)) : 8;
    const parsedThreshold = parseFloat(c.req.query('threshold') || '0.5');
    const threshold = Number.isFinite(parsedThreshold) ? Math.max(0, Math.min(1, parsedThreshold)) : 0.5;

    const raw = await searchThoughts({ query, limit, threshold });
    return c.json({
      ok: true,
      query,
      limit,
      threshold,
      results: parseSearchText(raw),
      raw,
    });
  });

  app.post('/api/brain/capture', async (c) => {
    if (!killSwitchFlag('DASHBOARD_MUTATIONS_ENABLED', true)) {
      return c.json({ ok: false, error: 'Dashboard mutations are disabled by DASHBOARD_MUTATIONS_ENABLED=false' }, 423);
    }
    if (!openBrainConfigured()) {
      return c.json({
        ok: false,
        error: 'OpenBrain capture is not configured. Set BRAIN=ob1, OB1_SUPABASE_URL, MCP_ACCESS_KEY, and OB1_BRAIN_FUNCTION.',
      }, 400);
    }

    const body = await c.req.json().catch(() => ({}));
    const content = body && typeof body === 'object' && typeof (body as { content?: unknown }).content === 'string'
      ? (body as { content: string }).content.trim()
      : '';
    if (!content) return c.json({ ok: false, error: 'content required' }, 400);
    if (content.length > 12_000) return c.json({ ok: false, error: 'content too long, max 12000 characters' }, 400);

    const result = await captureThought({ content });
    return c.json(result);
  });

  // System health
  app.get('/api/health', (c) => {
    const chatId = dashboardChatId(c);
    const { provider, providerError } = currentProviderStatus();
    const sessionId = getSession(chatId, AGENT_ID, provider);
    const runtime = providerRuntime(provider, agentDefaultModel || MAIN_AGENT_MODEL, sessionId);
    let contextPct = 0;
    let turns = 0;
    let compactions = 0;
    let sessionAge = '-';

    if (sessionId) {
      const summary = getSessionTokenUsage(sessionId);
      if (summary) {
        turns = summary.turns;
        compactions = summary.compactions;
        const contextTokens = (summary.lastContextTokens || 0) + (summary.lastCacheRead || 0);
        contextPct = contextTokens > 0 ? Math.round((contextTokens / CONTEXT_LIMIT) * 100) : 0;
        const ageSec = Math.floor(Date.now() / 1000) - summary.firstTurnAt;
        if (ageSec < 3600) sessionAge = Math.floor(ageSec / 60) + 'm';
        else if (ageSec < 86400) sessionAge = Math.floor(ageSec / 3600) + 'h';
        else sessionAge = Math.floor(ageSec / 86400) + 'd';
      }
    }

    // Kill-switch surface — fork doesn't yet wire central kill-switches
    // module, so we publish the contract shape with env-derived defaults.
    // The frontend reads these flags to render gate state.
    const killSwitchesShape = {
      WARROOM_TEXT_ENABLED: killSwitchFlag('WARROOM_TEXT_ENABLED', true),
      WARROOM_VOICE_ENABLED: killSwitchFlag('WARROOM_VOICE_ENABLED', true),
      LLM_SPAWN_ENABLED: killSwitchFlag('LLM_SPAWN_ENABLED', true),
      DASHBOARD_MUTATIONS_ENABLED: killSwitchFlag('DASHBOARD_MUTATIONS_ENABLED', true),
      MISSION_AUTO_ASSIGN_ENABLED: killSwitchFlag('MISSION_AUTO_ASSIGN_ENABLED', true),
      SCHEDULER_ENABLED: killSwitchFlag('SCHEDULER_ENABLED', true),
    };

    return c.json({
      contextPct,
      turns,
      compactions,
      sessionAge,
      model: runtime.configuredModel,
      provider: runtime.provider,
      configuredProvider: configuredProviderValue(),
      providerError,
      supportedProviders: getSupportedLlmProviders(),
      configuredModel: runtime.configuredModel,
      resolvedModel: runtime.resolvedModel,
      hasSession: runtime.hasSession,
      sessionShort: runtime.sessionShort,
      telegramConnected: getTelegramConnected(),
      waConnected: WHATSAPP_ENABLED,
      slackConnected: !!SLACK_USER_TOKEN,
      killSwitches: killSwitchesShape,
      killSwitchRefusals: {},
      warroom: { textOpenMeetings: 0 },
    });
  });

  app.get('/api/runtime/stack', (c) => {
    const chatId = dashboardChatId(c);
    const { provider, providerError } = currentProviderStatus();
    const sessionId = getSession(chatId, AGENT_ID, provider);
    const runtime = providerRuntime(provider, agentDefaultModel || MAIN_AGENT_MODEL, sessionId);
    const memoryStats = getDashboardMemoryStats(chatId);
    const mutationsEnabled = killSwitchFlag('DASHBOARD_MUTATIONS_ENABLED', true);
    const llmSpawnEnabled = killSwitchFlag('LLM_SPAWN_ENABLED', true);
    const activeCall = getIsProcessing().processing;

    return c.json({
      updatedAt: new Date().toISOString(),
      runtime: {
        activeProvider: runtime.provider,
        configuredProvider: configuredProviderValue(),
        supportedProviders: getSupportedLlmProviders(),
        configuredModel: runtime.configuredModel,
        resolvedModel: runtime.resolvedModel,
        hasSession: runtime.hasSession,
        sessionShort: runtime.sessionShort,
        providerError,
      },
      components: [
        {
          id: 'provider-adapter',
          name: 'Provider adapter',
          category: 'LLM',
          status: providerError ? 'degraded' : 'healthy',
          active: runtime.provider,
          configured: configuredProviderValue(),
          implementations: getSupportedLlmProviders(),
          contract: [
            'runAgent(options)',
            'stream progress events',
            'honor MCP allowlists',
            'return usage and session metadata',
            'map model tiers across providers',
          ],
          signals: {
            configuredModel: runtime.configuredModel,
            resolvedModel: runtime.resolvedModel,
            spawnEnabled: llmSpawnEnabled,
            activeCall,
          },
          actions: {
            smoke: '/api/provider/smoke',
            switch: '/api/provider/switch',
          },
          error: providerError,
        },
        {
          id: 'memory-backend',
          name: 'Memory backend',
          category: 'Memory',
          status: BRAIN === 'ob1' && !openBrainConfigured() ? 'degraded' : 'healthy',
          active: BRAIN === 'ob1' ? 'OpenBrain' : 'SQLite',
          configured: BRAIN,
          implementations: ['sqlite', 'ob1'],
          contract: [
            'retrieve context for agent turns',
            'capture distilled memories',
            'keep local history inspectable',
          ],
          signals: {
            sqliteMemories: memoryStats.total,
            sqlitePinned: memoryStats.pinned,
            avgSalience: memoryStats.avgSalience,
            openBrainConfigured: openBrainConfigured(),
            functionName: OB1_BRAIN_FUNCTION,
          },
          actions: {
            search: '/api/brain/search',
            capture: '/api/brain/capture',
          },
          error: BRAIN === 'ob1' && !openBrainConfigured() ? 'OpenBrain selected but not fully configured.' : null,
        },
        {
          id: 'tool-boundary',
          name: 'Tool boundary',
          category: 'Tools',
          status: 'healthy',
          active: 'MCP allowlist',
          configured: 'provider enforced',
          implementations: ['Claude MCP loader', 'Codex temp CODEX_HOME'],
          contract: [
            'allowed MCP servers only',
            'empty allowlist exposes no MCP servers',
            'undefined allowlist preserves provider defaults',
          ],
          signals: {
            provider: runtime.provider,
            securityBoundary: true,
          },
          actions: {},
          error: null,
        },
        {
          id: 'session-store',
          name: 'Session store',
          category: 'State',
          status: 'healthy',
          active: runtime.hasSession ? 'resumable' : 'fresh',
          configured: 'SQLite sessions',
          implementations: ['chat/agent/provider scoped sessions'],
          contract: [
            'isolate sessions by chat, agent, and provider',
            'never resume a Codex session through Claude',
            'preserve provider-specific continuity',
          ],
          signals: {
            chatId,
            agentId: AGENT_ID,
            provider: runtime.provider,
            sessionShort: runtime.sessionShort,
          },
          actions: {},
          error: null,
        },
        {
          id: 'safety-gates',
          name: 'Safety gates',
          category: 'Safety',
          status: mutationsEnabled && llmSpawnEnabled ? 'healthy' : 'limited',
          active: mutationsEnabled ? 'writes enabled' : 'writes locked',
          configured: 'env kill switches',
          implementations: ['DASHBOARD_MUTATIONS_ENABLED', 'LLM_SPAWN_ENABLED'],
          contract: [
            'dashboard writes fail closed when disabled',
            'LLM spawning can be blocked independently',
            'active model calls block provider switches',
          ],
          signals: {
            dashboardMutationsEnabled: mutationsEnabled,
            llmSpawnEnabled,
            activeCall,
          },
          actions: {},
          error: mutationsEnabled ? null : 'Dashboard mutations are disabled.',
        },
      ],
    });
  });

  app.post('/api/provider/switch', async (c) => {
    if (!killSwitchFlag('DASHBOARD_MUTATIONS_ENABLED', true)) {
      return c.json({ ok: false, error: 'Dashboard mutations are disabled.' }, 423);
    }
    if (getIsProcessing().processing) {
      return c.json({ ok: false, error: 'A model call is currently active. Try again once it finishes.' }, 409);
    }

    let body: { provider?: string } = {};
    try {
      body = await c.req.json();
    } catch {
      body = {};
    }

    let provider: LlmProviderName;
    try {
      provider = normalizeLlmProvider(body.provider);
    } catch (err: any) {
      return c.json({ ok: false, error: err?.message || 'Unsupported provider' }, 400);
    }

    writeEnvValue('LLM_PROVIDER', provider);
    return c.json({
      ok: true,
      provider,
      previousProvider: currentProviderStatus().provider,
      restartRequired: provider !== currentProviderStatus().provider,
      message: provider === currentProviderStatus().provider
        ? 'LLM_PROVIDER already matches the active runtime provider.'
        : 'LLM_PROVIDER updated. Restart Sage to activate this provider.',
    });
  });

  // Manual provider smoke test. This intentionally runs without a saved
  // Telegram session id and with zero MCP servers, so it checks provider
  // reachability without mutating the live conversation.
  app.post('/api/provider/smoke', async (c) => {
    if (!killSwitchFlag('LLM_SPAWN_ENABLED', true)) {
      return c.json({
        ok: false,
        error: 'LLM spawn is disabled by LLM_SPAWN_ENABLED.',
      }, 423);
    }

    let body: { provider?: string; model?: string } = {};
    try {
      body = await c.req.json();
    } catch {
      body = {};
    }

    let provider: LlmProviderName;
    try {
      provider = normalizeLlmProvider(body.provider || LLM_PROVIDER);
    } catch (err: any) {
      return c.json({ ok: false, error: err?.message || 'Unsupported provider' }, 400);
    }

    const configuredModel = body.model || agentDefaultModel || MAIN_AGENT_MODEL;
    const resolvedModel = resolveModelForProvider(provider, configuredModel) || configuredModel;
    const abortController = new AbortController();
    const timer = setTimeout(() => abortController.abort(), 45_000);

    try {
      const result = await getLlmProvider(provider).runAgent({
        message: buildAgentRuntimePrompt(
          'Provider smoke test. Reply exactly: PROVIDER_SMOKE_OK',
          'You are a provider health smoke test. Do not use tools.',
        ),
        sessionId: undefined,
        onTyping: () => {},
        model: resolvedModel,
        abortController,
        mcpAllowlist: [],
        cwdOverride: PROJECT_ROOT,
        maxTurns: 1,
      });

      const text = result.text || '';
      const ok = text.includes('PROVIDER_SMOKE_OK');
      return c.json({
        ok,
        provider,
        configuredModel,
        resolvedModel,
        hasSession: !!result.newSessionId,
        sessionShort: shortenSessionId(result.newSessionId),
        usage: result.usage ? {
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
          cacheReadInputTokens: result.usage.cacheReadInputTokens,
          totalCostUsd: result.usage.totalCostUsd,
        } : null,
        textPreview: text.slice(0, 120),
      }, 200);
    } catch (err: any) {
      logger.error({ err, provider, resolvedModel }, 'Provider smoke test failed');
      return c.json({
        ok: false,
        provider,
        configuredModel,
        resolvedModel,
        error: err?.message || 'Provider smoke test failed',
      }, 500);
    } finally {
      clearTimeout(timer);
    }
  });

  // Token / cost stats
  app.get('/api/tokens', (c) => {
    const chatId = c.req.query('chatId') || '';
    const stats = getDashboardTokenStats(chatId);
    const costTimeline = getDashboardCostTimeline(chatId, 30);
    const recentUsage = getDashboardRecentTokenUsage(chatId, 20);
    return c.json({ stats, costTimeline, recentUsage });
  });

  // Bot info (name, PID, chatId) — reads dynamically from state
  app.get('/api/info', (c) => {
    const chatId = c.req.query('chatId') || '';
    const info = getBotInfo();
    return c.json({
      botName: info.name || 'ClaudeClaw',
      botUsername: info.username || '',
      pid: process.pid,
      chatId: chatId || null,
    });
  });

  // ── Agent endpoints ──────────────────────────────────────────────────

  // List all configured agents with status
  app.get('/api/agents', (c) => {
    const chatId = c.req.query('chatId') || '';
    const { provider, providerError } = currentProviderStatus();
    const agentIds = listAgentIds();
    const agents = agentIds.map((id) => {
      try {
        const config = loadAgentConfig(id);
        // Check if agent process is alive via PID file
        const pidFile = path.join(STORE_DIR, `agent-${id}.pid`);
        let running = false;
        if (fs.existsSync(pidFile)) {
          try {
            const pid = parseInt(fs.readFileSync(pidFile, 'utf-8').trim(), 10);
            process.kill(pid, 0); // signal 0 = check if alive
            running = true;
          } catch { /* process not running */ }
        }
        const stats = getAgentTokenStats(id);
        const sessionId = getSession(chatId, id, provider);
        const runtime = providerRuntime(provider, config.model ?? MAIN_AGENT_MODEL, sessionId);
        return {
          id,
          name: config.name,
          description: config.description,
          model: runtime.configuredModel,
          provider: runtime.provider,
          configuredProvider: LLM_PROVIDER,
          providerError,
          configuredModel: runtime.configuredModel,
          resolvedModel: runtime.resolvedModel,
          hasSession: runtime.hasSession,
          sessionShort: runtime.sessionShort,
          lastProviderError: null,
          running,
          todayTurns: stats.todayTurns,
          todayCost: stats.todayCost,
        };
      } catch {
        return {
          id,
          name: id,
          description: '',
          model: 'unknown',
          provider,
          configuredProvider: LLM_PROVIDER,
          providerError,
          configuredModel: 'unknown',
          resolvedModel: 'unknown',
          hasSession: false,
          sessionShort: null,
          lastProviderError: null,
          running: false,
          todayTurns: 0,
          todayCost: 0,
        };
      }
    });

    // Include main bot too
    const mainPidFile = path.join(STORE_DIR, 'claudeclaw.pid');
    let mainRunning = false;
    if (fs.existsSync(mainPidFile)) {
      try {
        const pid = parseInt(fs.readFileSync(mainPidFile, 'utf-8').trim(), 10);
        process.kill(pid, 0);
        mainRunning = true;
      } catch { /* not running */ }
    }
    const mainStats = getAgentTokenStats('main');
    const mainSessionId = getSession(chatId, 'main', provider);
    const mainRuntime = providerRuntime(provider, agentDefaultModel || MAIN_AGENT_MODEL, mainSessionId);
    const allAgents = [
      {
        id: 'main',
        name: 'Main',
        description: 'Primary ClaudeClaw bot',
        model: mainRuntime.configuredModel,
        provider: mainRuntime.provider,
        configuredProvider: LLM_PROVIDER,
        providerError,
        configuredModel: mainRuntime.configuredModel,
        resolvedModel: mainRuntime.resolvedModel,
        hasSession: mainRuntime.hasSession,
        sessionShort: mainRuntime.sessionShort,
        lastProviderError: null,
        running: mainRunning,
        todayTurns: mainStats.todayTurns,
        todayCost: mainStats.todayCost,
      },
      ...agents,
    ];

    return c.json({ agents: allAgents });
  });

  // Agent-specific recent conversation
  app.get('/api/agents/:id/conversation', (c) => {
    const agentId = c.req.param('id');
    const chatId = c.req.query('chatId') || ALLOWED_CHAT_ID || '';
    const limit = parseInt(c.req.query('limit') || '4', 10);
    const turns = getAgentRecentConversation(agentId, chatId, limit);
    return c.json({ turns });
  });

  // Agent-specific tasks
  app.get('/api/agents/:id/tasks', (c) => {
    const agentId = c.req.param('id');
    const tasks = getAllScheduledTasks(agentId);
    return c.json({ tasks });
  });

  // Agent-specific token stats
  app.get('/api/agents/:id/tokens', (c) => {
    const agentId = c.req.param('id');
    const stats = getAgentTokenStats(agentId);
    return c.json(stats);
  });

  // Update ALL agent models at once. MUST be registered before the
  // parameterized /:id variant below: Hono matches routes first-win, so
  // if this came second, a PATCH /api/agents/model would match the
  // parameterized route with id="model" and the bulk endpoint would be
  // unreachable (the dashboard "Set all" button was silently a no-op).
  app.patch('/api/agents/model', async (c) => {
    const body = await c.req.json<{ model?: string }>();
    const model = body?.model?.trim();
    if (!model) return c.json({ error: 'model required' }, 400);

    const validModels = ['claude-opus-4-7', 'claude-sonnet-4-6', 'claude-sonnet-4-5', 'claude-haiku-4-5'];
    if (!validModels.includes(model)) return c.json({ error: `Invalid model` }, 400);

    const agentIds = listAgentIds();
    const updated: string[] = [];
    for (const id of agentIds) {
      try { setAgentModel(id, model); updated.push(id); } catch {}
    }
    return c.json({ ok: true, model, updated });
  });

  // Update agent model
  app.patch('/api/agents/:id/model', async (c) => {
    const agentId = c.req.param('id');
    const body = await c.req.json<{ model?: string }>();
    const model = body?.model?.trim();
    if (!model) return c.json({ error: 'model required' }, 400);

    const validModels = ['claude-opus-4-7', 'claude-sonnet-4-6', 'claude-sonnet-4-5', 'claude-haiku-4-5'];
    if (!validModels.includes(model)) return c.json({ error: `Invalid model. Valid: ${validModels.join(', ')}` }, 400);

    try {
      if (agentId === 'main') {
        // Main agent uses in-memory override (same as /model command);
        // takes effect on the next turn — no process restart required.
        const { setMainModelOverride } = await import('./bot.js');
        setMainModelOverride(model);
        return c.json({ ok: true, agent: 'main', model, restartRequired: false });
      }
      setAgentModel(agentId, model);
      return c.json({ ok: true, agent: agentId, model, restartRequired: true });
    } catch (err) {
      return c.json({ error: 'Failed to update model' }, 500);
    }
  });

  // ── Agent Creation & Management ──────────────────────────────────────

  // List available agent templates
  app.get('/api/agents/templates', (c) => {
    return c.json({ templates: listTemplates() });
  });

  // Validate an agent ID (before creation)
  app.get('/api/agents/validate-id', (c) => {
    const id = c.req.query('id') || '';
    const result = validateAgentId(id);
    const suggestions = id ? suggestBotNames(id) : null;
    return c.json({ ...result, suggestions });
  });

  // Validate a bot token
  app.post('/api/agents/validate-token', async (c) => {
    const body = await c.req.json<{ token?: string }>();
    const token = body?.token?.trim();
    if (!token) return c.json({ ok: false, error: 'token required' }, 400);
    const result = await validateBotToken(token);
    return c.json(result);
  });

  // Create a new agent
  app.post('/api/agents/create', async (c) => {
    const body = await c.req.json<{
      id?: string;
      name?: string;
      description?: string;
      model?: string;
      template?: string;
      botToken?: string;
    }>();

    const id = body?.id?.trim();
    const name = body?.name?.trim();
    const description = body?.description?.trim();
    const botToken = body?.botToken?.trim();

    if (!id) return c.json({ error: 'id required' }, 400);
    if (!name) return c.json({ error: 'name required' }, 400);
    if (!description) return c.json({ error: 'description required' }, 400);
    if (!botToken) return c.json({ error: 'botToken required' }, 400);

    try {
      const result = await createAgent({
        id,
        name,
        description,
        model: body?.model?.trim() || undefined,
        template: body?.template?.trim() || undefined,
        botToken,
      });
      return c.json({ ok: true, ...result }, 201);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ error: msg }, 400);
    }
  });

  // Activate an agent (install service + start)
  app.post('/api/agents/:id/activate', (c) => {
    const agentId = c.req.param('id');
    if (agentId === 'main') return c.json({ error: 'Cannot activate main via this endpoint' }, 400);
    const result = activateAgent(agentId);
    return c.json(result);
  });

  // Deactivate an agent (stop + uninstall service)
  app.post('/api/agents/:id/deactivate', (c) => {
    const agentId = c.req.param('id');
    if (agentId === 'main') return c.json({ error: 'Cannot deactivate main via this endpoint' }, 400);
    const result = deactivateAgent(agentId);
    return c.json(result);
  });

  // Restart an agent (kill + relaunch service)
  app.post('/api/agents/:id/restart', (c) => {
    const agentId = c.req.param('id');
    if (agentId === 'main') return c.json({ error: 'Cannot restart main via this endpoint. Restart the main process manually.' }, 400);
    const result = restartAgent(agentId);
    if (result.ok) {
      return c.json({ ok: true, message: `Agent ${agentId} restarted` });
    }
    return c.json({ error: result.error }, 500);
  });

  // Delete an agent entirely
  app.delete('/api/agents/:id/full', (c) => {
    const agentId = c.req.param('id');
    if (agentId === 'main') return c.json({ error: 'Cannot delete main' }, 400);
    const result = deleteAgent(agentId);
    if (result.ok) {
      return c.json({ ok: true });
    }
    return c.json({ error: result.error }, 500);
  });

  // Check if a specific agent is running
  app.get('/api/agents/:id/status', (c) => {
    const agentId = c.req.param('id');
    return c.json({ running: isAgentRunning(agentId) });
  });

  // ── Security & Audit ─────────────────────────────────────────────────

  app.get('/api/security/status', (c) => {
    return c.json(getSecurityStatus());
  });

  app.get('/api/audit', (c) => {
    const limit = parseInt(c.req.query('limit') || '50', 10);
    const offset = parseInt(c.req.query('offset') || '0', 10);
    const agentId = c.req.query('agent') || undefined;
    const entries = getAuditLog(limit, offset, agentId);
    const total = getAuditLogCount(agentId);
    return c.json({ entries, total });
  });

  app.get('/api/audit/blocked', (c) => {
    const limit = parseInt(c.req.query('limit') || '10', 10);
    return c.json({ entries: getRecentBlockedActions(limit) });
  });

  // Hive mind feed
  app.get('/api/hive-mind', (c) => {
    const agentId = c.req.query('agent');
    const limit = parseInt(c.req.query('limit') || '20', 10);
    const entries = getHiveMindEntries(limit, agentId || undefined);
    return c.json({ entries });
  });

  // ── Chat endpoints ─────────────────────────────────────────────────

  // SSE stream for real-time chat updates
  app.get('/api/chat/stream', (c) => {
    return streamSSE(c, async (stream) => {
      // Send initial processing state
      const state = getIsProcessing();
      await stream.writeSSE({
        event: 'processing',
        data: JSON.stringify({ processing: state.processing, chatId: state.chatId }),
      });

      // Forward chat events to SSE client
      const handler = async (event: ChatEvent) => {
        try {
          await stream.writeSSE({
            event: event.type,
            data: JSON.stringify(event),
          });
        } catch {
          // Client disconnected
        }
      };

      chatEvents.on('chat', handler);

      // Keepalive ping every 30s
      const pingInterval = setInterval(async () => {
        try {
          await stream.writeSSE({ event: 'ping', data: '' });
        } catch {
          clearInterval(pingInterval);
        }
      }, 30_000);

      // Wait until the client disconnects
      try {
        await new Promise<void>((_, reject) => {
          stream.onAbort(() => reject(new Error('aborted')));
        });
      } catch {
        // Expected: client disconnected
      } finally {
        clearInterval(pingInterval);
        chatEvents.off('chat', handler);
      }
    });
  });

  // Chat history (paginated)
  app.get('/api/chat/history', (c) => {
    const chatId = c.req.query('chatId') || '';
    if (!chatId) return c.json({ error: 'chatId required' }, 400);
    const limit = parseInt(c.req.query('limit') || '40', 10);
    const beforeId = c.req.query('beforeId');
    const turns = getConversationPage(chatId, limit, beforeId ? parseInt(beforeId, 10) : undefined);
    return c.json({ turns });
  });

  // Send message from dashboard
  app.post('/api/chat/send', async (c) => {
    if (!botApi) return c.json({ error: 'Bot API not available' }, 503);
    const body = await c.req.json<{ message?: string }>();
    const message = body?.message?.trim();
    if (!message) return c.json({ error: 'message required' }, 400);

    // Fire-and-forget: response comes via SSE
    void processMessageFromDashboard(botApi, message);
    return c.json({ ok: true });
  });

  // ── Agent files editor (Phase C1.a) ───────────────────────────────
  // Live-edit Sage's main CLAUDE.md from the dashboard with atomic writes,
  // SQLite-backed history, and hot-reload of the running main process. Path
  // allowlist enforced inside src/agent-files.ts; all writes refused for
  // unknown ids with a clear 400.

  app.get('/api/agent-files', (c) => {
    return c.json({ files: listEditableFiles() });
  });

  app.get('/api/agent-files/:id', (c) => {
    const id = c.req.param('id');
    if (!isEditableFileId(id)) {
      return c.json({ error: 'Unknown file id' }, 400);
    }
    try {
      return c.json(readEditableFile(id));
    } catch (err) {
      logger.error({ err, id }, 'agent-files read failed');
      return c.json({ error: 'Read failed' }, 500);
    }
  });

  app.get('/api/agent-files/:id/history', (c) => {
    const id = c.req.param('id');
    if (!isEditableFileId(id)) {
      return c.json({ error: 'Unknown file id' }, 400);
    }
    const limit = Math.max(1, Math.min(200, parseInt(c.req.query('limit') ?? '50', 10) || 50));
    const rows = listHistory(id, limit);
    // Strip large `content` from the list response — clients fetch a
    // specific revision via /history/:rowId if they want the body.
    return c.json({
      history: rows.map((r) => ({
        id: r.id,
        file_path: r.file_path,
        real_path: r.real_path,
        content_sha: r.content_sha,
        edited_by_chat_id: r.edited_by_chat_id,
        created_at: r.created_at,
        size: r.content.length,
      })),
    });
  });

  app.put('/api/agent-files/:id', async (c) => {
    const id = c.req.param('id');
    if (!isEditableFileId(id)) {
      return c.json({ error: 'Unknown file id' }, 400);
    }
    let body: { content?: unknown; expectedSha?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }
    if (typeof body.content !== 'string') {
      return c.json({ error: 'content (string) required' }, 400);
    }
    // Belt-and-braces size cap: refuse anything wildly larger than the
    // largest sane CLAUDE.md (~256 KiB). Stops a runaway client/UI bug
    // from blowing out SQLite history rows.
    if (Buffer.byteLength(body.content, 'utf-8') > MAX_AGENT_FILE_BYTES) {
      return c.json({ error: 'content exceeds 256 KiB cap' }, 413);
    }
    if (typeof body.expectedSha !== 'string' || !/^[a-f0-9]{64}$/i.test(body.expectedSha)) {
      return c.json({ error: 'expectedSha (sha-256 hex string) required' }, 400);
    }
    const expectedSha =
      body.expectedSha;
    try {
      const result = saveEditableFile(id, body.content, {
        editedByChatId: ALLOWED_CHAT_ID || null,
        expectedSha,
      });
      return c.json({ ok: true, ...result });
    } catch (err) {
      if (err instanceof EditorError) {
        return c.json({ error: err.message }, err.status as 400 | 409 | 413);
      }
      logger.error({ err, id }, 'agent-files save failed');
      return c.json({ error: 'Save failed' }, 500);
    }
  });

  // Abort current processing
  app.post('/api/chat/abort', (c) => {
    const { chatId } = getIsProcessing();
    if (!chatId) return c.json({ ok: false, reason: 'not_processing' });
    const aborted = abortActiveQuery(chatId);
    return c.json({ ok: aborted });
  });

  // SPA fallback for v2 deep-links when v2 owns root (`/tasks`,
  // `/agents`, etc.). Registered last so all explicit routes win first.
  // We only fire on GET — POSTs to unknown paths still 404 cleanly.
  if (MISSION_CONTROL_V2) {
    app.get('*', (c) => {
      const reqPath = new URL(c.req.url).pathname;
      // Don't shadow API or warroom 404s — those should stay as-is so
      // the frontend sees real backend errors instead of an HTML body.
      if (reqPath.startsWith('/api/') || reqPath.startsWith('/warroom')) {
        return c.json({ error: 'Not found' }, 404);
      }
      return serveV2(c, '/index.html');
    });
  }

  return app;
}

/**
 * Production entry point: build the dashboard app and bind it to a port.
 * Wires the War Room WS proxy onto the same HTTP server when enabled.
 */
export function startDashboard(botApi?: Api<RawApi>): void {
  if (!DASHBOARD_TOKEN) {
    logger.info('DASHBOARD_TOKEN not set, dashboard disabled');
    return;
  }

  const app = buildDashboardApp(botApi);

  let server: ReturnType<typeof serve>;
  try {
    server = serve({ fetch: app.fetch, port: DASHBOARD_PORT }, () => {
      logger.info({ port: DASHBOARD_PORT }, 'Dashboard server running');
    });
  } catch (err: any) {
    if (err?.code === 'EADDRINUSE') {
      logger.error({ port: DASHBOARD_PORT }, 'Dashboard port already in use. Change DASHBOARD_PORT in .env or kill the process using port %d.', DASHBOARD_PORT);
    } else {
      logger.error({ err }, 'Dashboard server failed to start');
    }
    return;
  }

  // ── WebSocket proxy: /ws/warroom → localhost:WARROOM_PORT ──────────
  // Allows the War Room to work through a single Cloudflare tunnel on
  // the dashboard port. Without this, remote/mobile users can't reach
  // the Python WebSocket server on port 7860.
  if (WARROOM_ENABLED) {
    void import('ws').then((wsModule: any) => {
    const WS = wsModule.default?.WebSocket ?? wsModule.WebSocket;
    const WSServer = wsModule.default?.WebSocketServer ?? wsModule.WebSocketServer;

    if (WSServer) {
      const wss = new WSServer({ noServer: true });

      (server as unknown as import('http').Server).on('upgrade', (
        req: import('http').IncomingMessage,
        socket: import('stream').Duplex,
        head: Buffer,
      ) => {
        const url = new URL(req.url || '/', `http://${req.headers.host}`);
        if (url.pathname !== '/ws/warroom') return;

        wss.handleUpgrade(req, socket, head, (clientWs: any) => {
          const remote = new WS(`ws://127.0.0.1:${WARROOM_PORT}`);
          let remoteReady = false;
          const buffered: (Buffer | ArrayBuffer | string)[] = [];

          remote.on('open', () => {
            remoteReady = true;
            for (const msg of buffered) remote.send(msg);
            buffered.length = 0;
          });
          remote.on('message', (data: Buffer | ArrayBuffer | string) => {
            if (clientWs.readyState === 1) clientWs.send(data);
          });
          remote.on('close', () => clientWs.close());
          remote.on('error', (err: Error) => {
            logger.warn({ err }, 'War Room WS proxy: remote error');
            try { clientWs.close(1011, 'War Room server error'); } catch { /* ok */ }
          });

          clientWs.on('message', (data: Buffer | ArrayBuffer | string) => {
            if (remoteReady) remote.send(data);
            else buffered.push(data);
          });
          clientWs.on('close', () => {
            if (remote.readyState <= 1) remote.close();
          });
        });
      });

      logger.info('War Room WebSocket proxy active at /ws/warroom');
    }
    }).catch((err: unknown) => {
      logger.warn({ err }, 'Could not set up War Room WS proxy');
    });
  }
}
