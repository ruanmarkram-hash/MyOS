#!/usr/bin/env node
// Unified brain watcher — runs three passes per tick:
//   1. CLAUDE CODE pass: scans ~/.claude/projects/**/*.jsonl for recent edits,
//      parses turn pairs, extracts via Gemini Flash, inserts into OB1.
//      Dedupe via claude_code_turn_cache (raw user+asst fingerprint).
//   2. CODEX pass: scans ~/.codex/archived_sessions/rollout-*.jsonl for recent
//      edits, parses Codex response_item turn pairs, extracts via the same
//      Gemini extractor, inserts into OB1 with source: 'codex'. Shares the
//      same turn-cache table (fingerprint-keyed) with the Claude pass so
//      duplicate captures from cross-engine work get deduped automatically.
//   3. VAULT pass: scans ~/workspace/**/*.md for recent edits, chunks each
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
import { parseTurnPairs, stripInjectedContext, isJsonlIncluded } from './brain-watcher-parser.mjs';
import { embed, vecLit, EMBED_DIM, EMBED_MODEL_NAME } from './lib/embed.mjs';

// ── Config ──────────────────────────────────────────────────────────
const ROOT = '/Users/sc/HQ';
const PROJECTS_DIR = join(homedir(), '.claude', 'projects');
const CODEX_SESSIONS_DIR = join(homedir(), '.codex', 'archived_sessions');
const VAULT_DIR = join(homedir(), 'workspace');
const STATE_DB = join(ROOT, 'store', 'claudeclaw.db');
const LOG_PATH = join(ROOT, 'logs', 'brain-watcher.log');

const MTIME_LOOKBACK_MS = process.env.MTIME_LOOKBACK_MS_OVERRIDE
  ? parseInt(process.env.MTIME_LOOKBACK_MS_OVERRIDE, 10)
  : 20 * 60 * 1000;
const MIN_TURN_CHARS = 200;
const IMPORTANCE_FLOOR = 0.4;
const CHUNK_CHARS = 4000;
const CHUNK_OVERLAP = 400;
// Embedder is BGE-M3 (1024d) via local llama.cpp — see scripts/lib/embed.mjs.
// Do not reintroduce a Gemini 1536d embed path; the OB1 thoughts.embedding
// column is vector(1024) and any 1536d insert is silently dropped.

const JSONL_CONCURRENCY = 8;
const VAULT_CONCURRENCY = 4;

const GEMINI_FLASH_MODEL = 'gemini-2.5-flash';
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';

const VAULT_SKIP_DIRS = new Set(['.git', 'node_modules', '.obsidian', 'dist', '.next', '.cache', '__pycache__', '.vitepress', 'build']);
const VAULT_SKIP_TOP = new Set(['sonke-hub-app', 'sonke-support', 'scratchpad']);

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

async function insertThought({ content, metadata, createdAtSec }) {
  const fp = fingerprint(content);
  const existing = await pool.query('SELECT 1 FROM thoughts WHERE content_fingerprint = $1 LIMIT 1', [fp]);
  if (existing.rowCount > 0) return 'duplicate';
  const emb = await embed(content);
  if (!emb) return 'embed_fail';
  const enrichedMeta = {
    ...metadata,
    embedding_model: EMBED_MODEL_NAME,
    embedding_provider: 'llamacpp',
    embedding_dimensions: EMBED_DIM,
  };
  const res = await pool.query(
    `INSERT INTO thoughts (content, content_fingerprint, metadata, embedding, created_at)
     VALUES ($1, $2, $3::jsonb, $4::vector, to_timestamp($5))
     ON CONFLICT (content_fingerprint) WHERE content_fingerprint IS NOT NULL DO NOTHING
     RETURNING id`,
    [content, fp, JSON.stringify(enrichedMeta), vecLit(emb), createdAtSec]
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

// isJsonlIncluded() lives in ./brain-watcher-parser.mjs so monitor-brain.mjs
// can import the same filter when counting "upstream jsonl files in window".
// Keeping one source of truth prevents the monitor from raising CRITICAL
// "watcher dropping data" alerts on folders the watcher legitimately skips.

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

// parseTurnPairs / stripInjectedContext / eventText live in
// ./brain-watcher-parser.mjs so the parser is unit-testable without
// triggering this script's top-level sqlite / pg / env initialisation.

const EXTRACTION_PROMPT = `You are distilling one conversation turn between a user and an AI coding/agent assistant into a single long-term memory.

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
// ║ PASS 2: CODEX ARCHIVED SESSIONS                                   ║
// ╚═════════════════════════════════════════════════════════════════╝

function walkCodexJsonl(dir, cutoff, out = []) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      // Recurse into subdirs (the new dated tree is ~/.codex/sessions/YYYY/MM/DD/)
      walkCodexJsonl(full, cutoff, out);
    } else if (entry.isFile() && entry.name.startsWith('rollout-') && entry.name.endsWith('.jsonl')) {
      let st; try { st = statSync(full); } catch { continue; }
      if (st.mtimeMs < cutoff) continue;
      out.push({ path: full, mtimeSec: Math.floor(st.mtimeMs / 1000) });
    }
  }
  return out;
}

function discoverRecentCodexJsonl() {
  const cutoff = Date.now() - MTIME_LOOKBACK_MS;
  const out = [];
  // Scan BOTH the old flat dir and the new dated tree so we don't miss sessions
  // after Codex moved its live storage to ~/.codex/sessions/YYYY/MM/DD/.
  const paths = [
    join(homedir(), '.codex', 'archived_sessions'),  // old flat dir
    join(homedir(), '.codex', 'sessions'),           // new dated tree
  ];
  for (const root of paths) {
    walkCodexJsonl(root, cutoff, out);
  }
  return out;
}

// Codex JSONL schema (codex-cli 0.128):
//   { type: 'session_meta', payload: { id, timestamp, cwd, ... } }   // 1 per file
//   { type: 'turn_context', payload: {...} }                          // 1 per file
//   { type: 'response_item', payload: { type: 'message', role, content: [{type, text}, ...] } }
//   { type: 'event_msg',     payload: { type, ... } }                 // task_started, etc.
//
// Roles seen on response_item.message: 'developer' (system scaffolding — skip),
// 'user', 'assistant'. Content blocks have type 'input_text' / 'output_text'
// (the actual prose) plus reasoning/tool blocks we ignore.
function codexMessageText(msgPayload) {
  if (!msgPayload || msgPayload.type !== 'message') return '';
  const content = msgPayload.content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((c) => c && typeof c.text === 'string')
    .map((c) => c.text)
    .join('\n')
    .trim();
}

// Codex 'user' messages frequently contain large auto-injected blocks
// (environment_context, user_instructions, sandbox/permissions notes). These
// are scaffolding, not real user prompts — strip them so extraction sees the
// actual question.
const CODEX_SCAFFOLD_RE = /<(environment_context|user_instructions|app-context|permissions instructions|collaboration_mode|skills_instructions|plugins_instructions)>[\s\S]*?<\/\1>\s*/g;
function stripCodexScaffold(text) {
  if (!text) return text;
  return text.replace(CODEX_SCAFFOLD_RE, '').trim();
}

function parseCodexTurnPairs(filepath) {
  const pairs = [];
  let raw; try { raw = readFileSync(filepath, 'utf-8'); } catch { return { pairs, firstTs: null, sessionId: null }; }
  let userBuf = [], asstBuf = [], firstTs = null, lastState = null, sessionId = null;
  function flush() {
    if (!userBuf.length || !asstBuf.length) return;
    const user = stripInjectedContext(stripCodexScaffold(userBuf.join('\n').trim()));
    const asst = asstBuf.join('\n').trim();
    if (user && asst) pairs.push({ user, asst });
  }
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (!firstTs && o.timestamp) firstTs = o.timestamp;
    if (o.type === 'session_meta' && o.payload?.id) sessionId = o.payload.id;
    if (o.type !== 'response_item') continue;
    const p = o.payload;
    if (!p || p.type !== 'message') continue;
    const role = p.role;
    if (role === 'user') {
      if (lastState === 'assistant') { flush(); userBuf = []; asstBuf = []; }
      const tx = codexMessageText(p);
      if (tx) userBuf.push(tx);
      lastState = 'user';
    } else if (role === 'assistant') {
      const tx = codexMessageText(p);
      if (tx) { asstBuf.push(tx); lastState = 'assistant'; }
    }
    // role === 'developer' / other → ignored (system scaffolding)
  }
  flush();
  return { pairs, firstTs, sessionId };
}

const codexCounters = { files: 0, newTurns: 0, cached: 0, short: 0, lowImp: 0, extractFail: 0, embedFail: 0, inserted: 0, deduped: 0, errors: 0 };

async function processCodexJsonlFile({ path, mtimeSec }) {
  codexCounters.files++;
  const { pairs, firstTs, sessionId: payloadSid } = parseCodexTurnPairs(path);
  // Prefer the session id from session_meta payload; fall back to filename UUID.
  const sessionId = payloadSid || basename(path, '.jsonl').replace(/^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-/, '');
  const fileTsSec = firstTs ? Math.floor(new Date(firstTs).getTime() / 1000) : mtimeSec;

  for (const p of pairs) {
    const turnFp = fingerprint(`${p.user}\n---\n${p.asst}`);
    if (stmtCacheGet.get(turnFp)) { codexCounters.cached++; continue; }
    codexCounters.newTurns++;

    if (p.user.length + p.asst.length < MIN_TURN_CHARS) {
      stmtCachePut.run(turnFp, sessionId, Math.floor(Date.now() / 1000), 0);
      codexCounters.short++;
      continue;
    }
    const ext = await extract(p.user, p.asst);
    if (!ext || ext.skip || typeof ext.importance !== 'number' || ext.importance < IMPORTANCE_FLOOR || !ext.summary || ext.summary.length < 10) {
      stmtCachePut.run(turnFp, sessionId, Math.floor(Date.now() / 1000), 0);
      if (!ext) codexCounters.extractFail++; else codexCounters.lowImp++;
      continue;
    }

    try {
      const result = await insertThought({
        content: ext.summary,
        metadata: {
          source: 'codex',
          session_id: sessionId,
          topics: ext.topics || [],
          importance: ext.importance,
          type: 'codex_watcher',
        },
        createdAtSec: fileTsSec,
      });
      stmtCachePut.run(turnFp, sessionId, Math.floor(Date.now() / 1000), result === 'inserted' ? 1 : 0);
      if (result === 'inserted') codexCounters.inserted++;
      else if (result === 'duplicate') codexCounters.deduped++;
      else codexCounters.embedFail++;
    } catch (err) {
      codexCounters.errors++;
      log(`codex insert error ${sessionId}: ${err.message}`);
    }
  }
}

// ╔═════════════════════════════════════════════════════════════════╗
// ║ PASS 3: WORKSPACE VAULT                                           ║
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
  // Pass 2: Codex archived sessions
  const codexFiles = discoverRecentCodexJsonl();
  log(`tick start | claude=${jsonlFiles.length} codex=${codexFiles.length}`);
  if (jsonlFiles.length > 0) await runPool(jsonlFiles, processJsonlFile, JSONL_CONCURRENCY);
  if (codexFiles.length > 0) await runPool(codexFiles, processCodexJsonlFile, JSONL_CONCURRENCY);

  // Pass 3: workspace vault
  const mdFiles = walkRecentMd(VAULT_DIR, cutoff);
  log(`vault=${mdFiles.length}`);
  if (mdFiles.length > 0) await runPool(mdFiles, processVaultFile, VAULT_CONCURRENCY);

  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  log(`done in ${elapsed}s | claude: files=${jsonlCounters.files} newTurns=${jsonlCounters.newTurns} inserted=${jsonlCounters.inserted} cached=${jsonlCounters.cached} embedFail=${jsonlCounters.embedFail} errors=${jsonlCounters.errors} | codex: files=${codexCounters.files} newTurns=${codexCounters.newTurns} inserted=${codexCounters.inserted} cached=${codexCounters.cached} embedFail=${codexCounters.embedFail} errors=${codexCounters.errors} | vault: files=${vaultCounters.files} chunks=${vaultCounters.chunks} inserted=${vaultCounters.inserted} dup=${vaultCounters.dup} embedFail=${vaultCounters.embedFail}`);

  await pool.end();
  sqlite.close();
}

await main();
