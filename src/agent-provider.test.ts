import { describe, expect, it, vi } from 'vitest';
import { AgentError } from './errors.js';

describe('agent provider configuration', () => {
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
