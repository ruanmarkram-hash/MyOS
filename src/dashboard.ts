import { Api, RawApi } from 'grammy';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { serve } from '@hono/node-server';

import fs from 'fs';
import path from 'path';
import { AGENT_ID, ALLOWED_CHAT_ID, DASHBOARD_PORT, DASHBOARD_TOKEN, PROJECT_ROOT, STORE_DIR, WHATSAPP_ENABLED, SLACK_USER_TOKEN, CONTEXT_LIMIT, MISSION_CONTROL_V2, agentDefaultModel, LLM_PROVIDER, BRAIN, OB1_SUPABASE_URL, MCP_ACCESS_KEY, OB1_BRAIN_FUNCTION, OB1_GRAPH_FUNCTION, EMBEDDING_PROVIDER, LLAMACPP_EMBEDDING_URL, LLAMACPP_EMBEDDING_MODEL, LOCAL_EMBEDDING_MODEL_PATH, CODEX_HAIKU_MODEL, CODEX_SONNET_MODEL, CODEX_OPUS_MODEL } from './config.js';
import crypto from 'crypto';
import {
  getAllScheduledTasks,
  deleteScheduledTask,
  updateScheduledTask,
  pauseScheduledTask,
  resumeScheduledTask,
  clearScheduledTaskAttention,
  resetScheduledTaskRun,
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
  memoryExistsBySourceAndSummary,
  saveStructuredMemory,
  searchMemories,
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
  getMissionManifest,
  appendMissionTaskInstruction,
  createMissionTask,
  completeMissionTask,
  cancelMissionTask,
  deleteMissionTask,
  reassignMissionTask,
  assignMissionTask,
  getUnassignedMissionTasks,
  getMissionTaskHistory,
  listStaleMissionTasks,
  resetMissionTaskRun,
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
  getOutboxStats,
  listProblemTelegramOutbox,
  retryTelegramOutboxRow,
  deadLetterTelegramOutboxRow,
  listOverdueOperationNotifications,
  cancelOperationNotificationById,
} from './db.js';
import { generateContent, parseJsonResponse } from './gemini.js';
import { getSecurityStatus, getScrubbedSdkEnv } from './security.js';
import { readEnvFile } from './env.js';
import { AGENT_ID_RE, agentExists, listAgentIds, loadAgentConfig, resolveAgentDir, setAgentModel, setAgentProvider, type AgentConfig } from './agent-config.js';
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
import { getMainModelOverride, processMessageFromDashboard } from './bot.js';
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
import {
  captureThought,
  createGraphEdge,
  createGraphNode,
  getGraphNeighbors,
  getOpenBrainMap,
  getOpenBrainStats,
  getOpenBrainThought,
  getOpenBrainThoughtConnections,
  listGraphEdgeTypes,
  listOpenBrainThoughts,
  searchGraphNodes,
  searchOpenBrainText,
  searchThoughts,
  type GraphNode,
  type OpenBrainMapThought,
} from './brain/client.js';
import { parseSearchText } from './brain/adapter.js';
import { checkStale, RUNTIME_BUILD_META, RUNTIME_STARTED_AT, shortSha } from './build-meta.js';
import { computeNextRun } from './scheduler.js';

const MAIN_AGENT_MODEL = 'claude-opus-4-7';
const DASHBOARD_AUTH_COOKIE = 'claudeclaw_dashboard';
let mainRestartQueued = false;

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

function dashboardCookieSecurityFlag(c: any): string {
  const forwardedProto = c.req.header('x-forwarded-proto') || '';
  const reqProtocol = new URL(c.req.url).protocol;
  return forwardedProto.split(',')[0]?.trim() === 'https' || reqProtocol === 'https:' ? '; Secure' : '';
}

function setDashboardAuthCookie(c: any): void {
  c.header(
    'Set-Cookie',
    `${DASHBOARD_AUTH_COOKIE}=${dashboardCookieValue()}; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400${dashboardCookieSecurityFlag(c)}`,
  );
}

function clearDashboardAuthCookie(c: any): void {
  c.header(
    'Set-Cookie',
    `${DASHBOARD_AUTH_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${dashboardCookieSecurityFlag(c)}`,
  );
}

function dashboardChatId(c: any): string {
  return c.req.query('chatId') || ALLOWED_CHAT_ID || '';
}

function htmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function safeDashboardNext(raw: string | null | undefined): string {
  if (!raw || !raw.startsWith('/')) return MISSION_CONTROL_V2 ? '/home' : '/v2/home';
  if (raw.startsWith('//')) return MISSION_CONTROL_V2 ? '/home' : '/v2/home';
  if (raw.startsWith('/api/') || raw === '/login' || raw.startsWith('/login?') || raw === '/logout') {
    return MISSION_CONTROL_V2 ? '/home' : '/v2/home';
  }
  return raw;
}

function renderDashboardLogin(next = '', error = ''): string {
  const safeNext = safeDashboardNext(next);
  const escapedError = htmlEscape(error);
  const escapedNext = htmlEscape(safeNext);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <title>ClaudeClaw Login</title>
  <style>
    :root { color-scheme: dark; --bg:#0e0e10; --card:#1a1a1c; --border:#2a2a30; --text:#e8e8e6; --muted:#9a9a98; --accent:#8b8af0; --danger:#ef4444; }
    * { box-sizing: border-box; }
    body { margin:0; min-height:100dvh; display:grid; place-items:center; padding:24px; background:var(--bg); color:var(--text); font-family: Inter, ui-sans-serif, system-ui, -apple-system, sans-serif; }
    main { width:min(420px, 100%); border:1px solid var(--border); background:var(--card); border-radius:8px; padding:24px; }
    h1 { margin:0 0 6px; font-size:22px; letter-spacing:0; }
    p { margin:0 0 18px; color:var(--muted); font-size:13px; line-height:1.45; }
    label { display:block; margin:0 0 6px; color:var(--muted); font-size:11px; text-transform:uppercase; letter-spacing:.08em; }
    input { width:100%; border:1px solid var(--border); background:#111114; color:var(--text); border-radius:6px; padding:11px 12px; font:inherit; }
    button { width:100%; margin-top:14px; border:0; border-radius:6px; padding:11px 12px; background:var(--accent); color:white; font:inherit; font-weight:700; cursor:pointer; }
    .error { margin:0 0 12px; color:var(--danger); font-size:13px; }
    .hint { margin-top:14px; margin-bottom:0; font-size:12px; }
  </style>
</head>
<body>
  <main>
    <h1>ClaudeClaw</h1>
    <p>Sign in to Mission Control. This stores access in an HttpOnly browser cookie so you can use the dashboard without keeping the token in the URL.</p>
    ${escapedError ? `<div class="error">${escapedError}</div>` : ''}
    <form method="post" action="/login">
      <input type="hidden" name="next" value="${escapedNext}" />
      <label for="token">Dashboard token</label>
      <input id="token" name="token" type="password" autocomplete="current-password" autofocus required />
      <button type="submit">Sign in</button>
    </form>
    <p class="hint">Use this on your phone through the secure tunnel, then bookmark the dashboard after login.</p>
  </main>
</body>
</html>`;
}

function resolveDashboardAvatar(agentId: string, context: 'default' | 'meet'): string | null {
  const mutablePath = agentId === 'main'
    ? path.join(STORE_DIR, 'avatars', 'main.png')
    : path.join(resolveAgentDir(agentId), 'avatar.png');
  if (fs.existsSync(mutablePath)) return mutablePath;
  const meetPath = path.join(PROJECT_ROOT, 'warroom', 'avatars', `${agentId}-meet.png`);
  if (context === 'meet' && fs.existsSync(meetPath)) return meetPath;
  const bundledPath = path.join(PROJECT_ROOT, 'warroom', 'avatars', `${agentId}.png`);
  if (fs.existsSync(bundledPath)) return bundledPath;
  return null;
}

function imageContentType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  return 'image/png';
}

function queueMainRestart(source: string): boolean {
  if (mainRestartQueued) return false;
  mainRestartQueued = true;
  logger.info({ source }, 'Main agent restart queued');

  if (process.env.VITEST === 'true' || process.env.NODE_ENV === 'test') {
    return true;
  }

  const timer = setTimeout(() => {
    logger.info({ source }, 'Main agent exiting for graceful restart');
    process.kill(process.pid, 'SIGTERM');
  }, 1_500);
  timer.unref?.();
  return true;
}

function configuredProviderValue(): string {
  return process.env.LLM_PROVIDER || readEnvFile(['LLM_PROVIDER']).LLM_PROVIDER || LLM_PROVIDER;
}

function providerSourceForAgent(agentId: string, config?: Pick<AgentConfig, 'provider'> | null): 'global' | 'explicit' | 'default' {
  if (agentId === 'main') return 'global';
  return config?.provider ? 'explicit' : 'default';
}

function configuredProviderForAgent(agentId: string, config?: Pick<AgentConfig, 'provider'> | null): string {
  // The global LLM_PROVIDER belongs to Sage/main only. Specialist agents
  // must opt into a non-Claude provider in their own agent.yaml; otherwise a
  // main-provider switch makes the entire roster appear to flip providers.
  return agentId === 'main' ? configuredProviderValue() : (config?.provider || 'claude');
}

function providerStatusForAgent(agentId: string, config?: Pick<AgentConfig, 'provider'> | null): { provider: LlmProviderName; configuredProvider: string; providerSource: 'global' | 'explicit' | 'default'; providerError: string | null } {
  const configuredProvider = configuredProviderForAgent(agentId, config);
  const providerSource = providerSourceForAgent(agentId, config);
  try {
    const activeProvider = agentId === 'main' ? normalizeLlmProvider(LLM_PROVIDER) : normalizeLlmProvider(configuredProvider);
    return { provider: activeProvider, configuredProvider, providerSource, providerError: null };
  } catch (err: any) {
    return {
      provider: 'claude',
      configuredProvider,
      providerSource,
      providerError: err?.recovery?.userMessage || err?.message || 'Unsupported LLM provider',
    };
  }
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

function inlineMarkdownToHtml(input: string): string {
  return escapeHtml(input)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
}

function markdownishToHtml(title: string, content: string): string {
  const lines = content.split(/\r?\n/);
  const out: string[] = [];
  let inList = false;
  const closeList = () => {
    if (inList) {
      out.push('</ul>');
      inList = false;
    }
  };

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) {
      closeList();
      continue;
    }
    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      closeList();
      const level = Math.min(heading[1].length + 1, 4);
      out.push(`<h${level}>${inlineMarkdownToHtml(heading[2])}</h${level}>`);
      continue;
    }
    const bullet = line.match(/^[-*]\s+(.+)$/);
    if (bullet) {
      if (!inList) {
        out.push('<ul>');
        inList = true;
      }
      out.push(`<li>${inlineMarkdownToHtml(bullet[1])}</li>`);
      continue;
    }
    closeList();
    out.push(`<p>${inlineMarkdownToHtml(line)}</p>`);
  }
  closeList();

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>${escapeHtml(title)}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #111827; line-height: 1.5; }
    h1 { font-size: 24px; margin: 0 0 16px; }
    h2 { font-size: 18px; margin: 20px 0 8px; }
    h3, h4 { font-size: 15px; margin: 16px 0 8px; }
    p { margin: 0 0 10px; }
    ul { margin: 0 0 12px 20px; padding: 0; }
    code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; background: #f3f4f6; padding: 1px 4px; border-radius: 4px; }
  </style>
</head>
<body>
  <h1>${escapeHtml(title)}</h1>
  ${out.join('\n')}
</body>
</html>`;
}

function summarizeMissionForEmail(task: MissionTask): string {
  const raw = task.result || task.error || 'No result text was recorded.';
  return raw
    .replace(/\[SEND_(?:FILE|PHOTO):[^\]]+\]/g, '')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/[#*_>`]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 900);
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
  const manifest = getMissionManifest(task);
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

  for (const deliverable of manifest.deliverables) {
    if (deliverable.kind === 'file') addFile(deliverable.target);
    else if (deliverable.kind === 'url') addUrl(deliverable.target);
  }

  const sendFileRe = /\[SEND_(?:FILE|PHOTO):([^\]|]+)(?:\|[^\]]*)?\]/g;
  let match: RegExpExecArray | null;
  while ((match = sendFileRe.exec(text))) addFile(match[1]);

  const quotedPathRe = /(?:^|[\s([{:])["'`]((?:~\/|\/Users\/|\/tmp\/|\/private\/tmp\/)[^"'`]+?)["'`]/g;
  while ((match = quotedPathRe.exec(text))) addFile(match[1]);

  const markdownPathRe = /\]\(((?:~\/|\/Users\/|\/tmp\/|\/private\/tmp\/)[^)]+)\)/g;
  while ((match = markdownPathRe.exec(text))) addFile(match[1]);

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

function deliverableEmailScore(item: ReviewDeliverable): number {
  if (item.kind !== 'file' || !item.exists || !item.target) return -1;
  const ext = path.extname(item.target).toLowerCase();
  const name = path.basename(item.target).toLowerCase();
  let score = 0;
  if (['.pdf', '.docx', '.xlsx', '.pptx', '.pages', '.numbers', '.key'].includes(ext)) score += 80;
  else if (['.md', '.html', '.htm', '.txt', '.rtf'].includes(ext)) score += 55;
  else if (['.png', '.jpg', '.jpeg', '.webp'].includes(ext)) score += 40;
  else score += 20;
  if (/(deliverable|final|draft|review|support|plan|closure|audit|response|letter|pack|charter|policy|report)/i.test(name)) score += 20;
  if (/(mission[-_ ]?report|transcript|log|stdout|stderr|debug)/i.test(name)) score -= 45;
  if (item.sizeBytes && item.sizeBytes > 1024) score += 5;
  return score;
}

function selectBestEmailDeliverable(task: MissionTask): ReviewDeliverable | null {
  return extractMissionDeliverables(task)
    .filter((item) => item.kind === 'file' && item.exists && item.target)
    .sort((a, b) => deliverableEmailScore(b) - deliverableEmailScore(a))[0] || null;
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
  return `${task.result || ''}\n${task.error || ''}`;
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
const NO_HUMAN_ACTION_PATTERN = /\b(?:no|none|without)\s+(?:human\s+|manual\s+|your\s+|ruan\s+)?(?:action|review|approval|follow[- ]?up|intervention)\s+(?:required|needed|pending)|\bno\s+(?:deliverable|human action|manual action|review)\b/i;

function containsHumanActionSignal(task: MissionTask): boolean {
  const text = reviewOutcomeText(task);
  if (NO_HUMAN_ACTION_PATTERN.test(text)) return false;
  return HUMAN_ACTION_PATTERN.test(text);
}

// Intent-based deliverable detector. No agent exclusion — a mason or warden
// completion that produced a deliverable Ruan needs to review still counts.
// (2026-05-06: removed the hard mason/warden exclusion that was filtering
// 32/34 completions out of the inbox.)
function isNonDevDeliverable(task: MissionTask): boolean {
  if (NO_HUMAN_ACTION_PATTERN.test(reviewOutcomeText(task))) return false;
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
  return missionAgeHours(task) <= 24 * 14;
}

function defaultReviewStatusForTask(task: MissionTask, missions: MissionTask[]): MissionReviewStatus | null {
  const manifest = getMissionManifest(task);
  if (task.status === 'failed' || task.status === 'partial') {
    // Failures and partials are never routine history. They are the loop
    // breakages Ruan needs surfaced so he can retry, redirect, or archive.
    // Keep ancient internal agent noise out unless the lineage is Ruan-facing.
    return (isRecentActionableFailure(task) || originatedFromUser(task, missions)) ? 'needs_triage' : null;
  }
  if (task.status === 'completed') {
    if (completedMissionHasFollowUp(task, missions)) return null;
    if (manifest.route === 'needs_triage') return 'needs_triage';
    if (manifest.route === 'needs_review') return 'needs_review';
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
    const next = upsertMissionReview({
      taskId: review.task_id,
      reviewStatus: 'resolved',
      resolution: 'followup_completed',
      followupTaskId: followup.id,
      instruction: review.instruction,
    });
    closeTerminalMissionAttention(review.task_id, 'resolved');
    return next;
  }
  const next = upsertMissionReview({
    taskId: review.task_id,
    reviewStatus: 'needs_triage',
    resolution: 'retried',
    followupTaskId: followup.id,
    instruction: review.instruction,
  });
  reopenTerminalMissionAttention(review.task_id);
  return next;
}

function effectiveMissionReview(task: MissionTask, missions: MissionTask[]): MissionReview | null {
  const existing = getMissionReview(task.id);
  if (existing) {
    const refreshed = refreshReviewFromFollowup(existing);
    if (
      shouldShowReview(refreshed)
      && refreshed.review_status !== 'waiting_followup'
      && completedMissionHasFollowUp(task, missions)
    ) {
      return null;
    }
    return refreshed;
  }

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
    const manifest = getMissionManifest(task);
    if (manifest.route === 'needs_review' || manifest.route === 'needs_triage') return 'needs_action';
    if (containsHumanActionSignal(task)) return 'needs_action';
    if (isNonDevDeliverable(task)) return 'needs_action';
    if (isSortedCompletion(task, missions)) return 'sorted';
  }
  return 'needs_action';
}

function reviewWhyText(task: MissionTask, review: MissionReview, missions: MissionTask[]): string {
  const manifest = getMissionManifest(task);
  if (task.status === 'failed') return 'Mission failed, so it needs triage before the loop can close.';
  if (task.status === 'partial') return 'Mission landed partial work, so it needs review or follow-up.';
  if (review.review_status === 'waiting_followup') return 'A follow-up mission was dispatched and this parent is waiting for that result.';
  if (manifest.route === 'needs_triage') return 'The mission manifest explicitly routed this item to triage.';
  if (manifest.route === 'needs_review') return 'The mission manifest explicitly routed this item for review.';
  if (containsHumanActionSignal(task)) return 'The result contains a human-action signal such as approval, review, sending, signing, or a manual step.';
  if (isNonDevDeliverable(task)) return 'The mission produced a deliverable or handoff that should be checked before closure.';
  if (isSortedCompletion(task, missions)) return 'This is a Ruan-originated completion. It is shown as sorted so you can see it landed, then archive it.';
  return 'This item has an open review state.';
}

function buildReviewItem(task: MissionTask, review: MissionReview, missions: MissionTask[]) {
  const text = task.result || task.error || '';
  const manifest = getMissionManifest(task);
  return {
    id: task.id,
    title: task.title,
    agentId: task.assigned_agent,
    status: task.status,
    priority: task.priority,
    createdAt: task.created_at,
    completedAt: task.completed_at,
    summary: text.replace(/\s+/g, ' ').trim().slice(0, 260),
    why: reviewWhyText(task, review, missions),
    result: task.result,
    error: task.error,
    kind: reviewItemKind(task, missions),
    manifest,
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

type ReviewEmailAttachment = {
  path: string;
  format: string;
  source: 'deliverable' | 'report';
  label: string;
  originalPath?: string;
};

async function createTextDeliverableExport(
  task: MissionTask,
  filePath: string,
  format: 'docx' | 'html',
): Promise<ReviewEmailAttachment> {
  fs.mkdirSync(REVIEW_EXPORT_DIR, { recursive: true, mode: 0o700 });
  const slug = sanitizeExportSlug(path.basename(filePath, path.extname(filePath)) || task.title);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const htmlPath = path.join(REVIEW_EXPORT_DIR, `${slug}-${task.id}-${stamp}.html`);
  const content = fs.readFileSync(filePath, 'utf-8');
  fs.writeFileSync(htmlPath, markdownishToHtml(path.basename(filePath), content), { encoding: 'utf-8', mode: 0o600 });

  if (format === 'html') {
    return { path: htmlPath, format: 'html', source: 'deliverable', label: path.basename(htmlPath), originalPath: filePath };
  }

  const docxPath = htmlPath.replace(/\.html$/, '.docx');
  try {
    const { safeExecFileAsync } = await import('./safe-spawn.js');
    await safeExecFileAsync('textutil', ['-convert', 'docx', '-output', docxPath, htmlPath], {
      envClass: 'system-tool',
      timeout: 30_000,
    });
    if (fs.existsSync(docxPath)) {
      return { path: docxPath, format: 'docx', source: 'deliverable', label: path.basename(docxPath), originalPath: filePath };
    }
  } catch {
    // Fall back to formatted HTML on systems without textutil conversion support.
  }

  return { path: htmlPath, format: 'html', source: 'deliverable', label: path.basename(htmlPath), originalPath: filePath };
}

export async function createReviewEmailAttachment(
  task: MissionTask,
  format: 'docx' | 'html' = 'docx',
): Promise<ReviewEmailAttachment> {
  const deliverable = selectBestEmailDeliverable(task);

  if (deliverable) {
    const filePath = deliverable.target;
    const ext = path.extname(filePath).toLowerCase();
    if (['.md', '.txt', '.html', '.htm'].includes(ext)) {
      return createTextDeliverableExport(task, filePath, format);
    }
    return {
      path: filePath,
      format: ext.replace(/^\./, '') || 'file',
      source: 'deliverable',
      label: path.basename(filePath),
      originalPath: filePath,
    };
  }

  const exported = await createMissionTaskExport(task, format);
  return {
    ...exported,
    source: 'report',
    label: path.basename(exported.path),
  };
}

async function sendMissionTaskExportEmail(task: MissionTask, to: string, from: string, attachment: ReviewEmailAttachment): Promise<void> {
  const graphEnv = readEnvFile([
    'GRAPH_CLIENT_ID',
    'GRAPH_TENANT_ID',
    'GRAPH_CLIENT_SECRET',
    'GRAPH_REFRESH_TOKEN',
    'MSGRAPH_FORBIDDEN_FROM_EMAILS',
  ]);
  const bodyPath = path.join(REVIEW_EXPORT_DIR, `${sanitizeExportSlug(task.title)}-${task.id}.email.html`);
  const summary = summarizeMissionForEmail(task);
  const attachmentLabel = attachment.source === 'deliverable'
    ? `actual deliverable: ${attachment.label}`
    : `mission report: ${attachment.label}`;
  const body = `<p>Attached is the ${escapeHtml(attachmentLabel)} from Mission Control.</p>
<p><strong>${escapeHtml(task.title)}</strong><br>
Mission ${escapeHtml(task.id)} · ${escapeHtml(task.assigned_agent || 'unassigned')} · ${escapeHtml(task.status)}</p>
<p><strong>Quick summary</strong><br>${escapeHtml(summary)}</p>`;
  fs.writeFileSync(bodyPath, body, { encoding: 'utf-8', mode: 0o600 });

  const { safeExecFileAsync } = await import('./safe-spawn.js');
  await safeExecFileAsync('python3', [
    MSGRAPH_SEND_SCRIPT,
    '--to', to,
    '--from', from,
    '--subject', `Mission deliverable: ${task.title}`,
    '--body-file', bodyPath,
    '--html',
    '--attach', attachment.path,
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

function openBrainGraphConfigured(): boolean {
  return openBrainConfigured() && !!OB1_GRAPH_FUNCTION;
}

function openBrainConfigState() {
  const missing = [
    BRAIN === 'ob1' ? '' : 'BRAIN=ob1',
    OB1_SUPABASE_URL ? '' : 'OB1_SUPABASE_URL',
    MCP_ACCESS_KEY ? '' : 'MCP_ACCESS_KEY',
    OB1_BRAIN_FUNCTION ? '' : 'OB1_BRAIN_FUNCTION',
  ].filter(Boolean);
  return {
    active: BRAIN === 'ob1',
    configured: missing.length === 0,
    ready: BRAIN === 'ob1' && missing.length === 0,
    graphFunctionName: OB1_GRAPH_FUNCTION,
    graphConfigured: missing.length === 0 && !!OB1_GRAPH_FUNCTION,
    missing,
  };
}

function confidenceFromMemory(memory: { importance: number; salience: number }): number {
  return Math.max(0.1, Math.min(0.99, ((memory.importance || 0.5) * 0.65) + (Math.min(memory.salience || 1, 5) / 5) * 0.35));
}

function localBrainSearch(chatId: string, query: string, limit: number) {
  return searchMemories(chatId, query, limit).map((memory) => ({
    match: `${Math.round(confidenceFromMemory(memory) * 100)}% local`,
    date: memory.created_at ? new Date(memory.created_at * 1000).toISOString().slice(0, 10) : '',
    type: memory.source,
    source: memory.source,
    confidence: confidenceFromMemory(memory),
    topics: safeJsonArray(memory.topics),
    people: safeJsonArray(memory.entities),
    content: memory.summary || memory.raw_text,
    rawPreview: (memory.raw_text || '').slice(0, 500),
  }));
}

function safeJsonArray(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String).filter(Boolean) : [];
  } catch {
    return [];
  }
}

function summarizeForBrain(text: string, limit = 220): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, limit);
}

function saveLocalBrainCapture(chatId: string, content: string, source = 'dashboard_capture', topics: string[] = ['openbrain']): number {
  return saveStructuredMemory(
    chatId,
    content,
    summarizeForBrain(content),
    [],
    topics,
    0.75,
    source,
    AGENT_ID,
  );
}

function collectBrainIngestionCandidates(chatId: string) {
  const missionCandidates: Array<{ source: string; summary: string; content: string; topics: string[]; confidence: number }> = [];
  const briefCandidates: Array<{ source: string; summary: string; content: string; topics: string[]; confidence: number }> = [];
  const decisionCandidates: Array<{ source: string; summary: string; content: string; topics: string[]; confidence: number }> = [];
  for (const task of getMissionTaskHistory(8, 0).tasks) {
    const manifest = getMissionManifest(task);
    if (manifest.route === 'done' && !manifest.summary) continue;
    missionCandidates.push({
      source: 'mission_manifest',
      summary: `Mission ${task.id}: ${task.title} -> ${manifest.route}`,
      content: [
        `Mission: ${task.title}`,
        `Status: ${task.status}`,
        `Route: ${manifest.route}`,
        `Summary: ${manifest.summary}`,
        manifest.nextAction ? `Next action: ${manifest.nextAction}` : '',
        manifest.blockers.length ? `Blockers: ${manifest.blockers.join('; ')}` : '',
        manifest.deliverables.length ? `Deliverables: ${manifest.deliverables.map((d) => `${d.label} ${d.target}`).join('; ')}` : '',
      ].filter(Boolean).join('\n'),
      topics: ['mission', manifest.route, task.assigned_agent || 'unassigned'],
      confidence: task.status === 'completed' ? 0.82 : 0.68,
    });
  }

  for (const task of getAllScheduledTasks()) {
    if (!task.last_result || !briefSlot(task)) continue;
    const actions = extractStructuredBriefActions(task.last_result, 8);
    if (actions.length === 0 && !/(decision|decided|blocked|risk|priority|handoff|action)/i.test(task.last_result)) continue;
    briefCandidates.push({
      source: 'brief_output',
      summary: `${briefLabel(briefSlot(task)!)} brief: ${actions.length} structured action${actions.length === 1 ? '' : 's'}`,
      content: [
        `Scheduled task: ${scheduleTitle(task.prompt)}`,
        `Last status: ${task.last_status || 'unknown'}`,
        actions.length ? `Actions:\n${actions.map((a) => `- [${a.severity}] ${a.detail}`).join('\n')}` : '',
        `Output:\n${task.last_result.slice(0, 2500)}`,
      ].filter(Boolean).join('\n'),
      topics: ['brief', briefSlot(task)!, 'attention'],
      confidence: actions.some((a) => a.confidence >= 0.8) ? 0.78 : 0.58,
    });
  }

  const decisionsDir = path.join(PROJECT_ROOT, '..', 'workspace', 'decisions');
  if (fs.existsSync(decisionsDir)) {
    const files = fs.readdirSync(decisionsDir).filter((f) => /\.md$/i.test(f)).slice(0, 80);
    for (const file of files) {
      const full = path.join(decisionsDir, file);
      try {
        const content = fs.readFileSync(full, 'utf-8').slice(0, 5000);
        decisionCandidates.push({
          source: 'decision',
          summary: `Decision: ${file.replace(/\.md$/i, '')}`,
          content: `Source: ${full}\n${content}`,
          topics: ['decision', 'architecture'],
          confidence: 0.9,
        });
      } catch {
        // skip unreadable decisions
      }
    }
  }

  return [
    ...missionCandidates.slice(0, 20),
    ...briefCandidates.slice(0, 10),
    ...decisionCandidates.slice(0, 20),
  ]
    .filter((candidate) => !memoryExistsBySourceAndSummary(chatId, candidate.source, candidate.summary))
    .slice(0, 50);
}

type GraphCandidateNode = {
  key: string;
  label: string;
  type: string;
  properties: Record<string, unknown>;
};

type GraphCandidateEdge = {
  sourceKey: string;
  targetKey: string;
  relationship: string;
  weight: number;
  properties: Record<string, unknown>;
};

type WholeBrainGraphNode = {
  id: string;
  label: string;
  kind: 'database' | 'type' | 'source' | 'topic' | 'person' | 'time' | 'sensitivity';
  count: number;
  score: number;
  sampleThoughtIds: string[];
  metadata: Record<string, unknown>;
};

type WholeBrainGraphEdge = {
  source: string;
  target: string;
  relationship: string;
  weight: number;
  count: number;
};

type WholeBrainThoughtPoint = {
  id: string;
  clusterIds: string[];
  primaryKind: WholeBrainGraphNode['kind'];
  score: number;
  label: string;
  type: string;
  sourceType: string;
  createdAt: string;
  topics: string[];
  people: string[];
};

function addGraphNode(nodes: Map<string, GraphCandidateNode>, node: GraphCandidateNode): void {
  if (!nodes.has(node.key)) nodes.set(node.key, node);
}

function metadataStringArray(metadata: Record<string, unknown>, key: string): string[] {
  const value = metadata?.[key];
  if (!Array.isArray(value)) return [];
  return value.map(String).map((item) => item.trim()).filter(Boolean).slice(0, 20);
}

function monthBucket(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return 'unknown date';
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

function bumpWholeBrainNode(
  nodes: Map<string, WholeBrainGraphNode>,
  id: string,
  label: string,
  kind: WholeBrainGraphNode['kind'],
  thoughtId: string,
  score: number,
  metadata: Record<string, unknown> = {},
): void {
  const existing = nodes.get(id);
  if (existing) {
    existing.count++;
    existing.score += score;
    if (existing.sampleThoughtIds.length < 8) existing.sampleThoughtIds.push(thoughtId);
    return;
  }
  nodes.set(id, {
    id,
    label,
    kind,
    count: 1,
    score,
    sampleThoughtIds: [thoughtId],
    metadata,
  });
}

function edgeKey(source: string, target: string, relationship: string): string {
  return `${source}::${relationship}::${target}`;
}

function bumpWholeBrainEdge(
  edges: Map<string, WholeBrainGraphEdge>,
  source: string,
  target: string,
  relationship: string,
  weight = 1,
): void {
  if (source === target) return;
  const key = edgeKey(source, target, relationship);
  const existing = edges.get(key);
  if (existing) {
    existing.count++;
    existing.weight += weight;
    return;
  }
  edges.set(key, { source, target, relationship, weight, count: 1 });
}

function wholeBrainPointLabel(thought: OpenBrainMapThought, type: string, source: string): string {
  const metadata = thought.metadata || {};
  const candidates = [
    metadata.title,
    metadata.summary,
    metadata.label,
    metadata.name,
    metadata.subject,
  ];
  for (const value of candidates) {
    if (typeof value === 'string' && value.trim()) return value.trim().slice(0, 160);
  }
  return `${type || 'thought'} from ${source || 'unknown source'}`;
}

async function buildWholeOpenBrainGraph() {
  const map = await getOpenBrainMap(10_000);
  const nodes = new Map<string, WholeBrainGraphNode>();
  const edges = new Map<string, WholeBrainGraphEdge>();
  const points: WholeBrainThoughtPoint[] = [];
  const rootId = 'database:ob1';
  nodes.set(rootId, {
    id: rootId,
    label: 'OB1 Database',
    kind: 'database',
    count: map.represented,
    score: map.represented,
    sampleThoughtIds: [],
    metadata: {
      total: map.total,
      represented: map.represented,
      truncated: map.truncated,
      coverage: map.total ? map.represented / map.total : 1,
    },
  });

  for (const thought of map.thoughts) {
    const score = Number(thought.importance ?? 1) + Number(thought.quality_score ?? 0) / 50;
    const type = thought.type || String(thought.metadata?.type || 'unknown');
    const source = thought.source_type || String(thought.metadata?.source || 'unknown');
    const sensitivity = thought.sensitivity_tier || 'standard';
    const month = monthBucket(thought.created_at);
    const topics = metadataStringArray(thought.metadata, 'topics');
    const people = metadataStringArray(thought.metadata, 'people');
    const nodeIds: string[] = [];
    const add = (id: string, label: string, kind: WholeBrainGraphNode['kind'], metadata: Record<string, unknown> = {}) => {
      bumpWholeBrainNode(nodes, id, label, kind, thought.id, score, metadata);
      nodeIds.push(id);
    };

    add(`type:${type}`, type, 'type');
    add(`source:${source}`, source, 'source');
    add(`sensitivity:${sensitivity}`, sensitivity, 'sensitivity');
    add(`time:${month}`, month, 'time');
    for (const topic of topics) add(`topic:${topic.toLowerCase()}`, topic, 'topic');
    for (const person of people) add(`person:${person.toLowerCase()}`, person, 'person');

    for (const id of nodeIds) bumpWholeBrainEdge(edges, rootId, id, 'contains', 1);
    for (let i = 0; i < nodeIds.length; i++) {
      for (let j = i + 1; j < nodeIds.length; j++) {
        bumpWholeBrainEdge(edges, nodeIds[i], nodeIds[j], 'co_occurs_in_thought', 1);
      }
    }
    const primaryId = nodeIds.find((id) => id.startsWith('topic:'))
      || nodeIds.find((id) => id.startsWith('source:'))
      || nodeIds.find((id) => id.startsWith('type:'))
      || nodeIds[0]
      || rootId;
    points.push({
      id: thought.id,
      clusterIds: [primaryId, ...nodeIds.filter((id) => id !== primaryId).slice(0, 8)],
      primaryKind: nodes.get(primaryId)?.kind || 'database',
      score,
      label: wholeBrainPointLabel(thought, type, source),
      type,
      sourceType: source,
      createdAt: thought.created_at,
      topics: topics.slice(0, 8),
      people: people.slice(0, 8),
    });
  }

  const sortedNodes = [...nodes.values()].sort((a, b) => {
    if (a.kind === 'database') return -1;
    if (b.kind === 'database') return 1;
    return b.count - a.count || a.label.localeCompare(b.label);
  });
  const visibleNodeIds = new Set([
    rootId,
    ...sortedNodes.filter((node) => node.kind !== 'database').slice(0, 260).map((node) => node.id),
  ]);
  const visibleEdges = [...edges.values()]
    .filter((edge) => visibleNodeIds.has(edge.source) && visibleNodeIds.has(edge.target))
    .sort((a, b) => b.count - a.count || b.weight - a.weight)
    .slice(0, 600);

  return {
    ok: true,
    source: 'ob1-thoughts',
    total: map.total,
    represented: map.represented,
    truncated: map.truncated,
    coverage: map.total ? map.represented / map.total : 1,
    nodes: sortedNodes.filter((node) => visibleNodeIds.has(node.id)),
    edges: visibleEdges,
    points,
    hiddenNodes: Math.max(0, sortedNodes.length - visibleNodeIds.size),
    generatedAt: new Date().toISOString(),
  };
}

function missionGraphRoute(task: MissionTask): string {
  try {
    return getMissionManifest(task).route;
  } catch {
    return task.status;
  }
}

function collectOpenBrainGraphCandidates(): { nodes: GraphCandidateNode[]; edges: GraphCandidateEdge[] } {
  const nodes = new Map<string, GraphCandidateNode>();
  const edges: GraphCandidateEdge[] = [];

  addGraphNode(nodes, {
    key: 'system:claudeclaw',
    label: 'ClaudeClaw OS',
    type: 'system',
    properties: { source: 'mission-control', stableKey: 'system:claudeclaw' },
  });
  addGraphNode(nodes, {
    key: 'workflow:review-inbox',
    label: 'Review Inbox',
    type: 'workflow',
    properties: { source: 'mission-control', stableKey: 'workflow:review-inbox' },
  });
  addGraphNode(nodes, {
    key: 'workflow:needs-attention',
    label: 'Needs Attention',
    type: 'workflow',
    properties: { source: 'mission-control', stableKey: 'workflow:needs-attention' },
  });

  for (const task of getMissionTaskHistory(80, 0).tasks) {
    const missionKey = `mission:${task.id}`;
    const agentKey = `agent:${task.assigned_agent || 'unassigned'}`;
    const route = missionGraphRoute(task);
    addGraphNode(nodes, {
      key: missionKey,
      label: `Mission: ${task.title}`,
      type: 'mission',
      properties: {
        source: 'mission-control',
        stableKey: missionKey,
        missionId: task.id,
        status: task.status,
        route,
        priority: task.priority,
        createdAt: task.created_at,
        completedAt: task.completed_at,
      },
    });
    addGraphNode(nodes, {
      key: agentKey,
      label: task.assigned_agent ? `Agent: ${task.assigned_agent}` : 'Agent: unassigned',
      type: 'agent',
      properties: { source: 'mission-control', stableKey: agentKey, agentId: task.assigned_agent || 'unassigned' },
    });
    edges.push({
      sourceKey: 'system:claudeclaw',
      targetKey: missionKey,
      relationship: 'runs_mission',
      weight: 0.9,
      properties: { source: 'mission-control', missionId: task.id },
    });
    edges.push({
      sourceKey: missionKey,
      targetKey: agentKey,
      relationship: 'assigned_to',
      weight: 1,
      properties: { source: 'mission-control', missionId: task.id },
    });

    const manifest = getMissionManifest(task);
    if (manifest.route === 'needs_review' || manifest.route === 'needs_triage') {
      edges.push({
        sourceKey: missionKey,
        targetKey: 'workflow:review-inbox',
        relationship: 'requires_review_in',
        weight: 0.95,
        properties: { source: 'mission-control', missionId: task.id, route: manifest.route },
      });
    }
    if (task.status === 'failed' || task.status === 'partial') {
      edges.push({
        sourceKey: missionKey,
        targetKey: 'workflow:needs-attention',
        relationship: 'surfaces_attention_in',
        weight: 0.9,
        properties: { source: 'mission-control', missionId: task.id, status: task.status },
      });
    }
    for (const deliverable of manifest.deliverables.slice(0, 6)) {
      const target = deliverable.target || deliverable.label;
      const deliverableKey = `deliverable:${crypto.createHash('sha1').update(target).digest('hex').slice(0, 16)}`;
      addGraphNode(nodes, {
        key: deliverableKey,
        label: `Deliverable: ${path.basename(target) || deliverable.label}`,
        type: 'deliverable',
        properties: {
          source: 'mission-control',
          stableKey: deliverableKey,
          missionId: task.id,
          kind: deliverable.kind,
          target,
          label: deliverable.label,
        },
      });
      edges.push({
        sourceKey: missionKey,
        targetKey: deliverableKey,
        relationship: 'produced_deliverable',
        weight: 1,
        properties: { source: 'mission-control', missionId: task.id, kind: deliverable.kind },
      });
    }
  }

  for (const item of listOpenAttentionItems(6)) {
    const attentionKey = `attention:${item.id}`;
    addGraphNode(nodes, {
      key: attentionKey,
      label: `Attention: ${item.title}`,
      type: 'attention',
      properties: {
        source: 'mission-control',
        stableKey: attentionKey,
        attentionId: item.id,
        sourceKind: item.source_kind,
        sourceId: item.source_id,
        severity: item.severity,
        status: item.status,
      },
    });
    edges.push({
      sourceKey: attentionKey,
      targetKey: 'workflow:needs-attention',
      relationship: 'visible_in',
      weight: 0.95,
      properties: { source: 'mission-control', attentionId: item.id },
    });
    if (item.linked_mission_id) {
      const missionKey = `mission:${item.linked_mission_id}`;
      edges.push({
        sourceKey: attentionKey,
        targetKey: missionKey,
        relationship: 'follows_from_mission',
        weight: 0.9,
        properties: { source: 'mission-control', attentionId: item.id, missionId: item.linked_mission_id },
      });
    }
  }

  return { nodes: [...nodes.values()], edges };
}

async function ensureGraphNode(node: GraphCandidateNode): Promise<{ node: GraphNode; created: boolean }> {
  const existing = await searchGraphNodes({ query: node.label, node_type: node.type, limit: 25 });
  const exact = (existing.nodes || []).find((candidate) =>
    candidate.label === node.label
    && candidate.node_type === node.type
    && (candidate.properties as any)?.stableKey === node.key,
  );
  if (exact) return { node: exact, created: false };
  const created = await createGraphNode({
    label: node.label,
    node_type: node.type,
    properties: node.properties,
  });
  return { node: created.node, created: true };
}

async function ingestOpenBrainGraph(): Promise<{ nodesCreated: number; edgesCreated: number; edgesSkipped: number; errors: string[] }> {
  const candidates = collectOpenBrainGraphCandidates();
  const resolved = new Map<string, GraphNode>();
  let nodesCreated = 0;
  let edgesCreated = 0;
  let edgesSkipped = 0;
  const errors: string[] = [];

  for (const node of candidates.nodes.slice(0, 32)) {
    try {
      const result = await ensureGraphNode(node);
      resolved.set(node.key, result.node);
      if (result.created) nodesCreated++;
    } catch (err: any) {
      errors.push(`node ${node.label}: ${err?.message || String(err)}`);
      if (errors.length >= 5) return { nodesCreated, edgesCreated, edgesSkipped, errors };
    }
  }

  for (const edge of candidates.edges.slice(0, 48)) {
    const source = resolved.get(edge.sourceKey);
    const target = resolved.get(edge.targetKey);
    if (!source || !target) {
      edgesSkipped++;
      continue;
    }
    try {
      await createGraphEdge({
        source_node_id: source.id,
        target_node_id: target.id,
        relationship_type: edge.relationship,
        weight: edge.weight,
        properties: edge.properties,
      });
      edgesCreated++;
    } catch (err: any) {
      if (/duplicate key value|unique_edge/i.test(err?.message || String(err))) {
        edgesSkipped++;
        continue;
      }
      errors.push(`edge ${edge.relationship}: ${err?.message || String(err)}`);
      if (errors.length >= 5) break;
    }
  }

  return { nodesCreated, edgesCreated, edgesSkipped, errors };
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

interface StructuredBriefAction {
  title: string;
  detail: string;
  severity: AttentionSeverity;
  sourceCategory: string;
  confidence: number;
  suggestedAgent?: string | null;
  due?: string | null;
  requiresRuan?: boolean;
}

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

function isNonActionBriefLine(cleaned: string): boolean {
  if (/:\s*$/.test(cleaned)) return true;
  if (/^(action needed|blocked on you|open threads|stale|breakdown|notes|projects|compliance|calendar|inbox|today|tomorrow top 3):?$/i.test(cleaned)) return true;
  if (/^(items blocked\/awaiting|total unread|after triage|skipped):/i.test(cleaned)) return true;
  if (/^(urgent|overdue|blocked|awaiting|needs|actions?|risks?|review|follow.?up|open threads|auth|permissions?):\s*(none|nil|n\/a|no(?:\s+(?:urgent\s+)?(?:blockers?|risks?|actions?|follow.?ups?|reviews?|items?))?|0)(\.|$)/i.test(cleaned)) return true;
  if (/^(no|none)\s+(urgent|overdue|blocked|awaiting|open|review|follow.?up|action|actions|risks?)/i.test(cleaned)) return true;
  return false;
}

function actionableBriefDetail(cleaned: string): string {
  if (!/^(inbox|calendar|today|overdue|actions?|follow.?up):\s*/i.test(cleaned)) return cleaned;
  const parts = cleaned.split(/(?<=\.)\s+/).map((part) => part.trim()).filter(Boolean);
  const actionable = parts.find((part) =>
    /has(?: not|n't) been actioned|needs|action|follow.?up|awaiting|blocked|review|approve|failed|missing|error|permission|auth/i.test(part)
    && !isNonActionBriefLine(part),
  );
  if (!actionable) return cleaned;
  return actionable.replace(/^(inbox|calendar|today|overdue|actions?|follow.?up):\s*/i, '').trim();
}

function normalizeStructuredAction(input: any): StructuredBriefAction | null {
  if (!input || typeof input !== 'object') return null;
  const rawTitle = typeof input.title === 'string' ? input.title.trim() : '';
  const rawDetail = typeof input.detail === 'string' ? input.detail.trim()
    : typeof input.action === 'string' ? input.action.trim()
      : typeof input.summary === 'string' ? input.summary.trim()
        : '';
  if (!rawDetail || isNonActionBriefLine(rawDetail)) return null;
  const category = typeof input.sourceCategory === 'string' ? input.sourceCategory.trim()
    : typeof input.category === 'string' ? input.category.trim()
      : 'brief';
  const severityRaw = typeof input.severity === 'string' ? input.severity.toLowerCase() : '';
  const severity: AttentionSeverity = severityRaw === 'high' || severityRaw === 'medium' || severityRaw === 'low'
    ? severityRaw
    : severityForText(rawDetail);
  const confidence = typeof input.confidence === 'number' && Number.isFinite(input.confidence)
    ? Math.max(0, Math.min(1, input.confidence))
    : 0.8;
  const suggestedAgentRaw = typeof input.suggested_agent === 'string' ? input.suggested_agent.trim()
    : typeof input.suggestedAgent === 'string' ? input.suggestedAgent.trim()
      : '';
  const suggestedAgent = suggestedAgentRaw && !/^null$/i.test(suggestedAgentRaw) ? suggestedAgentRaw : null;
  const dueRaw = typeof input.due === 'string' ? input.due.trim()
    : typeof input.due_at === 'string' ? input.due_at.trim()
      : typeof input.dueAt === 'string' ? input.dueAt.trim()
        : '';
  const due = dueRaw && !/^null$/i.test(dueRaw) ? dueRaw : null;
  const requiresRuan = typeof input.requires_ruan === 'boolean' ? input.requires_ruan
    : typeof input.requiresRuan === 'boolean' ? input.requiresRuan
      : undefined;
  return {
    title: rawTitle || category || 'Brief action',
    detail: rawDetail.length > 900 ? `${rawDetail.slice(0, 897)}...` : rawDetail,
    severity,
    sourceCategory: category || 'brief',
    confidence,
    suggestedAgent,
    due,
    requiresRuan,
  };
}

function extractJsonBriefActions(text: string): StructuredBriefAction[] {
  const candidates: string[] = [];
  for (const match of text.matchAll(/```(?:json)?\s*ATTENTION_ACTIONS\s*([\s\S]*?)```/gi)) {
    candidates.push(match[1].trim());
  }
  for (const match of text.matchAll(/ATTENTION_ACTIONS\s*:\s*(\[[\s\S]*?\])/gi)) {
    candidates.push(match[1].trim());
  }

  const out: StructuredBriefAction[] = [];
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      const rows = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.actions) ? parsed.actions : [];
      for (const row of rows) {
        const action = normalizeStructuredAction(row);
        if (action) out.push(action);
      }
    } catch {
      // Fall back to line extraction below.
    }
  }
  return out;
}

function extractStructuredBriefActions(text: string, limit = 4): StructuredBriefAction[] {
  const explicit = extractJsonBriefActions(text);
  if (explicit.length > 0) return explicit.slice(0, limit);

  const out: StructuredBriefAction[] = [];
  const seen = new Set<string>();

  for (const line of text.split(/\r?\n/)) {
    const cleaned = line
      .replace(/^[-*•☐\d.)\s]+/, '')
      .replace(/\*\*/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!cleaned || /^OK$/i.test(cleaned)) continue;
    if (isNonActionBriefLine(cleaned)) continue;
    if (!/urgent|overdue|blocked|awaiting|needs|action|failed|missing|error|risk|review|approve|follow.?up|due|tomorrow top|open threads|auth|expired|lapsed|consent|unavailable|re-auth|permission/i.test(cleaned)) continue;
    const detail = actionableBriefDetail(cleaned);
    if (!detail || isNonActionBriefLine(detail)) continue;
    const key = detail.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      title: 'Brief action',
      detail: detail.length > 900 ? `${detail.slice(0, 897)}...` : detail,
      severity: severityForText(detail),
      sourceCategory: (cleaned.match(/^([^:]{2,32}):/)?.[1] || 'brief').toLowerCase(),
      confidence: 0.55,
    });
    if (out.length >= limit) break;
  }

  return out;
}

function extractAttentionItems(text: string, limit = 4): string[] {
  return extractStructuredBriefActions(text, limit).map((action) => action.detail);
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

function displayDetailForStructuredAction(action: StructuredBriefAction): string {
  const meta: string[] = [];
  if (action.suggestedAgent) meta.push(`Suggested agent: @${action.suggestedAgent.replace(/^@/, '')}`);
  if (action.due) meta.push(`Due: ${action.due}`);
  if (typeof action.requiresRuan === 'boolean') meta.push(`Requires Ruan: ${action.requiresRuan ? 'yes' : 'no'}`);
  if (meta.length > 0) meta.push(`Confidence: ${Math.round(action.confidence * 100)}%`);
  const detail = meta.length > 0 ? `${action.detail}\n${meta.join(' · ')}` : action.detail;
  return detail.length > 1000 ? `${detail.slice(0, 997)}...` : detail;
}

function syncReportAttentionItems(tasks: ScheduledTask[], missions: MissionTask[]): void {
  for (const brief of buildHomeBriefs(tasks)) {
    if (!brief) continue;
    const currentSourceKeys = new Set<string>();
    for (const action of extractStructuredBriefActions(brief.content)) {
      const detail = action.detail;
      const sourceKey = attentionSourceKey('brief', brief.taskId, `${action.sourceCategory}:${detail}`);
      currentSourceKeys.add(sourceKey);
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
        detail: displayDetailForStructuredAction(action),
        severity: action.severity,
        href: '/home',
      });
    }
    for (const stale of listOpenAttentionItems(200)) {
      if (stale.source_kind !== 'brief' || stale.source_id !== brief.taskId) continue;
      if (!currentSourceKeys.has(stale.source_key)) updateAttentionStatus(stale.id, 'archived');
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

function terminalMissionAttentionDetail(mission: MissionTask): string {
  const manifest = getMissionManifest(mission);
  const blocker = manifest.blockers.find(Boolean);
  if (blocker) return blocker.length > 700 ? `${blocker.slice(0, 697)}...` : blocker;
  if (mission.status === 'partial') return manifest.nextAction || 'Mission landed partial work and needs review.';
  return mission.error || manifest.summary || 'Mission failed and needs triage.';
}

function syncTerminalMissionAttentionItems(missions: MissionTask[]): void {
  for (const mission of missions) {
    if (mission.status !== 'failed' && mission.status !== 'partial') continue;
    const sourceKey = `mission:${mission.id}:terminal`;
    const storedReview = getMissionReview(mission.id);
    const review = storedReview ? refreshReviewFromFollowup(storedReview) : null;
    if (review && ['archived', 'resolved'].includes(review.review_status)) {
      const existing = getAttentionItemBySourceKey(sourceKey);
      if (existing?.status === 'open') updateAttentionStatus(existing.id, 'archived');
      continue;
    }
    if (review?.review_status === 'waiting_followup') {
      const existing = getAttentionItemBySourceKey(sourceKey);
      if (existing?.status === 'open') updateAttentionStatus(existing.id, 'assigned');
      continue;
    }
    upsertAttentionItem({
      sourceKind: 'mission',
      sourceId: mission.id,
      sourceKey,
      title: mission.title,
      detail: terminalMissionAttentionDetail(mission),
      severity: mission.status === 'failed' ? 'high' : 'medium',
      href: `/review?task=${encodeURIComponent(mission.id)}`,
    });
  }
}

function closeTerminalMissionAttention(missionId: string, status: 'resolved' | 'archived' | 'assigned'): void {
  const existing = getAttentionItemBySourceKey(`mission:${missionId}:terminal`);
  if (existing && (existing.status === 'open' || existing.status === 'assigned')) {
    updateAttentionStatus(existing.id, status);
  }
}

function reopenTerminalMissionAttention(missionId: string): void {
  const mission = getMissionTask(missionId);
  if (!mission || (mission.status !== 'failed' && mission.status !== 'partial')) return;
  const sourceKey = `mission:${mission.id}:terminal`;
  const existing = getAttentionItemBySourceKey(sourceKey);
  if (existing?.status === 'assigned') {
    updateAttentionStatus(existing.id, 'open');
  }
  upsertAttentionItem({
    sourceKind: 'mission',
    sourceId: mission.id,
    sourceKey,
    title: mission.title,
    detail: terminalMissionAttentionDetail(mission),
    severity: mission.status === 'failed' ? 'high' : 'medium',
    href: `/review?task=${encodeURIComponent(mission.id)}`,
  });
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
  syncTerminalMissionAttentionItems(missions);
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
    const review = effectiveMissionReview(mission, missions);
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
    } else if (mission.status === 'failed' || mission.status === 'partial') {
      continue;
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
        href: '/scheduled',
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
        href: '/scheduled',
      });
    }
  }

  const rank = { high: 0, medium: 1, low: 2 } satisfies Record<AttentionSeverity, number>;
  return items
    .sort((a, b) => rank[a.severity] - rank[b.severity] || b.createdAt - a.createdAt)
    .slice(0, 12);
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

const CLAUDE_DASHBOARD_MODELS = ['claude-opus-4-7', 'claude-opus-4-6', 'claude-sonnet-4-6', 'claude-sonnet-4-5', 'claude-haiku-4-5'];

function validModelsForProvider(provider: LlmProviderName): string[] {
  if (provider === 'codex') {
    return Array.from(new Set([
      ...CLAUDE_DASHBOARD_MODELS,
      CODEX_OPUS_MODEL,
      CODEX_SONNET_MODEL,
      CODEX_HAIKU_MODEL,
      'gpt-5.5',
      'gpt-5.4',
      'gpt-5.4-mini',
      'gpt-5.4-nano',
      'gpt-5.3-codex',
      'gpt-5.3-codex-spark',
      'gpt-5.2',
    ]));
  }
  return CLAUDE_DASHBOARD_MODELS;
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
        decodedReqPath.startsWith('/pwa/') ||
        decodedReqPath === '/favicon.svg' ||
        decodedReqPath === '/favicon.ico' ||
        decodedReqPath === '/manifest.webmanifest' ||
        decodedReqPath === '/sw.js'
      );
    if (isV2Asset) {
      await next();
      return;
    }
    if (decodedReqPath === '/login' || decodedReqPath === '/logout') {
      await next();
      return;
    }
    const token = c.req.query('token');
    const cookies = parseCookieHeader(c.req.header('cookie'));
    const cookieOk = cookies[DASHBOARD_AUTH_COOKIE] === dashboardCookieValue();
    const tokenOk = !!DASHBOARD_TOKEN && !!token && token === DASHBOARD_TOKEN;
    if (!DASHBOARD_TOKEN || (!tokenOk && !cookieOk)) {
      if (c.req.method === 'GET' && !decodedReqPath.startsWith('/api/')) {
        const url = new URL(c.req.url);
        return c.redirect(`/login?next=${encodeURIComponent(url.pathname + url.search)}`, 302);
      }
      return c.json({ error: 'Unauthorized' }, 401);
    }
    if (tokenOk) {
      setDashboardAuthCookie(c);
      if (c.req.method === 'GET' && !decodedReqPath.startsWith('/api/')) {
        const url = new URL(c.req.url);
        url.searchParams.delete('token');
        return c.redirect(url.pathname + url.search, 302);
      }
    }
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
    '.webmanifest': 'application/manifest+json; charset=utf-8',
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
    if (ext === '.html' || path.basename(file) === 'sw.js' || ext === '.webmanifest') {
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

  const v2RootRoutes = [
    '/home',
    '/review',
    '/mission',
    '/scheduled',
    '/agents',
    '/chat',
    '/runtime',
    '/reliability',
    '/brain',
    '/memories',
    '/hive',
    '/usage',
    '/audit',
    '/voices',
    '/files',
    '/settings',
  ];

  function serveRootV2Route(c: any): Response {
    if (MISSION_CONTROL_V2) return serveV2(c, '/index.html');
    const url = new URL(c.req.url);
    return c.redirect(`/v2${url.pathname}${url.search}`, 302);
  }

  function redirectDeprecatedMobileRoute(c: any): Response {
    const url = new URL(c.req.url);
    return c.redirect(`${MISSION_CONTROL_V2 ? '' : '/v2'}/home${url.search}`, 302);
  }

  app.get('/login', (c) => {
    const next = safeDashboardNext(c.req.query('next'));
    return c.html(renderDashboardLogin(next));
  });

  app.post('/login', async (c) => {
    const body = await c.req.parseBody();
    const token = typeof body.token === 'string' ? body.token.trim() : '';
    const next = safeDashboardNext(typeof body.next === 'string' ? body.next : undefined);
    if (!DASHBOARD_TOKEN || token !== DASHBOARD_TOKEN) {
      return c.html(renderDashboardLogin(next, 'Invalid dashboard token.'), 401);
    }
    setDashboardAuthCookie(c);
    return c.redirect(next, 303);
  });

  app.post('/logout', (c) => {
    clearDashboardAuthCookie(c);
    return c.redirect('/login', 303);
  });

  if (MISSION_CONTROL_V2) {
    // v2 owns root. Legacy reachable at /legacy for cutover comparison.
    app.get('/', (c) => serveV2(c, '/index.html'));
    app.get('/legacy', renderLegacy);
    app.get('/mobile', redirectDeprecatedMobileRoute);
  } else {
    // Legacy owns root (default). v2 reachable at /v2 once built.
    app.get('/', renderLegacy);
    app.get('/v2', (c) => serveV2(c, '/index.html'));
    app.get('/v2/mobile', redirectDeprecatedMobileRoute);
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

  for (const route of v2RootRoutes) {
    app.get(route, serveRootV2Route);
  }

  // Static asset routes are always mounted (the v2 bundle uses absolute
  // /assets/ URLs whether the SPA lives at `/` or `/v2`).
  app.get('/assets/*', (c) => {
    const reqPath = new URL(c.req.url).pathname;
    return serveV2(c, reqPath);
  });
  app.get('/pwa/*', (c) => {
    const reqPath = new URL(c.req.url).pathname;
    return serveV2(c, reqPath);
  });
  app.get('/favicon.svg', (c) => serveV2(c, '/favicon.svg'));
  app.get('/favicon.ico', (c) => serveV2(c, '/favicon.ico'));
  app.get('/manifest.webmanifest', (c) => serveV2(c, '/manifest.webmanifest'));
  app.get('/sw.js', (c) => serveV2(c, '/sw.js'));

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

    let body: { itemId?: string; agentId?: string; instruction?: string } = {};
    try { body = await c.req.json(); } catch { body = {}; }
    const itemId = String(body.itemId || '');
    const agentId = String(body.agentId || '').trim();
    const instruction = String(body.instruction || '').trim().slice(0, 2000);
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
          if (instruction) appendMissionTaskInstruction(linked.id, instruction);
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
        instruction ? `Additional instructions from Ruan:\n${instruction}` : '',
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
        if (instruction) appendMissionTaskInstruction(id, instruction);
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
        instruction ? `Additional instructions from Ruan:\n${instruction}` : '',
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
        instruction ? `Additional instructions from Ruan:\n${instruction}` : '',
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
    const calendar = await fetchHomeCalendarItems();
    return c.json({
      updatedAt: new Date().toISOString(),
      externalCalendar: {
        connected: calendar.connected,
        provider: calendar.connected ? 'Microsoft Graph' : null,
        note: calendar.note,
      },
      items: calendar.items,
    });
  });

  // Delete a scheduled task
  app.delete('/api/tasks/:id', (c) => {
    const id = c.req.param('id');
    deleteScheduledTask(id);
    return c.json({ ok: true });
  });

  app.patch('/api/tasks/:id', async (c) => {
    const id = c.req.param('id');
    const existing = getAllScheduledTasks().find((task) => task.id === id);
    if (!existing) return c.json({ ok: false, error: 'Scheduled task not found.' }, 404);
    let body: { prompt?: unknown; schedule?: unknown; agent_id?: unknown } = {};
    try { body = await c.req.json(); } catch {}

    const patch: { prompt?: string; schedule?: string; nextRun?: number; agentId?: string } = {};
    if (typeof body.prompt === 'string') {
      const prompt = body.prompt.trim();
      if (!prompt) return c.json({ ok: false, error: 'Prompt cannot be empty.' }, 400);
      patch.prompt = prompt;
    }
    if (typeof body.schedule === 'string') {
      const schedule = body.schedule.trim();
      if (!schedule) return c.json({ ok: false, error: 'Schedule cannot be empty.' }, 400);
      if (schedule !== existing.schedule) {
        try {
          patch.nextRun = computeNextRun(schedule);
        } catch (err: any) {
          return c.json({ ok: false, error: 'Invalid cron: ' + (err?.message || String(err)) }, 400);
        }
      }
      patch.schedule = schedule;
    }
    if (typeof body.agent_id === 'string') {
      const agentId = body.agent_id.trim();
      const validAgents = ['main', ...listAgentIds()];
      if (!validAgents.includes(agentId)) {
        return c.json({ ok: false, error: `Unknown agent: ${agentId}. Valid: ${validAgents.join(', ')}` }, 400);
      }
      patch.agentId = agentId;
    }

    const task = updateScheduledTask(id, patch);
    return c.json({ ok: true, task });
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
    const body = await c.req.json<{ assigned_agent?: string; instruction?: string }>();
    const newAgent = body?.assigned_agent?.trim();
    const instruction = body?.instruction?.trim().slice(0, 2000) || '';
    if (!newAgent && !instruction) return c.json({ error: 'assigned_agent or instruction required' }, 400);
    const validAgents = ['main', ...listAgentIds()];
    if (newAgent && !validAgents.includes(newAgent)) return c.json({ error: 'Unknown agent' }, 400);
    const task = getMissionTask(id);
    if (!task) return c.json({ error: 'Not found' }, 404);
    if (task.status === 'running') return c.json({ ok: false, error: 'Running mission tasks cannot be edited or reassigned.' }, 409);
    let ok = true;
    if (newAgent) ok = reassignMissionTask(id, newAgent);
    if (instruction) appendMissionTaskInstruction(id, instruction);
    return c.json({ ok, task: getMissionTask(id) });
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
    const requestedTaskId = c.req.query('task') || '';
    const missions = getMissionTasks();
    const terminalMissions = missions
      .filter((task) => TERMINAL_MISSION_STATUSES.has(task.status))
      .sort((a, b) => {
        const bTime = b.completed_at || b.created_at || 0;
        const aTime = a.completed_at || a.created_at || 0;
        return bTime - aTime;
      });
    const openItems = terminalMissions
      .map((task) => {
        const review = effectiveMissionReview(task, missions);
        if (!review || !shouldShowReview(review)) return null;
        const item = buildReviewItem(task, review, missions);
        // Auto-decay sorted (Category B) items older than 7 days — they're
        // FYI heads-ups, not action items, so let them fall off automatically.
        if (isStaleSortedItem(task, item.kind)) return null;
        return item;
      })
      .filter((item): item is ReturnType<typeof buildReviewItem> => item !== null)
      .sort((a, b) => {
        if (a.kind !== b.kind) return a.kind === 'needs_action' ? -1 : 1;
        const bTime = b.completedAt || b.createdAt || 0;
        const aTime = a.completedAt || a.createdAt || 0;
        return bTime - aTime;
      });
    const items = openItems.slice(0, limit);
    if (requestedTaskId && !items.some((item) => item.id === requestedTaskId)) {
      const requestedTask = terminalMissions.find((task) => task.id === requestedTaskId);
      if (requestedTask) {
        const review = effectiveMissionReview(requestedTask, missions);
        if (review && shouldShowReview(review)) {
          const requestedItem = buildReviewItem(requestedTask, review, missions);
          items.push(requestedItem);
        }
      }
    }
    return c.json({
      updatedAt: new Date().toISOString(),
      items,
      total: terminalMissions.length,
      openTotal: openItems.length,
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
    closeTerminalMissionAttention(id, 'archived');
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
    closeTerminalMissionAttention(id, 'resolved');
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
        const extraInstructions = (body.instructions || '').trim().slice(0, 6000);
        if (extraInstructions) appendMissionTaskInstruction(existingFollowup.id, extraInstructions);
        closeTerminalMissionAttention(id, 'assigned');
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
    closeTerminalMissionAttention(task.id, 'assigned');
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
    if (!selectBestEmailDeliverable(task)) {
      return c.json({
        ok: false,
        error: 'No actual deliverable file was found for this mission. The mission report remains visible in Review Inbox, but Email deliverable only sends a real worked file.',
      }, 400);
    }
    const exported = await createReviewEmailAttachment(task, body.format === 'html' ? 'html' : 'docx');
    try {
      await sendMissionTaskExportEmail(task, ownerEmail, fromEmail, exported);
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
    const config = openBrainConfigState();
    const ingestion = collectBrainIngestionCandidates(chatId);
    return c.json({
      backend: BRAIN,
      openBrain: {
        enabled: config.active,
        configured: config.configured,
        ready: config.ready,
        missing: config.missing,
        functionName: OB1_BRAIN_FUNCTION,
        graphFunctionName: config.graphFunctionName,
        graphConfigured: config.graphConfigured,
        supabaseConfigured: !!OB1_SUPABASE_URL,
        accessKeyConfigured: !!MCP_ACCESS_KEY,
      },
      localFallback: true,
      ingestion: {
        pending: ingestion.length,
        sources: {
          missionManifests: ingestion.filter((i) => i.source === 'mission_manifest').length,
          briefOutputs: ingestion.filter((i) => i.source === 'brief_output').length,
          decisions: ingestion.filter((i) => i.source === 'decision').length,
        },
      },
      mutationsEnabled: killSwitchFlag('DASHBOARD_MUTATIONS_ENABLED', true),
      sqlite: {
        enabled: true,
        chatId,
        totalMemories: stats.total,
        pinned: stats.pinned,
        avgSalience: stats.avgSalience,
      },
      notes: config.ready
        ? 'OpenBrain is configured and active. Captures are mirrored locally so the dashboard graph remains inspectable.'
        : `OpenBrain is not ready. Dashboard search/capture is using the local SQLite brain mirror. Missing: ${config.missing.join(', ') || 'none'}.`,
    });
  });

  app.get('/api/brain/search', async (c) => {
    const query = (c.req.query('query') || c.req.query('q') || '').trim();
    if (!query) return c.json({ ok: false, error: 'query required', results: [], raw: '' }, 400);

    const parsedLimit = parseInt(c.req.query('limit') || '8', 10);
    const limit = Number.isFinite(parsedLimit) ? Math.max(1, Math.min(20, parsedLimit)) : 8;
    const parsedOffset = parseInt(c.req.query('offset') || '0', 10);
    const offset = Number.isFinite(parsedOffset) ? Math.max(0, parsedOffset) : 0;
    const parsedThreshold = parseFloat(c.req.query('threshold') || '0.5');
    const threshold = Number.isFinite(parsedThreshold) ? Math.max(0, Math.min(1, parsedThreshold)) : 0.5;
    const mode = (c.req.query('mode') || 'semantic').toLowerCase();

    const forceLocal = (c.req.query('backend') || '').toLowerCase() === 'sqlite';
    if (forceLocal || !openBrainConfigured()) {
      return c.json({
        ok: true,
        backend: 'sqlite',
        query,
        limit,
        threshold,
        results: localBrainSearch(dashboardChatId(c), query, limit),
        raw: '',
      });
    }

    if (mode === 'text') {
      const data = await searchOpenBrainText({ query, limit, offset });
      return c.json({
        ok: true,
        backend: 'ob1',
        mode: 'text',
        query,
        limit,
        offset,
        total: data.total,
        results: data.thoughts.map((thought) => ({
          ...thought,
          match: `${Math.round(Number(thought.rank ?? 0) * 100)} rank`,
          date: thought.created_at ? new Date(thought.created_at).toISOString().slice(0, 10) : '',
          topics: Array.isArray(thought.metadata?.topics) ? thought.metadata.topics : [],
          people: Array.isArray(thought.metadata?.people) ? thought.metadata.people : [],
        })),
        raw: '',
      });
    }

    const raw = await searchThoughts({ query, limit, threshold });
    return c.json({
      ok: true,
      backend: 'ob1',
      query,
      limit,
      threshold,
      results: parseSearchText(raw),
      raw,
    });
  });

  app.get('/api/brain/thoughts', async (c) => {
    if (!openBrainConfigured()) {
      return c.json({ ok: false, configured: false, thoughts: [], total: 0, error: 'OpenBrain is not configured.' }, 400);
    }
    const parsedLimit = parseInt(c.req.query('limit') || '25', 10);
    const parsedOffset = parseInt(c.req.query('offset') || '0', 10);
    const importanceRaw = c.req.query('importanceMin');
    const result = await listOpenBrainThoughts({
      limit: Number.isFinite(parsedLimit) ? parsedLimit : 25,
      offset: Number.isFinite(parsedOffset) ? parsedOffset : 0,
      type: (c.req.query('type') || '').trim() || undefined,
      source_type: (c.req.query('source') || '').trim() || undefined,
      importance_min: importanceRaw ? parseInt(importanceRaw, 10) : undefined,
    });
    return c.json({ ok: true, configured: true, ...result });
  });

  app.get('/api/brain/thoughts/:id', async (c) => {
    if (!openBrainConfigured()) {
      return c.json({ ok: false, configured: false, error: 'OpenBrain is not configured.' }, 400);
    }
    const id = c.req.param('id');
    const thought = await getOpenBrainThought(id);
    if (!thought) return c.json({ ok: false, error: 'thought not found' }, 404);
    return c.json({ ok: true, thought });
  });

  app.get('/api/brain/thoughts/:id/connections', async (c) => {
    if (!openBrainConfigured()) {
      return c.json({ ok: false, configured: false, connections: [], error: 'OpenBrain is not configured.' }, 400);
    }
    const id = c.req.param('id');
    const limit = Math.max(1, Math.min(parseInt(c.req.query('limit') || '20', 10) || 20, 50));
    const connections = await getOpenBrainThoughtConnections(id, limit);
    return c.json({ ok: true, connections });
  });

  app.get('/api/brain/stats/openbrain', async (c) => {
    if (!openBrainConfigured()) {
      return c.json({ ok: false, configured: false, stats: null, error: 'OpenBrain is not configured.' }, 400);
    }
    const stats = await getOpenBrainStats();
    return c.json({ ok: true, configured: true, stats });
  });

  app.get('/api/brain/map', async (c) => {
    if (!openBrainConfigured()) {
      return c.json({ ok: false, configured: false, error: 'OpenBrain is not configured.', nodes: [], edges: [], points: [] }, 400);
    }
    try {
      const graph = await buildWholeOpenBrainGraph();
      return c.json({ configured: true, ...graph });
    } catch (err) {
      return c.json({
        ok: false,
        configured: true,
        error: `OpenBrain map unavailable: ${err instanceof Error ? err.message : String(err)}`,
        nodes: [],
        edges: [],
        points: [],
      }, 400);
    }
  });

  app.post('/api/brain/capture', async (c) => {
    if (!killSwitchFlag('DASHBOARD_MUTATIONS_ENABLED', true)) {
      return c.json({ ok: false, error: 'Dashboard mutations are disabled by DASHBOARD_MUTATIONS_ENABLED=false' }, 423);
    }

    const body = await c.req.json().catch(() => ({}));
    const content = body && typeof body === 'object' && typeof (body as { content?: unknown }).content === 'string'
      ? (body as { content: string }).content.trim()
      : '';
    if (!content) return c.json({ ok: false, error: 'content required' }, 400);
    if (content.length > 12_000) return c.json({ ok: false, error: 'content too long, max 12000 characters' }, 400);

    const localId = saveLocalBrainCapture(dashboardChatId(c), content);
    if ((body as { backend?: unknown }).backend === 'sqlite' || !openBrainConfigured()) {
      return c.json({
        ok: true,
        backend: 'sqlite',
        localMemoryId: localId,
        confirmation: 'Captured to the local brain mirror. OpenBrain is not configured yet.',
      });
    }

    const result = await captureThought({ content });
    return c.json({ ...result, backend: 'ob1', localMemoryId: localId });
  });

  app.get('/api/brain/sources', (c) => {
    const chatId = dashboardChatId(c);
    const candidates = collectBrainIngestionCandidates(chatId);
    return c.json({
      updatedAt: new Date().toISOString(),
      pending: candidates.length,
      candidates: candidates.slice(0, 20),
    });
  });

  app.get('/api/brain/graph/status', async (c) => {
    const configured = openBrainGraphConfigured();
    if (!configured) {
      return c.json({
        ok: true,
        configured: false,
        ready: false,
        functionName: OB1_GRAPH_FUNCTION,
        missing: openBrainConfigState().missing.concat(OB1_GRAPH_FUNCTION ? [] : ['OB1_GRAPH_FUNCTION']),
        edgeTypes: [],
      });
    }

    try {
      const edgeTypeResult = await listGraphEdgeTypes();
      return c.json({
        ok: true,
        configured: true,
        ready: edgeTypeResult.success !== false,
        functionName: OB1_GRAPH_FUNCTION,
        edgeTypes: edgeTypeResult.edge_types || edgeTypeResult.types || [],
      });
    } catch (err: any) {
      return c.json({
        ok: false,
        configured: true,
        ready: false,
        functionName: OB1_GRAPH_FUNCTION,
        edgeTypes: [],
        error: err?.message || String(err),
      }, 200);
    }
  });

  app.get('/api/brain/graph/nodes', async (c) => {
    const query = (c.req.query('query') || c.req.query('q') || '').trim();
    const nodeType = (c.req.query('type') || '').trim();
    const parsedLimit = parseInt(c.req.query('limit') || '40', 10);
    const limit = Number.isFinite(parsedLimit) ? Math.max(1, Math.min(100, parsedLimit)) : 40;

    if (!openBrainGraphConfigured()) {
      return c.json({
        ok: true,
        configured: false,
        ready: false,
        functionName: OB1_GRAPH_FUNCTION,
        nodes: [],
        count: 0,
        error: 'OB-Graph is not deployed/configured yet.',
      });
    }

    try {
      const result = await searchGraphNodes({ query: query || undefined, node_type: nodeType || undefined, limit });
      return c.json({
        ok: result.success !== false,
        configured: true,
        ready: result.success !== false,
        functionName: OB1_GRAPH_FUNCTION,
        nodes: result.nodes || [],
        count: result.count ?? result.nodes?.length ?? 0,
        error: result.error,
      });
    } catch (err: any) {
      return c.json({
        ok: false,
        configured: true,
        ready: false,
        functionName: OB1_GRAPH_FUNCTION,
        nodes: [],
        count: 0,
        error: err?.message || String(err),
      }, 200);
    }
  });

  app.get('/api/brain/graph/nodes/:id/neighbors', async (c) => {
    const nodeId = c.req.param('id');
    if (!nodeId) return c.json({ ok: false, error: 'node id required', neighbors: [] }, 400);
    if (!openBrainGraphConfigured()) {
      return c.json({
        ok: true,
        configured: false,
        ready: false,
        functionName: OB1_GRAPH_FUNCTION,
        neighbors: [],
        count: 0,
        error: 'OB-Graph is not deployed/configured yet.',
      });
    }

    try {
      const result = await getGraphNeighbors({ node_id: nodeId, direction: 'both' });
      return c.json({
        ok: result.success !== false,
        configured: true,
        ready: result.success !== false,
        functionName: OB1_GRAPH_FUNCTION,
        neighbors: result.neighbors || result.results || [],
        count: result.count ?? (result.neighbors || result.results || []).length,
        error: result.error,
      });
    } catch (err: any) {
      return c.json({
        ok: false,
        configured: true,
        ready: false,
        functionName: OB1_GRAPH_FUNCTION,
        neighbors: [],
        count: 0,
        error: err?.message || String(err),
      }, 200);
    }
  });

  app.post('/api/brain/graph/ingest', async (c) => {
    if (!killSwitchFlag('DASHBOARD_MUTATIONS_ENABLED', true)) {
      return c.json({ ok: false, error: 'Dashboard mutations are disabled by DASHBOARD_MUTATIONS_ENABLED=false' }, 423);
    }
    if (!openBrainGraphConfigured()) {
      return c.json({
        ok: false,
        configured: false,
        ready: false,
        functionName: OB1_GRAPH_FUNCTION,
        error: 'OB-Graph is not deployed/configured yet.',
      }, 400);
    }

    const result = await ingestOpenBrainGraph();
    return c.json({
      ok: result.errors.length === 0,
      configured: true,
      ready: true,
      functionName: OB1_GRAPH_FUNCTION,
      ...result,
    }, result.errors.length === 0 ? 200 : 207);
  });

  app.post('/api/brain/ingest', async (c) => {
    if (!killSwitchFlag('DASHBOARD_MUTATIONS_ENABLED', true)) {
      return c.json({ ok: false, error: 'Dashboard mutations are disabled by DASHBOARD_MUTATIONS_ENABLED=false' }, 423);
    }
    const chatId = dashboardChatId(c);
    const candidates = collectBrainIngestionCandidates(chatId);
    const openBrainReady = openBrainConfigured();
    let localSaved = 0;
    let remoteCaptured = 0;
    const errors: string[] = [];
    for (const candidate of candidates) {
      saveStructuredMemory(chatId, candidate.content, candidate.summary, [], candidate.topics, candidate.confidence, candidate.source, AGENT_ID);
      localSaved++;
      if (openBrainReady && remoteCaptured < 20) {
        try {
          await captureThought({
            content: `[source=${candidate.source}] [confidence=${candidate.confidence.toFixed(2)}]\n${candidate.content}`,
          });
          remoteCaptured++;
        } catch (err: any) {
          errors.push(err?.message || String(err));
          break;
        }
      }
    }
    return c.json({
      ok: errors.length === 0,
      backend: openBrainReady ? 'ob1' : 'sqlite',
      localSaved,
      remoteCaptured,
      skippedExisting: 0,
      errors,
    }, errors.length === 0 ? 200 : 207);
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

  app.post('/api/system/restart-main', (c) => {
    if (!killSwitchFlag('DASHBOARD_MUTATIONS_ENABLED', true)) {
      return c.json({ ok: false, error: 'Dashboard mutations are disabled.' }, 423);
    }
    const queued = queueMainRestart('dashboard');
    return c.json({
      ok: true,
      queued,
      message: queued ? 'Main agent restart queued' : 'Main agent restart already queued',
    }, 202);
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
    const agentRoutes = [
      {
        agentId: 'main',
        name: 'Main',
        ...providerStatusForAgent('main', null),
        model: agentDefaultModel || MAIN_AGENT_MODEL,
        restartRequired: false,
      },
      ...listAgentIds().map((id) => {
        try {
          const config = loadAgentConfig(id);
          const status = providerStatusForAgent(id, config);
          return {
            agentId: id,
            name: config.name,
            ...status,
            model: config.model || MAIN_AGENT_MODEL,
            restartRequired: true,
          };
        } catch (err: any) {
          const status = providerStatusForAgent(id, null);
          return {
            agentId: id,
            name: id,
            ...status,
            model: MAIN_AGENT_MODEL,
            restartRequired: true,
          };
        }
      }),
    ];

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
      agentRoutes,
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
            agentRoutes: agentRoutes.map((route) => ({
              agentId: route.agentId,
              provider: route.provider,
              configuredProvider: route.configuredProvider,
              model: route.model,
            })),
          },
          actions: {
            smoke: '/api/provider/smoke',
            switch: '/api/provider/switch',
          },
          error: providerError,
        },
        {
          id: 'local-model-readiness',
          name: 'Local model readiness',
          category: 'LLM',
          status: process.env.LOCAL_LLM_BASE_URL || EMBEDDING_PROVIDER === 'llamacpp' ? 'limited' : 'disabled',
          active: EMBEDDING_PROVIDER === 'llamacpp' ? 'local embeddings configured' : process.env.LOCAL_LLM_BASE_URL ? 'LLM endpoint configured' : 'not configured',
          configured: EMBEDDING_PROVIDER === 'llamacpp' ? LLAMACPP_EMBEDDING_MODEL : process.env.LOCAL_LLM_MODEL || 'no local model selected',
          implementations: ['OpenAI-compatible local API', 'Ollama-compatible API'],
          contract: [
            'provider adapter must implement runAgent(options)',
            'same MCP allowlist contract as Claude and Codex',
            'session storage must be scoped by provider',
            'model routing must be selectable per agent/task',
          ],
          signals: {
            localBaseUrlConfigured: !!process.env.LOCAL_LLM_BASE_URL,
            localModelConfigured: !!process.env.LOCAL_LLM_MODEL,
            embeddingProvider: EMBEDDING_PROVIDER,
            llamaCppEmbeddingUrl: LLAMACPP_EMBEDDING_URL,
            llamaCppEmbeddingModel: LLAMACPP_EMBEDDING_MODEL,
            localEmbeddingModelPathConfigured: !!LOCAL_EMBEDDING_MODEL_PATH,
            adapterImplemented: false,
          },
          actions: {},
          error: process.env.LOCAL_LLM_BASE_URL
            ? 'Local endpoint is configured, but the local LLM provider adapter has not landed yet.'
            : EMBEDDING_PROVIDER === 'llamacpp'
              ? 'Local embeddings are wired through llama.cpp. Local chat routing still needs a separate provider adapter.'
              : 'Set LOCAL_LLM_BASE_URL for local chat, or EMBEDDING_PROVIDER=llamacpp for local embeddings.',
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

  app.get('/api/reliability/status', (c) => {
    const now = Math.floor(Date.now() / 1000);
    const outbox = getOutboxStats();
    const outboxRows = listProblemTelegramOutbox(25).map((row) => ({
      id: row.id,
      agentId: row.agent_id,
      status: row.status,
      attempts: row.attempt_count,
      lastError: row.last_error,
      ageSeconds: now - row.created_at,
      nextRetryAt: row.next_retry_at,
      lastAttemptAt: row.last_attempt_at,
      payloadPreview: row.payload.replace(/\s+/g, ' ').slice(0, 180),
      canRetry: ['failed', 'dead-lettered', 'pending'].includes(row.status),
      canDeadLetter: ['pending', 'failed'].includes(row.status),
    }));
    const overdueOperations = listOverdueOperationNotifications(now, 25).map((row) => ({
      id: row.id,
      agentId: row.agent_id,
      operationId: row.operation_id,
      fireAt: row.fire_at,
      overdueSeconds: now - row.fire_at,
      payloadPreview: row.payload.replace(/\s+/g, ' ').slice(0, 180),
      canCancel: true,
    }));
    const staleCode = checkStale();
    const scheduled = getAllScheduledTasks();
    const staleScheduled = scheduled
      .filter((task) => task.status === 'running' && (task.started_at || 0) < now - 30 * 60)
      .map((task) => ({
        id: task.id,
        title: scheduleTitle(task.prompt),
        agentId: task.agent_id,
        ageSeconds: now - (task.started_at || now),
        href: '/scheduled',
        actions: { reset: true, open: '/scheduled' },
      }));
    const failedScheduled = scheduled
      .filter((task) => task.last_status === 'failed' || task.last_status === 'timeout')
      .slice(0, 20)
      .map((task) => ({
        id: task.id,
        title: scheduleTitle(task.prompt),
        agentId: task.agent_id,
        status: task.last_status,
        lastRun: task.last_run,
        detail: task.last_result?.slice(0, 500) || '',
        href: '/scheduled',
        actions: { clear: true, open: '/scheduled' },
      }));
    const staleMissions = listStaleMissionTasks(now).map((task) => ({
      id: task.id,
      title: task.title,
      agentId: task.assigned_agent,
      status: task.status,
      ageSeconds: now - (task.started_at || task.completed_at || task.created_at),
      notifyOnDone: task.notify_on_done === 1,
      delivered: !!task.delivered_at,
      attempts: task.notify_attempt_count,
      href: `/mission?task=${encodeURIComponent(task.id)}`,
      actions: {
        reset: task.status === 'running',
        review: ['completed', 'failed', 'partial'].includes(task.status),
        open: task.status === 'running' || task.status === 'queued'
          ? `/mission?task=${encodeURIComponent(task.id)}`
          : `/review?task=${encodeURIComponent(task.id)}`,
      },
    }));
    const agentHealth = ['main', ...listAgentIds()].map((id) => {
      const pidFile = id === 'main'
        ? path.join(STORE_DIR, 'claudeclaw.pid')
        : path.join(STORE_DIR, `agent-${id}.pid`);
      let running = false;
      if (fs.existsSync(pidFile)) {
        try {
          const pid = parseInt(fs.readFileSync(pidFile, 'utf-8').trim(), 10);
          process.kill(pid, 0);
          running = true;
        } catch {
          running = false;
        }
      }
      let provider = currentProviderStatus().provider;
      let providerError = currentProviderStatus().providerError;
      let model = agentDefaultModel || MAIN_AGENT_MODEL;
      if (id !== 'main') {
        try {
          const config = loadAgentConfig(id);
          const status = providerStatusForAgent(id, config);
          provider = status.provider;
          providerError = status.providerError;
          model = config.model || MAIN_AGENT_MODEL;
        } catch (err: any) {
          providerError = err?.message || 'Agent config unreadable';
        }
      }
      return { id, running, provider, model, providerError };
    });

    const issues = [
      ...staleScheduled.map((item) => ({ kind: 'stuck_worker', severity: 'high', title: item.title, detail: `${item.agentId} running ${Math.floor(item.ageSeconds / 60)}m`, href: item.href })),
      ...failedScheduled.map((item) => ({ kind: 'failed_schedule', severity: 'high', title: item.title, detail: `${item.status}: ${item.detail}`, href: item.href })),
      ...staleMissions.map((item) => ({ kind: 'stale_mission', severity: item.status === 'running' ? 'high' : 'medium', title: item.title, detail: `${item.status} with ${item.agentId || 'unassigned'}`, href: item.href })),
      ...(outbox.deadLettered > 0 ? [{ kind: 'telegram_dead_letter', severity: 'high', title: 'Telegram dead letters', detail: `${outbox.deadLettered} row(s) dead-lettered`, href: '/reliability' }] : []),
      ...(outbox.oldestUnsentAgeSeconds && outbox.oldestUnsentAgeSeconds > 10 * 60 ? [{ kind: 'telegram_stale', severity: 'medium', title: 'Telegram outbox delayed', detail: `oldest unsent ${Math.floor(outbox.oldestUnsentAgeSeconds / 60)}m`, href: '/reliability' }] : []),
      ...overdueOperations.map((item) => ({ kind: 'operation_notification', severity: 'medium', title: `Operation ${item.operationId}`, detail: `overdue ${Math.floor(item.overdueSeconds / 60)}m`, href: '/reliability' })),
      ...(staleCode.stale ? [{ kind: 'restart_needed', severity: 'medium', title: 'Restart needed', detail: `runtime ${shortSha(staleCode.runtimeSha)} behind disk ${shortSha(staleCode.diskSha)}`, href: '/agents' }] : []),
      ...agentHealth.filter((a) => a.providerError).map((a) => ({ kind: 'provider_health', severity: 'high', title: `${a.id} provider`, detail: a.providerError || '', href: '/runtime' })),
    ];

    return c.json({
      updatedAt: new Date().toISOString(),
      ok: issues.length === 0,
      summary: {
        openIssues: issues.length,
        stuckWorkers: staleScheduled.length,
        failedSchedules: failedScheduled.length,
        staleMissions: staleMissions.length,
        telegramDeadLetters: outbox.deadLettered,
        overdueOperations: overdueOperations.length,
        restartNeeded: staleCode.stale,
      },
      issues,
      workers: { staleScheduled, failedScheduled },
      missions: { stale: staleMissions },
      telegram: { ...outbox, rows: outboxRows },
      operations: { overdue: overdueOperations },
      providers: agentHealth,
      restart: {
        needed: staleCode.stale,
        runtimeSha: shortSha(RUNTIME_BUILD_META.sha),
        diskSha: shortSha(staleCode.diskSha),
        branch: staleCode.diskMeta.branch,
        builtAt: RUNTIME_BUILD_META.builtAt,
        uptimeSeconds: Math.floor((Date.now() - RUNTIME_STARTED_AT) / 1000),
      },
    });
  });

  app.post('/api/reliability/schedules/:id/reset', (c) => {
    if (!killSwitchFlag('DASHBOARD_MUTATIONS_ENABLED', true)) {
      return c.json({ ok: false, error: 'Dashboard mutations are disabled.' }, 423);
    }
    const ok = resetScheduledTaskRun(c.req.param('id'));
    return c.json({ ok, reset: ok });
  });

  app.post('/api/reliability/schedules/:id/clear-failure', (c) => {
    if (!killSwitchFlag('DASHBOARD_MUTATIONS_ENABLED', true)) {
      return c.json({ ok: false, error: 'Dashboard mutations are disabled.' }, 423);
    }
    const ok = clearScheduledTaskAttention(c.req.param('id'), 'Cleared from Reliability dashboard.');
    return c.json({ ok, cleared: ok });
  });

  app.post('/api/reliability/missions/:id/reset', (c) => {
    if (!killSwitchFlag('DASHBOARD_MUTATIONS_ENABLED', true)) {
      return c.json({ ok: false, error: 'Dashboard mutations are disabled.' }, 423);
    }
    const ok = resetMissionTaskRun(c.req.param('id'));
    return c.json({ ok, reset: ok });
  });

  app.post('/api/reliability/outbox/:id/retry', (c) => {
    if (!killSwitchFlag('DASHBOARD_MUTATIONS_ENABLED', true)) {
      return c.json({ ok: false, error: 'Dashboard mutations are disabled.' }, 423);
    }
    const id = parseInt(c.req.param('id'), 10);
    if (!Number.isFinite(id)) return c.json({ ok: false, error: 'Invalid outbox id' }, 400);
    const ok = retryTelegramOutboxRow(id);
    return c.json({ ok, retried: ok });
  });

  app.post('/api/reliability/outbox/:id/dead-letter', (c) => {
    if (!killSwitchFlag('DASHBOARD_MUTATIONS_ENABLED', true)) {
      return c.json({ ok: false, error: 'Dashboard mutations are disabled.' }, 423);
    }
    const id = parseInt(c.req.param('id'), 10);
    if (!Number.isFinite(id)) return c.json({ ok: false, error: 'Invalid outbox id' }, 400);
    const ok = deadLetterTelegramOutboxRow(id);
    return c.json({ ok, deadLettered: ok });
  });

  app.post('/api/reliability/operations/:id/cancel', (c) => {
    if (!killSwitchFlag('DASHBOARD_MUTATIONS_ENABLED', true)) {
      return c.json({ ok: false, error: 'Dashboard mutations are disabled.' }, 423);
    }
    const id = parseInt(c.req.param('id'), 10);
    if (!Number.isFinite(id)) return c.json({ ok: false, error: 'Invalid operation notification id' }, 400);
    const ok = cancelOperationNotificationById(id);
    return c.json({ ok, cancelled: ok });
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

    const previousProvider = currentProviderStatus().provider;
    writeEnvValue('LLM_PROVIDER', provider);
    return c.json({
      ok: true,
      provider,
      previousProvider,
      restartRequired: provider !== previousProvider,
      message: provider === previousProvider
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

  app.get('/api/agents/:id/avatar', (c) => {
    const agentId = c.req.param('id');
    if (!AGENT_ID_RE.test(agentId)) return c.json({ error: 'invalid id' }, 400);
    if (!agentExists(agentId)) return c.json({ error: 'agent not found' }, 404);
    const context = c.req.query('context') === 'meet' ? 'meet' : 'default';
    const avatarPath = resolveDashboardAvatar(agentId, context);
    if (!avatarPath) return new Response(null, { status: 204 });

    const stat = fs.statSync(avatarPath);
    const etag = `W/"${Math.floor(stat.mtimeMs)}-${stat.size}"`;
    if (c.req.header('if-none-match') === etag) return new Response(null, { status: 304 });

    const data = fs.readFileSync(avatarPath);
    return new Response(data, {
      headers: {
        'Content-Type': imageContentType(avatarPath),
        'Cache-Control': 'public, max-age=3600',
        ETag: etag,
      },
    });
  });

  // List all configured agents with status
  app.get('/api/agents', (c) => {
    const chatId = c.req.query('chatId') || '';
    const agentIds = listAgentIds();
    const agents = agentIds.map((id) => {
      try {
        const config = loadAgentConfig(id);
        const { provider, configuredProvider, providerSource, providerError } = providerStatusForAgent(id, config);
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
          configuredProvider,
          providerSource,
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
        const { provider, configuredProvider, providerSource, providerError } = providerStatusForAgent(id, null);
        return {
          id,
          name: id,
          description: '',
          model: 'unknown',
          provider,
          configuredProvider,
          providerSource,
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
    const mainProviderStatus = providerStatusForAgent('main', null);
    const mainSessionId = getSession(chatId, 'main', mainProviderStatus.provider);
    const mainRuntime = providerRuntime(mainProviderStatus.provider, getMainModelOverride() || agentDefaultModel || MAIN_AGENT_MODEL, mainSessionId);
    const allAgents = [
      {
        id: 'main',
        name: 'Main',
        description: 'Primary ClaudeClaw bot',
        model: mainRuntime.configuredModel,
        provider: mainRuntime.provider,
        configuredProvider: mainProviderStatus.configuredProvider,
        providerSource: mainProviderStatus.providerSource,
        providerError: mainProviderStatus.providerError,
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

    const validModels = validModelsForProvider('claude');
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

    let provider: LlmProviderName;
    try {
      if (agentId === 'main') provider = currentProviderStatus().provider;
      else provider = providerStatusForAgent(agentId, loadAgentConfig(agentId)).provider;
    } catch {
      provider = 'claude';
    }
    const validModels = validModelsForProvider(provider);
    if (!validModels.includes(model)) return c.json({ error: `Invalid model for ${provider}. Valid: ${validModels.join(', ')}` }, 400);

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

  app.patch('/api/agents/:id/provider', async (c) => {
    if (!killSwitchFlag('DASHBOARD_MUTATIONS_ENABLED', true)) {
      return c.json({ ok: false, error: 'Dashboard mutations are disabled.' }, 423);
    }
    const agentId = c.req.param('id');
    const body = await c.req.json<{ provider?: string }>();
    let provider: LlmProviderName;
    try {
      provider = normalizeLlmProvider(body?.provider);
    } catch (err: any) {
      return c.json({ ok: false, error: err?.message || 'Unsupported provider' }, 400);
    }

    try {
      if (agentId === 'main') {
        const previousProvider = currentProviderStatus().provider;
        writeEnvValue('LLM_PROVIDER', provider);
        return c.json({
          ok: true,
          agent: 'main',
          provider,
          restartRequired: provider !== previousProvider,
          message: provider === previousProvider
            ? 'Main provider already matches active runtime.'
            : 'Main provider saved. Restart Sage to activate it.',
        });
      }
      setAgentProvider(agentId, provider);
      return c.json({
        ok: true,
        agent: agentId,
        provider,
        restartRequired: true,
        message: `${agentId} provider saved. Restart that agent to activate it.`,
      });
    } catch {
      return c.json({ ok: false, error: 'Failed to update provider' }, 500);
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
    const chatId = dashboardChatId(c);
    const limit = parseInt(c.req.query('limit') || '40', 10);
    const beforeId = c.req.query('beforeId');
    if (!chatId) return c.json({ turns: [] });
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
