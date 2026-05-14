#!/usr/bin/env node
// Phase 3 ETL: Copy SQLite memories + conversation_log into OB1 thoughts table.
// - Embeds content via scripts/lib/embed.mjs (BGE-M3, 1024d, local llama.cpp)
// - Writes directly to Supabase via pg client (preserves original created_at)
// - Uses ON CONFLICT (content_fingerprint) to dedupe

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import pg from 'pg';
import { embed as embedShared, vecLit, EMBED_DIM, EMBED_MODEL_NAME } from './lib/embed.mjs';

const ROOT = new URL('..', import.meta.url).pathname;
const envText = readFileSync(new URL('../.env', import.meta.url), 'utf-8');
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

const DB_PATH = `${ROOT}store/myos.db`;
const PG_URL = env.OB1_SUPABASE_DB_URL;
const BATCH = 10;

if (!PG_URL) throw new Error('OB1_SUPABASE_DB_URL not set');

const sqlite = new Database(DB_PATH, { readonly: true });
const pgClient = new pg.Client({ connectionString: PG_URL });
await pgClient.connect();

function fingerprint(text) {
  const norm = text.toLowerCase().trim().replace(/\s+/g, ' ');
  return createHash('sha256').update(norm, 'utf8').digest('hex');
}

async function embed(text) {
  const v = await embedShared(text, { throwOnFail: true });
  return v;
}

const vecLiteral = vecLit;

async function upsertBatch(rows) {
  // rows: [{ content, fingerprint, metadata, embedding, created_at }]
  if (!rows.length) return { inserted: 0, skipped: 0 };
  const values = [];
  const placeholders = [];
  rows.forEach((r, i) => {
    const b = i * 5;
    placeholders.push(`($${b + 1}, $${b + 2}, $${b + 3}::jsonb, $${b + 4}::vector, to_timestamp($${b + 5}))`);
    values.push(r.content, r.fingerprint, JSON.stringify(r.metadata), vecLiteral(r.embedding), r.created_at);
  });
  const sql = `
    INSERT INTO thoughts (content, content_fingerprint, metadata, embedding, created_at)
    VALUES ${placeholders.join(', ')}
    ON CONFLICT (content_fingerprint) WHERE content_fingerprint IS NOT NULL DO NOTHING
    RETURNING id
  `;
  const res = await pgClient.query(sql, values);
  return { inserted: res.rowCount, skipped: rows.length - res.rowCount };
}

async function etlMemories() {
  const rows = sqlite.prepare(`
    SELECT id, chat_id, agent_id, source, raw_text, summary, entities, topics,
           importance, created_at
    FROM memories
    WHERE raw_text IS NOT NULL AND length(trim(summary)) > 0
    ORDER BY created_at ASC
  `).all();

  console.log(`memories: ${rows.length} rows`);
  let inserted = 0, skipped = 0, failed = 0;

  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    const prepared = [];
    await Promise.all(batch.map(async (r) => {
      try {
        const content = r.summary.trim();
        const emb = await embed(content);
        let topics = [], entities = [];
        try { topics = JSON.parse(r.topics || '[]'); } catch {}
        try { entities = JSON.parse(r.entities || '[]'); } catch {}
        prepared.push({
          content,
          fingerprint: fingerprint(content),
          embedding: emb,
          created_at: r.created_at,
          metadata: {
            source: 'sqlite_memory',
            origin: r.source,
            agent_id: r.agent_id,
            chat_id: r.chat_id,
            topics, entities,
            importance: r.importance,
            type: r.source === 'lesson' ? 'lesson' : 'memory',
            raw_text: r.raw_text,
            sqlite_id: r.id,
          },
        });
      } catch (err) {
        failed++;
        console.error(`  memory id=${r.id} failed:`, err.message);
      }
    }));
    const { inserted: ins, skipped: skp } = await upsertBatch(prepared);
    inserted += ins; skipped += skp;
    process.stdout.write(`  memories ${Math.min(i + BATCH, rows.length)}/${rows.length} (ins=${inserted} skip=${skipped} fail=${failed})\r`);
  }
  console.log(`\nmemories done: inserted=${inserted} skipped=${skipped} failed=${failed}`);
  return { inserted, skipped, failed, total: rows.length };
}

async function etlConversationLog() {
  const rows = sqlite.prepare(`
    SELECT id, chat_id, session_id, agent_id, role, content, created_at
    FROM conversation_log
    WHERE length(trim(content)) > 0
    ORDER BY created_at ASC
  `).all();

  console.log(`conversation_log: ${rows.length} rows`);
  let inserted = 0, skipped = 0, failed = 0;

  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    const prepared = [];
    await Promise.all(batch.map(async (r) => {
      try {
        const content = r.content.slice(0, 8000);
        const emb = await embed(content);
        prepared.push({
          content,
          fingerprint: fingerprint(content),
          embedding: emb,
          created_at: r.created_at,
          metadata: {
            source: 'sqlite_conversation_log',
            agent_id: r.agent_id,
            chat_id: r.chat_id,
            session_id: r.session_id,
            role: r.role,
            type: 'conversation',
            sqlite_id: r.id,
          },
        });
      } catch (err) {
        failed++;
        console.error(`  convo id=${r.id} failed:`, err.message);
      }
    }));
    const { inserted: ins, skipped: skp } = await upsertBatch(prepared);
    inserted += ins; skipped += skp;
    process.stdout.write(`  convo ${Math.min(i + BATCH, rows.length)}/${rows.length} (ins=${inserted} skip=${skipped} fail=${failed})\r`);
  }
  console.log(`\nconversation_log done: inserted=${inserted} skipped=${skipped} failed=${failed}`);
  return { inserted, skipped, failed, total: rows.length };
}

async function main() {
  const mode = process.argv[2] || 'all';
  const out = {};
  if (mode === 'memories' || mode === 'all') out.memories = await etlMemories();
  if (mode === 'convo' || mode === 'all') out.conversation_log = await etlConversationLog();
  const { rows: [{ count }] } = await pgClient.query('SELECT count(*)::bigint AS count FROM thoughts');
  console.log(`\nthoughts table now has ${count} rows.`);
  console.log(JSON.stringify(out, null, 2));
  await pgClient.end();
  sqlite.close();
}

await main();
