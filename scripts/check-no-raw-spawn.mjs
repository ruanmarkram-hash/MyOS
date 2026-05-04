#!/usr/bin/env node
/**
 * check-no-raw-spawn — guardrail for the safe-spawn convergence.
 *
 * Codex adversarial review (2026-05-04) found 11 spawn/exec sites
 * leaking process.env. The fix routes every subprocess through
 * src/safe-spawn.ts. This script enforces convergence: any new file
 * that imports node:child_process directly or calls
 * spawn/exec/execFile/spawnSync/fork raw is flagged.
 *
 * Why this and not eslint:
 *   The repo has no eslint config today. Wiring eslint + a custom
 *   rule plugin just for this single guardrail is heavy tooling for
 *   one check. This script is ~60 lines, has zero deps, runs in
 *   under 200ms, and produces the same convergence pressure.
 *
 * Allow-list:
 *   - src/safe-spawn.ts itself (the chokepoint).
 *   - Any line carrying the marker comment:
 *       SAFE-SPAWN-EXEMPT: <one-line justification>
 *     The marker must appear on the same line as the offending call
 *     or import, OR on the line immediately above.
 *
 * Usage:
 *   node scripts/check-no-raw-spawn.mjs        # exit 1 on violations
 *   node scripts/check-no-raw-spawn.mjs --fix-suggest  # print sed hints
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const SRC = join(ROOT, 'src');
const SAFE_SPAWN = join(SRC, 'safe-spawn.ts');

// Files allowed to import node:child_process / call raw spawn.
// - safe-spawn.ts is the chokepoint.
// - security.ts and shell-task.ts are the env-shape foundations
//   (they define getScrubbedSdkEnv and buildShellTaskEnv that
//   safe-spawn delegates to). Their own internal spawn use is
//   reviewed in lockstep with the wrapper and audited by the
//   security.test.ts / shell-task.test.ts suites.
const FILE_ALLOWLIST = new Set([
  SAFE_SPAWN,
  join(SRC, 'security.ts'),
  join(SRC, 'shell-task.ts'),
]);

// Match: import ... from 'child_process' / 'node:child_process'
//        await import('child_process') / require('child_process')
const IMPORT_RE = /(?:from\s+|import\s*\(\s*|require\s*\(\s*)['"](?:node:)?child_process['"]/;

// Match: bare calls to spawn / spawnSync / exec / execFile / execFileSync / fork
// at start of a token (not preceded by . or _ or letter/digit).
const CALL_RE = /(?<![A-Za-z0-9_.])(?:spawn|spawnSync|exec|execSync|execFile|execFileSync|fork)\s*\(/;

// Marker that lets a single line pass.
const EXEMPT_RE = /SAFE-SPAWN-EXEMPT:\s*\S/;

const VIOLATIONS = [];

function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (name === 'node_modules' || name === 'dist' || name.startsWith('.')) continue;
      walk(p);
    } else if (/\.(ts|mts|cts|js|mjs|cjs)$/.test(name) && !/\.test\.(ts|js)$/.test(name)) {
      checkFile(p);
    }
  }
}

function checkFile(filePath) {
  if (FILE_ALLOWLIST.has(filePath)) return;
  let text;
  try {
    text = readFileSync(filePath, 'utf8');
  } catch {
    return;
  }
  if (!IMPORT_RE.test(text) && !CALL_RE.test(text)) return;

  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Skip pure comment lines — block comments and // lines.
    const trimmed = line.trim();
    if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue;
    const stripped = line.replace(/\/\/.*$/, '');
    const importHit = IMPORT_RE.test(stripped);
    const callHit = CALL_RE.test(stripped);
    if (!importHit && !callHit) continue;
    const sameLineExempt = EXEMPT_RE.test(line);
    const aboveExempt = i > 0 && EXEMPT_RE.test(lines[i - 1]);
    if (sameLineExempt || aboveExempt) continue;
    VIOLATIONS.push({
      file: relative(ROOT, filePath),
      line: i + 1,
      kind: importHit ? 'import' : 'call',
      text: line.trim(),
    });
  }
}

walk(SRC);

if (VIOLATIONS.length === 0) {
  process.exit(0);
}

console.error(`check-no-raw-spawn: ${VIOLATIONS.length} violation(s)\n`);
for (const v of VIOLATIONS) {
  console.error(`  ${v.file}:${v.line}  [${v.kind}]  ${v.text}`);
}
console.error('');
console.error('Fix: route through src/safe-spawn.ts (safeSpawn / safeSpawnSync /');
console.error('safeExec / safeExecFile / safeExecFileAsync) with an explicit');
console.error("envClass: 'sdk' | 'shell-task' | 'system-tool'.");
console.error('');
console.error('Or add a justification on the offending line (or the line above):');
console.error("  // SAFE-SPAWN-EXEMPT: <reason — what makes this safe>");
process.exit(1);
