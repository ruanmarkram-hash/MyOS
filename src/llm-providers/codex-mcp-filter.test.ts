import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { filterMcpServers, mcpServersName, prepareCodexHome } from './codex-mcp-filter.js';

describe('mcpServersName', () => {
  it('extracts name from a top-level mcp_servers table', () => {
    expect(mcpServersName('mcp_servers.brain-mcp')).toBe('brain-mcp');
  });

  it('extracts name from a nested mcp_servers table', () => {
    expect(mcpServersName('mcp_servers.brain-mcp.env_http_headers')).toBe('brain-mcp');
  });

  it('handles quoted names', () => {
    expect(mcpServersName('mcp_servers."weird name"')).toBe('weird name');
  });

  it('returns null for non-mcp_servers tables', () => {
    expect(mcpServersName('marketplaces.openai-bundled')).toBeNull();
    expect(mcpServersName('plugins."codex@openai-codex"')).toBeNull();
  });

  it('returns null for the bare parent without a name', () => {
    expect(mcpServersName('mcp_servers')).toBeNull();
  });
});

describe('filterMcpServers', () => {
  const sampleConfig = `model = "gpt-5.5"
project_doc_max_bytes = 20000

[marketplaces.openai-bundled]
last_updated = "2026-05-01T21:46:39Z"

[mcp_servers.brain-mcp]
url = "https://example.supabase.co/functions/v1/brain-mcp"

[mcp_servers.brain-mcp.env_http_headers]
"x-brain-key" = "MCP_ACCESS_KEY"

[mcp_servers.gmail-mcp]
command = "/usr/local/bin/gmail-mcp"
args = ["--readonly"]

[mcp_servers."weird name"]
url = "https://weird"

[plugins."codex@openai-codex"]
enabled = true
`;

  it('keeps only allowlisted servers and drops the rest', () => {
    const out = filterMcpServers(sampleConfig, ['brain-mcp']);
    expect(out).toContain('[mcp_servers.brain-mcp]');
    expect(out).toContain('[mcp_servers.brain-mcp.env_http_headers]');
    expect(out).not.toContain('[mcp_servers.gmail-mcp]');
    expect(out).not.toContain('mcp_servers."weird name"');
  });

  it('preserves non-mcp_servers tables byte-for-byte', () => {
    const out = filterMcpServers(sampleConfig, ['brain-mcp']);
    expect(out).toContain('[marketplaces.openai-bundled]');
    expect(out).toContain('last_updated = "2026-05-01T21:46:39Z"');
    expect(out).toContain('[plugins."codex@openai-codex"]');
    expect(out).toContain('enabled = true');
    expect(out).toContain('model = "gpt-5.5"');
  });

  it('drops everything when allowlist is empty', () => {
    const out = filterMcpServers(sampleConfig, []);
    expect(out).not.toContain('[mcp_servers.');
    expect(out).toContain('[marketplaces.openai-bundled]');
  });

  it('returns input unchanged when there are no mcp_servers blocks', () => {
    const noMcp = `model = "gpt-5.5"\n[marketplaces.x]\na = 1\n`;
    expect(filterMcpServers(noMcp, ['anything'])).toBe(noMcp);
  });

  it('keeps quoted-name servers when allowlisted', () => {
    const out = filterMcpServers(sampleConfig, ['weird name']);
    expect(out).toContain('mcp_servers."weird name"');
    expect(out).toContain('url = "https://weird"');
    expect(out).not.toContain('[mcp_servers.brain-mcp]');
  });
});

describe('prepareCodexHome', () => {
  let fakeHome: string;

  beforeEach(() => {
    fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-fake-home-'));
    fs.writeFileSync(
      path.join(fakeHome, 'config.toml'),
      `model = "gpt-5.5"\n[mcp_servers.brain-mcp]\nurl = "x"\n[mcp_servers.gmail-mcp]\nurl = "y"\n`,
    );
    fs.writeFileSync(path.join(fakeHome, 'auth.json'), '{"token":"fake"}');
    fs.mkdirSync(path.join(fakeHome, 'sessions'));
    fs.writeFileSync(path.join(fakeHome, 'sessions', 's1'), 'sess data');
  });

  afterEach(() => {
    fs.rmSync(fakeHome, { recursive: true, force: true });
  });

  it('writes a filtered config and symlinks auth + sessions', () => {
    const prep = prepareCodexHome(['brain-mcp'], fakeHome);
    try {
      expect(prep.home).not.toBe(fakeHome);

      const cfg = fs.readFileSync(path.join(prep.home, 'config.toml'), 'utf8');
      expect(cfg).toContain('[mcp_servers.brain-mcp]');
      expect(cfg).not.toContain('[mcp_servers.gmail-mcp]');

      // auth.json should resolve to the real file via symlink.
      const authReal = fs.realpathSync(path.join(prep.home, 'auth.json'));
      expect(authReal).toBe(fs.realpathSync(path.join(fakeHome, 'auth.json')));

      // sessions/ should be a symlink that exposes the real session file.
      expect(fs.existsSync(path.join(prep.home, 'sessions', 's1'))).toBe(true);
    } finally {
      prep.cleanup();
    }
  });

  it('cleanup is idempotent and removes the temp dir', () => {
    const prep = prepareCodexHome(['brain-mcp'], fakeHome);
    expect(fs.existsSync(prep.home)).toBe(true);
    prep.cleanup();
    expect(fs.existsSync(prep.home)).toBe(false);
    // Second call must not throw.
    expect(() => prep.cleanup()).not.toThrow();
  });

  it('passes through (no temp dir) when realHome has no config.toml', () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-empty-home-'));
    try {
      const prep = prepareCodexHome(['brain-mcp'], empty);
      expect(prep.home).toBe(empty);
      // Cleanup should be a no-op (must not delete the real home).
      prep.cleanup();
      expect(fs.existsSync(empty)).toBe(true);
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });

  it('does not leak symlink to the real config.toml', () => {
    const prep = prepareCodexHome(['brain-mcp'], fakeHome);
    try {
      const stat = fs.lstatSync(path.join(prep.home, 'config.toml'));
      expect(stat.isSymbolicLink()).toBe(false);
      expect(stat.isFile()).toBe(true);
    } finally {
      prep.cleanup();
    }
  });
});
