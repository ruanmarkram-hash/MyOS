#!/usr/bin/env node
// Phase 6.5: Historical backfill of ~/.claude/projects/*.jsonl transcripts
// into OB1 thoughts table.
//
// Usage:
//   node scripts/backfill-claude-code.mjs            # full run
//   node scripts/backfill-claude-code.mjs --limit N  # stop after N files (smoke)
//   node scripts/backfill-claude-code.mjs --only FOLDER  # one folder only
//
// Idempotent via claude_code_backfill_state in claudeclaw.db. Safe to resume.

import { readFileSync, readdirSync, statSync, appendFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';
import pg from 'pg';

// ── Config ──────────────────────────────────────────────────────────
const ROOT = '/Users/sagecos1/HQ';
const PROJECTS_DIR = join(homedir(), '.claude', 'projects');
const STATE_DB = join(ROOT, 'store', 'claudeclaw.db');
const LOG_PATH = `/tmp/backfill-${new Date().toISOString().replace(/[:.]/g, '-')}.log`;
const SUMMARY_PATH = '/tmp/backfill-summary.txt';
const NOTIFY = join(ROOT, 'scripts', 'notify.sh');

const CONCURRENCY = 25;
const MIN_TURN_CHARS = 200;
const IMPORTANCE_FLOOR = 0.4;
const GEMINI_FLASH_MODEL = 'gemini-2.5-flash';
const GEMINI_EMBED_MODEL = 'gemini-embedding-001';
const EMBED_DIM = 1536;
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';

// Parse args
const args = process.argv.slice(2);
const getArg = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const limitFiles = parseInt(getArg('--limit') || '0', 10) || 0;
const onlyFolder = getArg('--only');

// Load env
const env = Object.fromEntries(
  readFileSync(`${ROOT}/.env`, 'utf-8').split(/\r?\n/)
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')]; })
);
const GEMINI_KEY = env.GOOGLE_API_KEY;
const PG_URL = env.OB1_SUPABASE_DB_URL;
if (!GEMINI_KEY) throw new Error('GOOGLE_API_KEY missing');
if (!PG_URL) throw new Error('OB1_SUPABASE_DB_URL missing');

// ── Logging ─────────────────────────────────────────────────────────
function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  appendFileSync(LOG_PATH, line + '\n');
}
function notify(msg) {
  try { spawnSync('bash', [NOTIFY, msg], { stdio: 'ignore' }); } catch {}
}

// ── State DB ────────────────────────────────────────────────────────
const sqlite = new Database(STATE_DB);
const stmtIsDone = sqlite.prepare('SELECT completed_at FROM claude_code_backfill_state WHERE filepath = ?');
const stmtUpsert = sqlite.prepare(`
  INSERT INTO claude_code_backfill_state (filepath, last_offset, turns_ingested, completed_at)
  VALUES (?, ?, ?, ?)
  ON CONFLICT (filepath) DO UPDATE SET
    last_offset = excluded.last_offset,
    turns_ingested = excluded.turns_ingested,
    completed_at = excluded.completed_at
`);

// ── Postgres pool ───────────────────────────────────────────────────
const pool = new pg.Pool({ connectionString: PG_URL, max: 10 });

// ── Folder discovery ────────────────────────────────────────────────
function isIncluded(folderName) {
  if (folderName.includes('claude-worktrees')) return false;
  // strip "-Users-sagecos1" prefix, then check against inclusion set
  const stripped = folderName
    .replace(/^-Users-sagecos1-?-?/, '')
    .replace(/^-/, '');
  if (stripped === '') return true;              // bare home dir
  if (/^HQ(-|$)/.test(stripped)) return true;    // HQ or HQ-agents-*
  if (/^sonke-hub/.test(stripped)) return true;
  if (/^openclaw/.test(stripped)) return true;
  return false;
}

function discoverFiles() {
  const out = [];
  for (const folder of readdirSync(PROJECTS_DIR)) {
    if (!isIncluded(folder)) continue;
    if (onlyFolder && folder !== onlyFolder) continue;
    const fullFolder = join(PROJECTS_DIR, folder);
    let st;
    try { st = statSync(fullFolder); } catch { continue; }
    if (!st.isDirectory()) continue;
    for (const name of readdirSync(fullFolder)) {
      if (!name.endsWith('.jsonl')) continue;
      out.push({ folder, path: join(fullFolder, name) });
    }
  }
  return out;
}

// ── Content extraction from a JSONL event ──────────────────────────
function eventText(evt) {
  const msg = evt?.message;
  if (!msg) return '';
  const c = msg.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    return c
      .filter((b) => b?.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('\n');
  }
  return '';
}

// Strip [Memory context]/[Team activity]/[Conversation history recall] and Obsidian
// blocks that ClaudeClaw prepends to user messages. Returns the real user intent.
function stripInjectedContext(text) {
  if (!text) return text;
  let s = text;
  // Remove blocks [Foo] ... [End Foo]
  s = s.replace(/\[(Memory context|Team activity[^\]]*|Conversation history recall|Obsidian context)\][\s\S]*?\[End[^\]]+\]\s*/g, '');
  return s.trim();
}

// ── Parse JSONL into turn pairs ────────────────────────────────────
function parseTurnPairs(filepath) {
  const pairs = [];
  let raw;
  try { raw = readFileSync(filepath, 'utf-8'); } catch { return { pairs, firstTs: null }; }
  const lines = raw.split('\n');

  let userBuf = [];
  let asstBuf = [];
  let firstTs = null;
  let lastState = null; // 'user' | 'assistant' | null

  function flush() {
    if (userBuf.length === 0 || asstBuf.length === 0) return;
    const user = stripInjectedContext(userBuf.join('\n').trim());
    const asst = asstBuf.join('\n').trim();
    if (!user || !asst) return;
    pairs.push({ user, asst });
  }

  for (const line of lines) {
    if (!line.trim()) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    if (!firstTs && o.timestamp) firstTs = o.timestamp;

    const t = o.type;
    if (t === 'user') {
      if (lastState === 'assistant') {
        // turn boundary: flush the completed turn
        flush();
        userBuf = [];
        asstBuf = [];
      }
      const tx = eventText(o);
      if (tx) userBuf.push(tx);
      lastState = 'user';
    } else if (t === 'assistant') {
      const tx = eventText(o);
      if (tx) asstBuf.push(tx);
      lastState = 'assistant';
    }
    // ignore queue-operation, system, etc.
  }
  // final turn
  flush();

  return { pairs, firstTs };
}

// ── Gemini Flash extraction ─────────────────────────────────────────
const EXTRACTION_PROMPT = `You are distilling one conversation turn between a user and a Claude Code AI coding assistant into a single long-term memory.

Return JSON with this exact shape:
{"skip": boolean, "importance": number 0-1, "summary": "1-2 sentence fact or rule (no 'the user said...')", "topics": ["topic1", "topic2"]}

SKIP (importance < 0.4) if the turn is:
- Pure tool invocation chatter, shell output, or file listings
- Short acknowledgments or commands with no lasting context
- Ephemeral one-off lookups ("what's in this folder", "show me this file")
- Session summaries or recaps
- Troubleshooting that was resolved and is no longer relevant
- Code changes without architectural meaning

EXTRACT (importance >= 0.4) if the turn reveals:
- Architectural decisions, patterns, design rules (0.7-1.0)
- User preferences, habits, or standing policies (0.7-1.0)
- Project-specific context that future sessions will need (0.5-0.7)
- Technical configuration facts (file paths, env vars, endpoints) (0.5-0.7)
- Important domain knowledge (NDIS rules, business logic) (0.6-0.8)
- Reusable approaches, idioms, or library choices (0.4-0.6)

Write summary as a STANDALONE FACT. Not narrative. Not "the user wants..." or "Claude helped...".

User: {USER}
Assistant: {ASSISTANT}`;

async function extract(userText, asstText, retries = 3) {
  const prompt = EXTRACTION_PROMPT
    .replace('{USER}', userText.slice(0, 4000))
    .replace('{ASSISTANT}', asstText.slice(0, 4000));

  for (let i = 0; i < retries; i++) {
    try {
      const r = await fetch(
        `${GEMINI_BASE}/models/${GEMINI_FLASH_MODEL}:generateContent?key=${GEMINI_KEY}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
            generationConfig: { responseMimeType: 'application/json', temperature: 0 },
          }),
        }
      );
      if (r.status === 503 || r.status === 429) {
        if (i === retries - 1) return null;
        await new Promise((res) => setTimeout(res, 1000 * Math.pow(2, i)));
        continue;
      }
      if (!r.ok) return null;
      const j = await r.json();
      const txt = j?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!txt) return null;
      const parsed = JSON.parse(txt);
      if (typeof parsed.importance !== 'number') return null;
      return parsed;
    } catch {
      if (i === retries - 1) return null;
      await new Promise((res) => setTimeout(res, 1000 * Math.pow(2, i)));
    }
  }
  return null;
}

async function embed(text, retries = 2) {
  for (let i = 0; i < retries; i++) {
    try {
      const r = await fetch(
        `${GEMINI_BASE}/models/${GEMINI_EMBED_MODEL}:embedContent?key=${GEMINI_KEY}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            content: { parts: [{ text }] },
            outputDimensionality: EMBED_DIM,
          }),
        }
      );
      if (!r.ok) {
        if (i === retries - 1) return null;
        await new Promise((res) => setTimeout(res, 500 * Math.pow(2, i)));
        continue;
      }
      const j = await r.json();
      const v = j?.embedding?.values;
      if (Array.isArray(v) && v.length === EMBED_DIM) return v;
      return null;
    } catch {
      if (i === retries - 1) return null;
      await new Promise((res) => setTimeout(res, 500 * Math.pow(2, i)));
    }
  }
  return null;
}

function fingerprint(text) {
  const norm = text.toLowerCase().trim().replace(/\s+/g, ' ');
  return createHash('sha256').update(norm, 'utf8').digest('hex');
}

function vecLit(v) { return '[' + v.join(',') + ']'; }

async function insertThought({ summary, embedding, metadata, createdAtSec }) {
  const sql = `
    INSERT INTO thoughts (content, content_fingerprint, metadata, embedding, created_at)
    VALUES ($1, $2, $3::jsonb, $4::vector, to_timestamp($5))
    ON CONFLICT (content_fingerprint) WHERE content_fingerprint IS NOT NULL DO NOTHING
    RETURNING id
  `;
  const res = await pool.query(sql, [summary, fingerprint(summary), JSON.stringify(metadata), vecLit(embedding), createdAtSec]);
  return res.rowCount > 0;
}

// ── Per-file processing ─────────────────────────────────────────────
const counters = {
  files: 0,
  filesCompleted: 0,
  filesSkipped: 0,
  turns: 0,
  turnsShort: 0,
  turnsLowImportance: 0,
  turnsExtractFailed: 0,
  turnsEmbedFailed: 0,
  thoughts: 0,
  insertErrors: 0,
};

async function processFile({ folder, path }) {
  const done = stmtIsDone.get(path);
  if (done?.completed_at) {
    counters.filesSkipped++;
    return;
  }

  const { pairs, firstTs } = parseTurnPairs(path);
  const fileTsSec = firstTs
    ? Math.floor(new Date(firstTs).getTime() / 1000)
    : Math.floor(statSync(path).mtimeMs / 1000);

  let turnsIngested = 0;

  for (const p of pairs) {
    counters.turns++;
    const combined = `${p.user}\n${p.asst}`;
    if (combined.length < MIN_TURN_CHARS) {
      counters.turnsShort++;
      continue;
    }

    const ext = await extract(p.user, p.asst);
    if (!ext || ext.skip || typeof ext.importance !== 'number' || ext.importance < IMPORTANCE_FLOOR) {
      if (!ext) counters.turnsExtractFailed++;
      else counters.turnsLowImportance++;
      continue;
    }

    if (!ext.summary || typeof ext.summary !== 'string' || ext.summary.length < 10) {
      counters.turnsLowImportance++;
      continue;
    }

    const emb = await embed(ext.summary);
    if (!emb) { counters.turnsEmbedFailed++; continue; }

    try {
      const ok = await insertThought({
        summary: ext.summary,
        embedding: emb,
        createdAtSec: fileTsSec,
        metadata: {
          source: 'claude_code',
          working_dir: folder,
          session_id: basename(path, '.jsonl'),
          topics: ext.topics || [],
          importance: ext.importance,
          type: 'claude_code_backfill',
        },
      });
      if (ok) {
        turnsIngested++;
        counters.thoughts++;
      }
    } catch (err) {
      counters.insertErrors++;
      log(`  insert error for ${basename(path)}: ${err.message}`);
    }
  }

  stmtUpsert.run(path, pairs.length, turnsIngested, Math.floor(Date.now() / 1000));
  counters.filesCompleted++;

  if (counters.filesCompleted % 50 === 0) {
    log(`progress: ${counters.filesCompleted} files processed (skipped ${counters.filesSkipped}) | ${counters.thoughts} thoughts captured | turns: ${counters.turns} seen, ${counters.turnsShort} short, ${counters.turnsLowImportance} low-imp, ${counters.turnsExtractFailed} extract-fail, ${counters.turnsEmbedFailed} embed-fail`);
  }
  if (counters.filesCompleted % 200 === 0) {
    notify(`Backfill: ${counters.filesCompleted}/${counters.files} files, ${counters.thoughts} thoughts captured`);
  }
}

// ── Concurrency limiter ─────────────────────────────────────────────
async function runPool(items, worker, concurrency) {
  let idx = 0;
  const workers = Array(concurrency).fill(null).map(async () => {
    while (idx < items.length) {
      const i = idx++;
      try { await worker(items[i]); }
      catch (err) { log(`worker error: ${err.message}`); }
    }
  });
  await Promise.all(workers);
}

// ── Main ────────────────────────────────────────────────────────────
async function main() {
  log(`starting backfill`);
  log(`log file: ${LOG_PATH}`);
  const allFiles = discoverFiles();
  counters.files = allFiles.length;
  log(`discovered ${allFiles.length} files across ${new Set(allFiles.map((f) => f.folder)).size} folders`);

  const files = limitFiles > 0 ? allFiles.slice(0, limitFiles) : allFiles;
  if (limitFiles > 0) log(`LIMIT: ${limitFiles} files`);
  if (onlyFolder) log(`ONLY folder: ${onlyFolder}`);

  const alreadyDone = sqlite.prepare('SELECT COUNT(*) AS n FROM claude_code_backfill_state WHERE completed_at IS NOT NULL').get().n;
  log(`state table: ${alreadyDone} files already marked complete`);

  const started = Date.now();
  notify(`Backfill started: ${files.length} files queued, ${alreadyDone} already done`);

  await runPool(files, processFile, CONCURRENCY);

  const elapsed = ((Date.now() - started) / 1000 / 60).toFixed(1);

  const summary = [
    `Claude Code backfill summary`,
    `Started: ${new Date(started).toISOString()}`,
    `Finished: ${new Date().toISOString()}`,
    `Elapsed: ${elapsed} min`,
    ``,
    `Files discovered: ${counters.files}`,
    `Files processed this run: ${counters.filesCompleted}`,
    `Files skipped (already done): ${counters.filesSkipped}`,
    ``,
    `Turn pairs seen: ${counters.turns}`,
    `  too short (<${MIN_TURN_CHARS} chars): ${counters.turnsShort}`,
    `  low-importance (<${IMPORTANCE_FLOOR}): ${counters.turnsLowImportance}`,
    `  extraction failed: ${counters.turnsExtractFailed}`,
    `  embedding failed: ${counters.turnsEmbedFailed}`,
    ``,
    `Thoughts captured: ${counters.thoughts}`,
    `Insert errors: ${counters.insertErrors}`,
  ].join('\n');
  writeFileSync(SUMMARY_PATH, summary);
  log('\n' + summary);
  notify(`Backfill complete: ${counters.filesCompleted} files, ${counters.thoughts} thoughts in ${elapsed} min`);

  await pool.end();
  sqlite.close();
}

await main();
