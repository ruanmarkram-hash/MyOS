#!/usr/bin/env node
// Backfill local SQLite + OB1 Supabase embeddings with the local BGE-M3
// llama.cpp embedding server. This intentionally replaces Gemini vectors
// with one canonical embedding space.

import { readFileSync, existsSync } from 'node:fs';
import Database from 'better-sqlite3';
import pg from 'pg';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const env = readEnv();
const EMBEDDING_URL = env.LLAMACPP_EMBEDDING_URL || 'http://127.0.0.1:8081/v1/embeddings';
const EMBEDDING_MODEL = env.LLAMACPP_EMBEDDING_MODEL || 'bge-m3';
const EMBEDDING_MODEL_NAME = `llamacpp:${EMBEDDING_MODEL}`;
const EMBEDDING_DIM = Number(env.LLAMACPP_EMBEDDING_DIM || 1024);
const BATCH = Number(env.BGE_BACKFILL_BATCH || 12);

const args = new Set(process.argv.slice(2));
const migrateOb1 = args.has('--migrate-ob1');
const backfillLocal = args.has('--local') || args.has('--all') || process.argv.length <= 2;
const backfillOb1 = args.has('--ob1') || args.has('--all') || process.argv.length <= 2;
const limitArg = process.argv.find((arg) => arg.startsWith('--limit='));
const limit = limitArg ? Number(limitArg.split('=')[1]) : 0;

function readEnv() {
  const envPath = new URL('../.env', import.meta.url);
  if (!existsSync(envPath)) return { ...process.env };
  const text = readFileSync(envPath, 'utf8');
  const fileEnv = Object.fromEntries(
    text.split(/\r?\n/)
      .filter((line) => line && !line.trimStart().startsWith('#') && line.includes('='))
      .map((line) => {
        const i = line.indexOf('=');
        let value = line.slice(i + 1).trim();
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
        return [line.slice(0, i).trim(), value];
      }),
  );
  return { ...fileEnv, ...process.env };
}

async function embed(text, maxChars = 24_000) {
  const input = text.slice(0, maxChars);
  const res = await fetch(EMBEDDING_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: EMBEDDING_MODEL, input }),
  });
  const body = await res.text();
  if (!res.ok && /too large to process|maximum context|context length/i.test(body) && maxChars > 2_000) {
    return embed(text, Math.floor(maxChars / 2));
  }
  if (!res.ok) throw new Error(`llama.cpp embedding HTTP ${res.status}: ${body.slice(0, 300)}`);
  const parsed = JSON.parse(body);
  const vector = parsed?.data?.[0]?.embedding ?? parsed?.embedding;
  if (!Array.isArray(vector) || vector.length !== EMBEDDING_DIM) {
    throw new Error(`llama.cpp embedding shape mismatch: len=${vector?.length}, expected=${EMBEDDING_DIM}`);
  }
  return vector.map(Number);
}

function vecLiteral(vector) {
  return `[${vector.join(',')}]`;
}

async function mapLimit(rows, concurrency, fn) {
  const results = [];
  let index = 0;
  async function worker() {
    while (index < rows.length) {
      const current = rows[index++];
      results.push(await fn(current));
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, rows.length) }, worker));
  return results;
}

async function migrateOb1Schema(client) {
  console.log(`OB1: migrating thoughts.embedding + match_thoughts to vector(${EMBEDDING_DIM})`);
  const dim = await client.query(`
    SELECT a.atttypmod::int AS dim
    FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'thoughts' AND a.attname = 'embedding'
  `);
  if (dim.rows[0]?.dim !== EMBEDDING_DIM) {
    await client.query('DROP INDEX IF EXISTS public.thoughts_embedding_idx');
    await client.query(`ALTER TABLE public.thoughts ALTER COLUMN embedding TYPE vector(${EMBEDDING_DIM}) USING NULL`);
  }
  await client.query(`
    CREATE OR REPLACE FUNCTION public.match_thoughts(
      query_embedding vector(${EMBEDDING_DIM}),
      match_threshold double precision DEFAULT 0.7,
      match_count integer DEFAULT 10,
      filter jsonb DEFAULT '{}'::jsonb
    )
    RETURNS TABLE(id uuid, content text, metadata jsonb, similarity double precision, created_at timestamp with time zone)
    LANGUAGE plpgsql
    AS $$
    BEGIN
      RETURN QUERY
      SELECT
        t.id,
        t.content,
        t.metadata,
        (1 - (t.embedding <=> query_embedding))::double precision AS similarity,
        t.created_at
      FROM public.thoughts t
      WHERE t.embedding IS NOT NULL
        AND 1 - (t.embedding <=> query_embedding) > match_threshold
        AND (filter = '{}'::jsonb OR t.metadata @> filter)
      ORDER BY t.embedding <=> query_embedding
      LIMIT match_count;
    END;
    $$;
  `);
  await client.query('CREATE INDEX IF NOT EXISTS thoughts_embedding_idx ON public.thoughts USING hnsw (embedding vector_cosine_ops)');
}

async function backfillSqlite() {
  const dbPath = `${ROOT}/store/myos.db`;
  if (!existsSync(dbPath)) {
    console.log('local: store/myos.db not found, skipping');
    return;
  }
  const db = new Database(dbPath);
  const memories = db.prepare(`
    SELECT id, raw_text, summary, entities, topics
    FROM memories
    WHERE superseded_by IS NULL
      AND length(trim(coalesce(summary, raw_text, ''))) > 0
      AND coalesce(embedding_model, '') != ?
    ORDER BY created_at ASC
    ${limit ? 'LIMIT ?' : ''}
  `).all(...(limit ? [EMBEDDING_MODEL_NAME, limit] : [EMBEDDING_MODEL_NAME]));
  const consolidations = db.prepare(`
    SELECT id, summary, insight
    FROM consolidations
    WHERE length(trim(coalesce(summary, insight, ''))) > 0
      AND coalesce(embedding_model, '') != ?
    ORDER BY created_at ASC
    ${limit ? 'LIMIT ?' : ''}
  `).all(...(limit ? [EMBEDDING_MODEL_NAME, limit] : [EMBEDDING_MODEL_NAME]));

  console.log(`local: ${memories.length} memories, ${consolidations.length} consolidations to embed`);
  const updateMemory = db.prepare('UPDATE memories SET embedding = ?, embedding_model = ? WHERE id = ?');
  const updateConsolidation = db.prepare('UPDATE consolidations SET embedding = ?, embedding_model = ? WHERE id = ?');
  let done = 0;

  for (let i = 0; i < memories.length; i += BATCH) {
    const batch = memories.slice(i, i + BATCH);
    const rows = await mapLimit(batch, Math.min(4, BATCH), async (row) => {
      const text = [row.summary, row.raw_text, row.entities, row.topics].filter(Boolean).join('\n');
      return { id: row.id, embedding: await embed(text) };
    });
    const tx = db.transaction(() => {
      for (const row of rows) updateMemory.run(JSON.stringify(row.embedding), EMBEDDING_MODEL_NAME, row.id);
    });
    tx();
    done += rows.length;
    if (done % 120 === 0 || done === memories.length) console.log(`local memories: ${done}/${memories.length}`);
  }

  done = 0;
  for (let i = 0; i < consolidations.length; i += BATCH) {
    const batch = consolidations.slice(i, i + BATCH);
    const rows = await mapLimit(batch, Math.min(4, BATCH), async (row) => ({
      id: row.id,
      embedding: await embed([row.summary, row.insight].filter(Boolean).join('\n')),
    }));
    const tx = db.transaction(() => {
      for (const row of rows) updateConsolidation.run(JSON.stringify(row.embedding), EMBEDDING_MODEL_NAME, row.id);
    });
    tx();
    done += rows.length;
    if (done % 120 === 0 || done === consolidations.length) console.log(`local consolidations: ${done}/${consolidations.length}`);
  }
}

async function backfillSupabase() {
  if (!env.OB1_SUPABASE_DB_URL) throw new Error('OB1_SUPABASE_DB_URL not set');
  const client = new pg.Client({ connectionString: env.OB1_SUPABASE_DB_URL });
  await client.connect();
  try {
    if (migrateOb1) await migrateOb1Schema(client);
    const totalRes = await client.query(
      `SELECT count(*)::int AS count FROM public.thoughts WHERE embedding IS NULL OR metadata->>'embedding_model' IS DISTINCT FROM $1`,
      [EMBEDDING_MODEL_NAME],
    );
    const total = limit ? Math.min(limit, totalRes.rows[0].count) : totalRes.rows[0].count;
    console.log(`OB1: ${total} thoughts to embed`);
    let done = 0;
    while (done < total) {
      const page = await client.query(
        `SELECT id, content, metadata
         FROM public.thoughts
         WHERE embedding IS NULL OR metadata->>'embedding_model' IS DISTINCT FROM $1
         ORDER BY created_at ASC
         LIMIT $2`,
        [EMBEDDING_MODEL_NAME, Math.min(BATCH, total - done)],
      );
      if (page.rows.length === 0) break;
      const rows = await mapLimit(page.rows, Math.min(4, BATCH), async (row) => ({
        id: row.id,
        embedding: await embed(row.content || ''),
        metadata: {
          ...(row.metadata || {}),
          embedding_model: EMBEDDING_MODEL_NAME,
          embedding_provider: 'llamacpp',
          embedding_dimensions: EMBEDDING_DIM,
        },
      }));
      await client.query('BEGIN');
      try {
        for (const row of rows) {
          await client.query(
            'UPDATE public.thoughts SET embedding = $1::vector, metadata = $2::jsonb, updated_at = now() WHERE id = $3',
            [vecLiteral(row.embedding), JSON.stringify(row.metadata), row.id],
          );
        }
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
      done += rows.length;
      if (done % 120 === 0 || done === total) console.log(`OB1 thoughts: ${done}/${total}`);
    }
  } finally {
    await client.end();
  }
}

await embed('embedding preflight');
if (backfillLocal) await backfillSqlite();
if (backfillOb1) await backfillSupabase();
console.log('BGE backfill complete.');
