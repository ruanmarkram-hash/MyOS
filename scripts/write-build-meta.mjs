#!/usr/bin/env node
/**
 * write-build-meta — writes dist/.build-meta.json after tsc build.
 *
 * Captures the git SHA, branch, and ISO timestamp at build time so
 * the live process can later compare its in-memory snapshot against
 * the on-disk build and detect stale-code drift (b15c047 incident:
 * fixes shipped to disk but the live Telegram process kept running
 * the cached pre-fix code, silently dropping 6 notifications).
 *
 * Tiny on purpose: zero deps, runs in <100ms, never throws on a
 * detached HEAD or missing git — emits "unknown" instead so the
 * build never fails because of metadata.
 */
import { execSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const OUT = join(ROOT, 'dist', '.build-meta.json');

function safeGit(args) {
  try {
    return execSync(`git ${args}`, { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString().trim();
  } catch {
    return 'unknown';
  }
}

const meta = {
  sha: safeGit('rev-parse HEAD'),
  branch: safeGit('rev-parse --abbrev-ref HEAD'),
  builtAt: new Date().toISOString(),
};

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(meta, null, 2) + '\n');
console.log(`[build-meta] wrote ${OUT} sha=${meta.sha.slice(0, 7)} branch=${meta.branch}`);
