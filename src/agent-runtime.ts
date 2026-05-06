/**
 * Provider-neutral prompt assembly for ClaudeClaw agent runs.
 *
 * Claude, Codex, and future local providers should all receive the same
 * OS-owned agent definition. Provider-native project docs remain useful
 * compatibility projections, but callers should not rely on them as the
 * only source of agent identity.
 */

export const AGENT_RUNTIME_CONTRACT = [
  '[ClaudeClaw runtime contract]',
  'The active agent definition below is owned by ClaudeClaw OS.',
  'Follow it regardless of the LLM provider executing this turn.',
  'Provider-specific project files are compatibility projections only.',
  '[End ClaudeClaw runtime contract]',
].join('\n');

export function formatAgentSystemPrompt(systemPrompt: string): string {
  return [
    AGENT_RUNTIME_CONTRACT,
    '[Agent role - follow these instructions]',
    systemPrompt.trim(),
    '[End agent role]',
  ].join('\n');
}

export interface AgentRuntimeMetadata {
  provider?: string;
  model?: string;
}

function formatRuntimeMetadata(metadata?: AgentRuntimeMetadata): string {
  const lines = [
    '[Runtime state]',
    metadata?.provider ? `LLM provider: ${metadata.provider}` : undefined,
    metadata?.model ? `Resolved model: ${metadata.model}` : undefined,
    'If asked what model or provider you are running on, answer from this runtime state.',
    '[End runtime state]',
  ].filter(Boolean);
  return lines.join('\n');
}

export function buildAgentRuntimePrompt(
  message: string,
  systemPrompt?: string,
  metadata?: AgentRuntimeMetadata,
): string {
  const trimmedPrompt = systemPrompt?.trim();
  const runtimeState = formatRuntimeMetadata(metadata);
  if (!trimmedPrompt) return `${runtimeState}\n\n${message}`;
  return `${formatAgentSystemPrompt(trimmedPrompt)}\n\n${runtimeState}\n\n${message}`;
}
