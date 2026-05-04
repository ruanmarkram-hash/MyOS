import { describe, it, expect } from 'vitest';
import { tryExtractShellCommand, runShellCommand, buildShellTaskEnv } from './shell-task.js';

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

  // Codex re-review 2026-05-04 (NEW HIGH): shell-task.spawn must NOT
  // inherit secrets. The argv-controlled prompt becomes a bash command,
  // so any inherited DASHBOARD_TOKEN / DB_ENCRYPTION_KEY / API key is
  // exfiltratable by a malicious task definition.
  it('does NOT inherit secret-shaped vars into the spawned shell', async () => {
    const sentinels = {
      DASHBOARD_TOKEN: 'leak-dashboard',
      DB_ENCRYPTION_KEY: 'leak-dbenc',
      ANTHROPIC_API_KEY: 'leak-anthropic',
      OPENAI_API_KEY: 'leak-openai',
      DATABASE_URL: 'postgres://leak',
      MCP_ACCESS_KEY: 'leak-mcp',
    };
    const restore: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(sentinels)) {
      restore[k] = process.env[k];
      process.env[k] = v;
    }
    try {
      const r = await runShellCommand(
        'echo "DT=${DASHBOARD_TOKEN-_unset_} DB=${DB_ENCRYPTION_KEY-_unset_} AK=${ANTHROPIC_API_KEY-_unset_} OK=${OPENAI_API_KEY-_unset_} DU=${DATABASE_URL-_unset_} MC=${MCP_ACCESS_KEY-_unset_}"',
      );
      expect(r.exitCode).toBe(0);
      // Every secret must be unset inside the child.
      expect(r.stdout).toBe('DT=_unset_ DB=_unset_ AK=_unset_ OK=_unset_ DU=_unset_ MC=_unset_');
    } finally {
      for (const [k, v] of Object.entries(restore)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  it('still exposes PATH and HOME so login shells can resolve commands', async () => {
    const r = await runShellCommand('echo "PATH_LEN=${#PATH} HOME_SET=${HOME:+yes}"');
    expect(r.exitCode).toBe(0);
    // PATH must be non-empty (otherwise `echo` itself wouldn't resolve via
    // /bin/bash builtins, but downstream scripts would break).
    expect(r.stdout).toMatch(/^PATH_LEN=[1-9]\d* HOME_SET=yes$/);
  });
});

describe('buildShellTaskEnv', () => {
  it('drops every secret-shaped var', () => {
    const env = buildShellTaskEnv({
      PATH: '/usr/bin',
      HOME: '/home/x',
      DASHBOARD_TOKEN: 'leak',
      DB_ENCRYPTION_KEY: 'leak',
      ANTHROPIC_API_KEY: 'leak',
      DATABASE_URL: 'postgres://leak',
      SOMETHING_ELSE: 'leak',
    });
    expect(env.PATH).toBe('/usr/bin');
    expect(env.HOME).toBe('/home/x');
    expect(env.DASHBOARD_TOKEN).toBeUndefined();
    expect(env.DB_ENCRYPTION_KEY).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.DATABASE_URL).toBeUndefined();
    expect(env.SOMETHING_ELSE).toBeUndefined();
  });

  it('keeps locale family (LC_*) and CLAUDECLAW_AGENT_ID', () => {
    const env = buildShellTaskEnv({
      PATH: '/x',
      LC_ALL: 'en_AU.UTF-8',
      LC_CTYPE: 'en_AU.UTF-8',
      LANG: 'en_AU.UTF-8',
      TZ: 'Australia/Brisbane',
      CLAUDECLAW_AGENT_ID: 'mason',
    });
    expect(env.LC_ALL).toBe('en_AU.UTF-8');
    expect(env.LC_CTYPE).toBe('en_AU.UTF-8');
    expect(env.LANG).toBe('en_AU.UTF-8');
    expect(env.TZ).toBe('Australia/Brisbane');
    expect(env.CLAUDECLAW_AGENT_ID).toBe('mason');
  });

  it('skips empty-string allowlisted entries', () => {
    const env = buildShellTaskEnv({ PATH: '', HOME: '/h' });
    expect(env.PATH).toBeUndefined();
    expect(env.HOME).toBe('/h');
  });
});
