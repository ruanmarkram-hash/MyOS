/**
 * Per-call MCP server filter for the Codex provider.
 *
 * Why this exists
 * ----------------
 * Codex's MCP config lives globally at `~/.codex/config.toml` and applies to
 * every `codex exec` invocation. ClaudeClaw's per-agent
 * `agent.yaml.mcp_servers` allowlist therefore has no effect under Codex
 * unless we filter the config at call time.
 *
 * Approach
 * --------
 * For each Codex invocation that carries an mcpAllowlist:
 *   1. Build a temp `CODEX_HOME` directory.
 *   2. Symlink everything from the real `~/.codex` into it EXCEPT config.toml
 *      (auth tokens, sessions, marketplaces, caches, etc. all need to remain
 *      addressable so resume / auth / plugins still work).
 *   3. Write a *filtered* config.toml that drops any
 *      `[mcp_servers.<name>]` (and nested `[mcp_servers.<name>.*]`) block
 *      whose name is not in the allowlist. Everything else is preserved
 *      byte-for-byte.
 *   4. `spawn('codex', ..., { env: { CODEX_HOME: <tempdir>, ... } })`.
 *   5. Clean up the temp dir when the call finishes (or aborts).
 *
 * The filter is a line-based scanner rather than a full TOML parser to avoid
 * adding a dependency for one narrow use case. TOML's table-header grammar
 * is regular enough (`[name.path]` on its own line) for this to be safe.
 *
 * Provider-agnostic intent
 * ------------------------
 * The contract being enforced ("if `mcpAllowlist` is non-undefined, the
 * provider must expose only servers from that list") is part of the
 * `LlmProvider` interface from Phase 1. The Claude provider already
 * satisfies it via `loadMcpServers`. This module is the equivalent for
 * Codex. A future local-model provider must satisfy the same contract
 * (enforced via the contract test in `llm-provider.test.ts`).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import { logger } from '../logger.js';

/**
 * Filter a TOML config string, dropping any `[mcp_servers.<name>]` table and
 * its nested `[mcp_servers.<name>.<sub>]` tables whose <name> is NOT in the
 * allowlist. All other content is preserved exactly.
 *
 * Implementation: scans line-by-line. When a line opens a table that begins
 * with `mcp_servers.`, we extract <name>. If it's allowlisted we keep the
 * block; otherwise we drop everything until the next non-mcp_servers table
 * header (or EOF).
 *
 * Edge cases handled:
 *  - Quoted names: `[mcp_servers."weird name"]`
 *  - Nested tables: `[mcp_servers.foo.env_http_headers]`
 *  - Blank lines + comments inside a dropped block
 *  - File doesn't define mcp_servers at all → returned unchanged
 *  - allowlist is empty → all mcp_servers blocks dropped
 */
export function filterMcpServers(configToml: string, allowlist: string[]): string {
  const allowed = new Set(allowlist);
  const lines = configToml.split(/\r?\n/);
  const out: string[] = [];
  let droppingUntilNextTable = false;
  // TOML multiline string state: triple-double `"""` and triple-single `'''`.
  // While inside a multiline string the contents may contain anything,
  // including lines that LOOK like table headers. We must not treat those
  // as headers. The state machine flips when we see the matching delimiter
  // (counting triple-occurrences per line, not per character).
  let inTripleDouble = false;
  let inTripleSingle = false;

  for (const line of lines) {
    if (!inTripleDouble && !inTripleSingle) {
      const tableMatch = line.match(/^\s*\[\s*([^\]]+?)\s*\]\s*(?:#.*)?$/);
      if (tableMatch) {
        const tablePath = tableMatch[1]!;
        const name = mcpServersName(tablePath);
        if (name === null) {
          // Not an mcp_servers table — keep this line and stop dropping.
          droppingUntilNextTable = false;
          out.push(line);
        } else if (allowed.has(name)) {
          droppingUntilNextTable = false;
          out.push(line);
        } else {
          droppingUntilNextTable = true;
          // skip the header line itself
        }
        // Update string state from this header line too — defensive, in
        // case a header line somehow contained an embedded ''' or """.
        const flips = countTripleStringFlips(line);
        if (flips.tripleDouble & 1) inTripleDouble = !inTripleDouble;
        if (flips.tripleSingle & 1) inTripleSingle = !inTripleSingle;
        continue;
      }
    }

    // Track string state changes for non-header lines. Always emit the
    // line if we're not currently dropping (string content inside a kept
    // block is preserved verbatim).
    const flips = countTripleStringFlips(line);
    const tripleDoubleParity = flips.tripleDouble & 1;
    const tripleSingleParity = flips.tripleSingle & 1;

    if (!droppingUntilNextTable) out.push(line);
    // else: inside a dropped block — string content is dropped too,
    // which is correct because the whole block is gone.

    if (tripleDoubleParity) inTripleDouble = !inTripleDouble;
    if (tripleSingleParity) inTripleSingle = !inTripleSingle;
  }

  return out.join('\n');
}

/**
 * Count occurrences of TOML's triple-quote multiline string delimiters
 * on a single line. Used to maintain "are we inside a multiline string"
 * state across lines so that lines like `[mcp_servers.x]` appearing
 * INSIDE a multiline string aren't misread as table headers.
 *
 * Note: full TOML escape semantics (e.g. `\"\"\"` inside a basic string)
 * are not handled. Codex's config.toml is generated, not hand-edited
 * with adversarial inputs, so this is sufficient for the threat model.
 */
export function countTripleStringFlips(line: string): {
  tripleDouble: number;
  tripleSingle: number;
} {
  const tripleDouble = (line.match(/"""/g) ?? []).length;
  const tripleSingle = (line.match(/'''/g) ?? []).length;
  return { tripleDouble, tripleSingle };
}

/**
 * Given a TOML table path (the part inside the `[]`), return the mcp server
 * name it refers to, or `null` if this isn't an mcp_servers table.
 *
 * Examples:
 *   "mcp_servers.brain-mcp"                       → "brain-mcp"
 *   "mcp_servers.brain-mcp.env_http_headers"      → "brain-mcp"
 *   "mcp_servers.\"weird name\""                  → "weird name"
 *   "marketplaces.openai-bundled"                 → null
 *   "mcp_servers"                                 → null  (parent only, no name)
 */
export function mcpServersName(tablePath: string): string | null {
  const trimmed = tablePath.trim();
  if (!trimmed.startsWith('mcp_servers')) return null;
  const rest = trimmed.slice('mcp_servers'.length);
  if (rest.length === 0) return null;
  if (!rest.startsWith('.')) return null;
  const after = rest.slice(1);
  // First segment: either "name" (bare) or "\"quoted name\""
  if (after.startsWith('"')) {
    const close = after.indexOf('"', 1);
    if (close === -1) return null;
    return after.slice(1, close);
  }
  const dot = after.indexOf('.');
  return dot === -1 ? after : after.slice(0, dot);
}

/** Return value from {@link prepareCodexHome}. */
export interface CodexHomePrep {
  /** Path to the prepared CODEX_HOME directory (pass to spawn env). */
  home: string;
  /** Synchronous cleanup. Idempotent — safe to call multiple times. */
  cleanup: () => void;
}

/**
 * Prepare a temporary CODEX_HOME directory that mirrors the real one but
 * with `config.toml` filtered to only the allowlisted MCP servers.
 *
 * If `realHome` doesn't exist or doesn't contain config.toml, returns a
 * cleanup-only handle pointing at the real home (no filtering needed —
 * Codex will use its own defaults).
 */
export function prepareCodexHome(allowlist: string[], realHome?: string): CodexHomePrep {
  const home = realHome ?? path.join(os.homedir(), '.codex');
  const configPath = path.join(home, 'config.toml');
  if (!fs.existsSync(configPath)) {
    // No config to filter; pass through.
    return { home, cleanup: () => {} };
  }

  const tempBase = os.tmpdir();
  const id = crypto.randomBytes(6).toString('hex');
  const tempHome = path.join(tempBase, `codex-allowlist-${id}`);
  fs.mkdirSync(tempHome, { recursive: true, mode: 0o700 });

  // Build cleanup IMMEDIATELY after mkdirSync so we can rm the temp dir
  // even if a later step throws. Critical: the temp dir contains symlinks
  // to auth.json / sessions / etc. — leaking it on a setup failure leaves
  // live links to credential material lying around.
  let cleanedUp = false;
  const cleanup = (): void => {
    if (cleanedUp) return;
    cleanedUp = true;
    try {
      fs.rmSync(tempHome, { recursive: true, force: true });
    } catch (err) {
      logger.warn({ err, tempHome }, 'codex-mcp-filter: cleanup failed');
    }
  };

  try {
    // Symlink everything from real home into temp home, except config.toml.
    for (const entry of fs.readdirSync(home)) {
      if (entry === 'config.toml') continue;
      const target = path.join(home, entry);
      const link = path.join(tempHome, entry);
      try {
        fs.symlinkSync(target, link);
      } catch (err) {
        // Best-effort: if a symlink fails (eg permissions), log and continue.
        // The agent may still work for read-only resources but resume / auth
        // could be impacted. Surface this in logs.
        logger.warn({ err, target, link }, 'codex-mcp-filter: symlink failed');
      }
    }

    // Write filtered config.toml.
    const original = fs.readFileSync(configPath, 'utf8');
    const filtered = filterMcpServers(original, allowlist);
    fs.writeFileSync(path.join(tempHome, 'config.toml'), filtered, { mode: 0o600 });
  } catch (err) {
    // Setup failed after mkdirSync. Rip the temp dir back out so we don't
    // leak the symlinks-to-credentials it might contain, then rethrow.
    cleanup();
    throw err;
  }

  return { home: tempHome, cleanup };
}
