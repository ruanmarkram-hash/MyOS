#!/usr/bin/env node
// Entity extraction worker (Gemini, Node.js edition).
// Polls entity_extraction_queue, calls Gemini Flash to extract entities +
// relationships from each thought, upserts into entities/edges/thought_entities.
// Run via launchd every 2 minutes. Designed to drain ~50 items per tick.

import { readFileSync, appendFileSync } from 'node:fs';
import pg from 'pg';

const ROOT = process.env.PROJECT_ROOT || new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const LOG_PATH = `${ROOT}/logs/entity-worker.log`;
const WORKER_VERSION = 'entity-worker-gemini-v1';

const BATCH_SIZE = parseInt(process.env.BATCH_SIZE || '50', 10);
const CONCURRENCY = parseInt(process.env.CONCURRENCY || '5', 10);
const MAX_CONTENT_CHARS = 6000;
const GEMINI_MODEL = 'gemini-2.5-flash';
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';

const env = Object.fromEntries(
  readFileSync(`${ROOT}/.env`, 'utf-8').split(/\r?\n/)
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')]; })
);
const GEMINI_KEY = env.GOOGLE_API_KEY;
const PG_URL = env.OB1_SUPABASE_DB_URL;
if (!GEMINI_KEY || !PG_URL) { console.error('missing env'); process.exit(1); }

const pool = new pg.Pool({ connectionString: PG_URL, max: 8 });

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try { appendFileSync(LOG_PATH, line + '\n'); } catch {}
}

// ── Gemini extraction ───────────────────────────────────────────────
const EXTRACTION_PROMPT = `Extract entities and relationships from the thought below.

Entity types (lowercase): person, project, topic, tool, organization, place.
Relations (lowercase): works_on, uses, related_to, member_of, located_in, co_occurs_with.

Rules:
- Only entities that are EXPLICITLY named in the text. No inference, no generic concepts.
- Canonical name should match what appears in the text, cleaned (e.g. "[YOUR PROJECT]" not "project_slug", "[YOUR NAME]" not just "the user" if the fuller name appears; collect alternate forms into aliases).
- aliases: other surface forms seen in this text only.
- Tools: libraries, frameworks, databases, APIs, services. NOT generic verbs.
- Topics: short concept tags only when they are the SUBJECT of the thought (e.g. "NDIS compliance", "memory architecture"). Skip noisy topics.
- Skip if none found (return empty arrays).
- Only include high-confidence relationships. When unsure, skip.

Return JSON: {"entities":[{"type":"...","name":"...","aliases":[...]}],"edges":[{"from":"...","to":"...","relation":"..."}]}

Thought:
{CONTENT}`;

const VALID_TYPES = new Set(['person', 'project', 'topic', 'tool', 'organization', 'place']);
const VALID_RELATIONS = new Set(['works_on', 'uses', 'related_to', 'member_of', 'located_in', 'co_occurs_with']);

async function extractWithGemini(content, retries = 3) {
  const prompt = EXTRACTION_PROMPT.replace('{CONTENT}', content.slice(0, MAX_CONTENT_CHARS));
  for (let i = 0; i < retries; i++) {
    try {
      const r = await fetch(`${GEMINI_BASE}/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_KEY}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: { responseMimeType: 'application/json', temperature: 0 },
        }),
      });
      if (r.status === 429 || r.status === 503) {
        if (i === retries - 1) return null;
        await new Promise((res) => setTimeout(res, 1000 * Math.pow(2, i)));
        continue;
      }
      if (!r.ok) return null;
      const j = await r.json();
      const txt = j?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!txt) return null;
      const parsed = JSON.parse(txt);
      // Normalise
      const entities = Array.isArray(parsed.entities) ? parsed.entities : [];
      const edges = Array.isArray(parsed.edges) ? parsed.edges : [];
      return {
        entities: entities
          .filter((e) => e && typeof e.name === 'string' && VALID_TYPES.has(String(e.type).toLowerCase()))
          .map((e) => ({
            type: String(e.type).toLowerCase(),
            name: e.name.trim(),
            aliases: Array.isArray(e.aliases) ? e.aliases.filter((a) => typeof a === 'string').map((a) => a.trim()) : [],
          }))
          .filter((e) => e.name.length >= 2 && e.name.length <= 200),
        edges: edges
          .filter((g) => g && typeof g.from === 'string' && typeof g.to === 'string' && VALID_RELATIONS.has(String(g.relation).toLowerCase()))
          .map((g) => ({
            from: g.from.trim(),
            to: g.to.trim(),
            relation: String(g.relation).toLowerCase(),
          })),
      };
    } catch {
      if (i === retries - 1) return null;
      await new Promise((res) => setTimeout(res, 1000 * Math.pow(2, i)));
    }
  }
  return null;
}

function normalise(name) {
  return name.toLowerCase().trim().replace(/\s+/g, ' ');
}

// ── DB upserts ──────────────────────────────────────────────────────
async function upsertEntity(client, { type, name, aliases }) {
  const norm = normalise(name);
  const res = await client.query(
    `INSERT INTO entities (entity_type, canonical_name, normalized_name, aliases, last_seen_at)
     VALUES ($1, $2, $3, $4::jsonb, now())
     ON CONFLICT (entity_type, normalized_name) DO UPDATE SET
       last_seen_at = now(),
       aliases = COALESCE(
         (SELECT jsonb_agg(DISTINCT x) FROM jsonb_array_elements_text(
           entities.aliases || EXCLUDED.aliases
         ) x),
         '[]'::jsonb
       ),
       updated_at = now()
     RETURNING id`,
    [type, name, norm, JSON.stringify(aliases)]
  );
  return res.rows[0].id;
}

async function linkThoughtEntity(client, thoughtId, entityId) {
  await client.query(
    `INSERT INTO thought_entities (thought_id, entity_id, mention_role, source, confidence)
     VALUES ($1, $2, 'mentioned', 'entity_worker', 0.80)
     ON CONFLICT (thought_id, entity_id, mention_role) DO NOTHING`,
    [thoughtId, entityId]
  );
}

async function upsertEdge(client, fromId, toId, relation) {
  if (fromId === toId) return;
  await client.query(
    `INSERT INTO edges (from_entity_id, to_entity_id, relation, support_count, confidence)
     VALUES ($1, $2, $3, 1, 0.70)
     ON CONFLICT (from_entity_id, to_entity_id, relation) DO UPDATE SET
       support_count = edges.support_count + 1,
       updated_at = now()`,
    [fromId, toId, relation]
  );
}

async function markQueue(client, thoughtId, status, error = null) {
  await client.query(
    `UPDATE entity_extraction_queue
     SET status = $2, last_error = $3, processed_at = now(),
         attempt_count = attempt_count + 1, worker_version = $4
     WHERE thought_id = $1`,
    [thoughtId, status, error, WORKER_VERSION]
  );
}

async function markProcessing(client, thoughtIds) {
  await client.query(
    `UPDATE entity_extraction_queue
     SET status = 'processing', started_at = now(), worker_version = $2
     WHERE thought_id = ANY($1::uuid[]) AND status = 'pending'`,
    [thoughtIds, WORKER_VERSION]
  );
}

// ── Per-thought ──────────────────────────────────────────────────────
const counters = { claimed: 0, processed: 0, failed: 0, skipped: 0, entities: 0, edges: 0 };

async function processThought({ thought_id, content }) {
  if (!content || content.length < 40) {
    const client = await pool.connect();
    try { await markQueue(client, thought_id, 'skipped', 'content too short'); }
    finally { client.release(); }
    counters.skipped++;
    return;
  }

  const result = await extractWithGemini(content);
  const client = await pool.connect();
  try {
    if (!result) {
      // Gemini returned null after retries — usually means no entities extractable
      // (short snippets, data dumps, code with no proper nouns). Mark 'skipped'
      // rather than 'failed' since there's nothing actionable to retry.
      await markQueue(client, thought_id, 'skipped', 'nothing extractable');
      counters.skipped++;
      return;
    }

    // upsert entities first; capture name → id map
    const nameToId = new Map();
    for (const e of result.entities) {
      try {
        const id = await upsertEntity(client, e);
        nameToId.set(normalise(e.name), id);
        await linkThoughtEntity(client, thought_id, id);
        counters.entities++;
      } catch (err) {
        log(`entity upsert failed (${e.type}:${e.name}): ${err.message}`);
      }
    }

    // edges — both endpoints must have been upserted
    for (const g of result.edges) {
      const fromId = nameToId.get(normalise(g.from));
      const toId = nameToId.get(normalise(g.to));
      if (fromId && toId) {
        try {
          await upsertEdge(client, fromId, toId, g.relation);
          counters.edges++;
        } catch (err) {
          log(`edge upsert failed: ${err.message}`);
        }
      }
    }

    await markQueue(client, thought_id, 'complete');
    counters.processed++;
  } catch (err) {
    log(`processThought fatal ${thought_id}: ${err.message}`);
    try { await markQueue(client, thought_id, 'failed', err.message.slice(0, 500)); } catch {}
    counters.failed++;
  } finally {
    client.release();
  }
}

async function runPool(items, worker, n) {
  let i = 0;
  await Promise.all(Array(n).fill(null).map(async () => {
    while (i < items.length) { const idx = i++; try { await worker(items[idx]); } catch (e) { log('worker err: ' + e.message); } }
  }));
}

async function main() {
  const started = Date.now();

  const { rows: batch } = await pool.query(
    `SELECT q.thought_id, t.content
     FROM entity_extraction_queue q
     JOIN thoughts t ON t.id = q.thought_id
     WHERE q.status = 'pending'
     ORDER BY q.queued_at ASC
     LIMIT $1`,
    [BATCH_SIZE]
  );

  if (batch.length === 0) {
    log('nothing to do, queue empty');
    await pool.end();
    return;
  }
  counters.claimed = batch.length;

  // Mark the batch as processing in one shot
  const client = await pool.connect();
  try { await markProcessing(client, batch.map((b) => b.thought_id)); }
  finally { client.release(); }

  await runPool(batch, processThought, CONCURRENCY);

  // Queue depth after this tick
  const depth = await pool.query(`SELECT count(*)::int AS n FROM entity_extraction_queue WHERE status = 'pending'`);
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  log(`tick done in ${elapsed}s | claimed=${counters.claimed} processed=${counters.processed} failed=${counters.failed} skipped=${counters.skipped} entities=${counters.entities} edges=${counters.edges} queue_remaining=${depth.rows[0].n}`);

  await pool.end();
}

await main();
