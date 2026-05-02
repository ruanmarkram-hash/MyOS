import {
  CODEX_HAIKU_MODEL,
  CODEX_OPUS_MODEL,
  CODEX_SONNET_MODEL,
} from './config.js';
import type { LlmProviderName } from './llm-provider.js';

export type ModelTier = 'haiku' | 'sonnet' | 'opus';

const CLAUDE_TIER_BY_MODEL: Record<string, ModelTier> = {
  'claude-haiku-4-5': 'haiku',
  'claude-sonnet-4-5': 'sonnet',
  'claude-sonnet-4-6': 'sonnet',
  'claude-opus-4-6': 'opus',
  'claude-opus-4-7': 'opus',
};

const CODEX_MODEL_BY_TIER: Record<ModelTier, string> = {
  haiku: CODEX_HAIKU_MODEL,
  sonnet: CODEX_SONNET_MODEL,
  opus: CODEX_OPUS_MODEL,
};

function claudeTierFromModel(normalized: string): ModelTier | undefined {
  if (normalized.startsWith('claude-haiku-')) return 'haiku';
  if (normalized.startsWith('claude-sonnet-')) return 'sonnet';
  if (normalized.startsWith('claude-opus-')) return 'opus';
  return undefined;
}

export function modelTier(model: string | null | undefined): ModelTier | undefined {
  const normalized = model?.trim().toLowerCase();
  if (!normalized) return undefined;
  if (normalized === 'haiku' || normalized === 'sonnet' || normalized === 'opus') return normalized;
  return CLAUDE_TIER_BY_MODEL[normalized] ?? claudeTierFromModel(normalized);
}

export function resolveModelForProvider(
  provider: LlmProviderName,
  model: string | null | undefined,
): string | undefined {
  const trimmed = model?.trim();
  if (!trimmed) return undefined;

  if (provider === 'claude') {
    return trimmed;
  }

  const tier = modelTier(trimmed);
  return tier ? CODEX_MODEL_BY_TIER[tier] : trimmed;
}

export function resolveFallbackModelsForProvider(
  provider: LlmProviderName,
  models: string[] | undefined,
): string[] | undefined {
  const resolved = models
    ?.map((model) => resolveModelForProvider(provider, model))
    .filter((model): model is string => !!model);
  return resolved && resolved.length > 0 ? resolved : undefined;
}
