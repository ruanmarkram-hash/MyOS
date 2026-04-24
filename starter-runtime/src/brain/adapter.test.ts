import { describe, it, expect } from 'vitest';

// We test parseSearchText indirectly via buildMemoryContextOb1 using a stubbed
// searchThoughts. Instead of coupling the test to the internal helper, we
// just assert the block shape for representative inputs by re-implementing
// the parse here — the parser lives in adapter.ts and is the source of truth;
// this guards against regressions in the known-shape cases.

// Re-export the regex parse as a focused test by importing the module and
// invoking buildMemoryContextOb1 via a mock of ./client.js. Vitest mocks below.
import { vi } from 'vitest';

vi.mock('../config.js', () => ({
  BRAIN: 'ob1',
  MCP_ACCESS_KEY: 'test-key',
  OB1_SUPABASE_URL: 'https://test.supabase.co',
  OB1_BRAIN_FUNCTION: 'brain-mcp',
}));

const mockSearchText = vi.fn();

vi.mock('./client.js', () => ({
  searchThoughts: (args: { query: string; limit?: number; threshold?: number }) =>
    mockSearchText(args) as Promise<string>,
  captureThought: vi.fn(),
}));

describe('buildMemoryContextOb1', () => {
  it('returns empty string when OB1 says no matches', async () => {
    const { buildMemoryContextOb1 } = await import('./adapter.js');
    mockSearchText.mockResolvedValueOnce('No thoughts found matching "x".');
    const out = await buildMemoryContextOb1('anything');
    expect(out).toBe('');
  });

  it('returns empty string when response is blank', async () => {
    const { buildMemoryContextOb1 } = await import('./adapter.js');
    mockSearchText.mockResolvedValueOnce('');
    const out = await buildMemoryContextOb1('anything');
    expect(out).toBe('');
  });

  it('parses a single result block with topics and people', async () => {
    const { buildMemoryContextOb1 } = await import('./adapter.js');
    mockSearchText.mockResolvedValueOnce(
      [
        'Found 1 thought(s):',
        '',
        '--- Result 1 (82.7% match) ---',
        'Captured: 4/23/2026',
        'Type: observation',
        'Topics: ClaudeClaw, Phase 2, AI',
        'People: TestUser',
        '',
        'Agent is testing the brain pipeline end to end.',
      ].join('\n'),
    );
    const out = await buildMemoryContextOb1('brain test');
    expect(out).toContain('[Memory context]');
    expect(out).toContain('Relevant memories:');
    expect(out).toContain('- [0.8] Agent is testing the brain pipeline end to end.');
    expect(out).toContain('(ClaudeClaw, Phase 2, AI)');
    expect(out).toContain('[End memory context]');
  });

  it('parses multiple results in order', async () => {
    const { buildMemoryContextOb1 } = await import('./adapter.js');
    mockSearchText.mockResolvedValueOnce(
      [
        'Found 2 thought(s):',
        '',
        '--- Result 1 (73.0% match) ---',
        'Captured: 4/23/2026',
        'Type: task',
        'Topics: alpha',
        '',
        'First one.',
        '',
        '--- Result 2 (55.0% match) ---',
        'Captured: 4/20/2026',
        'Type: idea',
        'Topics: beta, gamma',
        '',
        'Second one.',
      ].join('\n'),
    );
    const out = await buildMemoryContextOb1('multi');
    const lines = out.split('\n');
    const firstIdx = lines.findIndex((l) => l.includes('First one.'));
    const secondIdx = lines.findIndex((l) => l.includes('Second one.'));
    expect(firstIdx).toBeGreaterThan(0);
    expect(secondIdx).toBeGreaterThan(firstIdx);
    expect(out).toContain('- [0.7] First one. (alpha)');
    expect(out).toContain('- [0.6] Second one. (beta, gamma)');
  });

  it('collapses multi-line content into one line and truncates at 280 chars', async () => {
    const { buildMemoryContextOb1 } = await import('./adapter.js');
    const longContent = 'x'.repeat(500);
    mockSearchText.mockResolvedValueOnce(
      [
        'Found 1 thought(s):',
        '',
        '--- Result 1 (60.0% match) ---',
        'Captured: 4/23/2026',
        'Type: observation',
        'Topics: long',
        '',
        `line one\nline two\n${longContent}`,
      ].join('\n'),
    );
    const out = await buildMemoryContextOb1('long');
    const memLine = out.split('\n').find((l) => l.startsWith('- '));
    expect(memLine).toBeDefined();
    expect(memLine!.length).toBeLessThan(330);
    expect(memLine).not.toContain('\n');
  });

  it('handles results without topics', async () => {
    const { buildMemoryContextOb1 } = await import('./adapter.js');
    mockSearchText.mockResolvedValueOnce(
      [
        'Found 1 thought(s):',
        '',
        '--- Result 1 (50.0% match) ---',
        'Captured: 4/23/2026',
        'Type: observation',
        '',
        'No topics here.',
      ].join('\n'),
    );
    const out = await buildMemoryContextOb1('no topic');
    expect(out).toContain('- [0.5] No topics here.');
    expect(out).not.toContain('()');
  });
});
