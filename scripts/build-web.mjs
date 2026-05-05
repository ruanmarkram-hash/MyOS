#!/usr/bin/env node
/**
 * build-web — invoked from the root postbuild step.
 *
 * Runs `npm run build` inside web/ (the Mission Control v2 React/Vite
 * project) and then mirrors the output into dist/web/ so the dashboard
 * router shim in src/dashboard.ts can serve it from a single location
 * relative to PROJECT_ROOT. We use a copy (not a symlink) so the
 * artifact survives clean tsc rebuilds that wipe dist/, and so the
 * stale-code detector reads consistent file metadata.
 *
 * Skips silently when web/ is absent (e.g. someone running tsc on a
 * stripped checkout). Failures inside the web build are surfaced via
 * non-zero exit so root `npm run build` fails loudly when the v2
 * bundle is broken.
 */

import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, cpSync, statSync, renameSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const WEB_DIR = join(ROOT, 'web');
const WEB_DIST = join(WEB_DIR, 'dist');
const ROOT_DIST_WEB = join(ROOT, 'dist', 'web');

if (!existsSync(WEB_DIR)) {
  console.log('[build-web] web/ not present — skipping v2 frontend build');
  process.exit(0);
}

if (!existsSync(join(WEB_DIR, 'package.json'))) {
  console.log('[build-web] web/package.json missing — skipping v2 frontend build');
  process.exit(0);
}

// Install deps if node_modules/.package-lock.json is missing or stale.
// We let npm decide via `--prefer-offline` to keep this fast on warm caches
// while still self-healing a fresh clone.
const webNodeModules = join(WEB_DIR, 'node_modules');
if (!existsSync(webNodeModules)) {
  console.log('[build-web] installing web/ dependencies (first run)');
  execSync('npm install --prefer-offline --no-audit --no-fund', {
    cwd: WEB_DIR,
    stdio: 'inherit',
  });
}

console.log('[build-web] building Mission Control v2 (web/)');
execSync('npm run build', { cwd: WEB_DIR, stdio: 'inherit' });

if (!existsSync(WEB_DIST) || !statSync(WEB_DIST).isDirectory()) {
  console.error('[build-web] expected web/dist/ after build but none found');
  process.exit(1);
}

// Mirror web/dist/ → dist/web/. Codex MED (A.3 review): the previous
// "rmSync then cpSync" sequence left a window where the dashboard
// could see a half-mirrored ROOT_DIST_WEB if a request landed during
// the copy. Use a temp staging dir + atomic rename to flip the
// directory in one inode operation, eliminating the window.
mkdirSync(dirname(ROOT_DIST_WEB), { recursive: true });
const STAGING = ROOT_DIST_WEB + '.staging';
const PURGATORY = ROOT_DIST_WEB + '.purgatory';

// Clean up any leftover staging from a prior crashed build first.
if (existsSync(STAGING)) rmSync(STAGING, { recursive: true, force: true });
if (existsSync(PURGATORY)) rmSync(PURGATORY, { recursive: true, force: true });

cpSync(WEB_DIST, STAGING, { recursive: true });

// Atomic flip: rename current dist/web/ aside, then rename staging into
// place. The window where neither exists is bounded by two rename()
// syscalls — sub-millisecond on local filesystems. A request that lands
// in that window will see ENOENT on serveV2 and get a 503 with a clear
// "build not found" message, which is preferable to serving partial files.
if (existsSync(ROOT_DIST_WEB)) {
  renameSync(ROOT_DIST_WEB, PURGATORY);
}
renameSync(STAGING, ROOT_DIST_WEB);
if (existsSync(PURGATORY)) {
  rmSync(PURGATORY, { recursive: true, force: true });
}

console.log(`[build-web] atomically swapped web/dist/ → ${ROOT_DIST_WEB}`);
