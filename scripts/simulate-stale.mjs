#!/usr/bin/env node
// Manual smoke: load build-meta module, mutate dist/.build-meta.json,
// run a stale-watcher tick, print the WARN line that index.ts would emit.
import fs from 'node:fs';
import path from 'node:path';
import { RUNTIME_BUILD_META, createStaleWatcher, shortSha, resolveBuildMetaPath } from '../dist/build-meta.js';

const metaPath = resolveBuildMetaPath();
const original = fs.readFileSync(metaPath, 'utf-8');
console.log('runtime sha:', shortSha(RUNTIME_BUILD_META.sha));

try {
  fs.writeFileSync(metaPath, JSON.stringify({
    sha: 'deadbeefcafe1234567890',
    branch: 'simulated',
    builtAt: new Date().toISOString(),
  }));
  const watcher = createStaleWatcher();
  const r = watcher.tick();
  // Format identical to src/index.ts:
  const diffMsg = `STALE_CODE_DETECTED runtime_sha=${shortSha(r.runtimeSha)} disk_sha=${shortSha(r.diskSha)}`;
  console.log('[WARN]', diffMsg, '| stale=', r.stale, 'shouldNotify=', r.shouldNotify);
  // Tick again — debounce.
  const r2 = watcher.tick();
  console.log('[tick2] stale=', r2.stale, 'shouldNotify=', r2.shouldNotify, '(should be false)');
} finally {
  fs.writeFileSync(metaPath, original);
  console.log('restored', path.basename(metaPath));
}
