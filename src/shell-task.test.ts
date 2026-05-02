import { describe, it, expect } from 'vitest';
import { tryExtractShellCommand, runShellCommand } from './shell-task.js';

describe('tryExtractShellCommand', () => {
  it('extracts "Run: bash <path>" form', () => {
    const got = tryExtractShellCommand(
      'Run: bash ~/workspace/operations/engine-room/skills/msgraph/refresh.sh — Print exactly what the script outputs, nothing else.'
    );
    // Match consumes the rest of the line including the explanatory tail —
    // that's fine, the user wrote it as a literal command line.
    expect(got).not.toBeNull();
    expect(got?.kind).toBe('run');
    expect(got?.command.startsWith('bash ~/workspace/')).toBe(true);
  });

  it('extracts "Execute exactly: python3 <path>" form', () => {
    const got = tryExtractShellCommand(
      'Execute exactly: python3 ~/workspace/operations/engine-room/skills/health-check/run.py\n\nReturn the script stdout VERBATIM as your entire response.'
    );
    expect(got).not.toBeNull();
    expect(got?.kind).toBe('execute');
    expect(got?.command).toBe('python3 ~/workspace/operations/engine-room/skills/health-check/run.py');
  });

  it('strips SILENT MODE trailer before counting matches', () => {
    const got = tryExtractShellCommand(
      'Execute exactly: python3 ~/foo.py\n\n---\nSILENT MODE: If there is nothing to report, your ENTIRE response must be exactly the two characters "OK"...'
    );
    expect(got).not.toBeNull();
    expect(got?.command).toBe('python3 ~/foo.py');
  });

  it('returns null for prompts with multiple distinct command patterns', () => {
    // Audit-style prompts that ask the agent to run several commands and
    // synthesize must NOT be bypassed.
    const got = tryExtractShellCommand(
      'Run: launchctl list | grep claudeclaw\nExecute exactly: python3 ~/foo.py'
    );
    expect(got).toBeNull();
  });

  it('returns null for free-form judgment prompts', () => {
    const got = tryExtractShellCommand(
      'Produce Ruan\'s morning briefing. Check calendar, inbox, reminders, and write a 5-line summary.'
    );
    expect(got).toBeNull();
  });

  it('returns null for empty match (e.g. "Run:" with no command)', () => {
    const got = tryExtractShellCommand('Run:   \n\nDo something');
    expect(got).toBeNull();
  });
});

describe('runShellCommand', () => {
  it('returns stdout and exit 0 on success', async () => {
    const r = await runShellCommand('echo hello');
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe('hello');
    expect(r.timedOut).toBe(false);
  });

  it('captures non-zero exit and stderr', async () => {
    const r = await runShellCommand('echo oops 1>&2; exit 3');
    expect(r.exitCode).toBe(3);
    expect(r.stderr).toBe('oops');
  });
});
