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
