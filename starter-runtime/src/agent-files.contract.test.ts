// Contract test for the Phase C1.a agent-files editor API. Pinned here so
// path-allowlist regressions show up in CI before they reach a running bot.

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import fs from 'fs';

import { _initTestDatabase } from './db.js';
import { buildDashboardApp } from './dashboard.js';
import { resolveMainClaudeMdPath } from './config.js';
import type { Hono } from 'hono';

const TOKEN = 'test-contract-token';
let app: Hono;

beforeAll(() => {
  app = buildDashboardApp(undefined) as unknown as Hono;
});

beforeEach(() => {
  _initTestDatabase();
});

const claudeMdPath = resolveMainClaudeMdPath();
let snapshot: string | null = null;

beforeEach(() => {
  snapshot = fs.existsSync(claudeMdPath) ? fs.readFileSync(claudeMdPath, 'utf-8') : null;
});

afterEach(() => {
  if (snapshot !== null) fs.writeFileSync(claudeMdPath, snapshot);
});

function tokenize(p: string): string {
  return p + (p.includes('?') ? '&' : '?') + 'token=' + TOKEN;
}

async function get(p: string): Promise<Response> {
  return app.request(tokenize(p));
}

async function put(p: string, body: unknown): Promise<Response> {
  return app.request(tokenize(p), {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function mainSha(): Promise<string> {
  const res = await get('/api/agent-files/main');
  const body = (await res.json()) as { contentSha: string };
  return body.contentSha;
}

describe('GET /api/agent-files', () => {
  it('lists exactly the main file id', async () => {
    const res = await get('/api/agent-files');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { files: Array<{ id: string }> };
    expect(body.files.map((f) => f.id)).toEqual(['main']);
  });
});

describe('GET /api/agent-files/:id', () => {
  it('returns content + sha for main', async () => {
    const res = await get('/api/agent-files/main');
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      id: 'main',
      label: expect.any(String),
      path: expect.any(String),
      content: expect.any(String),
      contentSha: expect.any(String),
      exists: expect.any(Boolean),
    });
  });

  it('refuses unknown ids with 400', async () => {
    const res = await get('/api/agent-files/charter');
    expect(res.status).toBe(400);
  });

  it('refuses traversal-style ids with 400', async () => {
    const res = await get('/api/agent-files/' + encodeURIComponent('../etc/passwd'));
    expect(res.status).toBe(400);
  });
});

describe('PUT /api/agent-files/:id', () => {
  it('refuses writes outside the allowlist (charter) with 400', async () => {
    const res = await put('/api/agent-files/charter', { content: 'pwned' });
    expect(res.status).toBe(400);
  });

  it('refuses traversal id with 400 (does not touch disk)', async () => {
    const before = fs.existsSync(claudeMdPath)
      ? fs.readFileSync(claudeMdPath, 'utf-8')
      : null;
    const res = await put(
      '/api/agent-files/' + encodeURIComponent('../etc/passwd'),
      { content: 'pwned' },
    );
    expect(res.status).toBe(400);
    const after = fs.existsSync(claudeMdPath)
      ? fs.readFileSync(claudeMdPath, 'utf-8')
      : null;
    expect(after).toBe(before);
  });

  it('rejects missing content with 400', async () => {
    const res = await put('/api/agent-files/main', {});
    expect(res.status).toBe(400);
  });

  it('rejects missing expectedSha with 400', async () => {
    const res = await put('/api/agent-files/main', { content: 'blind overwrite' });
    expect(res.status).toBe(400);
  });

  it('rejects oversize content with 413', async () => {
    const huge = 'x'.repeat(257 * 1024);
    const res = await put('/api/agent-files/main', { content: huge });
    expect(res.status).toBe(413);
  });

  it('saves valid main edit and returns hot-reload flag', async () => {
    const next = '# Sage rules\nstay chill.\n';
    const res = await put('/api/agent-files/main', {
      content: next,
      expectedSha: await mainSha(),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      ok: true,
      id: 'main',
      hotReloaded: true,
      contentSha: expect.any(String),
      historyId: expect.any(Number),
    });
    expect(fs.readFileSync(claudeMdPath, 'utf-8')).toBe(next);
  });

  it('rejects stale expectedSha with 409', async () => {
    fs.writeFileSync(claudeMdPath, 'current');
    const res = await put('/api/agent-files/main', {
      content: 'overwrite',
      expectedSha: '0'.repeat(64),
    });
    expect(res.status).toBe(409);
    expect(fs.readFileSync(claudeMdPath, 'utf-8')).toBe('current');
  });
});

describe('GET /api/agent-files/:id/history', () => {
  it('refuses unknown ids with 400', async () => {
    const res = await get('/api/agent-files/charter/history');
    expect(res.status).toBe(400);
  });

  it('returns empty history on a fresh DB', async () => {
    const res = await get('/api/agent-files/main/history');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { history: unknown[] };
    expect(body.history).toEqual([]);
  });

  it('returns rows after a save (newest first), without inlining content', async () => {
    await put('/api/agent-files/main', {
      content: 'first',
      expectedSha: await mainSha(),
    });
    await put('/api/agent-files/main', {
      content: 'second',
      expectedSha: await mainSha(),
    });
    const res = await get('/api/agent-files/main/history');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      history: Array<{ size: number; content_sha: string; content?: unknown }>;
    };
    expect(body.history.length).toBe(2);
    // Newest first.
    expect(body.history[0].size).toBe('second'.length);
    // Content body must NOT be inlined into the list response.
    expect((body.history[0] as Record<string, unknown>).content).toBeUndefined();
  });
});
