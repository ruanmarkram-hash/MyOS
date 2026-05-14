// Phase C1.a — main CLAUDE.md editor with live hot-reload.
//
// Surface owned by this module:
//   - Path allowlist: ONLY the active main CLAUDE.md is writable through the
//     dashboard editor today. C1.b will widen the list to per-agent files.
//   - Atomic write: every save lands via a sibling temp file + renameSync
//     so a crash mid-write can't truncate the live file.
//   - History append: one row per successful save, for revert + audit.
//   - Hot-reload: after a successful write the in-memory `agentSystemPrompt`
//     is refreshed so a NEW session picks up the new rules without a process
//     restart.

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import {
  agentSystemPrompt,
  resolveMainClaudeMdPath,
  setAgentSystemPrompt,
} from './config.js';
import { appendAgentFileHistory, listAgentFileHistory, AgentFileHistoryRow } from './db.js';
import { logger } from './logger.js';

/** Logical id used in the dashboard URL: /api/agent-files/:id. */
export const MAIN_FILE_ID = 'main' as const;
export const MAX_AGENT_FILE_BYTES = 256 * 1024;

/**
 * Allowlist of files the editor may write. Keyed by id so the API surface
 * never exposes raw filesystem paths to the client. Belt-and-braces
 * defence: every write helper rejects ids outside this map.
 */
const ALLOWLIST: Record<string, { absolutePath: () => string; label: string }> = {
  [MAIN_FILE_ID]: {
    absolutePath: resolveMainClaudeMdPath,
    label: 'Sage main CLAUDE.md',
  },
};

export interface AgentFileDescriptor {
  id: string;
  label: string;
  path: string;
  exists: boolean;
}

export function listEditableFiles(): AgentFileDescriptor[] {
  return Object.entries(ALLOWLIST).map(([id, entry]) => ({
    id,
    label: entry.label,
    path: entry.absolutePath(),
    exists: fs.existsSync(entry.absolutePath()),
  }));
}

export function isEditableFileId(id: string): boolean {
  return Object.prototype.hasOwnProperty.call(ALLOWLIST, id);
}

function resolveEntry(id: string): { absolutePath: string; label: string } {
  const entry = ALLOWLIST[id];
  if (!entry) {
    throw new EditorError(400, `Unknown file id: ${id}`);
  }
  return { absolutePath: entry.absolutePath(), label: entry.label };
}

export class EditorError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

/**
 * Atomic write helper: writes `content` to `<dir>/.<basename>.tmp-<rand>`
 * then renames into place. fs.renameSync is atomic on the same filesystem,
 * which CLAUDE.md and its temp sibling always are. Sets 0o600 perms before
 * rename to match the surrounding store/ permissioning.
 */
export function atomicWrite(absolutePath: string, content: string): void {
  const dir = path.dirname(absolutePath);
  const base = path.basename(absolutePath);
  const tmpName = `.${base}.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
  const tmpPath = path.join(dir, tmpName);
  // Open with O_WRONLY|O_CREAT|O_EXCL so a stale collision can't silently
  // overwrite an in-flight temp file from another writer.
  const fd = fs.openSync(tmpPath, 'wx', 0o600);
  try {
    fs.writeSync(fd, content);
    // fsync the file before rename so a crash post-rename can't expose
    // a zero-byte file (write+rename without fsync is the classic pitfall).
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.renameSync(tmpPath, absolutePath);
  } catch (err) {
    // Clean the temp file on rename failure so we don't leave debris.
    try { fs.unlinkSync(tmpPath); } catch { /* best-effort */ }
    throw err;
  }
}

export function sha256(content: string): string {
  return crypto.createHash('sha256').update(content, 'utf-8').digest('hex');
}

function assertWithinSizeLimit(content: string): void {
  if (Buffer.byteLength(content, 'utf-8') > MAX_AGENT_FILE_BYTES) {
    throw new EditorError(413, 'content exceeds 256 KiB cap');
  }
}

export interface ReadResult {
  id: string;
  label: string;
  path: string;
  content: string;
  contentSha: string;
  exists: boolean;
}

export function readEditableFile(id: string): ReadResult {
  const entry = resolveEntry(id);
  let content = '';
  let exists = false;
  try {
    content = fs.readFileSync(entry.absolutePath, 'utf-8');
    exists = true;
  } catch (err: any) {
    if (err?.code !== 'ENOENT') throw err;
  }
  return {
    id,
    label: entry.label,
    path: entry.absolutePath,
    content,
    contentSha: sha256(content),
    exists,
  };
}

export interface SaveOptions {
  /** Optional Telegram chat id of the operator (for audit trail). */
  editedByChatId?: string | null;
  /** Optional optimistic-concurrency check: if set, must match current sha. */
  expectedSha?: string;
}

export interface SaveResult {
  id: string;
  path: string;
  contentSha: string;
  historyId: number;
  hotReloaded: boolean;
}

export function saveEditableFile(
  id: string,
  newContent: string,
  opts: SaveOptions = {},
): SaveResult {
  const entry = resolveEntry(id);
  assertWithinSizeLimit(newContent);

  // Optimistic concurrency: refuse stale writes if caller passed
  // an expectedSha that no longer matches what's on disk.
  if (opts.expectedSha) {
    let onDisk = '';
    try { onDisk = fs.readFileSync(entry.absolutePath, 'utf-8'); } catch { /* missing */ }
    const onDiskSha = sha256(onDisk);
    if (onDiskSha !== opts.expectedSha) {
      throw new EditorError(
        409,
        `File changed on disk since you loaded it. Refresh and retry.`,
      );
    }
  }

  // Resolve symlinks BEFORE writing so we record the real target. For Sage's
  // main CLAUDE.md this is currently a real file, but recording real_path now
  // means C1.b's symlinked per-agent files share the same code path.
  // realpathSync on a non-existent file throws; fall back to the absolute
  // path the allowlist already resolved.
  let realPath = entry.absolutePath;
  try {
    realPath = fs.realpathSync(entry.absolutePath);
  } catch { /* file may not exist yet; that's fine for first write */ }

  atomicWrite(entry.absolutePath, newContent);
  const contentSha = sha256(newContent);

  const historyId = appendAgentFileHistory({
    filePath: entry.absolutePath,
    realPath,
    content: newContent,
    contentSha,
    editedByChatId: opts.editedByChatId ?? null,
  });

  // Hot-reload: refresh the in-memory systemPrompt for the main agent so a
  // brand-new session (no `resume`) picks up the new rules immediately.
  let hotReloaded = false;
  if (id === MAIN_FILE_ID) {
    try {
      setAgentSystemPrompt(newContent);
      hotReloaded = true;
      logger.info(
        { file: entry.absolutePath, sha: contentSha.slice(0, 12), historyId },
        'Hot-reloaded main CLAUDE.md',
      );
    } catch (err) {
      // Persist won — don't roll back. Just surface the soft failure.
      logger.error({ err }, 'Hot-reload failed; restart required for next NEW session');
    }
  }

  return {
    id,
    path: entry.absolutePath,
    contentSha,
    historyId,
    hotReloaded,
  };
}

/** Read-only glance at the in-memory system prompt (for ops/debug surfaces). */
export function currentSystemPromptSha(): string | null {
  return agentSystemPrompt ? sha256(agentSystemPrompt) : null;
}

export function listHistory(id: string, limit = 50): AgentFileHistoryRow[] {
  const entry = resolveEntry(id);
  return listAgentFileHistory(entry.absolutePath, limit);
}
