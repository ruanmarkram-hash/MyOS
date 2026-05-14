import { describe, expect, it, vi } from 'vitest';

vi.mock('./config.js', () => ({
  CODEX_HAIKU_MODEL: 'gpt-5.4-nano',
  CODEX_SONNET_MODEL: 'gpt-5.4',
  CODEX_OPUS_MODEL: 'gpt-5.5',
}));

import {
  modelTier,
  resolveFallbackModelsForProvider,
  resolveModelForProvider,
} from './model-router.js';

describe('model router', () => {
  it('keeps Claude model IDs unchanged for the Claude provider', () => {
    expect(resolveModelForProvider('claude', 'claude-opus-4-7')).toBe('claude-opus-4-7');
  });

  it('maps Claude tier models to Codex model IDs', () => {
    expect(resolveModelForProvider('codex', 'claude-haiku-4-5')).toBe('gpt-5.4-nano');
    expect(resolveModelForProvider('codex', 'claude-sonnet-4-6')).toBe('gpt-5.4');
    expect(resolveModelForProvider('codex', 'claude-opus-4-7')).toBe('gpt-5.5');
  });

  it('maps tier aliases to Codex model IDs', () => {
    expect(resolveModelForProvider('codex', 'haiku')).toBe('gpt-5.4-nano');
    expect(resolveModelForProvider('codex', 'sonnet')).toBe('gpt-5.4');
    expect(resolveModelForProvider('codex', 'opus')).toBe('gpt-5.5');
  });

  it('passes through explicit Codex model IDs', () => {
    expect(resolveModelForProvider('codex', 'gpt-5.4-mini')).toBe('gpt-5.4-mini');
  });

  it('resolves fallback chains for Codex', () => {
    expect(resolveFallbackModelsForProvider('codex', ['claude-sonnet-4-6', 'claude-haiku-4-5'])).toEqual([
      'gpt-5.4',
      'gpt-5.4-nano',
    ]);
  });

  it('detects model tiers', () => {
    expect(modelTier('claude-opus-4-7')).toBe('opus');
    expect(modelTier('claude-haiku-4-5-20251001')).toBe('haiku');
    expect(modelTier('sonnet')).toBe('sonnet');
    expect(modelTier('gpt-5.5')).toBeUndefined();
  });
});
