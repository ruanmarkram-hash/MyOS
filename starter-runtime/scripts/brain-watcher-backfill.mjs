#!/usr/bin/env node
// One-shot backfill script for Codex sessions that were missed after the path
// migration. Runs brain-watcher.mjs with an extended lookback window (30 days)
// to catch sessions from 2026-05-05 onward that weren't ingested because
// brain-watcher was looking at the old flat archive dir instead of the new
// dated tree at ~/.codex/sessions/YYYY/MM/DD/.
//
// Usage: node scripts/brain-watcher-backfill.mjs

import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BACKFILL_LOOKBACK_DAYS = 30;
const BACKFILL_LOOKBACK_MS = BACKFILL_LOOKBACK_DAYS * 24 * 60 * 60 * 1000;

console.log(`[backfill] Starting Codex session backfill (${BACKFILL_LOOKBACK_DAYS} day lookback)`);
console.log(`[backfill] Scanning ~/.codex/sessions/** and ~/.codex/archived_sessions/`);

const result = spawnSync('node', [join(__dirname, 'brain-watcher.mjs')], {
  env: { ...process.env, MTIME_LOOKBACK_MS_OVERRIDE: String(BACKFILL_LOOKBACK_MS) },
  encoding: 'utf-8',
  stdio: 'inherit',
});

if (result.status !== 0) {
  console.error(`[backfill] Failed with exit code ${result.status}`);
  process.exit(result.status);
}

console.log(`[backfill] Backfill complete. Check ~/myos/logs/brain-watcher.log for stats.`);
