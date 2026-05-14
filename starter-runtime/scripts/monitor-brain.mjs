#!/usr/bin/env node
// Phase 5 monitor: prints brain health stats. Designed to be run on demand
// (e.g. every few hours during the 48h parallel run) or as a scheduled task.
// Output is a one-page status block — OK to pipe into notify.sh.
//
// Checks:
//   1. MCP endpoint reachable (ping)
//   2. thoughts row count + growth since N hours ago
//   3. rows captured via MCP vs SQLite backfill
//   4. most recent capture timestamp + skew vs now
//   5. log grep for OB1 fallback errors in the last run window
//
// Exit code: 0 healthy, 1 warnings, 2 critical.

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { homedir } from 'node:os';
import pg from 'pg';
import { classifyGrowth } from './monitor-brain-classify.mjs';
import { isJsonlIncluded } from './brain-watcher-parser.mjs';

const ROOT = '~/HQ';
const env = Object.fromEntries(
  readFileSync(`${ROOT}/.env`, 'utf-8').split(/\r?\n/)
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')]; })
);

const WINDOW_HOURS = parseInt(process.argv[2] || '6', 10);

const issues = [];
const warnings = [];

// 1. ping
const pingStart = Date.now();
let pingOk = false;
try {
  const r = await fetch(`${env.OB1_SUPABASE_URL}/functions/v1/brain-mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      'x-brain-key': env.MCP_ACCESS_KEY,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'monitor', version: '1' } } }),
  });
  pingOk = r.ok;
} catch { pingOk = false; }
const pingMs = Date.now() - pingStart;
if (!pingOk) issues.push('MCP endpoint unreachable');
else if (pingMs > 2000) warnings.push(`ping slow: ${pingMs}ms`);

// 2+3+4. DB stats
const db = new pg.Client({ connectionString: env.OB1_SUPABASE_DB_URL });
await db.connect();
const stats = await db.query(`
  SELECT
    count(*)::int AS total,
    count(*) FILTER (WHERE created_at >= now() - ($1 || ' hours')::interval)::int AS recent,
    count(*) FILTER (WHERE metadata->>'source' = 'mcp')::int AS from_mcp,
    count(*) FILTER (WHERE metadata->>'source' = 'sqlite_memory')::int AS from_memories,
    count(*) FILTER (WHERE metadata->>'source' = 'sqlite_conversation_log')::int AS from_convlog,
    count(*) FILTER (WHERE embedding IS NULL)::int AS no_embedding,
    to_char(max(created_at), 'YYYY-MM-DD HH24:MI:SS TZ') AS latest
  FROM thoughts
`, [WINDOW_HOURS]);
const s = stats.rows[0];
if (s.no_embedding > 0) issues.push(`${s.no_embedding} rows without embedding`);

// Count NEW upstream jsonl files in the same window so we can tell "watcher
// broke" apart from "user was asleep, nothing to ingest". See
// ./monitor-brain-classify.mjs for the threshold rationale.
function walkAndCount(dir, cutoff, folderFilter, fileMatch, count = { n: 0 }) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return count; }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!folderFilter(entry.name)) continue;
      walkAndCount(full, cutoff, folderFilter, fileMatch, count);
    } else if (entry.isFile() && fileMatch(entry.name)) {
      let st; try { st = statSync(full); } catch { continue; }
      if (st.mtimeMs >= cutoff) count.n++;
    }
  }
  return count;
}

function countRecentJsonlFiles(windowHours) {
  const cutoff = Date.now() - windowHours * 60 * 60 * 1000;
  let total = 0;
  // Filters mirror brain-watcher.mjs's ingest universe so this count answers
  // "how many files did the watcher have a chance to ingest", not "how many
  // files exist on disk". Folders the watcher deliberately skips (e.g. ad-hoc
  // claude-worktrees, workspace agent dirs) would otherwise trip a CRITICAL
  // "watcher dropping data" false alarm.
  const roots = [
    {
      dir: join(homedir(), '.claude', 'projects'),
      recurse: true,
      folderFilter: isJsonlIncluded,
      match: (n) => n.endsWith('.jsonl'),
    },
    {
      dir: join(homedir(), '.codex', 'archived_sessions'),
      recurse: true,
      folderFilter: () => true,
      match: (n) => n.startsWith('rollout-') && n.endsWith('.jsonl'),
    },
    {
      dir: join(homedir(), '.codex', 'sessions'),
      recurse: true,
      folderFilter: () => true,
      match: (n) => n.startsWith('rollout-') && n.endsWith('.jsonl'),
    },
  ];
  for (const r of roots) {
    if (!r.recurse) {
      // Flat scan (kept for backwards compat, though all current roots recurse)
      let entries; try { entries = readdirSync(r.dir); } catch { continue; }
      for (const name of entries) {
        if (!r.match(name)) continue;
        let st; try { st = statSync(join(r.dir, name)); } catch { continue; }
        if (st.mtimeMs >= cutoff) total++;
      }
    } else {
      const count = walkAndCount(r.dir, cutoff, r.folderFilter, r.match);
      total += count.n;
    }
  }
  return total;
}
const newInputFiles = countRecentJsonlFiles(WINDOW_HOURS);
const growth = classifyGrowth({ recentThoughts: s.recent, newInputFiles, windowHours: WINDOW_HOURS });
if (growth.level === 'critical') issues.push(growth.message);

// 5. grep ClaudeClaw logs for OB1 errors in window
const logPaths = [
  '/tmp/claudeclaw-main.log',
  '/tmp/claudeclaw.log',
  `${ROOT}/store/agent-main.err`,
];
let errorLines = 0;
for (const p of logPaths) {
  if (!existsSync(p)) continue;
  const grep = spawnSync('grep', ['-c', '-E', 'OB1.*failed|ob1.*capture_thought failed', p], { encoding: 'utf-8' });
  const n = parseInt(grep.stdout.trim() || '0', 10);
  errorLines += isNaN(n) ? 0 : n;
}
if (errorLines > 0) warnings.push(`${errorLines} OB1 errors in logs`);

// Output
const status = issues.length ? 'CRITICAL' : warnings.length ? 'WARN' : 'OK';
console.log(`[brain monitor] ${status} | ${new Date().toISOString()}`);
console.log(`  ping:            ${pingOk ? `OK (${pingMs}ms)` : 'FAIL'}`);
console.log(`  thoughts total:  ${s.total}`);
console.log(`  last ${WINDOW_HOURS}h growth: +${s.recent} (input files in window: ${newInputFiles}; ${growth.level}: ${growth.message})`);
console.log(`  by source:       mcp=${s.from_mcp}, sqlite_memory=${s.from_memories}, conv_log=${s.from_convlog}`);
console.log(`  embeddings:      ${s.no_embedding === 0 ? '100%' : `MISSING: ${s.no_embedding}`}`);
console.log(`  latest capture:  ${s.latest}`);
console.log(`  log errors:      ${errorLines}`);
if (warnings.length) console.log(`  warnings:        ${warnings.join('; ')}`);
if (issues.length) console.log(`  issues:          ${issues.join('; ')}`);

await db.end();
process.exit(issues.length ? 2 : warnings.length ? 1 : 0);
