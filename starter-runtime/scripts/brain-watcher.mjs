#!/usr/bin/env node
// Unified brain watcher — runs two passes per tick:
//   1. CLAUDE CODE pass: scans ~/.claude/projects/**/*.jsonl for recent edits,
//      parses turn pairs, extracts via Gemini Flash, inserts into OB1.
//      Dedupe via claude_code_turn_cache (raw user+asst fingerprint).
//   2. VAULT pass: scans ~/workspace/**/*.md for recent edits, chunks each
//      file, embeds, inserts into OB1. Dedupe via content_fingerprint on
//      thoughts table (the same pre-check pattern the one-off import uses).
//
// One tick every 10 min via launchd (com.claudeclaw.brain-watcher.plist).

import { readFileSync, readdirSync, statSync, appendFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, basename, relative } from 'node:path';
import { homedir } from 'node:os';
import Database from 'better-sqlite3';
import pg from 'pg';

// ── Config ──────────────────────────────────────────────────────────
const ROOT = process.env.HOME + '/claudeclaw';
const PROJECTS_DIR = join(homedir(), '.claude', 'projects');
const VAULT_DIR = join(homedir(), 'workspace');
const STATE_DB = join(ROOT, 'store', 'claudeclaw.db');
const LOG_PATH = join(ROOT, 'logs', 'brain-watcher.log');

const MTIME_LOOKBACK_MS = 20 * 60 * 1000;
const MIN_TURN_CHARS = 200;
const IMPORTANCE_FLOOR = 0.4;
const CHUNK_CHARS = 4000;
const CHUNK_OVERLAP = 400;
const EMBED_DIM = 1536;

const JSONL_CONCURRENCY = 8;
const VAULT_CONCURRENCY = 4;

const GEMINI_FLASH_MODEL = 'gemini-2.5-flash';
const GEMINI_EMBED_MODEL = 'gemini-embedding-001';
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';

const VAULT_SKIP_DIRS = new Set(['.git', 'node_modules', '.obsidian', 'dist', '.next', '.cache', '__pycache__', '.vitepress', 'build']);
// Top-level folders inside ~/workspace/ that the watcher should skip.
// 'scratchpad' is ephemeral, auto-purged after 7 days. Add any large
// source-code trees here if you don't want them ingested as memories.
const VAULT_SKIP_TOP = new Set(['scratchpad']);

// ── Env / handles ───────────────────────────────────────────────────
const env = Object.fromEntries(
  readFileSync(`${ROOT}/.env`, 'utf-8').split(/\r?\n/)
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')]; })
);
const GEMINI_KEY = env.GOOGLE_API_KEY;
const PG_URL = env.OB1_SUPABASE_DB_URL;
if (!GEMINI_KEY || !PG_URL) { console.error('missing GOOGLE_API_KEY / OB1_SUPABASE_DB_URL'); process.exit(1); }

const sqlite = new Database(STATE_DB);
const stmtCacheGet = sqlite.prepare('SELECT 1 FROM claude_code_turn_cache WHERE turn_fp = ?');
const stmtCachePut = sqlite.prepare('INSERT OR IGNORE INTO claude_code_turn_cache (turn_fp, session_id, processed_at, ingested) VALUES (?, ?, ?, ?)');

const pool = new pg.Pool({ connectionString: PG_URL, max: 8 });

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try { appendFileSync(LOG_PATH, line + '\n'); } catch {}
}

// ── Shared helpers ──────────────────────────────────────────────────
function fingerprint(text) {
  return createHash('sha256').update(text.toLowerCase().trim().replace(/\s+/g, ' '), 'utf8').digest('hex');
}
function vecLit(v) { return '[' + v.join(',') + ']'; }

async function embed(text, retries = 2) {
  for (let i = 0; i < retries; i++) {
    try {
      const r = await fetch(`${GEMINI_BASE}/models/${GEMINI_EMBED_MODEL}:embedContent?key=${GEMINI_KEY}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: { parts: [{ text: text.slice(0, 10000) }] }, outputDimensionality: EMBED_DIM }),
      });
      if (!r.ok) { if (i === retries - 1) return null; await new Promise((res) => setTimeout(res, 500 * Math.pow(2, i))); continue; }
      const j = await r.json();
      const v = j?.embedding?.values;
      if (Array.isArray(v) && v.length === EMBED_DIM) return v;
      return null;
    } catch { if (i === retries - 1) return null; await new Promise((res) => setTimeout(res, 500 * Math.pow(2, i))); }
  }
  return null;
}

async function insertThought({ content, metadata, createdAtSec }) {
  const fp = fingerprint(content);
  const existing = await pool.query('SELECT 1 FROM thoughts WHERE content_fingerprint = $1 LIMIT 1', [fp]);
  if (existing.rowCount > 0) return 'duplicate';
  const emb = await embed(content);
  if (!emb) return 'embed_fail';
  const res = await pool.query(
    `INSERT INTO thoughts (content, content_fingerprint, metadata, embedding, created_at)
     VALUES ($1, $2, $3::jsonb, $4::vector, to_timestamp($5))
     ON CONFLICT (content_fingerprint) WHERE content_fingerprint IS NOT NULL DO NOTHING
     RETURNING id`,
    [content, fp, JSON.stringify(metadata), vecLit(emb), createdAtSec]
  );
  return res.rowCount > 0 ? 'inserted' : 'duplicate';
}

async function runPool(items, worker, n) {
  let i = 0;
  await Promise.all(Array(n).fill(null).map(async () => {
    while (i < items.length) {
      const idx = i++;
      try { await worker(items[idx]); } catch (e) { log('worker err: ' + e.message); }
    }
  }));
}

// ╔═════════════════════════════════════════════════════════════════╗
// ║ PASS 1: CLAUDE CODE JSONL                                         ║
// ╚═════════════════════════════════════════════════════════════════╝

// Decide whether a Claude Code JSONL project folder should be ingested.
// Claude Code stores each project's conversation JSONL under
// ~/.claude/projects/<encoded-path>/ — the folder name is the project
// directory with slashes replaced by dashes. By default we include the
// user's home (their default `claude` launch) and any `claudeclaw` /
// `workspace` folders. Adjust to include other project roots you want
// the watcher to learn from.
function isJsonlIncluded(folderName) {
  if (folderName.includes('claude-worktrees')) return false;
  const home = (process.env.HOME || '').replace(/\//g, '-');
  const stripped = folderName.replace(new RegExp(`^${home}-?-?`), '').replace(/^-/, '');
  if (stripped === '') return true; // home-root session
  if (/^claudeclaw(-|$)/.test(stripped)) return true;
  if (/^workspace(-|$)/.test(stripped)) return true;
  return false;
}

function discoverRecentJsonl() {
  const cutoff = Date.now() - MTIME_LOOKBACK_MS;
  const out = [];
  for (const folder of readdirSync(PROJECTS_DIR)) {
    if (!isJsonlIncluded(folder)) continue;
    const dir = join(PROJECTS_DIR, folder);
    let dstat; try { dstat = statSync(dir); } catch { continue; }
    if (!dstat.isDirectory()) continue;
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.jsonl')) continue;
      const path = join(dir, name);
      let st; try { st = statSync(path); } catch { continue; }
      if (st.mtimeMs < cutoff) continue;
      out.push({ folder, path, mtimeSec: Math.floor(st.mtimeMs / 1000) });
    }
  }
  return out;
}

function eventText(evt) {
  const msg = evt?.message;
  if (!msg) return '';
  const c = msg.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n');
  return '';
}

function stripInjectedContext(text) {
  if (!text) return text;
  return text.replace(/\[(Memory context|Team activity[^\]]*|Conversation history recall|Obsidian context)\][\s\S]*?\[End[^\]]+\]\s*/g, '').trim();
}

function parseTurnPairs(filepath) {
  const pairs = [];
  let raw; try { raw = readFileSync(filepath, 'utf-8'); } catch { return { pairs, firstTs: null }; }
  let userBuf = [], asstBuf = [], firstTs = null, lastState = null;
  function flush() {
    if (!userBuf.length || !asstBuf.length) return;
    const user = stripInjectedContext(userBuf.join('\n').trim());
    const asst = asstBuf.join('\n').trim();
    if (user && asst) pairs.push({ user, asst });
  }
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (!firstTs && o.timestamp) firstTs = o.timestamp;
    const t = o.type;
    if (t === 'user') {
      if (lastState === 'assistant') { flush(); userBuf = []; asstBuf = []; }
      const tx = eventText(o); if (tx) userBuf.push(tx);
      lastState = 'user';
    } else if (t === 'assistant') {
      const tx = eventText(o); if (tx) asstBuf.push(tx);
      lastState = 'assistant';
    }
  }
  flush();
  return { pairs, firstTs };
}

const EXTRACTION_PROMPT = `You are distilling one conversation turn between a user and a Claude Code AI coding assistant into a single long-term memory.

Return JSON with this exact shape:
{"skip": boolean, "importance": number 0-1, "summary": "1-2 sentence fact or rule (no 'the user said...')", "topics": ["topic1", "topic2"]}

SKIP (importance < 0.4) if the turn is pure tool chatter, ephemeral lookup, short acknowledgment, session summary, or code change without architectural meaning.
EXTRACT if it reveals: architectural decisions (0.7-1.0), user preferences/standing policies (0.7-1.0), project context (0.5-0.7), config facts (0.5-0.7), domain knowledge (0.6-0.8), reusable idioms (0.4-0.6).

Write summary as a STANDALONE FACT. Not narrative.

User: {USER}
Assistant: {ASSISTANT}`;

async function extract(userText, asstText, retries = 3) {
  const prompt = EXTRACTION_PROMPT.replace('{USER}', userText.slice(0, 4000)).replace('{ASSISTANT}', asstText.slice(0, 4000));
  for (let i = 0; i < retries; i++) {
    try {
      const r = await fetch(`${GEMINI_BASE}/models/${GEMINI_FLASH_MODEL}:generateContent?key=${GEMINI_KEY}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: { responseMimeType: 'application/json', temperature: 0 },
        }),
      });
      if (r.status === 429 || r.status === 503) { if (i === retries - 1) return null; await new Promise((res) => setTimeout(res, 1000 * Math.pow(2, i))); continue; }
      if (!r.ok) return null;
      const j = await r.json();
      const txt = j?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!txt) return null;
      const parsed = JSON.parse(txt);
      if (typeof parsed.importance !== 'number') return null;
      return parsed;
    } catch { if (i === retries - 1) return null; await new Promise((res) => setTimeout(res, 1000 * Math.pow(2, i))); }
  }
  return null;
}

const jsonlCounters = { files: 0, newTurns: 0, cached: 0, short: 0, lowImp: 0, extractFail: 0, embedFail: 0, inserted: 0, deduped: 0, errors: 0 };

async function processJsonlFile({ folder, path, mtimeSec }) {
  jsonlCounters.files++;
  const sessionId = basename(path, '.jsonl');
  const { pairs, firstTs } = parseTurnPairs(path);
  const fileTsSec = firstTs ? Math.floor(new Date(firstTs).getTime() / 1000) : mtimeSec;

  for (const p of pairs) {
    const turnFp = fingerprint(`${p.user}\n---\n${p.asst}`);
    if (stmtCacheGet.get(turnFp)) { jsonlCounters.cached++; continue; }
    jsonlCounters.newTurns++;

    if (p.user.length + p.asst.length < MIN_TURN_CHARS) {
      stmtCachePut.run(turnFp, sessionId, Math.floor(Date.now() / 1000), 0);
      jsonlCounters.short++;
      continue;
    }
    const ext = await extract(p.user, p.asst);
    if (!ext || ext.skip || typeof ext.importance !== 'number' || ext.importance < IMPORTANCE_FLOOR || !ext.summary || ext.summary.length < 10) {
      stmtCachePut.run(turnFp, sessionId, Math.floor(Date.now() / 1000), 0);
      if (!ext) jsonlCounters.extractFail++; else jsonlCounters.lowImp++;
      continue;
    }

    try {
      const result = await insertThought({
        content: ext.summary,
        metadata: {
          source: 'claude_code',
          working_dir: folder,
          session_id: sessionId,
          topics: ext.topics || [],
          importance: ext.importance,
          type: 'claude_code_watcher',
        },
        createdAtSec: fileTsSec,
      });
      stmtCachePut.run(turnFp, sessionId, Math.floor(Date.now() / 1000), result === 'inserted' ? 1 : 0);
      if (result === 'inserted') jsonlCounters.inserted++;
      else if (result === 'duplicate') jsonlCounters.deduped++;
      else jsonlCounters.embedFail++;
    } catch (err) {
      jsonlCounters.errors++;
      log(`jsonl insert error ${sessionId}: ${err.message}`);
    }
  }
}

// ╔═════════════════════════════════════════════════════════════════╗
// ║ PASS 2: WORKSPACE VAULT                                           ║
// ╚═════════════════════════════════════════════════════════════════╝

function walkRecentMd(dir, cutoff, out = []) {
  let entries; try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name.startsWith('.') && entry.name !== '.') continue;
      if (VAULT_SKIP_DIRS.has(entry.name)) continue;
      const rel = relative(VAULT_DIR, full);
      if (VAULT_SKIP_TOP.has(rel.split('/')[0])) continue;
      walkRecentMd(full, cutoff, out);
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      let st; try { st = statSync(full); } catch { continue; }
      if (st.mtimeMs < cutoff) continue;
      out.push({ path: full, mtimeMs: st.mtimeMs });
    }
  }
  return out;
}

function chunkText(text) {
  if (text.length <= CHUNK_CHARS + 500) return [{ text, idx: 0, total: 1 }];
  const chunks = [];
  let remaining = text;
  let idx = 0;
  while (remaining.length > 0) {
    let end = Math.min(remaining.length, CHUNK_CHARS);
    if (end < remaining.length) {
      const lastBreak = remaining.lastIndexOf('\n\n', end);
      if (lastBreak > CHUNK_CHARS / 2) end = lastBreak;
    }
    chunks.push({ text: remaining.slice(0, end).trim(), idx, total: -1 });
    if (end === remaining.length) break;
    remaining = remaining.slice(Math.max(0, end - CHUNK_OVERLAP));
    idx++;
  }
  return chunks.filter((c) => c.text.length >= 80).map((c, _, all) => ({ ...c, total: all.length }));
}

function classifyVaultPath(rel) {
  const top = rel.split('/')[0];
  const known = { memory: 'memory', knowledge: 'knowledge', projects: 'project', decisions: 'decision', compliance: 'compliance', operations: 'operations', archive: 'archive' };
  return known[top] || 'vault';
}

// Detect base64 image payloads or other non-text garbage. Obsidian / pasted
// screenshots get embedded inline in markdown; those chunks are useless.
function isGarbageChunk(text) {
  // Long unbroken alphanumeric runs = base64 image data
  if (/[A-Za-z0-9+/=]{500,}/.test(text)) return true;
  // Very low whitespace density = binary or base64
  const ws = (text.match(/\s/g) || []).length;
  if (text.length > 400 && ws / text.length < 0.03) return true;
  return false;
}

const vaultCounters = { files: 0, chunks: 0, inserted: 0, dup: 0, embedFail: 0 };

async function processVaultFile({ path, mtimeMs }) {
  let content; try { content = readFileSync(path, 'utf-8'); } catch { return; }
  if (!content.trim() || content.trim().length < 50) return;

  const rel = relative(VAULT_DIR, path);
  const createdAtSec = Math.floor(mtimeMs / 1000);
  const chunks = chunkText(content);

  for (const chunk of chunks) {
    vaultCounters.chunks++;
    if (isGarbageChunk(chunk.text)) { vaultCounters.dup++; continue; }
    const result = await insertThought({
      content: chunk.text,
      metadata: {
        source: 'workspace_vault',
        path: rel,
        type: classifyVaultPath(rel),
        chunk_idx: chunk.idx,
        chunk_total: chunk.total,
        mtime: new Date(mtimeMs).toISOString(),
      },
      createdAtSec,
    });
    if (result === 'inserted') vaultCounters.inserted++;
    else if (result === 'duplicate') vaultCounters.dup++;
    else vaultCounters.embedFail++;
  }
  vaultCounters.files++;
}

// ── Main ─────────────────────────────────────────────────────────────
async function main() {
  const started = Date.now();
  const cutoff = Date.now() - MTIME_LOOKBACK_MS;

  // Pass 1: Claude Code JSONL
  const jsonlFiles = discoverRecentJsonl();
  log(`tick start | jsonl=${jsonlFiles.length}`);
  if (jsonlFiles.length > 0) await runPool(jsonlFiles, processJsonlFile, JSONL_CONCURRENCY);

  // Pass 2: workspace vault
  const mdFiles = walkRecentMd(VAULT_DIR, cutoff);
  log(`vault=${mdFiles.length}`);
  if (mdFiles.length > 0) await runPool(mdFiles, processVaultFile, VAULT_CONCURRENCY);

  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  log(`done in ${elapsed}s | jsonl: files=${jsonlCounters.files} newTurns=${jsonlCounters.newTurns} inserted=${jsonlCounters.inserted} cached=${jsonlCounters.cached} embedFail=${jsonlCounters.embedFail} errors=${jsonlCounters.errors} | vault: files=${vaultCounters.files} chunks=${vaultCounters.chunks} inserted=${vaultCounters.inserted} dup=${vaultCounters.dup} embedFail=${vaultCounters.embedFail}`);

  await pool.end();
  sqlite.close();
}

await main();
