#!/usr/bin/env node
/**
 * check-no-raw-spawn — guardrail for the safe-spawn convergence.
 *
 * Codex adversarial review (2026-05-04) found 11 spawn/exec sites
 * leaking process.env. The fix routes every subprocess through
 * src/safe-spawn.ts. This script enforces convergence: any new file
 * that imports node:child_process directly, calls
 * spawn/exec/execFile/spawnSync/fork raw, or creates a promisified
 * alias of one of those, is flagged.
 *
 * Why this and not eslint:
 *   The repo has no eslint config today. Wiring eslint + a custom
 *   rule plugin just for this single guardrail is heavy tooling for
 *   one check. This script has zero deps, runs in under 200ms, and
 *   produces the same convergence pressure.
 *
 * Detection model:
 *   1. Scan imports/destructures/dynamic-imports of node:child_process
 *      and collect all binding names (default, named, namespace, alias).
 *   2. Scan `const X = promisify(Y)` / `const X = util.promisify(Y)`
 *      where Y is a tracked binding → add X to the tracked set.
 *   3. Flag any call site whose callee is a tracked name (or
 *      <namespace>.spawn / .exec / .execFile / .spawnSync / .fork).
 *
 * Allow-list:
 *   - src/safe-spawn.ts itself (the chokepoint).
 *   - security.ts and shell-task.ts (env-shape foundations).
 *   - Any line carrying the marker comment, where the marker MUST
 *     appear inside a // or /* *\/ comment (not a string literal):
 *       // SAFE-SPAWN-EXEMPT: <one-line justification>
 *     The marker may appear on the same line as the offending call
 *     or import, or on the line immediately above.
 *
 * Usage:
 *   node scripts/check-no-raw-spawn.mjs        # exit 1 on violations
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const SRC = join(ROOT, 'src');
const SAFE_SPAWN = join(SRC, 'safe-spawn.ts');

const FILE_ALLOWLIST = new Set([
  SAFE_SPAWN,
  join(SRC, 'security.ts'),
  join(SRC, 'shell-task.ts'),
]);

const RAW_NAMES = ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'];
const RAW_SET = new Set(RAW_NAMES);

const CP_SOURCE_RE = /['"](?:node:)?child_process['"]/;

const EXEMPT_TEXT = 'SAFE-SPAWN-EXEMPT:';

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

/**
 * Determine whether a SAFE-SPAWN-EXEMPT marker on a given line is
 * inside a real comment (not a string literal).
 *
 * Approach: walk the line char-by-char tracking string/comment state.
 * If the marker text begins while we are inside a // or /* *\/
 * comment, it counts. If we see it inside a string, it does not.
 *
 * Block comments that span lines: caller passes prevBlockComment=true
 * if the previous line ended inside an unterminated /* block.
 */
function exemptOnLine(line, prevBlockComment) {
  let i = 0;
  let inBlock = !!prevBlockComment;
  let inLine = false;
  let inStr = null; // "'" | '"' | '`'
  let escaped = false;
  while (i < line.length) {
    const c = line[i];
    const n = line[i + 1];
    if (inBlock) {
      // marker must be inside this block
      if (line.startsWith(EXEMPT_TEXT, i)) return { exempt: true, blockOpen: true };
      if (c === '*' && n === '/') { inBlock = false; i += 2; continue; }
      i++; continue;
    }
    if (inLine) {
      if (line.startsWith(EXEMPT_TEXT, i)) return { exempt: true, blockOpen: false };
      i++; continue;
    }
    if (inStr) {
      if (escaped) { escaped = false; i++; continue; }
      if (c === '\\') { escaped = true; i++; continue; }
      if (c === inStr) { inStr = null; i++; continue; }
      i++; continue;
    }
    if (c === '/' && n === '/') { inLine = true; i += 2; continue; }
    if (c === '/' && n === '*') { inBlock = true; i += 2; continue; }
    if (c === '"' || c === "'" || c === '`') { inStr = c; i++; continue; }
    i++;
  }
  return { exempt: false, blockOpen: inBlock };
}

/**
 * Track block-comment state line-by-line for a file so we can ask
 * "is line N starting inside an unterminated /* block?".
 */
function computeBlockState(lines) {
  const state = new Array(lines.length).fill(false);
  let open = false;
  for (let i = 0; i < lines.length; i++) {
    state[i] = open;
    // Walk this line, ignoring strings, to update open.
    const line = lines[i];
    let j = 0;
    let inStr = null;
    let escaped = false;
    let inLine = false;
    while (j < line.length) {
      const c = line[j];
      const n = line[j + 1];
      if (inLine) break;
      if (open) {
        if (c === '*' && n === '/') { open = false; j += 2; continue; }
        j++; continue;
      }
      if (inStr) {
        if (escaped) { escaped = false; j++; continue; }
        if (c === '\\') { escaped = true; j++; continue; }
        if (c === inStr) { inStr = null; j++; continue; }
        j++; continue;
      }
      if (c === '/' && n === '/') { inLine = true; break; }
      if (c === '/' && n === '*') { open = true; j += 2; continue; }
      if (c === '"' || c === "'" || c === '`') { inStr = c; j++; continue; }
      j++;
    }
  }
  return state;
}

/**
 * Strip strings and comments from a line so call/identifier regexes
 * don't false-positive on text that appears inside a string literal.
 */
function stripStringsAndComments(line, blockOpen) {
  let out = '';
  let i = 0;
  let inBlock = blockOpen;
  let inStr = null;
  let escaped = false;
  while (i < line.length) {
    const c = line[i];
    const n = line[i + 1];
    if (inBlock) {
      if (c === '*' && n === '/') { inBlock = false; i += 2; out += '  '; continue; }
      out += ' '; i++; continue;
    }
    if (inStr) {
      if (escaped) { escaped = false; out += ' '; i++; continue; }
      if (c === '\\') { escaped = true; out += ' '; i++; continue; }
      if (c === inStr) { inStr = null; out += ' '; i++; continue; }
      out += ' '; i++; continue;
    }
    if (c === '/' && n === '/') { break; }
    if (c === '/' && n === '*') { inBlock = true; i += 2; out += '  '; continue; }
    if (c === '"' || c === "'" || c === '`') { inStr = c; out += ' '; i++; continue; }
    out += c; i++;
  }
  return out;
}

function collectChildProcessBindings(text) {
  // Returns Set<string> of identifier bindings that resolve to
  // child_process module or one of its raw call functions.
  const direct = new Set(); // names that ARE raw call functions
  const ns = new Set();     // namespace identifiers (cp.spawn etc)
  const moduleAlias = new Set(); // identifiers holding the whole module

  // Strip comments only — keep string contents so module sources
  // like 'child_process' survive for the import/require matchers.
  const cleaned = text
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');

  // import X from 'child_process'  (rare, default-style)
  for (const m of cleaned.matchAll(new RegExp(`import\\s+([A-Za-z_$][\\w$]*)\\s+from\\s+${CP_SOURCE_RE.source}`, 'g'))) {
    moduleAlias.add(m[1]); ns.add(m[1]);
  }
  // import * as X from 'child_process'
  for (const m of cleaned.matchAll(new RegExp(`import\\s*\\*\\s*as\\s+([A-Za-z_$][\\w$]*)\\s+from\\s+${CP_SOURCE_RE.source}`, 'g'))) {
    moduleAlias.add(m[1]); ns.add(m[1]);
  }
  // import { a, b as c } from 'child_process'
  for (const m of cleaned.matchAll(new RegExp(`import\\s*\\{([^}]+)\\}\\s*from\\s+${CP_SOURCE_RE.source}`, 'g'))) {
    for (const part of m[1].split(',')) {
      const p = part.trim(); if (!p) continue;
      const am = p.match(/^([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/);
      if (!am) continue;
      const orig = am[1], alias = am[2] || am[1];
      if (RAW_SET.has(orig)) direct.add(alias);
    }
  }
  // const X = require('child_process')   or  await import('child_process')
  const reqRe = new RegExp(`(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*(?:require|await\\s+import)\\s*\\(\\s*${CP_SOURCE_RE.source}\\s*\\)`, 'g');
  for (const m of cleaned.matchAll(reqRe)) { moduleAlias.add(m[1]); ns.add(m[1]); }
  // const { a, b: c } = require('child_process') / await import(...)
  const destrRe = new RegExp(`(?:const|let|var)\\s*\\{([^}]+)\\}\\s*=\\s*(?:require|await\\s+import)\\s*\\(\\s*${CP_SOURCE_RE.source}\\s*\\)`, 'g');
  for (const m of cleaned.matchAll(destrRe)) {
    for (const part of m[1].split(',')) {
      const p = part.trim(); if (!p) continue;
      const am = p.match(/^([A-Za-z_$][\w$]*)(?:\s*:\s*([A-Za-z_$][\w$]*))?$/);
      if (!am) continue;
      const orig = am[1], alias = am[2] || am[1];
      if (RAW_SET.has(orig)) direct.add(alias);
    }
  }
  // Re-destructures from a module alias: const { spawn } = cp;
  if (moduleAlias.size) {
    const aliasList = [...moduleAlias].join('|');
    const reReDestr = new RegExp(`(?:const|let|var)\\s*\\{([^}]+)\\}\\s*=\\s*(?:${aliasList})\\b`, 'g');
    for (const m of cleaned.matchAll(reReDestr)) {
      for (const part of m[1].split(',')) {
        const p = part.trim(); if (!p) continue;
        const am = p.match(/^([A-Za-z_$][\w$]*)(?:\s*:\s*([A-Za-z_$][\w$]*))?$/);
        if (!am) continue;
        const orig = am[1], alias = am[2] || am[1];
        if (RAW_SET.has(orig)) direct.add(alias);
      }
    }
  }
  // promisify(X) / util.promisify(X)
  // const Y = promisify(X)
  const promRe = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:[A-Za-z_$][\w$]*\.)?promisify\s*\(\s*([A-Za-z_$][\w$.]*)\s*\)/g;
  // Need fixed-point: if X resolves to a tracked name (direct or ns.member where member is raw)
  // single pass is enough since promisify is rarely chained.
  for (const m of cleaned.matchAll(promRe)) {
    const newName = m[1];
    const arg = m[2];
    if (direct.has(arg)) { direct.add(newName); continue; }
    const dot = arg.split('.');
    if (dot.length === 2 && moduleAlias.has(dot[0]) && RAW_SET.has(dot[1])) {
      direct.add(newName);
    }
  }
  return { direct, ns };
}

function checkFile(filePath) {
  if (FILE_ALLOWLIST.has(filePath)) return;
  let text;
  try { text = readFileSync(filePath, 'utf8'); } catch { return; }

  // Quick reject — only files that mention child_process or one of
  // the raw names need full analysis. (We still need the alias
  // tracker to catch promisified renames in this file.)
  if (!CP_SOURCE_RE.test(text) && !RAW_NAMES.some((n) => text.includes(n))) return;

  const lines = text.split('\n');
  const blockState = computeBlockState(lines);
  const { direct, ns } = collectChildProcessBindings(text);

  // Build per-line check.
  const callNames = new Set([...direct]);
  // Also flag bare RAW_NAMES if they appear AS A CALL and a child_process
  // import exists in this file (defensive: catches `spawn(...)` after
  // `const { spawn } = require('child_process')` when our destructure
  // matcher misses some shape).
  const cpImported = CP_SOURCE_RE.test(text);

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const stripped = stripStringsAndComments(raw, blockState[i]);
    if (!stripped.trim()) continue;

    let importHit = false;
    let callHit = false;
    let hitText = '';

    // import / require / dynamic-import of child_process on this line.
    // Test on the raw line (strings intact) but only after we've
    // confirmed the line isn't entirely inside a comment.
    const rawNoLineComment = raw.replace(/\/\/.*$/, '');
    if (CP_SOURCE_RE.test(rawNoLineComment) && /(?:from|import|require)\b/.test(rawNoLineComment) && stripped.trim()) {
      importHit = true; hitText = raw.trim();
    }

    // Calls to tracked names: NAME(   where NAME is a word boundary.
    if (!importHit) {
      // tracked direct names
      for (const name of callNames) {
        const re = new RegExp(`(?<![A-Za-z0-9_$.])${name}\\s*\\(`);
        if (re.test(stripped)) { callHit = true; hitText = raw.trim(); break; }
      }
      // namespace calls: ns.spawn(, ns.exec(, etc.
      if (!callHit) {
        for (const n of ns) {
          const re = new RegExp(`(?<![A-Za-z0-9_$.])${n}\\.(?:${RAW_NAMES.join('|')})\\s*\\(`);
          if (re.test(stripped)) { callHit = true; hitText = raw.trim(); break; }
        }
      }
      // bare raw-name calls when child_process is imported in this file
      if (!callHit && cpImported) {
        for (const name of RAW_NAMES) {
          const re = new RegExp(`(?<![A-Za-z0-9_$.])${name}\\s*\\(`);
          if (re.test(stripped)) { callHit = true; hitText = raw.trim(); break; }
        }
      }
    }

    if (!importHit && !callHit) continue;

    // Exemption: marker must be inside a comment on this line or the
    // line above (and the comment context must carry through for
    // line-above checks too).
    const same = exemptOnLine(raw, blockState[i]).exempt;
    let above = false;
    if (i > 0) {
      above = exemptOnLine(lines[i - 1], blockState[i - 1]).exempt;
    }
    if (same || above) continue;

    VIOLATIONS.push({
      file: relative(ROOT, filePath),
      line: i + 1,
      kind: importHit ? 'import' : 'call',
      text: hitText,
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
console.error('Or add a justification IN A COMMENT on the offending line or above:');
console.error("  // SAFE-SPAWN-EXEMPT: <reason — what makes this safe>");
process.exit(1);
