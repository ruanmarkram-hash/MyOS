import { AgentError } from './errors.js';
import { ClaudeProvider } from './llm-providers/claude.js';
import { CodexProvider } from './llm-providers/codex.js';

export type LlmProviderName = 'claude' | 'codex';

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
  /**
   * Fully assembled provider prompt. The `runAgent` wrapper owns injecting
   * ClaudeClaw's provider-neutral agent definition before this reaches a
   * concrete provider.
   */
  message: string;
  sessionId: string | undefined;
  onTyping: () => void;
  onProgress?: (event: AgentProgressEvent) => void;
  model?: string;
  abortController?: AbortController;
  onStreamText?: (accumulatedText: string) => void;

  /**
   * Allowlist of MCP server names the model is permitted to see for this
   * call. Sourced from the active agent's `agent.yaml.mcp_servers` field.
   *
   * **Provider contract (enforced by `llm-provider.test.ts`):** if this list
   * is non-undefined, the provider MUST expose only servers whose names
   * appear in it. An empty list MUST result in zero MCP servers exposed.
   * `undefined` means "no constraint" — provider behaves as if no allowlist
   * was supplied (whatever the user's global config says).
   *
   * Implementations:
   *   - Claude: filtered in `loadMcpServers()` before passing to the SDK.
   *   - Codex: filtered via per-call temp `CODEX_HOME` config (see
   *     `codex-mcp-filter.ts`).
   *   - Future providers (local Ollama etc.): MUST honor this contract.
   */
  mcpAllowlist?: string[];

  /**
   * Override the cwd passed to the underlying Claude/Codex subprocess for
   * THIS call only. When set, providers MUST use this instead of the
   * default `agentCwd ?? PROJECT_ROOT`. Used by the mission scheduler to
   * isolate each mission in a per-mission git worktree (see
   * `mission-worktree.ts`) so concurrent agents don't trip on each other's
   * HEAD.
   *
   * `undefined` means "use the agent's normal cwd" — preserves the
   * pre-worktree behavior for non-mission paths (interactive chat,
   * scheduled tasks).
   */
  cwdOverride?: string;

  /**
   * Optional per-call cap for agentic turns. Providers that support a native
   * turn limit MUST honor it. Providers without a native equivalent MUST
   * still honor abortController and should log that they are falling back to
   * the caller's timeout.
   */
  maxTurns?: number;

  /**
   * Codex-only execution sandbox override. Defaults to danger-full-access for
   * existing trusted Telegram/mission paths. Callers that execute untrusted
   * chat-room text should request read-only and leave approval bypass off.
   */
  sandboxMode?: 'read-only' | 'workspace-write' | 'danger-full-access';
  bypassApprovalsAndSandbox?: boolean;
}

export interface LlmProvider {
  readonly name: LlmProviderName;
  /**
   * Run a single user message through this provider.
   *
   * Implementations MUST honor every field on `RunAgentOptions`. In
   * particular, `mcpAllowlist` is a security boundary, not a hint — see
   * the field doc for the exact contract.
   */
  runAgent(options: RunAgentOptions): Promise<AgentResult>;
}

const providers: Record<LlmProviderName, LlmProvider> = {
  claude: new ClaudeProvider(),
  codex: new CodexProvider(),
};

export function normalizeLlmProvider(value: string | null | undefined): LlmProviderName {
  const normalized = (value ?? 'claude').trim().toLowerCase();
  if (normalized === '' || normalized === 'claude') return 'claude';
  if (normalized === 'codex') return 'codex';

  throw new AgentError('unknown', {
    shouldRetry: false,
    shouldNewChat: false,
    shouldSwitchModel: false,
    retryAfterMs: 0,
    userMessage: `Unsupported LLM_PROVIDER "${value}". Supported providers: claude, codex.`,
  });
}

export function getLlmProvider(value: string | null | undefined): LlmProvider {
  return providers[normalizeLlmProvider(value)];
}

export function getSupportedLlmProviders(): LlmProviderName[] {
  return Object.keys(providers) as LlmProviderName[];
}
