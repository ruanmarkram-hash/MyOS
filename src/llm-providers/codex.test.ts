import { EventEmitter } from 'events';
import { PassThrough, Writable } from 'stream';
import { describe, expect, it, vi, beforeEach } from 'vitest';

const testPaths = vi.hoisted(() => ({
  projectRoot: '/tmp/claudeclaw-codex-provider-test',
}));

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock('child_process', () => ({
  spawn: spawnMock,
}));

vi.mock('../config.js', () => ({
  PROJECT_ROOT: testPaths.projectRoot,
  agentCwd: undefined,
}));

vi.mock('../env.js', () => ({
  readEnvFile: vi.fn(() => ({})),
}));

vi.mock('../logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import {
  buildCodexExecArgs,
  calculateCodexCostUsd,
  CodexProvider,
  codexModelForCli,
  extractCodexAssistantText,
  extractCodexProgressEvent,
  extractCodexSandboxMode,
  extractCodexSessionId,
  extractCodexUsage,
  isCodexTaskComplete,
  parseCodexJsonLine,
} from './codex.js';

class FakeCodexProcess extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  stdin = new Writable({
    write: (chunk, _encoding, callback) => {
      this.stdinChunks.push(String(chunk));
      callback();
    },
  });
  stdinChunks: string[] = [];
  killedWith: string | undefined;

  kill(signal?: NodeJS.Signals): boolean {
    this.killedWith = signal;
    this.emit('close', null, signal ?? null);
    return true;
  }
}

describe('CodexProvider helpers', () => {
  it('builds exec args with git skip, danger-full-access, cwd, and stdin prompt', () => {
    expect(buildCodexExecArgs({ cwd: '/tmp/no-git', model: 'gpt-5.4' })).toEqual([
      'exec',
      '--json',
      '--skip-git-repo-check',
      '--sandbox',
      'danger-full-access',
      '--dangerously-bypass-approvals-and-sandbox',
      '-C',
      '/tmp/no-git',
      '--model',
      'gpt-5.4',
      '-',
    ]);
  });

  it('can build read-only exec args without bypassing approvals', () => {
    expect(buildCodexExecArgs({
      cwd: '/tmp/no-git',
      sandboxMode: 'read-only',
      bypassApprovalsAndSandbox: false,
    })).toEqual([
      'exec',
      '--json',
      '--skip-git-repo-check',
      '--sandbox',
      'read-only',
      '-C',
      '/tmp/no-git',
      '-',
    ]);
  });

  it('uses exec resume when a Codex session id is provided', () => {
    expect(buildCodexExecArgs({ cwd: '/tmp/repo', sessionId: '019de35d-7e16-7d43-94ba-e2f40388be5c' })).toContain('resume');
    expect(buildCodexExecArgs({ cwd: '/tmp/repo', sessionId: '019de35d-7e16-7d43-94ba-e2f40388be5c' }).slice(-3)).toEqual([
      'resume',
      '019de35d-7e16-7d43-94ba-e2f40388be5c',
      '-',
    ]);
  });

  it('does not pass Claude model names to Codex CLI', () => {
    expect(codexModelForCli('claude-opus-4-7')).toBeUndefined();
    expect(codexModelForCli('gpt-5.5')).toBe('gpt-5.5');
  });

  it('parses nested payload objects and ignores developer messages', () => {
    const event = parseCodexJsonLine(JSON.stringify({
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'developer',
        content: [{ type: 'input_text', text: 'scaffolding' }],
      },
    }));

    expect(event).not.toBeNull();
    expect(extractCodexAssistantText(event!)).toBeNull();
  });

  it('extracts assistant text from exec item.completed events', () => {
    const event = parseCodexJsonLine(JSON.stringify({
      type: 'item.completed',
      item: { id: 'item_0', type: 'agent_message', text: 'PONG' },
    }));

    expect(extractCodexAssistantText(event!)).toBe('PONG');
  });

  it('maps Codex JSON events to progress events', () => {
    expect(extractCodexProgressEvent(parseCodexJsonLine('{"type":"turn.started"}')!)).toEqual({
      type: 'task_started',
      description: 'Codex turn started',
    });
    expect(extractCodexProgressEvent(parseCodexJsonLine(JSON.stringify({
      type: 'item.completed',
      item: { id: 'item_0', type: 'agent_message', text: 'PONG' },
    }))!)).toEqual({
      type: 'task_completed',
      description: 'Codex agent_message completed',
    });
    expect(extractCodexProgressEvent(parseCodexJsonLine('{"type":"turn.completed"}')!)).toEqual({
      type: 'task_completed',
      description: 'Codex turn completed',
    });
    expect(extractCodexProgressEvent(parseCodexJsonLine(JSON.stringify({
      type: 'event_msg',
      payload: { type: 'task_started' },
    }))!)).toEqual({
      type: 'task_started',
      description: 'Codex turn started',
    });
    expect(extractCodexProgressEvent(parseCodexJsonLine(JSON.stringify({
      type: 'event_msg',
      payload: {
        type: 'item_started',
        item: { id: 'item_0', type: 'tool_call' },
      },
    }))!)).toEqual({
      type: 'tool_active',
      description: 'Codex tool_call started',
    });
    expect(extractCodexProgressEvent(parseCodexJsonLine(JSON.stringify({
      type: 'event_msg',
      payload: {
        type: 'item_completed',
        item: { id: 'item_0', type: 'tool_call' },
      },
    }))!)).toEqual({
      type: 'task_completed',
      description: 'Codex tool_call completed',
    });
    expect(extractCodexProgressEvent(parseCodexJsonLine(JSON.stringify({
      type: 'event_msg',
      payload: { type: 'task_complete' },
    }))!)).toEqual({
      type: 'task_completed',
      description: 'Codex turn completed',
    });
  });

  it('uses task_complete last_agent_message as authoritative final text', () => {
    const event = parseCodexJsonLine(JSON.stringify({
      type: 'event_msg',
      payload: { type: 'task_complete', last_agent_message: 'FINAL' },
    }));

    expect(isCodexTaskComplete(event!)).toBe(true);
    expect(extractCodexAssistantText(event!)).toBe('FINAL');
  });

  it('extracts session id and usage from Codex JSON events', () => {
    const sessionEvent = parseCodexJsonLine('{"type":"thread.started","thread_id":"019de35d-7e16-7d43-94ba-e2f40388be5c"}');
    const usageEvent = parseCodexJsonLine('{"type":"turn.completed","usage":{"input_tokens":21604,"cached_input_tokens":4480,"output_tokens":6}}');

    expect(extractCodexSessionId(sessionEvent!)).toBe('019de35d-7e16-7d43-94ba-e2f40388be5c');
    expect(extractCodexUsage(usageEvent!)).toEqual({
      inputTokens: 21604,
      cachedInputTokens: 4480,
      outputTokens: 6,
    });
  });

  it('maps nested token_count usage and sandbox mode payloads', () => {
    const sandboxEvent = parseCodexJsonLine(JSON.stringify({
      type: 'turn_context',
      payload: { sandbox_policy: { type: 'danger-full-access' } },
    }));
    const usageEvent = parseCodexJsonLine(JSON.stringify({
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          total_token_usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 12 },
          last_token_usage: { input_tokens: 70, cached_input_tokens: 20, output_tokens: 6 },
        },
      },
    }));

    expect(extractCodexSandboxMode(sandboxEvent!)).toBe('danger-full-access');
    expect(extractCodexUsage(usageEvent!)).toEqual({
      inputTokens: 100,
      cachedInputTokens: 40,
      outputTokens: 12,
      lastInputTokens: 70,
      lastCachedInputTokens: 20,
    });
  });

  it('computes non-zero GPT-5.5 cost with cached input pricing', () => {
    const cost = calculateCodexCostUsd(
      { inputTokens: 21604, cachedInputTokens: 4480, outputTokens: 6 },
      'gpt-5.5',
    );

    expect(cost).toBeCloseTo(0.08804, 6);
  });
});

describe('CodexProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('runs codex exec, writes the message to stdin, and returns text/session/usage', async () => {
    const fake = new FakeCodexProcess();
    spawnMock.mockReturnValue(fake);
    const onProgress = vi.fn();

    const provider = new CodexProvider();
    const resultPromise = provider.runAgent({
      message: 'Reply with exactly PONG',
      sessionId: undefined,
      onTyping: () => {},
      onProgress,
      model: 'claude-opus-4-7',
    });

    fake.stdout.write('{"type":"thread.started","thread_id":"019de35d-7e16-7d43-94ba-e2f40388be5c"}\n');
    fake.stdout.write('{"type":"turn.started"}\n');
    fake.stdout.write('{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"PONG"}}\n');
    fake.stdout.write('{"type":"turn.completed","usage":{"input_tokens":21604,"cached_input_tokens":4480,"output_tokens":6}}\n');
    fake.emit('close', 0, null);

    const result = await resultPromise;

    expect(spawnMock).toHaveBeenCalledWith(
      'codex',
      expect.arrayContaining([
        'exec',
        '--json',
        '--skip-git-repo-check',
        '--sandbox',
        'danger-full-access',
        '--dangerously-bypass-approvals-and-sandbox',
        '-C',
        testPaths.projectRoot,
        '-',
      ]),
      expect.objectContaining({ cwd: testPaths.projectRoot }),
    );
    const args = spawnMock.mock.calls[0][1] as string[];
    expect(args).not.toContain('claude-opus-4-7');
    expect(fake.stdinChunks.join('')).toBe('Reply with exactly PONG');
    expect(result.text).toBe('PONG');
    expect(result.newSessionId).toBe('019de35d-7e16-7d43-94ba-e2f40388be5c');
    expect(result.usage?.totalCostUsd).toBeGreaterThan(0);
    expect(result.usage).toMatchObject({
      inputTokens: 21604,
      outputTokens: 6,
      cacheReadInputTokens: 4480,
      lastCallInputTokens: 21604,
      lastCallCacheRead: 4480,
    });
    expect(onProgress).toHaveBeenCalledWith({ type: 'task_started', description: 'Codex turn started' });
    expect(onProgress).toHaveBeenCalledWith({ type: 'task_completed', description: 'Codex agent_message completed' });
  });

  // HIGH-3 regression: codex exec used to be spawned with raw process.env,
  // bypassing getScrubbedSdkEnv. Ensure secrets that pattern-match the
  // sweep are gone from the spawn env.
  it('spawns codex with a scrubbed env (HIGH-3)', async () => {
    const planted = {
      DASHBOARD_TOKEN: 'leaked',
      MCP_ACCESS_KEY: 'leaked',
      WIDGET_PASSWORD: 'leaked',
      CLAUDE_CODE_OAUTH_TOKEN: 'leaked',
    };
    const prevValues: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(planted)) {
      prevValues[k] = process.env[k];
      process.env[k] = v;
    }

    try {
      const fake = new FakeCodexProcess();
      spawnMock.mockReturnValue(fake);

      const provider = new CodexProvider();
      const resultPromise = provider.runAgent({
        message: 'noop',
        sessionId: undefined,
        onTyping: () => {},
      });

      fake.stdout.write('{"type":"thread.started","thread_id":"abc"}\n');
      fake.stdout.write('{"type":"item.completed","item":{"id":"i","type":"agent_message","text":"ok"}}\n');
      fake.emit('close', 0, null);
      await resultPromise;

      const spawnOpts = spawnMock.mock.calls[0][2] as { env: NodeJS.ProcessEnv };
      expect(spawnOpts.env.DASHBOARD_TOKEN).toBeUndefined();
      expect(spawnOpts.env.MCP_ACCESS_KEY).toBeUndefined();
      expect(spawnOpts.env.WIDGET_PASSWORD).toBeUndefined();
      expect(spawnOpts.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    } finally {
      for (const [k, v] of Object.entries(prevValues)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});
