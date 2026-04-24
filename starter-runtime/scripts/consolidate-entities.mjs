#!/usr/bin/env node
// Entity consolidation — merge duplicate entities created during extraction.
//
// Strategy (conservative, string-only — no LLM adjudication):
// 1. Aggressive normalisation: lowercase, strip punctuation, collapse whitespace.
//    Entities with the same (type, aggressive_key) are definitely the same thing
//    ("Acme Corp" vs "acme-corp" vs "Acme-Corp").
// 2. Alias containment: if A.canonical_name appears (case-insensitive) in B.aliases
//    (or vice versa), they are the same thing.
// 3. Token-subset with high overlap: if A's normalised tokens are a strict subset
//    of B's AND A has <=2 mentions AND the types agree, merge A into B. This
//    catches short aliases like "Jane" (1 token, many mentions) vs "Jane Doe"
//    (2 tokens, fewer) — we keep the longer canonical name as survivor.
//
// For each merge:
//   - pick survivor (highest mention count; ties broken by longer canonical_name)
//   - move thought_entities links to survivor (dedup on conflict)
//   - move edges (add support_count on conflict)
//   - merge aliases (loser's canonical + aliases into survivor's)
//   - delete loser
//   - write a consolidation_log row
//
// Dry-run: node consolidate-entities.mjs --dry-run

import { readFileSync } from 'node:fs';
import pg from 'pg';

const ROOT = process.env.HOME + '/claudeclaw';
const DRY_RUN = process.argv.includes('--dry-run');

const env = Object.fromEntries(
  readFileSync(`${ROOT}/.env`, 'utf-8').split(/\r?\n/)
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')]; })
);
const pool = new pg.Pool({ connectionString: env.OB1_SUPABASE_DB_URL, max: 4 });

function aggressiveKey(name) {
  return name.toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function tokenize(name) {
  return new Set(aggressiveKey(name).split(' ').filter(Boolean));
}

async function loadEntities() {
  const { rows } = await pool.query(`
    SELECT e.id, e.entity_type, e.canonical_name, e.normalized_name,
           e.aliases, coalesce(m.mentions, 0) AS mentions
    FROM entities e
    LEFT JOIN (
      SELECT entity_id, count(*) AS mentions
      FROM thought_entities GROUP BY entity_id
    ) m ON m.entity_id = e.id
  `);
  return rows;
}

// ── Merge primitives ────────────────────────────────────────────────
async function mergeEntity(survivorId, loserId, reason) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 0. snapshot the loser for the log and for alias merging
    const loserRow = (await client.query(
      'SELECT canonical_name, aliases FROM entities WHERE id = $1',
      [loserId]
    )).rows[0];
    if (!loserRow) { await client.query('ROLLBACK'); return false; }

    // 1. move thought_entities (dedup on conflict — same thought may already link survivor)
    await client.query(`
      INSERT INTO thought_entities (thought_id, entity_id, mention_role, source, confidence, evidence)
      SELECT thought_id, $1, mention_role, source, confidence, evidence
      FROM thought_entities WHERE entity_id = $2
      ON CONFLICT (thought_id, entity_id, mention_role) DO NOTHING
    `, [survivorId, loserId]);

    await client.query('DELETE FROM thought_entities WHERE entity_id = $1', [loserId]);

    // 2. merge edges FROM loser
    await client.query(`
      INSERT INTO edges (from_entity_id, to_entity_id, relation, support_count, confidence, metadata)
      SELECT $1, to_entity_id, relation, support_count, confidence, metadata
      FROM edges WHERE from_entity_id = $2
      ON CONFLICT (from_entity_id, to_entity_id, relation) DO UPDATE SET
        support_count = edges.support_count + EXCLUDED.support_count,
        updated_at = now()
    `, [survivorId, loserId]);

    // 3. merge edges TO loser
    await client.query(`
      INSERT INTO edges (from_entity_id, to_entity_id, relation, support_count, confidence, metadata)
      SELECT from_entity_id, $1, relation, support_count, confidence, metadata
      FROM edges WHERE to_entity_id = $2 AND from_entity_id != $1
      ON CONFLICT (from_entity_id, to_entity_id, relation) DO UPDATE SET
        support_count = edges.support_count + EXCLUDED.support_count,
        updated_at = now()
    `, [survivorId, loserId]);

    // drop any self-loops that resulted from rerouting
    await client.query('DELETE FROM edges WHERE from_entity_id = to_entity_id');
    await client.query('DELETE FROM edges WHERE from_entity_id = $1 OR to_entity_id = $1', [loserId]);

    // 4. merge aliases into survivor
    await client.query(`
      UPDATE entities SET aliases = COALESCE(
        (SELECT jsonb_agg(DISTINCT x) FROM jsonb_array_elements_text(
          aliases || $2::jsonb || to_jsonb($3::text)
        ) x),
        '[]'::jsonb
      ), updated_at = now()
      WHERE id = $1
    `, [survivorId, JSON.stringify(loserRow.aliases || []), loserRow.canonical_name]);

    // 5. log and delete loser
    await client.query(`
      INSERT INTO consolidation_log (operation, survivor_id, loser_id, details)
      VALUES ('entity_merge', NULL, NULL,
        jsonb_build_object('survivor', $1::text, 'loser', $2::text, 'reason', $3::text, 'loser_canonical', $4::text))
    `, [String(survivorId), String(loserId), reason, loserRow.canonical_name]);

    await client.query('DELETE FROM entities WHERE id = $1', [loserId]);
    await client.query('COMMIT');
    return true;
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(`merge ${loserId}->${survivorId} failed: ${err.message}`);
    return false;
  } finally {
    client.release();
  }
}

// ── Candidate generation ────────────────────────────────────────────
function pickSurvivor(a, b) {
  if (a.mentions !== b.mentions) return a.mentions > b.mentions ? a : b;
  if (a.canonical_name.length !== b.canonical_name.length) {
    return a.canonical_name.length > b.canonical_name.length ? a : b;
  }
  return a.id < b.id ? a : b;
}

async function main() {
  const entities = await loadEntities();
  console.log(`Loaded ${entities.length} entities.`);

  const mergePlan = []; // { survivorId, loserId, reason }
  const mergedOut = new Set();

  // Pass 1: aggressive-key collision (exact match after strip-punctuation/case)
  const byKey = new Map();
  for (const e of entities) {
    const key = `${e.entity_type}::${aggressiveKey(e.canonical_name)}`;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(e);
  }
  for (const group of byKey.values()) {
    if (group.length < 2) continue;
    const survivor = group.reduce(pickSurvivor);
    for (const e of group) {
      if (e.id === survivor.id) continue;
      mergePlan.push({ survivorId: survivor.id, loserId: e.id, reason: 'aggressive_key_match', survivorName: survivor.canonical_name, loserName: e.canonical_name });
      mergedOut.add(e.id);
    }
  }

  // Pass 2: alias containment (loser's canonical appears in survivor's aliases, same type)
  for (const loser of entities) {
    if (mergedOut.has(loser.id)) continue;
    const loserNameLower = loser.canonical_name.toLowerCase();
    for (const survivor of entities) {
      if (survivor.id === loser.id || mergedOut.has(survivor.id)) continue;
      if (survivor.entity_type !== loser.entity_type) continue;
      const aliases = Array.isArray(survivor.aliases) ? survivor.aliases : [];
      if (aliases.some((a) => typeof a === 'string' && a.toLowerCase() === loserNameLower)) {
        const win = pickSurvivor(survivor, loser);
        const lose = win.id === survivor.id ? loser : survivor;
        mergePlan.push({ survivorId: win.id, loserId: lose.id, reason: 'alias_contains', survivorName: win.canonical_name, loserName: lose.canonical_name });
        mergedOut.add(lose.id);
        break;
      }
    }
  }

  // Pass 3: strict token subset (low-mention alias of high-mention parent, same type)
  for (const short of entities) {
    if (mergedOut.has(short.id)) continue;
    if (short.mentions > 3) continue;  // conservative: only auto-merge low-signal shorter names
    const shortTokens = tokenize(short.canonical_name);
    if (shortTokens.size === 0 || shortTokens.size > 2) continue;
    let best = null;
    for (const longer of entities) {
      if (longer.id === short.id || mergedOut.has(longer.id)) continue;
      if (longer.entity_type !== short.entity_type) continue;
      const longTokens = tokenize(longer.canonical_name);
      if (longTokens.size <= shortTokens.size) continue;
      // strict subset
      const isSubset = [...shortTokens].every((t) => longTokens.has(t));
      if (!isSubset) continue;
      // only consider if longer has many more mentions
      if (longer.mentions < short.mentions * 3) continue;
      if (!best || longer.mentions > best.mentions) best = longer;
    }
    if (best) {
      mergePlan.push({ survivorId: best.id, loserId: short.id, reason: 'token_subset', survivorName: best.canonical_name, loserName: short.canonical_name });
      mergedOut.add(short.id);
    }
  }

  // Deduplicate merge plan (same loser appearing twice)
  const seen = new Set();
  const planFinal = mergePlan.filter((p) => {
    if (seen.has(p.loserId)) return false;
    seen.add(p.loserId);
    return true;
  });

  console.log(`\n--- Plan: ${planFinal.length} merges ---`);
  const byReason = {};
  for (const p of planFinal) byReason[p.reason] = (byReason[p.reason] || 0) + 1;
  for (const [r, c] of Object.entries(byReason)) console.log(`  ${r}: ${c}`);

  console.log('\nSample (first 15):');
  for (const p of planFinal.slice(0, 15)) {
    console.log(`  [${p.reason}] "${p.loserName}" -> "${p.survivorName}"`);
  }

  if (DRY_RUN) {
    console.log('\n--dry-run: no writes. Exiting.');
    await pool.end();
    return;
  }

  console.log('\nExecuting merges...');
  let ok = 0, fail = 0;
  for (const p of planFinal) {
    const success = await mergeEntity(p.survivorId, p.loserId, p.reason);
    if (success) ok++; else fail++;
    if ((ok + fail) % 50 === 0) console.log(`  ${ok + fail}/${planFinal.length} (ok=${ok} fail=${fail})`);
  }

  const { rows: [{ count: remaining }] } = await pool.query('SELECT count(*)::int AS count FROM entities');
  console.log(`\n--- Done ---`);
  console.log(`Planned: ${planFinal.length} | Merged: ${ok} | Failed: ${fail}`);
  console.log(`Entities remaining: ${remaining}`);
  await pool.end();
}

await main();
