import { describe, expect, it } from 'vitest';
import { AgentError } from './errors.js';
import {
  getLlmProvider,
  getSupportedLlmProviders,
  normalizeLlmProvider,
} from './llm-provider.js';

describe('LLM provider selection', () => {
  it('defaults to claude when no provider is configured', () => {
    expect(normalizeLlmProvider(undefined)).toBe('claude');
    expect(normalizeLlmProvider('')).toBe('claude');
    expect(getLlmProvider(undefined).name).toBe('claude');
  });

  it('accepts LLM_PROVIDER=claude case-insensitively', () => {
    expect(normalizeLlmProvider('claude')).toBe('claude');
    expect(normalizeLlmProvider('Claude')).toBe('claude');
    expect(getLlmProvider(' CLAUDE ').name).toBe('claude');
  });

  it('rejects unsupported providers without retrying', () => {
    expect(() => getLlmProvider('codex')).toThrow(AgentError);

    try {
      getLlmProvider('codex');
    } catch (err) {
      expect(err).toBeInstanceOf(AgentError);
      expect((err as AgentError).recovery.shouldRetry).toBe(false);
      expect((err as AgentError).message).toContain('Unsupported LLM_PROVIDER');
    }
  });

  it('reports claude as the only Phase 1 provider', () => {
    expect(getSupportedLlmProviders()).toEqual(['claude']);
  });
});
