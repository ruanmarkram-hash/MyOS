#!/usr/bin/env node
// Side-by-side comparison: run 15 queries through the SQLite semantic layer
// (searchMemories) and the OB1 semantic layer (buildMemoryContextOb1).
// Writes markdown to store/baseline-comparison.md for human review.

import { writeFileSync, readFileSync } from 'node:fs';
import Database from 'better-sqlite3';
import { embed as embedShared } from './lib/embed.mjs';

process.env.BRAIN = 'ob1';

const QUERIES = [
  'What do I know about custom workflow?',
  "What's my em-dash rule?",
  "What's the custom workflow canonical URL?",
  'Who is user and what does he work on?',
  "What's the workspace layout under ~/workspace/?",
  'How do I restart Sage?',
  "What's the Supabase SQL access pattern?",
  "What's the Pilot Tool v1 status?",
  "What's in the mock data cleanup sprint?",
  "What's the CLAUDECODE env scrub fix?",
  "What's the root-cause feedback rule?",
  "What's the next major custom workflow feature?",
  "What's the SharePoint companion CSV pattern?",
  "What's the context discipline feedback?",
  "What's the custom workflow state as of April 21?",
];

// Load chat_id from sessions
const ROOT = '~/myos';
const DB_PATH = `${ROOT}/store/myos.db`;
const envText = readFileSync(`${ROOT}/.env`, 'utf-8');
const env = Object.fromEntries(
  envText.split(/\r?\n/)
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => {
      const i = l.indexOf('=');
      let v = l.slice(i + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      return [l.slice(0, i).trim(), v];
    })
);

async function embed(text) {
  return embedShared(text, { throwOnFail: true });
}

const sqlite = new Database(DB_PATH, { readonly: true });
const chatId = sqlite.prepare('SELECT chat_id FROM sessions LIMIT 1').get()?.chat_id;
if (!chatId) throw new Error('no sessions row found');
console.log(`chat_id: ${chatId}`);

// SQLite Layer 1 search: mirrors what searchMemories does inside db.ts.
// We use cosine in SQL via the stored embedding blob. Fallback is FTS5 if no embedding.
// To keep this lean we reimplement the Layer 1 ranking: pull all rows with embeddings
// for this chat, compute cosine in JS, take top 5.
const memoryRows = sqlite.prepare(`
  SELECT id, summary, topics, importance, embedding
  FROM memories
  WHERE chat_id = ? AND embedding IS NOT NULL
`).all(chatId);

function parseEmb(s) {
  if (!s) return null;
  try { const a = JSON.parse(s); return Array.isArray(a) ? a : null; } catch { return null; }
}

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

function sqliteLayer1(queryEmb, limit = 5) {
  const scored = memoryRows
    .map((m) => {
      const e = parseEmb(m.embedding);
      if (!e) return null;
      return { ...m, score: cosine(queryEmb, e) };
    })
    .filter((x) => x !== null)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
  if (scored.length === 0) return '';
  const lines = ['[Memory context]', 'Relevant memories:'];
  for (const r of scored) {
    let topics = [];
    try { topics = JSON.parse(r.topics || '[]'); } catch {}
    const topicStr = topics.length ? ` (${topics.join(', ')})` : '';
    lines.push(`- [${r.importance.toFixed(1)}] ${r.summary}${topicStr}`);
  }
  lines.push('[End memory context]');
  return lines.join('\n');
}

const { buildMemoryContextOb1 } = await import(`${ROOT}/dist/brain/adapter.js`);

const out = ['# Brain Comparison — SQLite vs OB1', `Date: ${new Date().toISOString()}`, `Chat: \`${chatId}\``, `Memories in SQLite: ${memoryRows.length}`, ''];

for (const q of QUERIES) {
  console.log(`\n> ${q}`);
  const qEmb = await embed(q);
  const sqliteAnswer = sqliteLayer1(qEmb) || '(no matches)';
  const ob1Answer = (await buildMemoryContextOb1(q)) || '(no matches)';

  out.push('---', `## Query: ${q}`, '', '### SQLite', '```', sqliteAnswer, '```', '', '### OB1', '```', ob1Answer, '```', '');
}

const outPath = `${ROOT}/store/baseline-comparison.md`;
writeFileSync(outPath, out.join('\n'));
console.log(`\nWrote ${outPath}`);
sqlite.close();
