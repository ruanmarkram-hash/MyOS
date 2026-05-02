import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';

import { query } from '@anthropic-ai/claude-agent-sdk';

import { AGENT_MAX_TURNS, PROJECT_ROOT, agentCwd } from '../config.js';
import { readEnvFile } from '../env.js';
import { classifyError } from '../errors.js';
import { logger } from '../logger.js';
import type {
  AgentProgressEvent,
  AgentResult,
  LlmProvider,
  McpStdioConfig,
  RunAgentOptions,
  UsageInfo,
} from '../llm-provider.js';

// MCP server loading
// The Agent SDK's settingSources loads CLAUDE.md and permissions from
// project/user settings, but does NOT load mcpServers from those files.
// We read them ourselves and pass them via the `mcpServers` option.

/**
 * Merge MCP server configs from user settings (~/.claude/settings.json) and
 * project settings (.claude/settings.json in cwd), optionally filtered by
 * an allowlist (e.g. from an agent's agent.yaml `mcp_servers` field).
 *
 * Exported so the voice bridge can reuse the exact same loader the text
 * bot uses, keeping behavior consistent across channels.
 */
export function loadMcpServers(allowlist?: string[], projectCwd?: string): Record<string, McpStdioConfig> {
  const merged: Record<string, McpStdioConfig> = {};

  // Load from project settings (.claude/settings.json in cwd). `projectCwd`
  // lets callers (e.g. the voice bridge) target a specific sub-agent's
  // settings file without needing the module-level `agentCwd` to be set.
  const projectSettings = path.join(projectCwd ?? agentCwd ?? PROJECT_ROOT, '.claude', 'settings.json');
  // Load from user settings (~/.claude/settings.json)
  const userSettings = path.join(
    process.env.HOME ?? '/tmp',
    '.claude',
    'settings.json',
  );

  for (const file of [userSettings, projectSettings]) {
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
      const servers = raw?.mcpServers;
      if (servers && typeof servers === 'object') {
        for (const [name, config] of Object.entries(servers)) {
          const cfg = config as Record<string, unknown>;
          if (cfg.command && typeof cfg.command === 'string') {
            merged[name] = {
              command: cfg.command,
              ...(cfg.args ? { args: cfg.args as string[] } : {}),
              ...(cfg.env ? { env: cfg.env as Record<string, string> } : {}),
            };
          }
        }
      }
    } catch {
      // File doesn't exist or is invalid, skip.
    }
  }

  // If an allowlist is provided, only keep the MCPs in that list.
  if (allowlist) {
    const allowed = new Set(allowlist);
    for (const name of Object.keys(merged)) {
      if (!allowed.has(name)) delete merged[name];
    }
  }

  return merged;
}

/** Map SDK tool names to human-readable labels. */
const TOOL_LABELS: Record<string, string> = {
  Read: 'Reading file',
  Write: 'Writing file',
  Edit: 'Editing file',
  Bash: 'Running command',
  Grep: 'Searching code',
  Glob: 'Finding files',
  WebSearch: 'Web search',
  WebFetch: 'Fetching page',
  Agent: 'Sub-agent',
  NotebookEdit: 'Editing notebook',
  AskUserQuestion: 'User question',
};

function toolLabel(toolName: string): string {
  if (TOOL_LABELS[toolName]) return TOOL_LABELS[toolName];
  // MCP tools: mcp__server__tool -> "server: tool"
  if (toolName.startsWith('mcp__')) {
    const parts = toolName.split('__');
    return parts.length >= 3 ? `${parts[1]}: ${parts.slice(2).join(' ')}` : toolName;
  }
  return toolName;
}

/**
 * A minimal AsyncIterable that yields a single user message then closes.
 * This is the format the Claude Agent SDK expects for its `prompt` parameter.
 * The SDK drives the agentic loop internally (tool use, multi-step reasoning)
 * and surfaces a final `result` event when done.
 */
async function* singleTurn(text: string): AsyncGenerator<{
  type: 'user';
  message: { role: 'user'; content: string };
  parent_tool_use_id: null;
  session_id: string;
}> {
  yield {
    type: 'user',
    message: { role: 'user', content: text },
    parent_tool_use_id: null,
    session_id: '',
  };
}

// Resolve the Claude Code executable path once per process.
// SDK v0.0.19+ no longer bundles cli.js, so it needs the installed binary.
function resolveClaudeExecutable(): string {
  if (process.env.CLAUDE_EXECUTABLE) return process.env.CLAUDE_EXECUTABLE;
  try {
    return execFileSync('which', ['claude'], { encoding: 'utf8' }).trim();
  } catch {
    // Fall back to common npm-global locations.
    const candidates = [
      path.join(process.env.HOME ?? '/Users', '.npm-global', 'bin', 'claude'),
      '/usr/local/bin/claude',
      '/opt/homebrew/bin/claude',
    ];
    for (const c of candidates) {
      if (fs.existsSync(c)) return c;
    }
    throw new Error('Claude Code executable not found. Set CLAUDE_EXECUTABLE in .env or ensure claude is on PATH.');
  }
}

let claudeExecutable: string | undefined;

function getClaudeExecutable(): string {
  if (!claudeExecutable) claudeExecutable = resolveClaudeExecutable();
  return claudeExecutable;
}

export class ClaudeProvider implements LlmProvider {
  readonly name = 'claude' as const;

  /**
   * Run a single user message through Claude Code and return the result.
   *
   * Uses `resume` to continue the same session across Telegram messages,
   * giving Claude persistent context without re-sending history.
   */
  async runAgent(options: RunAgentOptions): Promise<AgentResult> {
    const {
      message,
      sessionId,
      onTyping,
      onProgress,
      model,
      abortController,
      onStreamText,
      mcpAllowlist,
    } = options;

    // Read secrets from .env without polluting process.env.
    // CLAUDE_CODE_OAUTH_TOKEN is optional. The subprocess finds auth via
    // ~/.claude/ automatically unless explicitly overridden here.
    const secrets = readEnvFile(['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY']);

    const sdkEnv: Record<string, string | undefined> = { ...process.env };
    // Strip ALL Claude Code env vars from the child subprocess. When this
    // process runs inside another Claude Code session, the parent injects
    // session-scoped vars that break the child:
    //   - CLAUDECODE / CLAUDE_CODE_ENTRYPOINT -> anti-nesting guard (exit 1)
    //   - CLAUDE_CODE_OAUTH_TOKEN -> session-scoped token that expires
    //   - CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST -> expects missing host auth
    //
    // By stripping all CLAUDE* vars, the child subprocess falls back to its
    // own ~/.claude/ OAuth credentials, which auto-refresh.
    for (const k of Object.keys(sdkEnv)) {
      if (k === 'CLAUDECLAW_AGENT_ID') continue;
      if (k.startsWith('CLAUDE') || k === '__CFBundleIdentifier') {
        delete sdkEnv[k];
      }
    }
    // Re-inject only explicitly configured auth from .env (not from parent env).
    if (secrets.CLAUDE_CODE_OAUTH_TOKEN) {
      sdkEnv.CLAUDE_CODE_OAUTH_TOKEN = secrets.CLAUDE_CODE_OAUTH_TOKEN;
    }
    if (secrets.ANTHROPIC_API_KEY) {
      sdkEnv.ANTHROPIC_API_KEY = secrets.ANTHROPIC_API_KEY;
    }

    let newSessionId: string | undefined;
    let resultText: string | null = null;
    let usage: UsageInfo | null = null;
    let didCompact = false;
    let preCompactTokens: number | null = null;
    let lastCallCacheRead = 0;
    let lastCallInputTokens = 0;
    let streamedText = '';

    // Refresh typing indicator on an interval while Claude works.
    // Telegram's "typing..." action expires after ~5s.
    const typingInterval = setInterval(onTyping, 4000);

    try {
      // Load MCP servers from project + user settings files, filtered by agent allowlist.
      const mcpServers = loadMcpServers(mcpAllowlist);
      const mcpServerNames = Object.keys(mcpServers);
      logger.info(
        { sessionId: sessionId ?? 'new', messageLen: message.length, mcpServers: mcpServerNames },
        'Starting agent query',
      );

      // SDK Options.mcpServers expects Record<string, McpServerConfig>.
      const mcpServerSpecs = mcpServerNames.length > 0 ? mcpServers : undefined;

      for await (const event of query({
        prompt: singleTurn(message),
        options: {
          // cwd = agent directory (if running as agent) or project root.
          // Claude Code loads CLAUDE.md from cwd via settingSources: ['project'].
          cwd: agentCwd ?? PROJECT_ROOT,

          // Resume the previous session for this chat (persistent context).
          resume: sessionId,

          // 'project' loads CLAUDE.md from cwd; 'user' loads ~/.claude/skills and settings.
          settingSources: ['project', 'user'],

          // Skip permission prompts. This is a trusted personal bot on the user's machine.
          permissionMode: 'bypassPermissions',
          allowDangerouslySkipPermissions: true,

          // Cap agentic turns to prevent runaway tool-use loops.
          ...(AGENT_MAX_TURNS > 0 ? { maxTurns: AGENT_MAX_TURNS } : {}),

          // Pass secrets to the subprocess without polluting our own process.env.
          env: sdkEnv,

          // MCP servers loaded from .claude/settings.json and ~/.claude/settings.json.
          ...(mcpServerSpecs ? { mcpServers: mcpServerSpecs } : {}),

          // Stream partial text so Telegram can show progressive updates.
          includePartialMessages: !!onStreamText,

          // Model override (e.g. 'claude-haiku-4-5', 'claude-sonnet-4-5').
          ...(model ? { model } : {}),

          // Abort support, signals the SDK to kill the subprocess.
          ...(abortController ? { abortController } : {}),

          // SDK v0.0.19+ requires an explicit path to the claude binary.
          pathToClaudeCodeExecutable: getClaudeExecutable(),
        },
      })) {
        const ev = event as Record<string, unknown>;

        if (ev['type'] === 'system' && ev['subtype'] === 'init') {
          newSessionId = ev['session_id'] as string;
          logger.info({ newSessionId }, 'Session initialized');
        }

        // Detect auto-compaction (context window was getting full).
        if (ev['type'] === 'system' && ev['subtype'] === 'compact_boundary') {
          didCompact = true;
          const meta = ev['compact_metadata'] as { trigger: string; pre_tokens: number } | undefined;
          preCompactTokens = meta?.pre_tokens ?? null;
          logger.warn(
            { trigger: meta?.trigger, preCompactTokens },
            'Context window compacted',
          );
        }

        // Track per-call token usage and detect tool use from assistant message events.
        // Each assistant message represents one API call; its usage reflects
        // that single call's context size, not cumulative usage across the turn.
        if (ev['type'] === 'assistant') {
          const msg = ev['message'] as Record<string, unknown> | undefined;
          const msgUsage = msg?.['usage'] as Record<string, number> | undefined;
          const callCacheRead = msgUsage?.['cache_read_input_tokens'] ?? 0;
          const callInputTokens = msgUsage?.['input_tokens'] ?? 0;
          if (callCacheRead > 0) {
            lastCallCacheRead = callCacheRead;
          }
          if (callInputTokens > 0) {
            lastCallInputTokens = callInputTokens;
          }

          // Extract tool_use blocks from assistant content for progress reporting.
          if (onProgress) {
            const content = msg?.['content'] as Array<{ type: string; name?: string }> | undefined;
            if (Array.isArray(content)) {
              for (const block of content) {
                if (block.type === 'tool_use' && block.name) {
                  onProgress({ type: 'tool_active', description: toolLabel(block.name) });
                }
              }
            }
          }
        }

        // Sub-agent lifecycle events, surfaced to Telegram for user feedback.
        if (ev['type'] === 'system' && ev['subtype'] === 'task_started' && onProgress) {
          const desc = (ev['description'] as string) ?? 'Sub-agent started';
          onProgress({ type: 'task_started', description: desc });
        }
        if (ev['type'] === 'system' && ev['subtype'] === 'task_notification' && onProgress) {
          const summary = (ev['summary'] as string) ?? 'Sub-agent finished';
          const status = (ev['status'] as string) ?? 'completed';
          onProgress({
            type: 'task_completed',
            description: status === 'failed' ? `Failed: ${summary}` : summary,
          });
        }

        // Stream text deltas for progressive Telegram updates.
        // Only stream the outermost assistant response (parent_tool_use_id === null)
        // to avoid showing internal tool-use reasoning.
        if (ev['type'] === 'stream_event' && onStreamText && ev['parent_tool_use_id'] === null) {
          const streamEvent = ev['event'] as Record<string, unknown> | undefined;
          if (streamEvent?.['type'] === 'content_block_delta') {
            const delta = streamEvent['delta'] as Record<string, unknown> | undefined;
            if (delta?.['type'] === 'text_delta' && typeof delta['text'] === 'string') {
              streamedText += delta['text'];
              onStreamText(streamedText);
            }
          }
          if (streamEvent?.['type'] === 'message_start') {
            streamedText = '';
          }
        }

        if (ev['type'] === 'result') {
          resultText = (ev['result'] as string | null | undefined) ?? null;

          // Extract usage info from result event.
          const evUsage = ev['usage'] as Record<string, number> | undefined;
          if (evUsage) {
            usage = {
              inputTokens: evUsage['input_tokens'] ?? 0,
              outputTokens: evUsage['output_tokens'] ?? 0,
              cacheReadInputTokens: evUsage['cache_read_input_tokens'] ?? 0,
              totalCostUsd: (ev['total_cost_usd'] as number) ?? 0,
              didCompact,
              preCompactTokens,
              lastCallCacheRead,
              lastCallInputTokens,
            };
            logger.info(
              {
                inputTokens: usage.inputTokens,
                cacheReadTokens: usage.cacheReadInputTokens,
                lastCallCacheRead: usage.lastCallCacheRead,
                lastCallInputTokens: usage.lastCallInputTokens,
                costUsd: usage.totalCostUsd,
                didCompact,
              },
              'Turn usage',
            );
          }

          logger.info(
            { hasResult: !!resultText, subtype: ev['subtype'] },
            'Agent result received',
          );
        }
      }
    } catch (err) {
      if (abortController?.signal.aborted) {
        logger.info('Agent query aborted by user');
        return { text: null, newSessionId, usage, aborted: true };
      }

      // Classify the error and attach context-aware metadata.
      const contextTokens = lastCallInputTokens || lastCallCacheRead || 0;
      const classified = classifyError(err, contextTokens || undefined);
      logger.error(
        { category: classified.category, recovery: classified.recovery, originalMsg: (err as Error)?.message },
        'Agent query failed (classified)',
      );
      throw classified;
    } finally {
      clearInterval(typingInterval);
    }

    return { text: resultText, newSessionId, usage };
  }
}
