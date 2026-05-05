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

export function buildAgentRuntimePrompt(message: string, systemPrompt?: string): string {
  const trimmedPrompt = systemPrompt?.trim();
  if (!trimmedPrompt) return message;
  return `${formatAgentSystemPrompt(trimmedPrompt)}\n\n${message}`;
}
