#!/usr/bin/env node
// Import ~/workspace/ markdown vault into OB1 thoughts table.
// - Reads every *.md under ~/workspace/
// - Skips noisy/generated folders (.git, node_modules, .obsidian, dist)
// - Chunks files >8000 chars into overlapping sections
// - Embeds with Gemini + direct pg insert + fingerprint dedup
// - Preserves file mtime as created_at, path + mtime in metadata
//
// Idempotent: fingerprint unique constraint skips already-ingested chunks.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, relative } from 'node:path';
import { homedir } from 'node:os';
import pg from 'pg';
import { embed, vecLit, EMBED_DIM, EMBED_MODEL_NAME } from './lib/embed.mjs';

const ROOT = '~/HQ';
const VAULT = join(homedir(), 'workspace');
const CHUNK_CHARS = 4000;           // aim for ~1000 tokens per chunk
const CHUNK_OVERLAP = 400;
const CONCURRENCY = parseInt(process.env.IMPORT_CONCURRENCY || '6', 10);

const SKIP_DIRS = new Set([
  '.git', 'node_modules', '.obsidian', 'dist', '.next', '.cache',
  '__pycache__', '.vitepress', 'build',
]);
const SKIP_FOLDERS_REL = new Set([
  'sonke-hub-app',    // full code tree, already in git
  'sonke-support',    // legacy code tree
  'scratchpad',       // ephemeral
]);

const env = Object.fromEntries(
  readFileSync(`${ROOT}/.env`, 'utf-8').split(/\r?\n/)
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')]; })
);
const PG_URL = env.OB1_SUPABASE_DB_URL;

const pool = new pg.Pool({ connectionString: PG_URL, max: 8 });

function walk(dir, out = []) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    if (entry.name.startsWith('.') && entry.name !== '.') {
      // allow dotfiles like .env.example but skip dotdirs like .git
      if (entry.isDirectory()) continue;
    }
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const rel = relative(VAULT, full);
      const topSegment = rel.split('/')[0];
      if (SKIP_FOLDERS_REL.has(topSegment)) continue;
      walk(full, out);
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      out.push(full);
    }
  }
  return out;
}

function chunkText(text, path) {
  // Keep small files whole.
  if (text.length <= CHUNK_CHARS + 500) return [{ text, idx: 0, total: 1 }];

  // Try to split on heading boundaries first for readability.
  const chunks = [];
  let remaining = text;
  let idx = 0;
  while (remaining.length > 0) {
    let end = Math.min(remaining.length, CHUNK_CHARS);
    if (end < remaining.length) {
      // Prefer ending at a double-newline or heading boundary
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

function fingerprint(text) {
  return createHash('sha256').update(text.toLowerCase().trim().replace(/\s+/g, ' '), 'utf8').digest('hex');
}

async function insertThought({ content, metadata, createdAtSec }) {
  const fp = fingerprint(content);
  // Pre-check: skip embed call if fingerprint already exists (avoids wasted spend + rate-limit hits on rerun)
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
  const sql = `
    INSERT INTO thoughts (content, content_fingerprint, metadata, embedding, created_at)
    VALUES ($1, $2, $3::jsonb, $4::vector, to_timestamp($5))
    ON CONFLICT (content_fingerprint) WHERE content_fingerprint IS NOT NULL DO NOTHING
    RETURNING id
  `;
  const res = await pool.query(sql, [content, fp, JSON.stringify(enrichedMeta), vecLit(emb), createdAtSec]);
  return res.rowCount > 0 ? 'inserted' : 'duplicate';
}

function classifyPath(rel) {
  const top = rel.split('/')[0];
  const known = {
    memory: 'memory',
    knowledge: 'knowledge',
    projects: 'project',
    decisions: 'decision',
    compliance: 'compliance',
    operations: 'operations',
    archive: 'archive',
  };
  return known[top] || 'vault';
}

function isGarbageChunk(text) {
  if (/[A-Za-z0-9+/=]{500,}/.test(text)) return true;
  const ws = (text.match(/\s/g) || []).length;
  if (text.length > 400 && ws / text.length < 0.03) return true;
  return false;
}

const counters = { files: 0, chunks: 0, inserted: 0, duplicate: 0, embedFail: 0, skipEmpty: 0 };

async function processFile(path) {
  let content;
  try { content = readFileSync(path, 'utf-8'); }
  catch { return; }
  if (!content.trim() || content.trim().length < 50) { counters.skipEmpty++; return; }

  let stat;
  try { stat = statSync(path); } catch { return; }
  const createdAtSec = Math.floor(stat.mtimeMs / 1000);
  const rel = relative(VAULT, path);
  const chunks = chunkText(content, rel);

  for (const chunk of chunks) {
    counters.chunks++;
    if (isGarbageChunk(chunk.text)) { counters.skipEmpty++; continue; }
    const metadata = {
      source: 'workspace_vault',
      path: rel,
      type: classifyPath(rel),
      chunk_idx: chunk.idx,
      chunk_total: chunk.total,
      mtime: new Date(stat.mtimeMs).toISOString(),
    };
    try {
      const result = await insertThought({
        content: chunk.text,
        metadata,
        createdAtSec,
      });
      if (result === 'inserted') counters.inserted++;
      else if (result === 'duplicate') counters.duplicate++;
      else counters.embedFail++;
    } catch (err) {
      console.error(`insert error ${rel}#${chunk.idx}: ${err.message}`);
    }
  }
  counters.files++;
  if (counters.files % 50 === 0) {
    console.log(`progress: ${counters.files} files | chunks=${counters.chunks} inserted=${counters.inserted} dup=${counters.duplicate} embedFail=${counters.embedFail}`);
  }
}

async function runPool(items, worker, n) {
  let i = 0;
  await Promise.all(Array(n).fill(null).map(async () => {
    while (i < items.length) {
      const idx = i++;
      try { await worker(items[idx]); } catch (err) { console.error('worker error:', err.message); }
    }
  }));
}

async function main() {
  const started = Date.now();
  console.log(`walking ${VAULT}...`);
  const files = walk(VAULT);
  console.log(`found ${files.length} markdown files`);

  await runPool(files, processFile, CONCURRENCY);

  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  console.log('\n--- SUMMARY ---');
  console.log(`Elapsed: ${elapsed}s`);
  console.log(`Files processed: ${counters.files}`);
  console.log(`Chunks: ${counters.chunks}`);
  console.log(`Inserted: ${counters.inserted}`);
  console.log(`Already present (dedup): ${counters.duplicate}`);
  console.log(`Embed failures: ${counters.embedFail}`);
  console.log(`Skipped empty: ${counters.skipEmpty}`);

  await pool.end();
}

await main();
