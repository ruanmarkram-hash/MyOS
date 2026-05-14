import { AGENT_ID, LLM_PROVIDER, agentProviderOverride } from './config.js';
import { AgentError } from './errors.js';
import { buildAgentRuntimePrompt } from './agent-runtime.js';
import { getLlmProvider } from './llm-provider.js';
import { logger } from './logger.js';
import { resolveFallbackModelsForProvider, resolveModelForProvider } from './model-router.js';
import type { AgentProgressEvent, AgentResult, LlmProviderName } from './llm-provider.js';

export type {
  AgentProgressEvent,
  AgentResult,
  McpStdioConfig,
  UsageInfo,
} from './llm-provider.js';
export { loadMcpServers } from './llm-providers/claude.js';

function looksLikeCodexSessionId(sessionId: string | undefined): boolean {
  // Codex thread ids are UUIDv7-style ids such as 019de375-ca31-...
  // Claude Code session ids in this runtime are UUIDv4-style. When flipping
  // providers, never feed a Codex session id to Claude's resume path.
  return /^019[0-9a-f]{5}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sessionId ?? '');
}

function sessionIdForProvider(
  providerName: ReturnType<typeof getLlmProvider>['name'],
  sessionId: string | undefined,
): string | undefined {
  if (providerName === 'claude' && looksLikeCodexSessionId(sessionId)) return undefined;
  return sessionId;
}

export function getActiveProviderName(): LlmProviderName {
  return getLlmProvider(configuredProviderName()).name;
}

function configuredProviderName(): string {
  if (agentProviderOverride) return agentProviderOverride;
  return AGENT_ID === 'main' ? LLM_PROVIDER : 'claude';
}

/**
 * Run a single user message through the configured LLM provider.
 *
 * `systemPrompt` is the provider-neutral MyOS agent definition. It is
 * injected by this boundary so callers do not depend on Claude's CLAUDE.md
 * loading behavior or Codex's AGENTS.md compatibility path.
 */
export async function runAgent(
  message: string,
  sessionId: string | undefined,
  onTyping: () => void,
  onProgress?: (event: AgentProgressEvent) => void,
  model?: string,
  abortController?: AbortController,
  onStreamText?: (accumulatedText: string) => void,
  mcpAllowlist?: string[],
  cwdOverride?: string,
  systemPrompt?: string,
  maxTurns?: number,
): Promise<AgentResult> {
  const provider = getLlmProvider(configuredProviderName());
  const providerModel = resolveModelForProvider(provider.name, model);
  const providerMessage = buildAgentRuntimePrompt(message, systemPrompt, {
    provider: provider.name,
    model: providerModel,
  });
  return provider.runAgent({
    message: providerMessage,
    sessionId: sessionIdForProvider(provider.name, sessionId),
    onTyping,
    onProgress,
    model: providerModel,
    abortController,
    onStreamText,
    mcpAllowlist,
    cwdOverride,
    maxTurns,
  });
}

// Retry wrapper

const MAX_RETRIES = 2;
const BACKOFF_BASE_MS = 2000;
const BACKOFF_MULTIPLIER = 4; // 2s, 8s

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run the agent with automatic retry for transient errors.
 * Only retries errors where recovery.shouldRetry is true.
 * Calls onRetry before each retry so the caller can notify the user.
 */
export async function runAgentWithRetry(
  message: string,
  sessionId: string | undefined,
  onTyping: () => void,
  onProgress?: (event: AgentProgressEvent) => void,
  model?: string,
  abortController?: AbortController,
  onStreamText?: (accumulatedText: string) => void,
  onRetry?: (attempt: number, error: AgentError) => void,
  fallbackModels?: string[],
  mcpAllowlist?: string[],
  cwdOverride?: string,
  systemPrompt?: string,
  maxTurns?: number,
): Promise<AgentResult> {
  let lastError: AgentError | undefined;
  const provider = getLlmProvider(configuredProviderName());
  const resolvedFallbackModels = resolveFallbackModelsForProvider(provider.name, fallbackModels);

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const currentModel =
        attempt === 0 ? model
        : lastError?.recovery.shouldSwitchModel && resolvedFallbackModels?.length
          ? resolvedFallbackModels[Math.min(attempt - 1, resolvedFallbackModels.length - 1)]
          : model;

      return await runAgent(
        message, sessionId, onTyping, onProgress,
        currentModel, abortController, onStreamText,
        mcpAllowlist, cwdOverride, systemPrompt, maxTurns,
      );
    } catch (err) {
      if (!(err instanceof AgentError)) throw err;
      lastError = err;

      // Don't retry non-retryable errors or if aborted.
      if (!err.recovery.shouldRetry || abortController?.signal.aborted) {
        throw err;
      }

      // Don't retry past the limit.
      if (attempt >= MAX_RETRIES) {
        throw err;
      }

      const delayMs = Math.min(
        BACKOFF_BASE_MS * Math.pow(BACKOFF_MULTIPLIER, attempt),
        60000,
      );
      // Add jitter (0-25% of delay).
      const jitter = Math.random() * delayMs * 0.25;

      logger.warn(
        { attempt: attempt + 1, category: err.category, delayMs: Math.round(delayMs + jitter) },
        'Retrying agent query',
      );

      onRetry?.(attempt + 1, err);
      await sleep(delayMs + jitter);
    }
  }

  // Should never reach here, but TypeScript needs it.
  throw lastError ?? new Error('Retry loop exhausted');
}
