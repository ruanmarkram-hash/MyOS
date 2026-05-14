import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentError } from './errors.js';
import {
  getLlmProvider,
  getSupportedLlmProviders,
  normalizeLlmProvider,
} from './llm-provider.js';
import { loadMcpServers } from './llm-providers/claude.js';
import { filterMcpServers } from './llm-providers/codex-mcp-filter.js';

describe('LLM provider selection', () => {
  it('defaults to claude when no provider is configured', () => {
    expect(normalizeLlmProvider(undefined)).toBe('claude');
    expect(normalizeLlmProvider('')).toBe('claude');
    expect(getLlmProvider(undefined).name).toBe('claude');
  });

  it('accepts LLM_PROVIDER=claude case-insensitively', () => {
    expect(normalizeLlmProvider('claude')).toBe('claude');
    expect(normalizeLlmProvider('Claude')).toBe('claude');
    expect(getLlmProvider(' CLAUDE ').name).toBe('claude');
  });

  it('rejects unsupported providers without retrying', () => {
    expect(() => getLlmProvider('openai')).toThrow(AgentError);

    try {
      getLlmProvider('openai');
    } catch (err) {
      expect(err).toBeInstanceOf(AgentError);
      expect((err as AgentError).recovery.shouldRetry).toBe(false);
      expect((err as AgentError).message).toContain('Unsupported LLM_PROVIDER');
    }
  });

  it('accepts LLM_PROVIDER=codex case-insensitively', () => {
    expect(normalizeLlmProvider('codex')).toBe('codex');
    expect(normalizeLlmProvider('Codex')).toBe('codex');
    expect(getLlmProvider(' CODEX ').name).toBe('codex');
  });

  it('reports supported Phase 2 providers', () => {
    expect(getSupportedLlmProviders()).toEqual(['claude', 'codex']);
  });
});

/**
 * Cross-provider MCP allowlist contract.
 *
 * Every LlmProvider implementation must honor `mcpAllowlist` at its provider
 * boundary. This test exercises each provider's filter mechanism directly
 * (rather than spawning the underlying CLI/SDK) and asserts that, given a
 * config exposing N servers and an allowlist of K (K < N), only the K
 * allowlisted servers are exposed downstream. Adding a new provider that
 * fails this contract must fail CI.
 *
 * Why test the filters and not full end-to-end:
 *   - End-to-end would require spawning Claude SDK and `codex exec` CLI in
 *     CI, both of which need credentials and incur cost.
 *   - The filter mechanism is the *only* place each provider can enforce
 *     the allowlist before the model sees it. Filter correctness ⇒
 *     enforcement.
 */
describe('LlmProvider contract: mcpAllowlist enforcement', () => {
  it('claude provider: loadMcpServers drops servers not in the allowlist', () => {
    const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-fake-home-'));
    try {
      const settingsDir = path.join(fakeHome, '.claude');
      fs.mkdirSync(settingsDir, { recursive: true });
      fs.writeFileSync(
        path.join(settingsDir, 'settings.json'),
        JSON.stringify({
          mcpServers: {
            'brain-mcp': { command: '/bin/true' },
            'gmail-mcp': { command: '/bin/true' },
            'supabase-mcp': { command: '/bin/true' },
          },
        }),
      );
      const realHome = process.env.HOME;
      process.env.HOME = fakeHome;
      try {
        const filtered = loadMcpServers(['brain-mcp'], fakeHome);
        expect(Object.keys(filtered).sort()).toEqual(['brain-mcp']);
      } finally {
        if (realHome === undefined) delete process.env.HOME;
        else process.env.HOME = realHome;
      }
    } finally {
      fs.rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  it('codex provider: filterMcpServers drops servers not in the allowlist', () => {
    const config = `model = "gpt-5.5"

[mcp_servers.brain-mcp]
url = "x"

[mcp_servers.gmail-mcp]
url = "y"

[mcp_servers.supabase-mcp]
url = "z"
`;
    const filtered = filterMcpServers(config, ['brain-mcp']);
    expect(filtered).toContain('[mcp_servers.brain-mcp]');
    expect(filtered).not.toContain('[mcp_servers.gmail-mcp]');
    expect(filtered).not.toContain('[mcp_servers.supabase-mcp]');
  });

  it('contract: empty allowlist exposes zero MCP servers across providers', () => {
    const claudeFakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-empty-'));
    try {
      const settingsDir = path.join(claudeFakeHome, '.claude');
      fs.mkdirSync(settingsDir, { recursive: true });
      fs.writeFileSync(
        path.join(settingsDir, 'settings.json'),
        JSON.stringify({ mcpServers: { 'a': { command: '/bin/true' } } }),
      );
      const realHome = process.env.HOME;
      process.env.HOME = claudeFakeHome;
      try {
        expect(Object.keys(loadMcpServers([], claudeFakeHome))).toEqual([]);
      } finally {
        if (realHome === undefined) delete process.env.HOME;
        else process.env.HOME = realHome;
      }
    } finally {
      fs.rmSync(claudeFakeHome, { recursive: true, force: true });
    }

    const codexConfig = `[mcp_servers.a]\nurl = "x"\n[mcp_servers.b]\nurl = "y"\n`;
    expect(filterMcpServers(codexConfig, [])).not.toContain('[mcp_servers.');
  });
});
