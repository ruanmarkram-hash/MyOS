#!/usr/bin/env node
// Quick verification script to check Codex ingestion results

import { readFileSync } from 'node:fs';
import pg from 'pg';

const ROOT = '~/HQ';
const env = Object.fromEntries(
  readFileSync(`${ROOT}/.env`, 'utf-8').split(/\r?\n/)
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')]; })
);

const db = new pg.Client({ connectionString: env.OB1_SUPABASE_DB_URL });
await db.connect();

// Count Codex thoughts by date
const result = await db.query(`
  SELECT
    COUNT(*)::int AS total_codex,
    COUNT(*) FILTER (WHERE created_at >= now() - interval '7 days')::int AS last_7d,
    COUNT(*) FILTER (WHERE created_at >= now() - interval '30 days')::int AS last_30d,
    to_char(MIN(created_at), 'YYYY-MM-DD') AS oldest,
    to_char(MAX(created_at), 'YYYY-MM-DD') AS newest
  FROM thoughts
  WHERE metadata->>'source' = 'codex'
`);

const stats = result.rows[0];
console.log('=== Codex Ingestion Stats ===');
console.log(`Total Codex thoughts: ${stats.total_codex}`);
console.log(`Last 7 days:          ${stats.last_7d}`);
console.log(`Last 30 days:         ${stats.last_30d}`);
console.log(`Date range:           ${stats.oldest} to ${stats.newest}`);

// Check recent brain-watcher runs
const logResult = await db.query(`
  SELECT
    to_char(created_at, 'YYYY-MM-DD HH24:MI:SS') AS run_time,
    (metadata->>'codex_files')::int AS files,
    (metadata->>'codex_inserted')::int AS inserted
  FROM thoughts
  WHERE metadata->>'type' = 'codex_watcher'
  ORDER BY created_at DESC
  LIMIT 10
`);

if (logResult.rowCount === 0) {
  console.log('\nNote: brain-watcher run stats not available (schema may not track this)');
} else {
  console.log('\n=== Recent brain-watcher runs ===');
  logResult.rows.forEach(r => {
    console.log(`${r.run_time}: ${r.files} files, ${r.inserted} inserted`);
  });
}

await db.end();
