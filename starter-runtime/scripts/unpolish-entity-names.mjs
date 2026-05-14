#!/usr/bin/env node
// Corrective pass — the first polish pass promoted qualified/parenthetical
// forms over clean originals (e.g. "SharePoint" got replaced by "SharePoint
// access logs"). This reverse pass swaps back when a clean shorter alias
// exists that is a prefix/substring of the current canonical.
//
// Rule: if an alias A is a strict substring of the canonical C, AND A is at
// least 3 chars, AND the resulting normalised key won't collide within the
// same entity_type, swap so A becomes canonical and C goes into aliases.

import { readFileSync } from 'node:fs';
import pg from 'pg';

const ROOT = '~/HQ';
const DRY_RUN = process.argv.includes('--dry-run');

const env = Object.fromEntries(
  readFileSync(`${ROOT}/.env`, 'utf-8').split(/\r?\n/)
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')]; })
);
const pool = new pg.Pool({ connectionString: env.OB1_SUPABASE_DB_URL, max: 4 });

function normalise(name) { return name.toLowerCase().trim().replace(/\s+/g, ' '); }

const BAD_POLISH_PATTERNS = [
  /\(/,                         // parenthetical qualifier: "Sage (Subagent...)"
  / — /,                        // em-dash qualifier
  / – /,                        // en-dash qualifier
  / access logs?$/i,
  / user accounts?$/i,
  / dashboard$/i,
  / cameras?$/i,
  / region\)?$/i,
  / table$/i,
];

function hasBadPolishSignature(canonical) {
  return BAD_POLISH_PATTERNS.some((p) => p.test(canonical));
}

function pickShortestCleanSubstringAlias(canonical, aliases) {
  if (!hasBadPolishSignature(canonical)) return null;
  const candidates = [];
  for (const a of aliases) {
    if (typeof a !== 'string') continue;
    const trimmed = a.trim();
    if (trimmed.length < 3) continue;
    if (trimmed === canonical) continue;
    if (trimmed.length >= canonical.length) continue;
    // Must be a prefix-with-word-boundary match against canonical
    const reLeft = new RegExp(`^${trimmed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
    if (!reLeft.test(canonical)) continue;
    // Reject slug / garbage aliases
    if (/[_]/.test(trimmed)) continue;
    if (hasBadPolishSignature(trimmed)) continue;  // alias itself is suspicious
    if (trimmed === trimmed.toLowerCase() && !/\s/.test(trimmed) && trimmed.length <= 4) continue;
    candidates.push(trimmed);
  }
  if (candidates.length === 0) return null;
  // Prefer longest clean candidate (preserves the most meaningful part)
  candidates.sort((a, b) => b.length - a.length || a.localeCompare(b));
  return candidates[0];
}

async function main() {
  const { rows } = await pool.query(`SELECT id, entity_type, canonical_name, normalized_name, aliases FROM entities`);
  console.log(`Evaluating ${rows.length} entities.`);

  const changes = [];
  for (const e of rows) {
    const aliases = Array.isArray(e.aliases) ? e.aliases : [];
    const pick = pickShortestCleanSubstringAlias(e.canonical_name, aliases);
    if (!pick) continue;
    const newNorm = normalise(pick);
    if (newNorm === e.normalized_name) continue;
    // collision check
    const collision = await pool.query(
      `SELECT id FROM entities WHERE entity_type = $1 AND normalized_name = $2 AND id != $3 LIMIT 1`,
      [e.entity_type, newNorm, e.id]
    );
    if (collision.rowCount > 0) continue;
    changes.push({ id: e.id, type: e.entity_type, oldC: e.canonical_name, newC: pick, newNorm, aliases });
  }

  console.log(`\nPlanned ${changes.length} reverse-polish swaps.`);
  console.log('Sample (first 15):');
  for (const c of changes.slice(0, 15)) {
    console.log(`  [${c.type}] "${c.oldC}" -> "${c.newC}"`);
  }

  if (DRY_RUN) { await pool.end(); return; }

  console.log('\nApplying...');
  let ok = 0, fail = 0;
  for (const c of changes) {
    try {
      const newAliases = Array.from(new Set([
        ...c.aliases.filter((a) => normalise(a) !== c.newNorm),
        c.oldC,
      ]));
      await pool.query(
        `UPDATE entities SET canonical_name = $1, normalized_name = $2, aliases = $3::jsonb, updated_at = now() WHERE id = $4`,
        [c.newC, c.newNorm, JSON.stringify(newAliases), c.id]
      );
      ok++;
    } catch (err) { fail++; console.error(`id=${c.id}: ${err.message}`); }
  }

  console.log(`\n--- Done ---`);
  console.log(`Planned: ${changes.length} | Reverted: ${ok} | Failed: ${fail}`);
  await pool.end();
}

await main();
