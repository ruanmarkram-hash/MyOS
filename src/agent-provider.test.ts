import { describe, expect, it, vi } from 'vitest';
import { AgentError } from './errors.js';

describe('agent provider configuration', () => {
  it('rejects unsupported LLM_PROVIDER through runAgent', async () => {
    vi.resetModules();
    vi.doMock('./config.js', () => ({
      LLM_PROVIDER: 'codex',
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
