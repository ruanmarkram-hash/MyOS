/**
 * Shell-task fast path for the scheduler.
 *
 * Background: many scheduled tasks are wrappers that just run a single shell
 * command verbatim and return stdout (heartbeats, route_invoices, refresh,
 * etc.). Spawning a full Claude Code session for each one is fragile — API
 * hiccups, slow context loads, or model tool-only responses can blow past the
 * 10m task timeout for what should be a sub-second check. Overnight 2026-05-02
 * we observed multiple heartbeat tasks killed at 10m and one audit returning
 * empty text — none of which are agent-judgment problems.
 *
 * This module detects that pattern in the prompt and runs the command
 * directly, bypassing the agent entirely. Anything that doesn't match falls
 * through to the normal agent path.
 *
 * Preconditions for bypass:
 *   - Task is marked silent (the only place we use the rigid "run X verbatim"
 *     contract today)
 *   - Prompt contains a single recognizable command line of one of the
 *     supported forms (Run: / Execute exactly: / bash X / python3 X)
 *
 * Anything else (audits, briefings, judgment-required prompts) is left alone.
 *
 * Aligned with claudeclaw-codex-migration PLAN.md Phase 4: trivial scheduled
 * tasks should be agent-free regardless of provider. Reduces the surface that
 * Phase 3 cutover has to revalidate on Codex.
 */
import { spawn } from 'node:child_process';
import { logger } from './logger.js';

/**
 * Allowlisted env vars that survive into a shell-bypass subprocess.
 *
 * Codex re-review 2026-05-04 (NEW HIGH): the schedule-cli → scheduler →
 * shell-task call chain runs an argv-controlled prompt as a bash command
 * with the FULL inherited process.env. That is the same exfil surface
 * the HIGH-3 fix closed for codex.ts, just one indirection deeper.
 *
 * Audited existing silent shell tasks (sqlite scheduled_tasks WHERE
 * silent=1): every task that needs secrets sources `.env` explicitly
 * inside its own bash command (e.g. `set -a && source /Users/sc/HQ/.env
 * && set +a && psql ...`). None rely on env inheritance for secrets.
 *
 * So the safe behaviour is to drop the entire parent env and pass only
 * the bare-minimum locale/path vars a login shell needs to resolve
 * pyenv / nvm / homebrew shims and run scripts. Anything secret-shaped
 * MUST be sourced explicitly by the task itself.
 */
const SHELL_TASK_ENV_ALLOWLIST = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'PWD',
  'TERM',
  'LANG',
  'TZ',
  'TMPDIR',
  // Keep the agent id so log lines / hive-mind writes know who fired.
  'CLAUDECLAW_AGENT_ID',
] as const;

// Locale family — LC_ALL, LC_CTYPE, LC_MESSAGES, etc. — kept as a prefix
// so we don't enumerate every variant.
const SHELL_TASK_ENV_ALLOW_PREFIXES = ['LC_'] as const;

/**
 * Build a scrubbed env for a shell-bypass subprocess.
 *
 * Exported so the test suite can assert that secrets do not leak.
 * Pure function: takes an explicit `source` (defaults to process.env)
 * so tests don't have to mutate the live env.
 */
export function buildShellTaskEnv(
  source: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of SHELL_TASK_ENV_ALLOWLIST) {
    const v = source[key];
    if (typeof v === 'string' && v.length > 0) out[key] = v;
  }
  for (const key of Object.keys(source)) {
    if (SHELL_TASK_ENV_ALLOW_PREFIXES.some((p) => key.startsWith(p))) {
      const v = source[key];
      if (typeof v === 'string' && v.length > 0) out[key] = v;
    }
  }
  return out;
}

/** Command extracted from a prompt that's safe to run without the agent. */
export interface ExtractedCommand {
  /** Full shell command line as it appears in the prompt. */
  command: string;
  /** Which pattern matched — useful for logging. */
  kind: 'run' | 'execute' | 'bash' | 'python3';
}

const PATTERNS: Array<{ kind: ExtractedCommand['kind']; re: RegExp }> = [
  // "Run: bash ~/path/script.sh" or "Run: cmd args" — must be one line.
  // [ \t]+ (not \s+) so a stray "Run:" with the command on the next line
  // does NOT match — that's a multi-line prompt the agent should handle.
  { kind: 'run', re: /^[ \t]*Run:[ \t]+([^\n]+?)[ \t]*$/m },
  // "Execute exactly: python3 ~/path.py"
  { kind: 'execute', re: /^[ \t]*Execute exactly:[ \t]+([^\n]+?)[ \t]*$/m },
  // Bare leading "bash ~/path.sh" (rare but supported)
  { kind: 'bash', re: /^\s*(bash\s+~?\/[^\n]+)$/m },
  // Bare leading "python3 ~/path.py"
  { kind: 'python3', re: /^\s*(python3\s+~?\/[^\n]+)$/m },
];

/**
 * Try to extract a single shell command from a scheduled-task prompt.
 * Returns null if the prompt isn't a simple "run this command" pattern.
 *
 * Conservative by design: if the prompt has multiple candidate commands
 * we return null and let the agent handle it (judgment required).
 */
export function tryExtractShellCommand(prompt: string): ExtractedCommand | null {
  // Strip the SILENT MODE trailer so it doesn't confuse multi-match detection.
  const head = prompt.split(/\n---\n/)[0] ?? prompt;

  let found: ExtractedCommand | null = null;
  let matchCount = 0;

  for (const { kind, re } of PATTERNS) {
    const m = head.match(re);
    if (m) {
      matchCount++;
      if (!found) {
        const command = (m[1] ?? '').trim();
        if (command.length > 0) {
          found = { command, kind };
        }
      }
    }
  }

  // If multiple distinct command patterns hit, the prompt is doing
  // something more involved than a single bypass; fall through to agent.
  if (matchCount > 1) {
    return null;
  }

  return found;
}

/** Result of running a bypassed shell command. */
export interface ShellTaskResult {
  /** Combined stdout. Trimmed. */
  stdout: string;
  /** Combined stderr. Trimmed. May be useful even on success. */
  stderr: string;
  /** Process exit code, or null if killed by signal. */
  exitCode: number | null;
  /** True if killed by our timeout. */
  timedOut: boolean;
}

/** 60s is a generous ceiling for any shell command we currently bypass. */
const SHELL_TIMEOUT_MS = 60_000;

/**
 * Execute a shell command directly via /bin/bash -lc. Login shell so PATH and
 * pyenv / nvm / homebrew shims resolve the same way they do in the prompts
 * the user has been writing.
 */
export function runShellCommand(command: string): Promise<ShellTaskResult> {
  return new Promise((resolve) => {
    const child = spawn('/bin/bash', ['-lc', command], {
      stdio: ['ignore', 'pipe', 'pipe'],
      // Codex re-review 2026-05-04: do NOT inherit process.env. The
      // command string is argv-controlled (silent scheduled-task
      // prompt), so inheriting parent secrets would re-open the same
      // exfil surface HIGH-3 closed for codex.ts. Tasks that need
      // secrets must source .env explicitly inside the command.
      env: buildShellTaskEnv(),
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, SHELL_TIMEOUT_MS);

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        exitCode: code,
        timedOut,
      });
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      logger.warn({ err, command }, 'Shell-task spawn error');
      resolve({
        stdout: stdout.trim(),
        stderr: (stderr + '\n' + (err instanceof Error ? err.message : String(err))).trim(),
        exitCode: null,
        timedOut: false,
      });
    });
  });
}
