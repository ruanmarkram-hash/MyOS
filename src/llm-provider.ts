import { AgentError } from './errors.js';
import { ClaudeProvider } from './llm-providers/claude.js';

export type LlmProviderName = 'claude';

export interface McpStdioConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface UsageInfo {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  totalCostUsd: number;
  /** True if the SDK auto-compacted context during this turn */
  didCompact: boolean;
  /** Token count before compaction (if it happened) */
  preCompactTokens: number | null;
  /**
   * The cache_read_input_tokens from the LAST API call in the turn.
   * Unlike the cumulative cacheReadInputTokens, this reflects the actual
   * context window size (cumulative overcounts on multi-step tool-use turns).
   */
  lastCallCacheRead: number;
  /**
   * The input_tokens from the LAST API call in the turn.
   * This is the actual context window size: system prompt + conversation
   * history + tool results for that call. Use this for context warnings.
   */
  lastCallInputTokens: number;
}

/** Progress event emitted during agent execution for Telegram feedback. */
export interface AgentProgressEvent {
  type: 'task_started' | 'task_completed' | 'tool_active';
  description: string;
}

export interface AgentResult {
  text: string | null;
  newSessionId: string | undefined;
  usage: UsageInfo | null;
  aborted?: boolean;
}

export interface RunAgentOptions {
  message: string;
  sessionId: string | undefined;
  onTyping: () => void;
  onProgress?: (event: AgentProgressEvent) => void;
  model?: string;
  abortController?: AbortController;
  onStreamText?: (accumulatedText: string) => void;
  mcpAllowlist?: string[];
}

export interface LlmProvider {
  readonly name: LlmProviderName;
  runAgent(options: RunAgentOptions): Promise<AgentResult>;
}

const providers: Record<LlmProviderName, LlmProvider> = {
  claude: new ClaudeProvider(),
};

export function normalizeLlmProvider(value: string | null | undefined): LlmProviderName {
  const normalized = (value ?? 'claude').trim().toLowerCase();
  if (normalized === '' || normalized === 'claude') return 'claude';

  throw new AgentError('unknown', {
    shouldRetry: false,
    shouldNewChat: false,
    shouldSwitchModel: false,
    retryAfterMs: 0,
    userMessage: `Unsupported LLM_PROVIDER "${value}". Supported providers: claude.`,
  });
}

export function getLlmProvider(value: string | null | undefined): LlmProvider {
  return providers[normalizeLlmProvider(value)];
}

export function getSupportedLlmProviders(): LlmProviderName[] {
  return Object.keys(providers) as LlmProviderName[];
}
