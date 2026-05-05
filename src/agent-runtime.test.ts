import { describe, expect, it } from 'vitest';
import { buildAgentRuntimePrompt } from './agent-runtime.js';

describe('agent runtime prompt', () => {
  it('returns the message unchanged when no system prompt is supplied', () => {
    expect(buildAgentRuntimePrompt('Do the task')).toBe('Do the task');
    expect(buildAgentRuntimePrompt('Do the task', '  ')).toBe('Do the task');
  });

  it('wraps the OS-owned agent definition before the user message', () => {
    const prompt = buildAgentRuntimePrompt('Do the task', 'You are Sage.');

    expect(prompt).toContain('[ClaudeClaw runtime contract]');
    expect(prompt).toContain('[Agent role - follow these instructions]');
    expect(prompt).toContain('You are Sage.');
    expect(prompt.endsWith('Do the task')).toBe(true);
  });
});
