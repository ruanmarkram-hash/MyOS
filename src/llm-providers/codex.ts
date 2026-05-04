import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import type { ChildProcessWithoutNullStreams } from 'child_process';

import { PROJECT_ROOT, agentCwd } from '../config.js';
import { readEnvFile } from '../env.js';
import { classifyError } from '../errors.js';
import { logger } from '../logger.js';
import { getScrubbedSdkEnv } from '../security.js';
import type { AgentResult, LlmProvider, RunAgentOptions, UsageInfo } from '../llm-provider.js';
import { prepareCodexHome } from './codex-mcp-filter.js';

interface CodexUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  lastInputTokens?: number;
  lastCachedInputTokens?: number;
}

interface CodexPricing {
  inputPerMillion: number;
  cachedInputPerMillion: number;
  outputPerMillion: number;
}

const DEFAULT_CODEX_MODEL = 'gpt-5.5';

// Standard OpenAI API rates, USD per 1M tokens, checked against the
// OpenAI pricing page during Phase 2 implementation.
const CODEX_PRICING: Array<{ prefix: string; pricing: CodexPricing }> = [
  { prefix: 'gpt-5.5', pricing: { inputPerMillion: 5.00, cachedInputPerMillion: 0.50, outputPerMillion: 30.00 } },
  { prefix: 'gpt-5.4-mini', pricing: { inputPerMillion: 0.75, cachedInputPerMillion: 0.075, outputPerMillion: 4.50 } },
  { prefix: 'gpt-5.4', pricing: { inputPerMillion: 2.50, cachedInputPerMillion: 0.25, outputPerMillion: 15.00 } },
];

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function numberField(obj: Record<string, unknown>, key: string): number {
  const value = obj[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function textFromContent(content: unknown): string {
  if (typeof content === 'string') return content;

  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (!isObject(block)) return '';
        const blockType = block['type'];
        if (blockType && !['output_text', 'text', 'input_text'].includes(String(blockType))) {
          return '';
        }
        const text = block['text'];
        return typeof text === 'string' ? text : '';
      })
      .join('');
  }

  if (isObject(content) && typeof content['text'] === 'string') {
    return content['text'];
  }

  return '';
}

function payloadOrSelf(event: Record<string, unknown>): Record<string, unknown> {
  const payload = event['payload'];
  if (isObject(payload)) return payload;
  return event;
}

export function parseCodexJsonLine(line: string): Record<string, unknown> | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return isObject(parsed) ? parsed : null;
  } catch {
    logger.warn({ line: trimmed.slice(0, 300) }, 'Ignoring non-JSON Codex output line');
    return null;
  }
}

export function extractCodexSessionId(event: Record<string, unknown>): string | undefined {
  if (event['type'] === 'thread.started' && typeof event['thread_id'] === 'string') {
    return event['thread_id'];
  }

  if (event['type'] === 'session_meta') {
    const meta = event['payload'];
    if (isObject(meta) && typeof meta['id'] === 'string') return meta['id'];
  }

  const payload = payloadOrSelf(event);
  if (typeof payload['id'] === 'string' && event['type'] === 'session_meta') {
    return payload['id'];
  }

  return undefined;
}

export function extractCodexAssistantText(event: Record<string, unknown>): string | null {
  if (event['type'] === 'item.completed') {
    const item = event['item'];
    if (isObject(item) && item['type'] === 'agent_message' && typeof item['text'] === 'string') {
      return item['text'];
    }
  }

  const payload = payloadOrSelf(event);

  if (payload['type'] === 'task_complete' && typeof payload['last_agent_message'] === 'string') {
    return payload['last_agent_message'];
  }

  if (payload['type'] === 'message') {
    if (payload['role'] === 'developer') return null;
    if (payload['role'] === 'assistant') {
      const phase = payload['phase'];
      if (phase && phase !== 'final_answer') return null;
      const text = textFromContent(payload['content']);
      return text || null;
    }
  }

  return null;
}

export function isCodexTaskComplete(event: Record<string, unknown>): boolean {
  const payload = payloadOrSelf(event);
  return payload['type'] === 'task_complete' && typeof payload['last_agent_message'] === 'string';
}

export function extractCodexUsage(event: Record<string, unknown>): CodexUsage | null {
  let usage = event['usage'];
  let lastUsage: unknown;
  const payload = payloadOrSelf(event);

  if (!isObject(usage) && isObject(payload['usage'])) {
    usage = payload['usage'];
  }

  const info = payload['info'];
  if (!isObject(usage) && isObject(info)) {
    const totalTokenUsage = info['total_token_usage'];
    const lastTokenUsage = info['last_token_usage'];
    if (isObject(totalTokenUsage)) usage = totalTokenUsage;
    if (isObject(lastTokenUsage)) lastUsage = lastTokenUsage;
  }

  if (!isObject(usage)) return null;

  const last = isObject(lastUsage) ? lastUsage : undefined;
  return {
    inputTokens: numberField(usage, 'input_tokens'),
    cachedInputTokens: numberField(usage, 'cached_input_tokens') || numberField(usage, 'cache_read_input_tokens'),
    outputTokens: numberField(usage, 'output_tokens'),
    ...(last ? {
      lastInputTokens: numberField(last, 'input_tokens'),
      lastCachedInputTokens: numberField(last, 'cached_input_tokens') || numberField(last, 'cache_read_input_tokens'),
    } : {}),
  };
}

export function extractCodexSandboxMode(event: Record<string, unknown>): string | undefined {
  const payload = payloadOrSelf(event);
  const sandboxPolicy = payload['sandbox_policy'];
  if (isObject(sandboxPolicy) && typeof sandboxPolicy['type'] === 'string') {
    return sandboxPolicy['type'];
  }
  return undefined;
}

export function codexModelForCli(model: string | undefined): string | undefined {
  const trimmed = model?.trim();
  if (!trimmed) return undefined;
  if (trimmed.toLowerCase().startsWith('claude-')) return undefined;
  return trimmed;
}

function readCodexConfigModel(): string | undefined {
  try {
    const configPath = path.join(os.homedir(), '.codex', 'config.toml');
    const raw = fs.readFileSync(configPath, 'utf8');
    const match = raw.match(/^\s*model\s*=\s*"([^"]+)"/m);
    return match?.[1]?.trim() || undefined;
  } catch {
    return undefined;
  }
}

export function codexModelForPricing(model: string | undefined): string {
  const env = readEnvFile(['CODEX_MODEL']);
  return codexModelForCli(model)
    ?? process.env.CODEX_MODEL
    ?? env.CODEX_MODEL
    ?? readCodexConfigModel()
    ?? DEFAULT_CODEX_MODEL;
}

function pricingForModel(model: string): CodexPricing {
  const normalized = model.toLowerCase();
  return CODEX_PRICING.find((entry) => normalized.startsWith(entry.prefix))?.pricing
    ?? CODEX_PRICING[0]!.pricing;
}

export function calculateCodexCostUsd(usage: CodexUsage, model: string): number {
  const pricing = pricingForModel(model);
  const cachedInput = Math.min(usage.cachedInputTokens, usage.inputTokens);
  const uncachedInput = Math.max(usage.inputTokens - cachedInput, 0);

  return (
    (uncachedInput / 1_000_000) * pricing.inputPerMillion
    + (cachedInput / 1_000_000) * pricing.cachedInputPerMillion
    + (usage.outputTokens / 1_000_000) * pricing.outputPerMillion
  );
}

export function buildCodexExecArgs(opts: {
  cwd: string;
  sessionId?: string;
  model?: string;
}): string[] {
  const args = [
    'exec',
    '--json',
    '--skip-git-repo-check',
    '--sandbox',
    'danger-full-access',
    '--dangerously-bypass-approvals-and-sandbox',
    '-C',
    opts.cwd,
  ];

  const cliModel = codexModelForCli(opts.model);
  if (cliModel) args.push('--model', cliModel);

  if (opts.sessionId) {
    args.push('resume', opts.sessionId, '-');
  } else {
    args.push('-');
  }

  return args;
}

function codexSessionExists(sessionId: string): boolean {
  const roots = [
    path.join(os.homedir(), '.codex', 'sessions'),
    path.join(os.homedir(), '.codex', 'archived_sessions'),
  ];

  const stack = roots.filter((root) => fs.existsSync(root));
  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (entry.name.includes(sessionId)) return true;
      if (entry.isDirectory()) stack.push(path.join(current, entry.name));
    }
  }

  return false;
}

function appendTail(existing: string, chunk: string, maxLen = 6000): string {
  const combined = existing + chunk;
  return combined.length > maxLen ? combined.slice(combined.length - maxLen) : combined;
}

async function waitForCodex(proc: ChildProcessWithoutNullStreams): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    proc.once('error', reject);
    proc.once('close', (code, signal) => resolve({ code, signal }));
  });
}

export class CodexProvider implements LlmProvider {
  readonly name = 'codex' as const;

  async runAgent(options: RunAgentOptions): Promise<AgentResult> {
    const {
      message,
      sessionId,
      onTyping,
      model,
      abortController,
      onStreamText,
      mcpAllowlist,
    } = options;

    const cwd = agentCwd ?? PROJECT_ROOT;
    const resumeSessionId = sessionId && codexSessionExists(sessionId) ? sessionId : undefined;
    const pricingModel = codexModelForPricing(model);
    const args = buildCodexExecArgs({ cwd, sessionId: resumeSessionId, model });

    // Per-call MCP allowlist enforcement. When mcpAllowlist is provided we
    // build a temp CODEX_HOME with a filtered config.toml. When undefined
    // the contract treats it as "no constraint" so we leave CODEX_HOME alone
    // and Codex uses the user's normal global config. See
    // ./codex-mcp-filter.ts for rationale.
    const homePrep = mcpAllowlist ? prepareCodexHome(mcpAllowlist) : undefined;

    // Scrub secrets from the spawned `codex exec` env. Codex authenticates
    // via ~/.codex/auth.json (OAuth on disk) so it does not need
    // ANTHROPIC_API_KEY or any other harness secret. If a future code path
    // needs OPENAI_API_KEY (or similar) for a non-OAuth deployment, read
    // it out of .env and pass it through the authSecrets parameter — never
    // by reverting to raw process.env. See security.ts HIGH-3 fix.
    const codexAuth = readEnvFile(['OPENAI_API_KEY']);
    const scrubbedEnv = getScrubbedSdkEnv(codexAuth) as NodeJS.ProcessEnv;
    const spawnEnv: NodeJS.ProcessEnv = homePrep
      ? { ...scrubbedEnv, CODEX_HOME: homePrep.home }
      : scrubbedEnv;
    if (homePrep) {
      logger.info({ tempHome: homePrep.home, mcpAllowlist }, 'Codex: applied per-call MCP allowlist');
    }

    let newSessionId: string | undefined;
    const usageState: { current: UsageInfo | null } = { current: null };
    const textParts: string[] = [];
    let stdoutBuffer = '';
    let stderrTail = '';
    let aborted = false;
    let sandboxVerified = false;
    let parseError: Error | undefined;
    let killTimer: NodeJS.Timeout | undefined;

    const typingInterval = setInterval(onTyping, 4000);
    const proc = spawn('codex', args, {
      cwd,
      env: spawnEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const abort = (): void => {
      aborted = true;
      proc.kill('SIGTERM');
      killTimer = setTimeout(() => proc.kill('SIGKILL'), 5000);
      killTimer.unref();
    };

    if (abortController?.signal.aborted) abort();
    abortController?.signal.addEventListener('abort', abort, { once: true });

    const handleLine = (line: string): void => {
      const event = parseCodexJsonLine(line);
      if (!event) return;

      const sandboxMode = extractCodexSandboxMode(event);
      if (sandboxMode) {
        sandboxVerified = true;
        if (sandboxMode !== 'danger-full-access') {
          parseError = new Error(`Codex sandbox mode was ${sandboxMode}, expected danger-full-access`);
          proc.kill('SIGTERM');
          return;
        }
      }

      const eventSessionId = extractCodexSessionId(event);
      if (eventSessionId) {
        newSessionId = eventSessionId;
        logger.info({ newSessionId }, 'Codex session initialized');
      }

      const text = extractCodexAssistantText(event);
      if (text) {
        if (isCodexTaskComplete(event)) {
          textParts.splice(0, textParts.length, text);
        } else {
          textParts.push(text);
        }
        onStreamText?.(textParts.join('\n'));
      }

      const eventUsage = extractCodexUsage(event);
      if (eventUsage) {
        const cachedInput = Math.min(eventUsage.cachedInputTokens, eventUsage.inputTokens);
        const lastInput = eventUsage.lastInputTokens ?? eventUsage.inputTokens;
        const lastCachedInput = Math.min(eventUsage.lastCachedInputTokens ?? cachedInput, lastInput);
        usageState.current = {
          inputTokens: eventUsage.inputTokens,
          outputTokens: eventUsage.outputTokens,
          cacheReadInputTokens: cachedInput,
          totalCostUsd: calculateCodexCostUsd(eventUsage, pricingModel),
          didCompact: false,
          preCompactTokens: null,
          lastCallCacheRead: lastCachedInput,
          lastCallInputTokens: lastInput,
        };
      }
    };

    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk: string) => {
      stdoutBuffer += chunk;
      let newlineIndex = stdoutBuffer.indexOf('\n');
      while (newlineIndex >= 0) {
        const line = stdoutBuffer.slice(0, newlineIndex);
        stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
        handleLine(line);
        newlineIndex = stdoutBuffer.indexOf('\n');
      }
    });

    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (chunk: string) => {
      stderrTail = appendTail(stderrTail, chunk);
    });

    proc.stdin.end(message);

    try {
      logger.info(
        { sessionId: resumeSessionId ?? 'new', messageLen: message.length, cwd, model: codexModelForCli(model) ?? 'config-default' },
        'Starting Codex agent query',
      );

      const { code, signal } = await waitForCodex(proc);
      if (stdoutBuffer.trim()) handleLine(stdoutBuffer);

      if (parseError) throw parseError;

      if (aborted || abortController?.signal.aborted) {
        logger.info('Codex agent query aborted by user');
        return { text: null, newSessionId, usage: usageState.current, aborted: true };
      }

      if (code !== 0) {
        throw new Error(`Codex exited with code ${code ?? 'null'}${signal ? ` signal ${signal}` : ''}${stderrTail ? `: ${stderrTail.trim()}` : ''}`);
      }

      logger.info(
        {
          hasResult: textParts.length > 0,
          sandboxVerified,
          inputTokens: usageState.current?.inputTokens,
          outputTokens: usageState.current?.outputTokens,
          cacheReadTokens: usageState.current?.cacheReadInputTokens,
          costUsd: usageState.current?.totalCostUsd,
        },
        'Codex agent result received',
      );

      return {
        text: textParts.length > 0 ? textParts.join('\n') : null,
        newSessionId,
        usage: usageState.current,
      };
    } catch (err) {
      if (aborted || abortController?.signal.aborted) {
        return { text: null, newSessionId, usage: usageState.current, aborted: true };
      }

      const classified = classifyError(
        err,
        usageState.current?.lastCallInputTokens || usageState.current?.lastCallCacheRead || undefined,
      );
      logger.error(
        { category: classified.category, recovery: classified.recovery, originalMsg: (err as Error)?.message },
        'Codex agent query failed (classified)',
      );
      throw classified;
    } finally {
      clearInterval(typingInterval);
      if (killTimer) clearTimeout(killTimer);
      abortController?.signal.removeEventListener('abort', abort);
      // Always clean up the per-call CODEX_HOME if we made one. Idempotent.
      homePrep?.cleanup();
    }
  }
}
