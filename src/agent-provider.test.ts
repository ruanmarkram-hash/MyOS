import { describe, expect, it, vi } from 'vitest';
import { AgentError } from './errors.js';

describe('agent provider configuration', () => {
  it('keeps sessions isolated across a Claude to Codex to Claude flip sequence', async () => {
    let activeProvider = 'claude';
    const claudeRunAgent = vi.fn(async (opts: { sessionId?: string }) => ({
      text: 'claude ok',
      newSessionId: opts.sessionId ?? '3fbb8b12-b4cc-41ae-bf46-db2ad900eb6a',
      usage: null,
    }));
    const codexRunAgent = vi.fn(async () => ({
      text: 'codex ok',
      newSessionId: '019de35d-7e16-7d43-94ba-e2f40388be5c',
      usage: null,
    }));

    vi.resetModules();
    vi.doMock('./config.js', () => ({
      get LLM_PROVIDER() {
        return activeProvider;
      },
      CODEX_HAIKU_MODEL: 'gpt-5.4-nano',
      CODEX_SONNET_MODEL: 'gpt-5.4',
      CODEX_OPUS_MODEL: 'gpt-5.5',
    }));
    vi.doMock('./llm-provider.js', async (importOriginal) => {
      const original = await importOriginal<typeof import('./llm-provider.js')>();
      return {
        ...original,
        getLlmProvider: vi.fn((provider: string) => ({
          name: provider,
          runAgent: provider === 'codex' ? codexRunAgent : claudeRunAgent,
        })),
      };
    });
    vi.doMock('./logger.js', () => ({
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    }));

    const { runAgent } = await import('./agent.js');
    const { _initTestDatabase, getSession, setSession } = await import('./db.js');
    _initTestDatabase();

    const chatId = 'chat-flip';
    const agentId = 'main';

    activeProvider = 'claude';
    const firstClaude = await runAgent('claude turn', getSession(chatId, agentId, 'claude'), () => {});
    setSession(chatId, firstClaude.newSessionId!, agentId, 'claude');

    activeProvider = 'codex';
    const codex = await runAgent('codex turn', getSession(chatId, agentId, 'codex'), () => {});
    setSession(chatId, codex.newSessionId!, agentId, 'codex');

    activeProvider = 'claude';
    const secondClaude = await runAgent('claude again', getSession(chatId, agentId, 'claude'), () => {});
    setSession(chatId, secondClaude.newSessionId!, agentId, 'claude');

    expect(claudeRunAgent).toHaveBeenNthCalledWith(1, expect.objectContaining({ sessionId: undefined }));
    expect(codexRunAgent).toHaveBeenCalledWith(expect.objectContaining({ sessionId: undefined }));
    expect(claudeRunAgent).toHaveBeenNthCalledWith(2, expect.objectContaining({
      sessionId: '3fbb8b12-b4cc-41ae-bf46-db2ad900eb6a',
    }));
    expect(getSession(chatId, agentId, 'claude')).toBe('3fbb8b12-b4cc-41ae-bf46-db2ad900eb6a');
    expect(getSession(chatId, agentId, 'codex')).toBe('019de35d-7e16-7d43-94ba-e2f40388be5c');
  });

  it('does not pass Codex session ids to Claude resume', async () => {
    const runAgentMock = vi.fn(async () => ({
      text: 'claude fresh session',
      newSessionId: '3fbb8b12-b4cc-41ae-bf46-db2ad900eb6a',
      usage: null,
    }));

    vi.resetModules();
    vi.doMock('./config.js', () => ({
      LLM_PROVIDER: 'claude',
      CODEX_HAIKU_MODEL: 'gpt-5.4-nano',
      CODEX_SONNET_MODEL: 'gpt-5.4',
      CODEX_OPUS_MODEL: 'gpt-5.5',
    }));
    vi.doMock('./llm-provider.js', async (importOriginal) => {
      const original = await importOriginal<typeof import('./llm-provider.js')>();
      return {
        ...original,
        getLlmProvider: vi.fn(() => ({
          name: 'claude',
          runAgent: runAgentMock,
        })),
      };
    });
    vi.doMock('./logger.js', () => ({
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    }));

    const { runAgent } = await import('./agent.js');
    await runAgent('hi', '019de375-ca31-7d12-9b37-62ffd7b26ca3', () => {});

    expect(runAgentMock).toHaveBeenCalledWith(expect.objectContaining({ sessionId: undefined }));
  });

  it('dispatches LLM_PROVIDER=codex through the provider boundary', async () => {
    const runAgentMock = vi.fn(async () => ({
      text: 'codex ok',
      newSessionId: '019de35d-7e16-7d43-94ba-e2f40388be5c',
      usage: null,
    }));

    vi.resetModules();
    vi.doMock('./config.js', () => ({
      LLM_PROVIDER: 'codex',
      CODEX_HAIKU_MODEL: 'gpt-5.4-nano',
      CODEX_SONNET_MODEL: 'gpt-5.4',
      CODEX_OPUS_MODEL: 'gpt-5.5',
    }));
    vi.doMock('./llm-provider.js', async (importOriginal) => {
      const original = await importOriginal<typeof import('./llm-provider.js')>();
      return {
        ...original,
        getLlmProvider: vi.fn(() => ({
          name: 'codex',
          runAgent: runAgentMock,
        })),
      };
    });
    vi.doMock('./logger.js', () => ({
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    }));

    const { runAgent } = await import('./agent.js');
    const result = await runAgent('hi', undefined, () => {}, undefined, 'claude-opus-4-7');

    expect(result.text).toBe('codex ok');
    expect(runAgentMock).toHaveBeenCalledWith(expect.objectContaining({ message: 'hi', model: 'gpt-5.5' }));
  });

  it('injects the provider-neutral agent definition at the runtime boundary', async () => {
    const runAgentMock = vi.fn(async () => ({
      text: 'codex ok',
      newSessionId: '019de35d-7e16-7d43-94ba-e2f40388be5c',
      usage: null,
    }));

    vi.resetModules();
    vi.doMock('./config.js', () => ({
      LLM_PROVIDER: 'codex',
      CODEX_HAIKU_MODEL: 'gpt-5.4-nano',
      CODEX_SONNET_MODEL: 'gpt-5.4',
      CODEX_OPUS_MODEL: 'gpt-5.5',
    }));
    vi.doMock('./llm-provider.js', async (importOriginal) => {
      const original = await importOriginal<typeof import('./llm-provider.js')>();
      return {
        ...original,
        getLlmProvider: vi.fn(() => ({
          name: 'codex',
          runAgent: runAgentMock,
        })),
      };
    });
    vi.doMock('./logger.js', () => ({
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    }));

    const { runAgent } = await import('./agent.js');
    await runAgent('ship it', undefined, () => {}, undefined, undefined, undefined, undefined, undefined, undefined, 'You are Sage.');

    expect(runAgentMock).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.stringContaining('[ClaudeClaw runtime contract]'),
    }));
    expect(runAgentMock).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.stringContaining('[Agent role - follow these instructions]\nYou are Sage.\n[End agent role]\n\nship it'),
    }));
  });

  it('still injects the runtime definition when resuming a provider session', async () => {
    const runAgentMock = vi.fn(async () => ({
      text: 'codex ok',
      newSessionId: '019de35d-7e16-7d43-94ba-e2f40388be5c',
      usage: null,
    }));

    vi.resetModules();
    vi.doMock('./config.js', () => ({
      LLM_PROVIDER: 'codex',
      CODEX_HAIKU_MODEL: 'gpt-5.4-nano',
      CODEX_SONNET_MODEL: 'gpt-5.4',
      CODEX_OPUS_MODEL: 'gpt-5.5',
    }));
    vi.doMock('./llm-provider.js', async (importOriginal) => {
      const original = await importOriginal<typeof import('./llm-provider.js')>();
      return {
        ...original,
        getLlmProvider: vi.fn(() => ({
          name: 'codex',
          runAgent: runAgentMock,
        })),
      };
    });
    vi.doMock('./logger.js', () => ({
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    }));

    const { runAgent } = await import('./agent.js');
    await runAgent('continue', '019de375-ca31-7d12-9b37-62ffd7b26ca3', () => {}, undefined, undefined, undefined, undefined, undefined, undefined, 'You are Sage.');

    expect(runAgentMock).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: '019de375-ca31-7d12-9b37-62ffd7b26ca3',
      message: expect.stringContaining('[Agent role - follow these instructions]\nYou are Sage.\n[End agent role]\n\ncontinue'),
    }));
  });

  it('rejects unsupported LLM_PROVIDER through runAgent', async () => {
    vi.resetModules();
    vi.doUnmock('./llm-provider.js');
    vi.doMock('./config.js', () => ({
      LLM_PROVIDER: 'openai',
      CODEX_HAIKU_MODEL: 'gpt-5.4-nano',
      CODEX_SONNET_MODEL: 'gpt-5.4',
      CODEX_OPUS_MODEL: 'gpt-5.5',
    }));
    vi.doMock('./logger.js', () => ({
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    }));

    const { runAgent } = await import('./agent.js');

    await expect(runAgent('hi', undefined, () => {})).rejects.toMatchObject({
      category: 'unknown',
      recovery: expect.objectContaining({ shouldRetry: false }),
    } satisfies Partial<AgentError>);
  });
});
