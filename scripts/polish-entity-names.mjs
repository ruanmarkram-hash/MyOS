#!/usr/bin/env node
// Polish entity canonical_names — for each entity, pick the most readable form
// (canonical_name or any alias) and promote it to canonical. Demote the old
// canonical into aliases. Updates normalized_name so the UNIQUE constraint
// continues to hold.
//
// Readability score (higher = better):
//   + length (favour fuller forms)
//   + 5 per uppercase letter (up to +15) — proper-noun signal
//   + 8 if contains any whitespace — multi-word reads better than a mashup
//   - 15 if contains underscore or hyphen — slug/identifier smell
//   - 20 if fully lowercase AND no whitespace AND length <= 6 — abbreviation smell
//
// Dry-run: node polish-entity-names.mjs --dry-run

import { readFileSync } from 'node:fs';
import pg from 'pg';

const ROOT = '/Users/sagecos1/HQ';
const DRY_RUN = process.argv.includes('--dry-run');

const env = Object.fromEntries(
  readFileSync(`${ROOT}/.env`, 'utf-8').split(/\r?\n/)
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')]; })
);
const pool = new pg.Pool({ connectionString: env.OB1_SUPABASE_DB_URL, max: 4 });

function readability(name) {
  if (!name || typeof name !== 'string') return -Infinity;
  let s = Math.min(name.length, 40);               // length saturates at 40 to stop file-extensions winning
  const uppers = (name.match(/[A-Z]/g) || []).length;
  s += Math.min(uppers, 3) * 5;                    // proper-noun signal (capped)
  if (/\s/.test(name)) s += 8;                     // multi-word
  if (/^[A-Z]/.test(name)) s += 3;                 // starts capitalised
  if (/[_]/.test(name)) s -= 20;                   // underscore = slug
  if (/-\S/.test(name) && !/^\p{L}+-\p{L}+$/u.test(name)) s -= 10;  // hyphen-id, not clean hyphenation
  if (/\.(xlsx|md|pdf|docx?|csv|txt|json|sql|ts|js|mjs|tsx|jsx|png|jpg|mp4|mov)$/i.test(name)) s -= 25;
  if (/^[\d\s()+\-]+$/.test(name)) s -= 25;        // all digits / phone-number-looking
  if (name.startsWith('/')) s -= 30;                // absolute path
  const slashes = (name.match(/\//g) || []).length;
  if (slashes >= 2) s -= 5 * slashes;              // path-like strings shouldn't beat plain names
  if (name === name.toLowerCase() && !/\s/.test(name) && name.length <= 6) s -= 20;
  return s;
}

const MIN_SCORE_DELTA_TO_SWAP = 10;

function normalise(name) {
  return name.toLowerCase().trim().replace(/\s+/g, ' ');
}

async function main() {
  const { rows } = await pool.query(`
    SELECT id, entity_type, canonical_name, normalized_name, aliases
    FROM entities
  `);

  console.log(`Evaluating ${rows.length} entities.`);

  const changes = [];
  for (const e of rows) {
    const aliases = Array.isArray(e.aliases) ? e.aliases.filter((a) => typeof a === 'string' && a.trim()) : [];
    if (aliases.length === 0) continue;

    const canonScore = readability(e.canonical_name);
    let bestAlias = null;
    let bestScore = canonScore;
    for (const a of aliases) {
      const s = readability(a);
      if (s > bestScore) { bestScore = s; bestAlias = a; }
    }
    if (!bestAlias) continue;
    if (bestScore - canonScore < MIN_SCORE_DELTA_TO_SWAP) continue;  // not a clear-enough win

    // make sure the new normalised key doesn't collide with a different entity
    // of the same type
    const newNorm = normalise(bestAlias);
    const collision = await pool.query(
      `SELECT id FROM entities WHERE entity_type = $1 AND normalized_name = $2 AND id != $3 LIMIT 1`,
      [e.entity_type, newNorm, e.id]
    );
    if (collision.rowCount > 0) continue;  // skip to avoid violating unique (type, normalized_name)

    changes.push({
      id: e.id,
      type: e.entity_type,
      oldCanonical: e.canonical_name,
      newCanonical: bestAlias,
      newNorm,
      oldScore: canonScore,
      newScore: bestScore,
      aliases,
    });
  }

  console.log(`\nPlanned ${changes.length} canonical swaps.`);
  console.log('Sample (first 15):');
  for (const c of changes.slice(0, 15)) {
    console.log(`  [${c.type}] "${c.oldCanonical}" (${c.oldScore}) -> "${c.newCanonical}" (${c.newScore})`);
  }

  if (DRY_RUN) {
    console.log('\n--dry-run: no writes. Exiting.');
    await pool.end();
    return;
  }

  console.log('\nApplying...');
  let ok = 0, fail = 0;
  for (const c of changes) {
    try {
      // new aliases = (old aliases minus new canonical) plus old canonical
      const newAliases = Array.from(new Set([
        ...c.aliases.filter((a) => normalise(a) !== c.newNorm),
        c.oldCanonical,
      ]));
      await pool.query(
        `UPDATE entities
         SET canonical_name = $1,
             normalized_name = $2,
             aliases = $3::jsonb,
             updated_at = now()
         WHERE id = $4`,
        [c.newCanonical, c.newNorm, JSON.stringify(newAliases), c.id]
      );
      ok++;
      if (ok % 50 === 0) console.log(`  ${ok + fail}/${changes.length} (ok=${ok} fail=${fail})`);
    } catch (err) {
      fail++;
      console.error(`swap id=${c.id}: ${err.message}`);
    }
  }

  console.log(`\n--- Done ---`);
  console.log(`Planned: ${changes.length} | Swapped: ${ok} | Failed: ${fail}`);
  await pool.end();
}

await main();
