import { describe, expect, it } from 'vitest';
import { buildAgentRuntimePrompt } from './agent-runtime.js';

describe('agent runtime prompt', () => {
  it('adds runtime state when no system prompt is supplied', () => {
    const prompt = buildAgentRuntimePrompt('Do the task', undefined, { provider: 'codex', model: 'gpt-5.4-mini' });

    expect(prompt).toContain('[Runtime state]');
    expect(prompt).toContain('LLM provider: codex');
    expect(prompt).toContain('Resolved model: gpt-5.4-mini');
    expect(prompt.endsWith('Do the task')).toBe(true);
  });

  it('wraps the OS-owned agent definition before the user message', () => {
    const prompt = buildAgentRuntimePrompt('Do the task', 'You are Sage.', { provider: 'claude', model: 'claude-opus-4-7' });

    expect(prompt).toContain('[MyOS runtime contract]');
    expect(prompt).toContain('[Agent role - follow these instructions]');
    expect(prompt).toContain('You are Sage.');
    expect(prompt).toContain('LLM provider: claude');
    expect(prompt).toContain('Resolved model: claude-opus-4-7');
    expect(prompt.endsWith('Do the task')).toBe(true);
  });
});
