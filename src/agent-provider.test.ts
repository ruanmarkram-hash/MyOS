import { describe, expect, it, vi } from 'vitest';
import { AgentError } from './errors.js';

describe('agent provider configuration', () => {
  it('dispatches LLM_PROVIDER=codex through the provider boundary', async () => {
    const runAgentMock = vi.fn(async () => ({
      text: 'codex ok',
      newSessionId: '019de35d-7e16-7d43-94ba-e2f40388be5c',
      usage: null,
    }));

    vi.resetModules();
    vi.doMock('./config.js', () => ({
      LLM_PROVIDER: 'codex',
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
    const result = await runAgent('hi', undefined, () => {});

    expect(result.text).toBe('codex ok');
    expect(runAgentMock).toHaveBeenCalledWith(expect.objectContaining({ message: 'hi' }));
  });

  it('rejects unsupported LLM_PROVIDER through runAgent', async () => {
    vi.resetModules();
    vi.doUnmock('./llm-provider.js');
    vi.doMock('./config.js', () => ({
      LLM_PROVIDER: 'openai',
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
