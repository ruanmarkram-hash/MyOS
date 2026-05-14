// Contract test suite for the Mission Control HTTP API.
//
// Why this exists: a frontend rewrite is in progress (web/ Vite project,
// rolling out PR-by-PR). The new frontend is built against the documented
// shape of every endpoint. If the backend ever drifts from that shape —
// renames a field, changes nullability, swaps a type — the rewrite breaks
// silently. These tests pin the response shape of every endpoint family
// the new frontend depends on, so any drift fails CI before it ships.
//
// Tests use Hono's `app.request()` so no real port is opened. The DB is
// the in-memory test DB initialized via `_initTestDatabase()`.
//
// Env vars are set by `src/test-env-setup.ts` (vitest setupFiles) so they
// land BEFORE config.ts evaluates at import time.

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { _initTestDatabase, _setMissionCompletedAtForTest, claimNextMissionTask, cleanupOldMissionTasks, completeMissionTask, createMissionTask, createScheduledTask, getAllScheduledTasks, getAttentionItem, getAttentionItemBySourceKey, getMissionManifest, getMissionReview, getMissionTask, getTelegramOutboxRow, insertOperationNotification, insertTelegramOutbox, markAttentionAssigned, markTaskRunning, markTelegramOutboxDeadLettered, saveStructuredMemory, updateTaskAfterRun, upsertAttentionItem, upsertMissionReview } from './db.js';
import { runAttentionAutofixSweep } from './attention-autofix.js';
import { buildDashboardApp, configuredReviewExportEmail, configuredReviewExportFromEmail, createReviewEmailAttachment } from './dashboard.js';
import type { Hono } from 'hono';

const TOKEN = 'test-contract-token';
const Q = '?token=' + TOKEN;

let app: Hono;

beforeAll(() => {
  app = buildDashboardApp(undefined) as unknown as Hono;
});

beforeEach(() => {
  _initTestDatabase();
});

async function get(path: string) {
  return app.request(path + (path.includes('?') ? '&' : '?') + 'token=' + TOKEN);
}

async function getNoToken(path: string) {
  return app.request(path);
}

// Tests fetch JSON we only describe shape-wise — typing as `any` keeps the
// assertions readable without forcing the real interfaces into the test file.
async function jsonOf(res: Response): Promise<any> {
  return res.json();
}

describe('auth gate', () => {
  it('rejects unauthorized GET without token', async () => {
    const res = await getNoToken('/api/health');
    expect(res.status).toBe(401);
    expect(await jsonOf(res)).toMatchObject({ error: 'Unauthorized' });
  });

  it('allows PWA install assets without dashboard token', async () => {
    for (const path of ['/manifest.webmanifest', '/sw.js', '/favicon.svg', '/pwa/icon-192.png']) {
      const res = await getNoToken(path);
      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toMatch(/no-cache|immutable/);
    }
  });

  it('rejects unauthorized GET with wrong token', async () => {
    const res = await app.request('/api/health?token=wrong');
    expect(res.status).toBe(401);
  });

  it('accepts GET with correct token', async () => {
    const res = await get('/api/health');
    expect(res.status).toBe(200);
  });

  it('sets an auth cookie after a valid token request', async () => {
    const res = await get('/api/health');
    expect(res.status).toBe(200);
    expect(res.headers.get('set-cookie')).toContain('claudeclaw_dashboard=');
  });

  it('accepts GET with dashboard auth cookie and no token', async () => {
    const first = await get('/api/health');
    const cookie = first.headers.get('set-cookie')?.split(';')[0] || '';
    const res = await app.request('/api/health', { headers: { cookie } });
    expect(res.status).toBe(200);
  });

  it('redirects browser GETs without auth to the login page', async () => {
    const res = await getNoToken('/v2/home');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('/login?next=');
  });

  it('serves the dashboard login page without a token', async () => {
    const res = await getNoToken('/login');
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('Sign in to Mission Control');
  });

  it('sets the auth cookie from the login form and redirects to a safe next path', async () => {
    const body = new URLSearchParams({ token: TOKEN, next: '/v2/home' });
    const res = await app.request('/login', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/v2/home');
    expect(res.headers.get('set-cookie')).toContain('claudeclaw_dashboard=');
  });

  it('marks the auth cookie secure behind an HTTPS tunnel', async () => {
    const body = new URLSearchParams({ token: TOKEN, next: '/v2/home' });
    const res = await app.request('/login', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'x-forwarded-proto': 'https',
      },
      body,
    });
    expect(res.headers.get('set-cookie')).toContain('Secure');
  });

  it('rejects unsafe login next redirects', async () => {
    const body = new URLSearchParams({ token: TOKEN, next: 'https://evil.example/' });
    const res = await app.request('/login', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/v2/home');
  });

  it('strips token query params from browser deep links after setting the cookie', async () => {
    const res = await app.request('/v2/home?token=' + TOKEN);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/v2/home');
    expect(res.headers.get('set-cookie')).toContain('claudeclaw_dashboard=');
  });

  it('redirects root-level v2 deep links to the mounted v2 app', async () => {
    const first = await get('/api/health');
    const cookie = first.headers.get('set-cookie')?.split(';')[0] || '';
    const res = await app.request('/home', { headers: { cookie } });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('/v2/home');
  });

  it('redirects the deprecated dedicated mobile route to the normal app', async () => {
    const first = await get('/api/health');
    const cookie = first.headers.get('set-cookie')?.split(';')[0] || '';
    const res = await app.request('/v2/mobile', { headers: { cookie } });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('/v2/home');
  });

  it('responds 204 to OPTIONS preflight without token check', async () => {
    const res = await app.request('/api/health', { method: 'OPTIONS' });
    expect(res.status).toBe(204);
  });
});

describe('GET /api/health', () => {
  it('returns the documented shape', async () => {
    const res = await get('/api/health');
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body).toMatchObject({
      contextPct: expect.any(Number),
      turns: expect.any(Number),
      compactions: expect.any(Number),
      sessionAge: expect.any(String),
      model: expect.any(String),
      provider: expect.stringMatching(/^(claude|codex)$/),
      configuredProvider: expect.any(String),
      supportedProviders: expect.arrayContaining(['claude', 'codex']),
      configuredModel: expect.any(String),
      resolvedModel: expect.any(String),
      hasSession: expect.any(Boolean),
      telegramConnected: expect.any(Boolean),
      waConnected: expect.any(Boolean),
      slackConnected: expect.any(Boolean),
      killSwitches: expect.any(Object),
      killSwitchRefusals: expect.any(Object),
      warroom: expect.objectContaining({
        textOpenMeetings: expect.any(Number),
      }),
    });
    expect('providerError' in body).toBe(true);
    expect('sessionId' in body).toBe(false);
    expect('sessionShort' in body).toBe(true);
  });

  it('killSwitches contains all 6 documented flags', async () => {
    const res = await get('/api/health');
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body.killSwitches).toMatchObject({
      WARROOM_TEXT_ENABLED: expect.any(Boolean),
      WARROOM_VOICE_ENABLED: expect.any(Boolean),
      LLM_SPAWN_ENABLED: expect.any(Boolean),
      DASHBOARD_MUTATIONS_ENABLED: expect.any(Boolean),
      MISSION_AUTO_ASSIGN_ENABLED: expect.any(Boolean),
      SCHEDULER_ENABLED: expect.any(Boolean),
    });
  });
});

describe('POST /api/system/restart-main', () => {
  it('respects DASHBOARD_MUTATIONS_ENABLED=false', async () => {
    const prev = process.env.DASHBOARD_MUTATIONS_ENABLED;
    process.env.DASHBOARD_MUTATIONS_ENABLED = 'false';
    try {
      const res = await app.request('/api/system/restart-main' + Q, { method: 'POST' });
      expect(res.status).toBe(423);
      expect(await jsonOf(res)).toMatchObject({ ok: false, error: expect.any(String) });
    } finally {
      if (prev === undefined) delete process.env.DASHBOARD_MUTATIONS_ENABLED;
      else process.env.DASHBOARD_MUTATIONS_ENABLED = prev;
    }
  });

  it('queues a graceful main restart', async () => {
    const res = await app.request('/api/system/restart-main' + Q, { method: 'POST' });
    expect(res.status).toBe(202);
    const body = await jsonOf(res);
    expect(body).toMatchObject({
      ok: true,
      queued: expect.any(Boolean),
      message: expect.any(String),
    });
  });
});

describe('GET /api/brain/status', () => {
  it('returns local and OpenBrain status', async () => {
    const res = await get('/api/brain/status');
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body).toMatchObject({
      backend: expect.any(String),
      openBrain: expect.objectContaining({
        enabled: expect.any(Boolean),
        configured: expect.any(Boolean),
        functionName: expect.any(String),
      }),
      sqlite: expect.objectContaining({
        chatId: expect.any(String),
        totalMemories: expect.any(Number),
      }),
      mutationsEnabled: expect.any(Boolean),
      notes: expect.any(String),
    });
  });
});

describe('GET /api/brain/search', () => {
  it('rejects a missing query before contacting OpenBrain', async () => {
    const res = await get('/api/brain/search');
    expect(res.status).toBe(400);
    const body = await jsonOf(res);
    expect(body).toMatchObject({ ok: false, error: expect.stringContaining('query') });
  });

  it('falls back to local SQLite search when OpenBrain is not configured', async () => {
    saveStructuredMemory('', 'Action: Follow up Lucas contact form.', 'Lucas contact form needs follow up', ['Lucas'], ['brief'], 0.8, 'contract');
    const res = await get('/api/brain/search?query=Lucas&backend=sqlite');
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body).toMatchObject({
      ok: true,
      backend: 'sqlite',
      results: expect.any(Array),
    });
  });
});

describe('GET /api/brain/graph', () => {
  it('reports graph status without requiring a deployed graph function', async () => {
    const res = await get('/api/brain/graph/status');
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body).toMatchObject({
      ok: expect.any(Boolean),
      configured: expect.any(Boolean),
      ready: expect.any(Boolean),
      functionName: expect.any(String),
      edgeTypes: expect.any(Array),
    });
  });

  it('returns an empty graph payload when OB-Graph is not configured', async () => {
    const res = await get('/api/brain/graph/nodes');
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body).toMatchObject({
      configured: expect.any(Boolean),
      nodes: expect.any(Array),
      count: expect.any(Number),
    });
  });

  it('returns a stable whole-OpenBrain map shape across configured and fallback states', async () => {
    const res = await get('/api/brain/map');
    expect([200, 400]).toContain(res.status);
    const body = await jsonOf(res);
    expect(body).toMatchObject({
      configured: expect.any(Boolean),
      nodes: expect.any(Array),
      edges: expect.any(Array),
      points: expect.any(Array),
    });
  });
});

describe('POST /api/brain/capture', () => {
  it('respects DASHBOARD_MUTATIONS_ENABLED=false before contacting OpenBrain', async () => {
    const prev = process.env.DASHBOARD_MUTATIONS_ENABLED;
    process.env.DASHBOARD_MUTATIONS_ENABLED = 'false';
    try {
      const res = await app.request('/api/brain/capture' + Q, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: 'contract test thought' }),
      });
      expect(res.status).toBe(423);
      const body = await jsonOf(res);
      expect(body).toMatchObject({ ok: false, error: expect.any(String) });
    } finally {
      if (prev === undefined) delete process.env.DASHBOARD_MUTATIONS_ENABLED;
      else process.env.DASHBOARD_MUTATIONS_ENABLED = prev;
    }
  });

  it('rejects malformed JSON bodies with 400, not 500', async () => {
    const res = await app.request('/api/brain/capture' + Q, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(null),
    });
    expect(res.status).toBe(400);
    const body = await jsonOf(res);
    expect(body).toMatchObject({ ok: false, error: expect.stringContaining('content') });
  });

  it('rejects non-string capture content with 400, not 500', async () => {
    const res = await app.request('/api/brain/capture' + Q, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 123 }),
    });
    expect(res.status).toBe(400);
    const body = await jsonOf(res);
    expect(body).toMatchObject({ ok: false, error: expect.stringContaining('content') });
  });

  it('captures locally when OpenBrain is not configured', async () => {
    const res = await app.request('/api/brain/capture' + Q, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'local brain capture contract thought', backend: 'sqlite' }),
    });
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body).toMatchObject({
      ok: true,
      backend: 'sqlite',
      localMemoryId: expect.any(Number),
    });
  });
});

describe('GET /api/reliability/status', () => {
  it('returns mission, worker, telegram, provider, and restart signals', async () => {
    const res = await get('/api/reliability/status');
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body).toMatchObject({
      ok: expect.any(Boolean),
      summary: expect.objectContaining({
        openIssues: expect.any(Number),
        stuckWorkers: expect.any(Number),
        staleMissions: expect.any(Number),
        telegramDeadLetters: expect.any(Number),
        overdueOperations: expect.any(Number),
        restartNeeded: expect.any(Boolean),
      }),
      workers: expect.any(Object),
      missions: expect.any(Object),
      telegram: expect.any(Object),
      operations: expect.any(Object),
      providers: expect.any(Array),
      restart: expect.any(Object),
    });
  });

  it('returns actionable stale workers, outbox rows, and overdue operations', async () => {
    const now = Math.floor(Date.now() / 1000);
    createScheduledTask('rel-schedule-stuck', 'Run stuck schedule', '* * * * *', now + 3600, 'warden');
    markTaskRunning('rel-schedule-stuck');
    createScheduledTask('rel-schedule-failed', 'Run failed schedule', '* * * * *', now + 3600, 'warden');
    updateTaskAfterRun('rel-schedule-failed', now + 3600, 'failure body', 'failed');

    const outboxId = insertTelegramOutbox('main', 'chat', JSON.stringify({ method: 'sendMessage', args: {} }));
    markTelegramOutboxDeadLettered(outboxId, 'boom');
    insertOperationNotification({
      agentId: 'main',
      chatId: 'chat',
      operationId: 'rel-overdue-op',
      fireAt: now - 600,
      payload: 'check back',
    });

    const res = await get('/api/reliability/status');
    const body = await jsonOf(res);
    expect(body.telegram.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: outboxId, status: 'dead-lettered', canRetry: true }),
    ]));
    expect(body.operations.overdue).toEqual(expect.arrayContaining([
      expect.objectContaining({ operationId: 'rel-overdue-op', canCancel: true }),
    ]));
  });

  it('resets a stuck scheduled task and retries a dead-lettered outbox row', async () => {
    const now = Math.floor(Date.now() / 1000);
    createScheduledTask('rel-reset-schedule', 'Run reset schedule', '* * * * *', now + 3600, 'warden');
    markTaskRunning('rel-reset-schedule');
    const reset = await app.request('/api/reliability/schedules/rel-reset-schedule/reset' + Q, { method: 'POST' });
    expect(reset.status).toBe(200);
    expect(getAllScheduledTasks().find((task) => task.id === 'rel-reset-schedule')?.status).toBe('active');

    const outboxId = insertTelegramOutbox('main', 'chat', JSON.stringify({ method: 'sendMessage', args: {} }));
    markTelegramOutboxDeadLettered(outboxId, 'boom');
    const retry = await app.request(`/api/reliability/outbox/${outboxId}/retry` + Q, { method: 'POST' });
    expect(retry.status).toBe(200);
    expect(getTelegramOutboxRow(outboxId)?.status).toBe('pending');

    const pendingId = insertTelegramOutbox('main', 'chat', JSON.stringify({ method: 'sendMessage', args: {} }));
    const dead = await app.request(`/api/reliability/outbox/${pendingId}/dead-letter` + Q, { method: 'POST' });
    expect(dead.status).toBe(200);
    expect(getTelegramOutboxRow(pendingId)?.status).toBe('dead-lettered');
  });

  it('does not clear a failed schedule row while a later run is active', async () => {
    const now = Math.floor(Date.now() / 1000);
    createScheduledTask('rel-running-failed-schedule', 'Run failed then running schedule', '* * * * *', now + 3600, 'warden');
    updateTaskAfterRun('rel-running-failed-schedule', now + 3600, 'previous failure', 'failed');
    markTaskRunning('rel-running-failed-schedule');

    const clear = await app.request('/api/reliability/schedules/rel-running-failed-schedule/clear-failure' + Q, { method: 'POST' });
    expect(clear.status).toBe(200);
    expect(await jsonOf(clear)).toMatchObject({ ok: false, cleared: false });
    const task = getAllScheduledTasks().find((row) => row.id === 'rel-running-failed-schedule');
    expect(task?.status).toBe('running');
    expect(task?.last_status).toBe('failed');
  });
});

describe('GET /api/info', () => {
  it('returns botName, botUsername, pid, chatId', async () => {
    const res = await get('/api/info');
    const body = await jsonOf(res);
    expect(body).toMatchObject({
      botName: expect.any(String),
      botUsername: expect.any(String),
      pid: expect.any(Number),
    });
    expect('chatId' in body).toBe(true);
  });
});

describe('GET /api/agents', () => {
  it('returns { agents: [] } even when no agents configured', async () => {
    const res = await get('/api/agents');
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body).toMatchObject({ agents: expect.any(Array) });
  });

  it('always includes main as first entry when present', async () => {
    const res = await get('/api/agents');
    const body = await jsonOf(res);
    if (body.agents.length > 0) {
      expect(body.agents[0]).toMatchObject({
        id: expect.any(String),
        name: expect.any(String),
        provider: expect.stringMatching(/^(claude|codex)$/),
        configuredProvider: expect.any(String),
        configuredModel: expect.any(String),
        resolvedModel: expect.any(String),
        hasSession: expect.any(Boolean),
        running: expect.any(Boolean),
      });
      expect('sessionId' in body.agents[0]).toBe(false);
      expect('sessionShort' in body.agents[0]).toBe(true);
      expect('providerError' in body.agents[0]).toBe(true);
      expect('lastProviderError' in body.agents[0]).toBe(true);
    }
  });
});

describe('POST /api/provider/smoke', () => {
  it('respects LLM_SPAWN_ENABLED=false before running a model', async () => {
    const prev = process.env.LLM_SPAWN_ENABLED;
    process.env.LLM_SPAWN_ENABLED = 'false';
    try {
      const res = await app.request('/api/provider/smoke' + Q, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ provider: 'claude' }),
      });
      expect(res.status).toBe(423);
      const body = await jsonOf(res);
      expect(body).toMatchObject({ ok: false, error: expect.stringContaining('LLM spawn') });
    } finally {
      if (prev === undefined) delete process.env.LLM_SPAWN_ENABLED;
      else process.env.LLM_SPAWN_ENABLED = prev;
    }
  });

  it('rejects unsupported provider before running a model', async () => {
    const res = await app.request('/api/provider/smoke' + Q, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'bad-provider' }),
    });
    expect(res.status).toBe(400);
    const body = await jsonOf(res);
    expect(body).toMatchObject({ ok: false, error: expect.any(String) });
  });
});

describe('POST /api/provider/switch', () => {
  it('respects DASHBOARD_MUTATIONS_ENABLED=false', async () => {
    const prev = process.env.DASHBOARD_MUTATIONS_ENABLED;
    process.env.DASHBOARD_MUTATIONS_ENABLED = 'false';
    try {
      const res = await app.request('/api/provider/switch' + Q, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ provider: 'codex' }),
      });
      expect(res.status).toBe(423);
      const body = await jsonOf(res);
      expect(body).toMatchObject({ ok: false, error: expect.any(String) });
    } finally {
      if (prev === undefined) delete process.env.DASHBOARD_MUTATIONS_ENABLED;
      else process.env.DASHBOARD_MUTATIONS_ENABLED = prev;
    }
  });

  it('rejects unsupported provider before writing config', async () => {
    const res = await app.request('/api/provider/switch' + Q, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'openbrain' }),
    });
    expect(res.status).toBe(400);
    const body = await jsonOf(res);
    expect(body).toMatchObject({ ok: false, error: expect.any(String) });
  });
});

describe('GET /api/runtime/stack', () => {
  it('returns provider, memory, tool, session, and safety components', async () => {
    const res = await get('/api/runtime/stack');
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body).toMatchObject({
      updatedAt: expect.any(String),
      runtime: expect.objectContaining({
        activeProvider: expect.stringMatching(/^(claude|codex)$/),
        configuredProvider: expect.any(String),
        supportedProviders: expect.arrayContaining(['claude', 'codex']),
      }),
      agentRoutes: expect.arrayContaining([
        expect.objectContaining({
          agentId: 'main',
          provider: expect.stringMatching(/^(claude|codex)$/),
          configuredProvider: expect.any(String),
        }),
      ]),
      components: expect.any(Array),
    });
    expect(body.components.map((c: any) => c.id)).toEqual(expect.arrayContaining([
      'provider-adapter',
      'local-model-readiness',
      'memory-backend',
      'tool-boundary',
      'session-store',
      'safety-gates',
    ]));
  });
});

describe('GET /api/home dashboard endpoints', () => {
  it('returns brief outputs from last_result, not scheduled prompts', async () => {
    const now = Math.floor(Date.now() / 1000);
    createScheduledTask('brief-1', 'Morning brief prompt that should not be primary content', '0 9 * * *', now + 3600, 'main');
    updateTaskAfterRun('brief-1', now + 86400, 'Needs review: approve supplier invoice\nLow risk note', 'success');

    const res = await get('/api/home/briefs');
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body).toMatchObject({
      updatedAt: expect.any(String),
      briefs: expect.any(Array),
      latest: expect.any(Object),
    });
    expect(body.briefs[0]).toMatchObject({
      label: 'Morning',
      content: expect.stringContaining('Needs review'),
      attentionItems: expect.arrayContaining([expect.stringContaining('Needs review')]),
      primary: true,
    });
    expect(body.briefs[0].content).not.toContain('prompt that should not be primary');
  });

  it('classifies brief slots from the scheduled prompt, not body wording', async () => {
    const now = Math.floor(Date.now() / 1000);
    createScheduledTask('brief-evening', 'Produce user evening wrap', '0 18 * * *', now + 3600, 'main');
    updateTaskAfterRun('brief-evening', now + 86400, 'What landed this morning: shipped dashboard work', 'success');

    const res = await get('/api/home/briefs');
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body.briefs[0]).toMatchObject({
      slot: 'evening',
      label: 'Evening',
      content: expect.stringContaining('this morning'),
    });
  });

  it('returns attention items from briefs and active missions', async () => {
    const now = Math.floor(Date.now() / 1000);
    createScheduledTask('brief-2', 'Midday pulse', '0 */4 * * *', now + 3600, 'main');
    updateTaskAfterRun('brief-2', now + 86400, 'Blocked: calendar connector still pending', 'success');
    createMissionTask('m-home-1', 'Build calendar connector', 'wire agenda API', null, 'dashboard', 7);

    const res = await get('/api/home/attention');
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body).toMatchObject({
      updatedAt: expect.any(String),
      items: expect.any(Array),
    });
    expect(body.items.map((item: any) => item.source)).toEqual(expect.arrayContaining(['brief', 'mission']));
    expect(body.items[0]).toMatchObject({
      id: expect.any(String),
      severity: expect.stringMatching(/^(high|medium|low)$/),
      title: expect.any(String),
      detail: expect.any(String),
      createdAt: expect.any(Number),
    });
  });

  it('emits workStatus=running for attention item assigned to a running mission', async () => {
    const item = upsertAttentionItem({
      sourceKind: 'brief',
      sourceId: 'brief-running-mission',
      sourceKey: 'brief:brief-running-mission:workstatus-running',
      title: 'Fix Graph auth',
      detail: 'Re-auth your Microsoft app before calendar briefs can run.',
      severity: 'high',
      href: '/home',
    });
    createMissionTask('m-workstatus-running', 'Fix Graph auth', 'fix it', 'mason', 'dashboard', 7);
    const claimed = claimNextMissionTask('mason');
    expect(claimed?.status).toBe('running');
    markAttentionAssigned(item.id, 'm-workstatus-running', 'mason');

    const attention = await jsonOf(await get('/api/home/attention'));
    const row = attention.items.find((it: any) => it.id === `attention:${item.id}`);
    expect(row).toBeDefined();
    expect(row.workStatus).toBe('running');
  });

  it('auto-resolves attention items whose linked mission completed', async () => {
    const item = upsertAttentionItem({
      sourceKind: 'brief',
      sourceId: 'brief-mission-completed',
      sourceKey: 'brief:brief-mission-completed:autoresolve',
      title: 'Resolve calendar issue',
      detail: 'Calendar connector pending.',
      severity: 'medium',
      href: '/home',
    });
    createMissionTask('m-workstatus-completed', 'Resolve calendar issue', 'do it', 'mason', 'dashboard', 5);
    markAttentionAssigned(item.id, 'm-workstatus-completed', 'mason');
    completeMissionTask('m-workstatus-completed', 'all done', 'completed');

    const attention = await jsonOf(await get('/api/home/attention'));
    expect(attention.items.find((it: any) => it.id === `attention:${item.id}`)).toBeUndefined();
    const stored = getAttentionItem(item.id);
    expect(stored?.status).toBe('resolved');
  });

  it('emits workStatus=failed when linked mission failed', async () => {
    const item = upsertAttentionItem({
      sourceKind: 'brief',
      sourceId: 'brief-mission-failed',
      sourceKey: 'brief:brief-mission-failed:workstatus-failed',
      title: 'Investigate Graph errors',
      detail: 'Graph calls returning 401.',
      severity: 'high',
      href: '/home',
    });
    createMissionTask('m-workstatus-failed', 'Investigate Graph errors', 'fix it', 'mason', 'dashboard', 7);
    markAttentionAssigned(item.id, 'm-workstatus-failed', 'mason');
    completeMissionTask('m-workstatus-failed', null, 'failed', 'auth refused');

    const attention = await jsonOf(await get('/api/home/attention'));
    const row = attention.items.find((it: any) => it.id === `attention:${item.id}`);
    expect(row).toBeDefined();
    expect(row.workStatus).toBe('failed');
  });

  it('preserves structured brief action metadata in durable attention detail', async () => {
    const now = Math.floor(Date.now() / 1000);
    createScheduledTask('brief-structured', 'Morning brief', '0 9 * * *', now + 3600, 'main');
    updateTaskAfterRun(
      'brief-structured',
      now + 86400,
      'ATTENTION_ACTIONS: [{"title":"Review Graph auth","detail":"Microsoft Graph auth expired; re-auth your Microsoft app before calendar briefs can run.","severity":"high","sourceCategory":"runtime","due":"today","requires_ruan":true,"confidence":0.91}]',
      'success',
    );

    const res = await get('/api/home/attention');
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    const item = body.items.find((row: any) => row.source === 'brief');
    expect(item).toMatchObject({
      title: 'Review Graph auth',
      origin: 'Morning brief',
      severity: 'high',
      detail: expect.stringContaining('Microsoft Graph auth expired'),
    });
    expect(item.detail).toContain('Due: today');
    expect(item.detail).toContain('Requires user: yes');
    expect(item.detail).toContain('Confidence: 91%');
  });

  it('uses action detail when structured brief title is generic', async () => {
    const now = Math.floor(Date.now() / 1000);
    createScheduledTask('brief-generic-title', 'Morning brief', '0 9 * * *', now + 3600, 'main');
    updateTaskAfterRun(
      'brief-generic-title',
      now + 86400,
      'ATTENTION_ACTIONS: [{"title":"Morning brief","detail":"Tag contacts in ~/workspace/operations/email-triage/contacts-review.md with K/W/S/I flags to enable smart inbox filtering.","severity":"medium","sourceCategory":"brief","requires_ruan":true,"confidence":0.8}]',
      'success',
    );

    const attention = await jsonOf(await get('/api/home/attention'));
    expect(attention.items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        title: expect.stringContaining('Tag contacts in ~/workspace/operations/email-triage/contacts-review.md'),
        detail: expect.stringContaining('Tag contacts'),
      }),
    ]));
    expect(attention.items.map((item: any) => item.title)).not.toContain('Morning brief');
  });

  it('derives display title for existing durable brief rows with generic titles', async () => {
    upsertAttentionItem({
      sourceKind: 'brief',
      sourceId: 'brief-existing-generic',
      sourceKey: 'brief:brief-existing-generic:tag-contacts',
      title: 'Morning brief',
      detail: 'Tag contacts in ~/workspace/operations/email-triage/contacts-review.md with K/W/S/I flags to enable smart inbox filtering.\nRequires user: yes · Confidence: 80%',
      severity: 'low',
      href: '/home',
    });

    const attention = await jsonOf(await get('/api/home/attention'));
    expect(attention.items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        title: expect.stringContaining('Tag contacts in ~/workspace/operations/email-triage/contacts-review.md'),
        detail: expect.stringContaining('Tag contacts'),
      }),
    ]));
    expect(attention.items.map((item: any) => item.title)).not.toContain('Morning brief');
  });

  it('does not promote non-action inbox summaries from briefs', async () => {
    const now = Math.floor(Date.now() / 1000);
    createScheduledTask('brief-inbox-noise', 'Morning brief', '0 9 * * *', now + 3600, 'main');
    updateTaskAfterRun(
      'brief-inbox-noise',
      now + 86400,
      'Inbox: No urgent K-tagged items. Unread are mostly system notifications (Sentry, Connecteam auto-clocks, SEEK marketing from Oct 2025).',
      'success',
    );

    const attention = await jsonOf(await get('/api/home/attention'));
    expect(attention.items.map((item: any) => item.detail)).not.toEqual(expect.arrayContaining([
      expect.stringContaining('No urgent K-tagged items'),
    ]));
  });

  it('does not promote system notification inbox summaries with auth-like vendor names', async () => {
    const now = Math.floor(Date.now() / 1000);
    createScheduledTask('brief-inbox-auth0-noise', 'Morning brief', '0 9 * * *', now + 3600, 'main');
    updateTaskAfterRun(
      'brief-inbox-auth0-noise',
      now + 86400,
      'Inbox: No urgent K-tagged items. Unread are mostly system notifications from Auth0 marketing.',
      'success',
    );

    const attention = await jsonOf(await get('/api/home/attention'));
    expect(attention.items.map((item: any) => item.detail)).not.toEqual(expect.arrayContaining([
      expect.stringContaining('Auth0 marketing'),
    ]));
  });

  it('still extracts actions from mixed inbox summary lines', async () => {
    const now = Math.floor(Date.now() / 1000);
    createScheduledTask('brief-inbox-mixed', 'Morning brief', '0 9 * * *', now + 3600, 'main');
    updateTaskAfterRun(
      'brief-inbox-mixed',
      now + 86400,
      'Inbox: No urgent K-tagged items. Lucas contact form has not been actioned.',
      'success',
    );

    const attention = await jsonOf(await get('/api/home/attention'));
    expect(attention.items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        title: 'Lucas contact form has not been actioned',
        detail: 'Lucas contact form has not been actioned.',
        origin: 'Morning brief',
      }),
    ]));
  });

  it('still extracts actions from mixed inbox summary lines with system-notification noise', async () => {
    const now = Math.floor(Date.now() / 1000);
    createScheduledTask('brief-inbox-mixed-noisy', 'Morning brief', '0 9 * * *', now + 3600, 'main');
    updateTaskAfterRun(
      'brief-inbox-mixed-noisy',
      now + 86400,
      'Inbox: No urgent K-tagged items. Unread are mostly system notifications. Lucas contact form has not been actioned.',
      'success',
    );

    const attention = await jsonOf(await get('/api/home/attention'));
    expect(attention.items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        title: 'Lucas contact form has not been actioned',
        detail: 'Lucas contact form has not been actioned.',
      }),
    ]));
  });

  it('still extracts actions from comma-style mixed inbox summary lines', async () => {
    const now = Math.floor(Date.now() / 1000);
    createScheduledTask('brief-inbox-comma-mixed', 'Morning brief', '0 9 * * *', now + 3600, 'main');
    updateTaskAfterRun(
      'brief-inbox-comma-mixed',
      now + 86400,
      'Inbox: No urgent K-tagged items, but Lucas contact form has not been actioned.',
      'success',
    );

    const attention = await jsonOf(await get('/api/home/attention'));
    expect(attention.items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        title: 'No urgent K-tagged items, but Lucas contact form has not been actioned',
        detail: 'Inbox: No urgent K-tagged items, but Lucas contact form has not been actioned.',
      }),
    ]));
  });

  it('auto-routes structured attention that explicitly does not need user', async () => {
    const now = Math.floor(Date.now() / 1000);
    createScheduledTask('brief-autofix-route', 'Morning brief', '0 9 * * *', now + 3600, 'main');
    updateTaskAfterRun(
      'brief-autofix-route',
      now + 86400,
      'ATTENTION_ACTIONS: [{"title":"Fix CalDAV module","detail":"Scripts unavailable: missing caldav module. Install the dependency and rerun the Reminders digest smoke test.","severity":"high","sourceCategory":"runtime","suggested_agent":"mason","requires_ruan":false,"confidence":0.93}]',
      'success',
    );

    const attention = await jsonOf(await get('/api/home/attention'));
    const routed = attention.items.find((item: any) => /missing caldav module/.test(item.detail));
    expect(routed).toBeDefined();
    expect(routed.workStatus).not.toBe('new');

    const res = await get('/api/home/attention');
    expect(res.status).toBe(200);

    const missions = await jsonOf(await get('/api/mission/tasks'));
    expect(missions.tasks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        assigned_agent: 'mason',
        created_by: 'autofix',
        prompt: expect.stringContaining('Auto-routed Needs Attention item.'),
      }),
    ]));
  });

  it('auto-routes suggested-agent work even when a brief overstates Requires user', async () => {
    const now = Math.floor(Date.now() / 1000);
    createScheduledTask('brief-overstated-ruan', 'Evening brief', '0 18 * * *', now + 3600, 'main');
    updateTaskAfterRun(
      'brief-overstated-ruan',
      now + 86400,
      'ATTENTION_ACTIONS: [{"title":"Export Child Safety Charter PDF","detail":"Export ~/workspace/projects/sonke-hub/dry-run-4-deliverables/Child-Safety-Charter-DRAFT-v3-signed-branded.docx to PDF, upload to SharePoint, paste webUrl back.","severity":"medium","sourceCategory":"deliverable","suggested_agent":"mason","requires_ruan":true,"confidence":0.95}]',
      'success',
    );

    const attention = await jsonOf(await get('/api/home/attention'));
    const routed = attention.items.find((item: any) => item.title === 'Export Child Safety Charter PDF');
    expect(routed).toBeDefined();
    expect(routed.workStatus).not.toBe('new');

    const missions = await jsonOf(await get('/api/mission/tasks'));
    expect(missions.tasks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        title: 'Export Child Safety Charter PDF',
        assigned_agent: 'mason',
        created_by: 'autofix',
      }),
    ]));
  });

  it('keeps suggested-agent actions when they still need an explicit decision', async () => {
    const now = Math.floor(Date.now() / 1000);
    createScheduledTask('brief-decision-needed', 'Evening brief', '0 18 * * *', now + 3600, 'main');
    updateTaskAfterRun(
      'brief-decision-needed',
      now + 86400,
      'ATTENTION_ACTIONS: [{"title":"Confirm OR merge approach","detail":"Codex recommended OR-merge in convert_prospect_to_client reconciliation should overwrite stale-true flags; brief forbade overwriting withdrawn-true. Confirm approach.","severity":"high","sourceCategory":"sonke-hub","suggested_agent":"mason","requires_ruan":true,"confidence":0.9}]',
      'success',
    );

    const attention = await jsonOf(await get('/api/home/attention'));
    expect(attention.items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        title: 'Confirm OR merge approach',
        detail: expect.stringContaining('Confirm approach'),
      }),
    ]));
  });

  it('keeps suggested-agent review work when Requires user is explicit', async () => {
    const now = Math.floor(Date.now() / 1000);
    createScheduledTask('brief-review-human', 'Evening brief', '0 18 * * *', now + 3600, 'main');
    updateTaskAfterRun(
      'brief-review-human',
      now + 86400,
      'ATTENTION_ACTIONS: [{"title":"Review draft intake policy","detail":"Review the draft intake policy and confirm whether it should replace the current version.","severity":"medium","sourceCategory":"policy","suggested_agent":"charter","requires_ruan":true,"confidence":0.9}]',
      'success',
    );

    const attention = await jsonOf(await get('/api/home/attention'));
    expect(attention.items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        title: 'Review draft intake policy',
        detail: expect.stringContaining('confirm whether'),
      }),
    ]));
  });

  it('keeps bare suggested-agent review work when Requires user is explicit', async () => {
    const now = Math.floor(Date.now() / 1000);
    createScheduledTask('brief-review-human-bare', 'Evening brief', '0 18 * * *', now + 3600, 'main');
    updateTaskAfterRun(
      'brief-review-human-bare',
      now + 86400,
      'ATTENTION_ACTIONS: [{"title":"Review draft intake policy","detail":"Review draft intake policy.","severity":"medium","sourceCategory":"policy","suggested_agent":"charter","requires_ruan":true,"confidence":0.9}]',
      'success',
    );

    const attention = await jsonOf(await get('/api/home/attention'));
    expect(attention.items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        title: 'Review draft intake policy',
        detail: expect.stringContaining('Review draft intake policy'),
      }),
    ]));

    const missions = await jsonOf(await get('/api/mission/tasks'));
    expect(missions.tasks.map((task: any) => task.title)).not.toContain('Review draft intake policy');
  });

  it('keeps external comms actions when Requires user is explicit', async () => {
    const now = Math.floor(Date.now() / 1000);
    createScheduledTask('brief-send-reply-human', 'Morning brief', '0 9 * * *', now + 3600, 'main');
    updateTaskAfterRun(
      'brief-send-reply-human',
      now + 86400,
      'ATTENTION_ACTIONS: [{"title":"Reply to Lucas family","detail":"Write and send reply to the family.","severity":"medium","sourceCategory":"inbox","suggested_agent":"ember","requires_ruan":true,"confidence":0.9}]',
      'success',
    );

    const attention = await jsonOf(await get('/api/home/attention'));
    expect(attention.items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        title: 'Reply to Lucas family',
        detail: expect.stringContaining('Write and send reply'),
      }),
    ]));

    const missions = await jsonOf(await get('/api/mission/tasks'));
    expect(missions.tasks.map((task: any) => task.title)).not.toContain('Reply to Lucas family');
  });

  it('keeps SMS actions when Requires user is explicit', async () => {
    const now = Math.floor(Date.now() / 1000);
    createScheduledTask('brief-sms-human', 'Morning brief', '0 9 * * *', now + 3600, 'main');
    updateTaskAfterRun(
      'brief-sms-human',
      now + 86400,
      'ATTENTION_ACTIONS: [{"title":"SMS Lucas family","detail":"Write SMS to Lucas family.","severity":"medium","sourceCategory":"inbox","suggested_agent":"ember","requires_ruan":true,"confidence":0.9}]',
      'success',
    );

    const attention = await jsonOf(await get('/api/home/attention'));
    expect(attention.items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        title: 'SMS Lucas family',
        detail: expect.stringContaining('Write SMS'),
      }),
    ]));

    const missions = await jsonOf(await get('/api/mission/tasks'));
    expect(missions.tasks.map((task: any) => task.title)).not.toContain('SMS Lucas family');
  });

  it('keeps external comms actions even when they omit explicit Requires user metadata', async () => {
    upsertAttentionItem({
      sourceKind: 'mission',
      sourceId: 'mission-external-comms',
      sourceKey: 'mission:mission-external-comms:terminal',
      title: 'SMS Lucas family failed',
      detail: 'Reply to Lucas family is blocked. Suggested agent: @ember. Draft and send the SMS.',
      severity: 'medium',
      href: '/review?task=mission-external-comms',
    });

    const sweep = runAttentionAutofixSweep(50);
    expect(sweep.routed).toBe(0);

    const attention = await jsonOf(await get('/api/home/attention'));
    expect(attention.items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        title: 'SMS Lucas family failed',
        detail: expect.stringContaining('Draft and send the SMS'),
      }),
    ]));

    const missions = await jsonOf(await get('/api/mission/tasks'));
    expect(missions.tasks.map((task: any) => task.title)).not.toContain('SMS Lucas family failed');
  });

  it('keeps plain message or text actions human-gated when they omit explicit Requires user metadata', async () => {
    upsertAttentionItem({
      sourceKind: 'brief',
      sourceId: 'brief-message-human',
      sourceKey: 'brief:brief-message-human:message-lucas',
      title: 'Message the family about missing database form',
      detail: 'Message the family about missing database form.',
      severity: 'medium',
      href: '/home',
    });

    const attention = await jsonOf(await get('/api/home/attention'));
    expect(attention.items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        title: 'Message the family about missing database form',
      }),
    ]));

    const missions = await jsonOf(await get('/api/mission/tasks'));
    expect(missions.tasks.map((task: any) => task.title)).not.toContain('Message the family about missing database form');
  });

  it('auto-routes technical message database failures', async () => {
    upsertAttentionItem({
      sourceKind: 'brief',
      sourceId: 'brief-message-db',
      sourceKey: 'brief:brief-message-db:message-db',
      title: 'Message database error',
      detail: 'Message database error: inbox digest unavailable.',
      severity: 'high',
      href: '/home',
    });

    const attention = await jsonOf(await get('/api/home/attention'));
    const routed = attention.items.find((item: any) => item.title === 'Message database error');
    expect(routed).toBeDefined();
    expect(routed.workStatus).not.toBe('new');

    const missions = await jsonOf(await get('/api/mission/tasks'));
    expect(missions.tasks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        title: 'Message database error',
        assigned_agent: 'mason',
        created_by: 'autofix',
      }),
    ]));
  });

  it('auto-routes system fix recommendations from briefs without explicit no-user metadata', async () => {
    upsertAttentionItem({
      sourceKind: 'brief',
      sourceId: 'brief-ob1-health',
      sourceKey: 'brief:brief-ob1-health:ob1-health',
      title: 'Other brief',
      detail: '[ob1-brain-health]: monitor-brain returned exit 2. Issue: 2 upstream jsonl file(s) modified in last 4h but 0 thoughts ingested. Fix recommendation: inspect brain-watcher ingestion path and upstream jsonl processing.',
      severity: 'high',
      href: '/home',
    });

    const attention = await jsonOf(await get('/api/home/attention'));
    const routed = attention.items.find((item: any) => /monitor-brain returned exit 2/.test(item.detail));
    expect(routed).toBeDefined();
    expect(routed.workStatus).not.toBe('new');

    const missions = await jsonOf(await get('/api/mission/tasks'));
    expect(missions.tasks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        assigned_agent: 'mason',
        created_by: 'autofix',
        prompt: expect.stringContaining('brain-watcher ingestion path'),
      }),
    ]));
  });

  it('auto-routes plain technical brief failures without explicit no-user metadata', async () => {
    upsertAttentionItem({
      sourceKind: 'brief',
      sourceId: 'brief-imessage-db',
      sourceKey: 'brief:brief-imessage-db:imessage-db',
      title: 'iMessages: Database error (unable to check)',
      detail: 'iMessages: Database error (unable to check).',
      severity: 'medium',
      href: '/home',
    });

    const attention = await jsonOf(await get('/api/home/attention'));
    const routed = attention.items.find((item: any) => item.title === 'iMessages: Database error (unable to check)');
    expect(routed).toBeDefined();
    expect(routed.workStatus).not.toBe('new');

    const missions = await jsonOf(await get('/api/mission/tasks'));
    expect(missions.tasks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        title: 'iMessages: Database error (unable to check)',
        assigned_agent: 'mason',
        created_by: 'autofix',
      }),
    ]));
  });

  it('keeps system-looking brief items when they explicitly need user', async () => {
    upsertAttentionItem({
      sourceKind: 'brief',
      sourceId: 'brief-ob1-human',
      sourceKey: 'brief:brief-ob1-human:ob1-health',
      title: 'Other brief',
      detail: '[ob1-brain-health]: monitor-brain returned exit 2. Requires user: yes. user to inspect the source export before ingestion is retried.',
      severity: 'high',
      href: '/home',
    });

    const attention = await jsonOf(await get('/api/home/attention'));
    expect(attention.items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        title: '[ob1-brain-health]: monitor-brain returned exit 2',
        detail: expect.stringContaining('Requires user: yes'),
      }),
    ]));
  });

  it('does not route normal human-owned brief recommendations just because they say fix recommendation', async () => {
    upsertAttentionItem({
      sourceKind: 'brief',
      sourceId: 'brief-human-reply',
      sourceKey: 'brief:brief-human-reply:reply',
      title: 'Morning brief',
      detail: 'Fix recommendation: user to reply to Lucas contact form before Ember drafts the follow-up.',
      severity: 'medium',
      href: '/home',
    });

    const attention = await jsonOf(await get('/api/home/attention'));
    expect(attention.items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        title: 'Fix recommendation: user to reply to Lucas contact form before Ember drafts the follow-up',
        detail: expect.stringContaining('user to reply to Lucas'),
      }),
    ]));
  });

  it('auto-routes terminal mission failures into a linked review follow-up', async () => {
    createMissionTask('m-autofix-terminal', 'Fix frontend build failure', 'fix build', 'mason', 'dashboard', 8);
    completeMissionTask('m-autofix-terminal', null, 'failed', 'TypeScript build failed: missing dependency.');

    const attention = await jsonOf(await get('/api/home/attention'));
    const routed = attention.items.find((item: any) => item.title === 'Fix frontend build failure');
    expect(routed).toBeDefined();
    expect(routed.workStatus).not.toBe('new');

    const review = getMissionReview('m-autofix-terminal');
    expect(review).toMatchObject({
      review_status: 'waiting_followup',
      resolution: 'delegated',
    });
    expect(review?.followup_task_id).toBeTruthy();

    const followup = getMissionTask(review!.followup_task_id!);
    expect(followup).toMatchObject({
      assigned_agent: 'mason',
      created_by: 'autofix',
      status: 'queued',
    });
    expect(followup?.prompt).toContain('Auto-routed Needs Attention item.');
    expect(getAttentionItemBySourceKey('mission:m-autofix-terminal:terminal')).toMatchObject({
      status: 'assigned',
      linked_mission_id: review?.followup_task_id,
    });

    await get('/api/home/attention');
    const missions = await jsonOf(await get('/api/mission/tasks'));
    expect(missions.tasks.filter((task: any) => task.created_by === 'autofix' && task.prompt.includes('m-autofix-terminal'))).toHaveLength(1);
  });

  it('promotes auth and unavailable failures from briefs into durable attention items', async () => {
    const now = Math.floor(Date.now() / 1000);
    createScheduledTask('brief-auth', 'Morning brief', '0 9 * * *', now + 3600, 'main');
    updateTaskAfterRun(
      'brief-auth',
      now + 86400,
      [
        '**Microsoft Graph auth expired**',
        'Calendar, email, and tasks unavailable. The MS app consent lapsed. Need to re-auth the your Microsoft app app.',
      ].join('\n'),
      'success',
    );

    const res = await get('/api/home/attention');
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    const details = body.items.map((item: any) => item.detail);
    expect(details).toContain('Microsoft Graph auth expired');
    expect(details).toContain('Calendar, email, and tasks unavailable. The MS app consent lapsed. Need to re-auth the your Microsoft app app.');
    expect(body.items.filter((item: any) => item.source === 'brief').every((item: any) => item.id.startsWith('attention:'))).toBe(true);
  });

  it('uses the script filename as the auto-routed mission title for failed command schedules', async () => {
    const now = Math.floor(Date.now() / 1000);
    createScheduledTask(
      'schedule-command-title',
      'Execute exactly: python3 ~/workspace/operations/engine-room/skills/msgraph/route_remittances.py',
      '*/30 * * * *',
      now + 3600,
      'main',
    );
    updateTaskAfterRun('schedule-command-title', now + 86400, 'Shell command exit 1', 'failed');

    const res = await get('/api/home/attention');
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    const routed = body.items.find((item: any) => item.id === 'schedule:schedule-command-title:last-status');
    expect(routed).toBeDefined();
    expect(routed.workStatus).not.toBe('new');
    const missions = await jsonOf(await get('/api/mission/tasks'));
    expect(missions.tasks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        title: 'route remittances',
        assigned_agent: 'mason',
        created_by: 'autofix',
      }),
    ]));
  });

  it('background auto-fix materializes and routes failed command schedules without opening Home first', async () => {
    const now = Math.floor(Date.now() / 1000);
    createScheduledTask(
      'schedule-background-command',
      'Execute exactly: python3 ~/workspace/operations/engine-room/skills/msgraph/route_remittances.py',
      '*/30 * * * *',
      now + 3600,
      'main',
    );
    updateTaskAfterRun('schedule-background-command', now + 86400, 'Shell command exit 1', 'failed');

    const result = runAttentionAutofixSweep(50);
    expect(result.routed).toBe(1);

    const missions = await jsonOf(await get('/api/mission/tasks'));
    expect(missions.tasks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        title: 'route remittances',
        assigned_agent: 'mason',
        created_by: 'autofix',
      }),
    ]));
  });

  it('does not duplicate auto-fix missions when a schedule is stuck with an old failed status', async () => {
    const now = Math.floor(Date.now() / 1000);
    createScheduledTask(
      'schedule-stuck-and-failed',
      'Execute exactly: python3 ~/workspace/operations/engine-room/skills/msgraph/route_remittances.py',
      '*/30 * * * *',
      now + 3600,
      'main',
    );
    updateTaskAfterRun('schedule-stuck-and-failed', now + 86400, 'Shell command exit 1', 'failed');
    markTaskRunning('schedule-stuck-and-failed');

    const result = runAttentionAutofixSweep(50);
    expect(result.routed).toBe(1);

    const missions = await jsonOf(await get('/api/mission/tasks'));
    expect(missions.tasks.filter((task: any) => (
      task.created_by === 'autofix'
      && task.prompt.includes('schedule-stuck-and-failed')
    ))).toHaveLength(1);
  });

  it('resolves a mission attention item by updating the source mission', async () => {
    createMissionTask('m-home-resolve', 'Resolve from Home', 'queued work', 'comms', 'dashboard', 7);

    const complete = await app.request('/api/home/attention/resolve' + Q, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ itemId: 'mission:m-home-resolve', action: 'complete' }),
    });
    expect(complete.status).toBe(200);
    expect(getMissionTask('m-home-resolve')?.status).toBe('completed');

    const res = await get('/api/home/attention');
    const body = await jsonOf(res);
    expect(body.items.map((item: any) => item.id)).not.toContain('mission:m-home-resolve');
  });

  it('assigns a report attention item into Mission Queue and removes it from Needs Attention', async () => {
    const now = Math.floor(Date.now() / 1000);
    createScheduledTask('brief-action-onramp', 'Morning brief', '0 9 * * *', now + 3600, 'main');
    updateTaskAfterRun('brief-action-onramp', now + 86400, 'Action needed: Draft Lucas inquiry response', 'success');

    const before = await jsonOf(await get('/api/home/attention'));
    const item = before.items.find((entry: any) => entry.detail.includes('Draft Lucas inquiry response'));
    expect(item).toMatchObject({ id: expect.stringMatching(/^attention:/), source: 'brief' });

    const assign = await app.request('/api/home/attention/assign' + Q, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ itemId: item.id, agentId: 'main', instruction: 'Prioritise the Lucas contact form and draft a direct reply.' }),
    });
    expect(assign.status).toBe(201);

    const after = await jsonOf(await get('/api/home/attention'));
    const stillThere = after.items.find((entry: any) => entry.id === item.id);
    expect(stillThere).toBeDefined();
    expect(stillThere.workStatus).not.toBe('new');

    const missions = await jsonOf(await get('/api/mission/tasks'));
    expect(missions.tasks.map((task: any) => task.title)).toContain('Draft Lucas inquiry response');
    const created = missions.tasks.find((task: any) => task.title === 'Draft Lucas inquiry response');
    expect(created.prompt).toContain('Additional instructions from user');
    expect(created.prompt).toContain('Prioritise the Lucas contact form');
  });

  it('carries steering instructions when assigning a scheduled attention item', async () => {
    const now = Math.floor(Date.now() / 1000);
    createScheduledTask('schedule-steering', 'Run a full workspace health audit', '0 * * * *', now - 3600, 'warden');
    updateTaskAfterRun('schedule-steering', now + 3600, 'Requires user: yes. Credential drift needs review before retry.', 'failed');

    const before = await jsonOf(await get('/api/home/attention'));
    const item = before.items.find((entry: any) => entry.id === 'schedule:schedule-steering:last-status');
    expect(item).toMatchObject({ source: 'schedule' });

    const assign = await app.request('/api/home/attention/assign' + Q, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ itemId: item.id, agentId: 'warden', instruction: 'Check Graph auth before retrying the audit.' }),
    });
    expect(assign.status).toBe(201);
    const body = await jsonOf(assign);
    const created = getMissionTask(body.task.id);
    expect(created?.prompt).toContain('Additional instructions from user');
    expect(created?.prompt).toContain('Check Graph auth before retrying');
  });

  it('archives a report attention item durably so the same report text does not resurface', async () => {
    const now = Math.floor(Date.now() / 1000);
    createScheduledTask('brief-action-archive', 'Morning brief', '0 9 * * *', now + 3600, 'main');
    updateTaskAfterRun('brief-action-archive', now + 86400, 'Action needed: Review CA-10 restrictive practices', 'success');

    const before = await jsonOf(await get('/api/home/attention'));
    const item = before.items.find((entry: any) => entry.detail.includes('Review CA-10'));
    expect(item?.id).toMatch(/^attention:/);

    const archive = await app.request('/api/home/attention/resolve' + Q, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ itemId: item.id, action: 'archive' }),
    });
    expect(archive.status).toBe(200);

    const after = await jsonOf(await get('/api/home/attention'));
    expect(after.items.map((entry: any) => entry.id)).not.toContain(item.id);
  });

  it('archives a mission attention item by updating review state at the source', async () => {
    createMissionTask('m-home-archive', 'Archive from Home', 'partial work', 'mason', 'dashboard', 7);
    completeMissionTask('m-home-archive', 'Partial output.', 'partial');

    const archive = await app.request('/api/home/attention/resolve' + Q, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ itemId: 'mission:m-home-archive:terminal', action: 'archive' }),
    });
    expect(archive.status).toBe(200);
    expect(getMissionReview('m-home-archive')?.review_status).toBe('archived');

    const res = await get('/api/home/attention');
    const body = await jsonOf(res);
    expect(body.items.map((item: any) => item.id)).not.toContain('mission:m-home-archive:terminal');
  });

  it('does not promote markdown section headings as attention items', async () => {
    const now = Math.floor(Date.now() / 1000);
    createScheduledTask('brief-headings', 'Morning brief', '0 9 * * *', now + 3600, 'main');
    updateTaskAfterRun(
      'brief-headings',
      now + 86400,
      ['**Action needed:**', '- Actual action needed: review CA-10 today', '**Blocked on you:**'].join('\n'),
      'success',
    );

    const res = await get('/api/home/attention');
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    const details = body.items.map((item: any) => item.detail);
    expect(details).toContain('Actual action needed: review CA-10 today');
    expect(details).not.toContain('Action needed:');
    expect(details).not.toContain('Blocked on you:');
  });

  it('does not promote explicit none lines from briefs as attention items', async () => {
    const now = Math.floor(Date.now() / 1000);
    createScheduledTask('brief-none-lines', 'Morning brief', '0 9 * * *', now + 3600, 'main');
    updateTaskAfterRun(
      'brief-none-lines',
      now + 86400,
      [
        '**Overdue:** None.',
        '**Risks:** no urgent blockers.',
        '- Actual follow-up: Lucas form submission has not been actioned.',
      ].join('\n'),
      'success',
    );

    const res = await get('/api/home/attention');
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    const details = body.items.map((item: any) => item.detail);
    expect(details).toContain('Actual follow-up: Lucas form submission has not been actioned.');
    expect(details).not.toContain('Overdue: None.');
    expect(details).not.toContain('Risks: no urgent blockers.');
  });

  it('does not promote scoped none lines from briefs as attention items', async () => {
    const now = Math.floor(Date.now() / 1000);
    createScheduledTask('brief-scoped-none-lines', 'Mid-day pulse', '30 12 * * *', now + 3600, 'main');
    updateTaskAfterRun(
      'brief-scoped-none-lines',
      now + 86400,
      [
        'Overdue reminders: None.',
        'Web forms: No urgent forms.',
        'Calendar: No action items.',
      ].join('\n'),
      'success',
    );

    const res = await get('/api/home/attention');
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    const details = body.items.map((item: any) => item.detail);
    expect(details).not.toContain('Overdue reminders: None.');
    expect(details).not.toContain('Web forms: No urgent forms.');
    expect(details).not.toContain('Calendar: No action items.');
  });

  it('keeps actionable text after scoped none clauses on the same brief line', async () => {
    const now = Math.floor(Date.now() / 1000);
    createScheduledTask('brief-mixed-scoped-none-line', 'Mid-day pulse', '30 12 * * *', now + 3600, 'main');
    updateTaskAfterRun(
      'brief-mixed-scoped-none-line',
      now + 86400,
      'Calendar: No action items. CalDAV unavailable; re-auth failed.',
      'success',
    );

    const res = await get('/api/home/attention');
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body.items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        title: 'CalDAV unavailable; re-auth failed',
        detail: expect.stringContaining('CalDAV unavailable'),
      }),
    ]));
  });

  it('archives stale brief attention rows when the current extraction changes', async () => {
    const now = Math.floor(Date.now() / 1000);
    createScheduledTask('brief-stale-cleanup', 'Mid-day pulse', '0 12 * * *', now + 3600, 'main');
    updateTaskAfterRun(
      'brief-stale-cleanup',
      now + 86400,
      '**Overdue:** None.\n**Inbox:** No K-tagged unread. One form submission from Lucas Riguccini (April 29) on contact form - hasn\'t been actioned.',
      'success',
    );

    const first = await jsonOf(await get('/api/home/attention'));
    expect(first.items.map((item: any) => item.detail)).toContain('One form submission from Lucas Riguccini (April 29) on contact form - hasn\'t been actioned.');
    expect(first.items.map((item: any) => item.detail)).not.toContain('Overdue: None.');

    updateTaskAfterRun(
      'brief-stale-cleanup',
      now + 90000,
      '**Inbox:** No K-tagged unread.\n**Overdue:** None.',
      'success',
    );
    const second = await jsonOf(await get('/api/home/attention'));
    expect(second.items.map((item: any) => item.detail)).not.toContain('One form submission from Lucas Riguccini (April 29) on contact form - hasn\'t been actioned.');
    expect(second.items.map((item: any) => item.detail)).not.toContain('Overdue: None.');
  });

  it('keeps report items out of Needs Attention once matching mission work exists', async () => {
    const now = Math.floor(Date.now() / 1000);
    createScheduledTask('brief-covered', 'Morning brief', '0 9 * * *', now + 3600, 'main');
    updateTaskAfterRun(
      'brief-covered',
      now + 86400,
      [
        'Scripts unavailable (missing `caldav` module). Fix needed.',
        'Digest unavailable (database access error). Fix needed.',
        'CA-05 Support Plans personalised (overdue since 12 Apr)',
      ].join('\n'),
      'success',
    );
    createMissionTask('m-reminders', 'Fix Reminders CalDAV auth', 'fix reminders', 'warden', 'dashboard', 8);
    createMissionTask('m-imessage', 'Fix iMessage digest access', 'fix imessage', 'warden', 'dashboard', 8);
    createMissionTask('m-ca05', 'CA-05 support plans recovery', 'fix ca05', 'charter', 'dashboard', 9);

    const res = await get('/api/home/attention');
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    const details = body.items.map((item: any) => item.detail);
    expect(details).not.toContain('Scripts unavailable (missing `caldav` module). Fix needed.');
    expect(details).not.toContain('Digest unavailable (database access error). Fix needed.');
    expect(details).not.toContain('CA-05 Support Plans personalised (overdue since 12 Apr)');
    expect(body.items.map((item: any) => item.title)).not.toEqual(expect.arrayContaining([
      'Fix Reminders CalDAV auth',
      'Fix iMessage digest access',
      'CA-05 support plans recovery',
    ]));

    const missions = await jsonOf(await get('/api/mission/tasks'));
    expect(missions.tasks.map((task: any) => task.title)).toEqual(expect.arrayContaining([
      'Fix Reminders CalDAV auth',
      'Fix iMessage digest access',
      'CA-05 support plans recovery',
    ]));
  });

  it('does not hide fresh brief actions behind old terminal missions', async () => {
    const now = Math.floor(Date.now() / 1000);
    createScheduledTask('brief-old-terminal-cover', 'Morning brief', '0 9 * * *', now + 3600, 'main');
    updateTaskAfterRun(
      'brief-old-terminal-cover',
      now + 86400,
      'Scripts unavailable (missing `caldav` module). Requires user: yes. user to inspect the Reminders account permission before retrying.',
      'success',
    );
    createMissionTask('m-old-reminders', 'Fix Reminders CalDAV auth', 'fix reminders', 'warden', 'dashboard', 8);
    completeMissionTask('m-old-reminders', null, 'failed', 'old failure');

    const res = await get('/api/home/attention');
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body.items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        title: 'Scripts unavailable (missing `caldav` module)',
        detail: expect.stringContaining('Requires user: yes'),
      }),
    ]));
  });

  it('adds origin metadata to transient mission attention rows', async () => {
    createMissionTask('m-unassigned-origin', 'Unassigned mission needing dispatch', 'do work', null, 'dashboard', 5);

    const res = await get('/api/home/attention');
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body.items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'mission:m-unassigned-origin',
        source: 'mission',
        origin: 'Mission Control / unassigned',
        title: 'Unassigned mission needing dispatch',
      }),
    ]));
  });

  it('keeps completed missions visible when their result says a manual fix is still required', async () => {
    const now = Math.floor(Date.now() / 1000);
    createMissionTask('m-auth', 'Fix Reminders CalDAV auth', 'fix auth', 'warden', 'dashboard', 8);
    const { completeMissionTask } = await import('./db.js');
    completeMissionTask('m-auth', 'Root cause: App-specific password is invalid. Manual refresh required.', 'completed');

    const res = await get('/api/home/attention');
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body.items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        title: 'Fix Reminders CalDAV auth',
        detail: expect.stringContaining('App-specific password'),
        createdAt: expect.any(Number),
      }),
    ]));
    expect(body.items.find((item: any) => item.title === 'Fix Reminders CalDAV auth').createdAt).toBeGreaterThanOrEqual(now);
  });

  it('suppresses completed diagnosis items and duplicate follow-ups once an active follow-up exists', async () => {
    createMissionTask('m-imessage-diagnosis', 'Fix iMessage digest access', 'diagnose imessage', 'warden', 'dashboard', 8);
    completeMissionTask('m-imessage-diagnosis', 'Root cause: Full Disk Access permission required.', 'completed');
    createMissionTask(
      'm-imessage-follow-1',
      'Follow up: Fix iMessage digest access',
      'Needs Attention item from Home dashboard.\nSource mission: m-imessage-diagnosis',
      'mason',
      'dashboard',
      6,
    );
    createMissionTask(
      'm-imessage-follow-2',
      'Follow up: Fix iMessage digest access',
      'Needs Attention item from Home dashboard.\nSource mission: m-imessage-diagnosis',
      'mason',
      'dashboard',
      6,
    );
    completeMissionTask('m-imessage-follow-2', 'Follow-up deliverable landed for review.', 'completed');

    const res = await get('/api/home/attention');
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    const titles = body.items.map((item: any) => item.title);
    expect(titles.filter((title: string) => title === 'Fix iMessage digest access')).toHaveLength(0);
    expect(titles.filter((title: string) => title === 'Follow up: Fix iMessage digest access')).toHaveLength(0);
  });

  it('does not surface old dev completed missions just because their result contains critical review text', async () => {
    createMissionTask('m-dev-critical', 'Stream2-M2: full-chain integration tests', 'dev work', 'mason', 'dashboard', 5);
    const { completeMissionTask } = await import('./db.js');
    completeMissionTask('m-dev-critical', 'CRITICAL #1 fixed: test harness issue closed.', 'completed');

    const res = await get('/api/home/attention');
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body.items.map((item: any) => item.title)).not.toContain('Stream2-M2: full-chain integration tests');
  });

  it('keeps Home calendar personal-only while the external calendar is unwired', async () => {
    const now = Math.floor(Date.now() / 1000);
    createScheduledTask('agenda-1', 'Run: scripts/daily-brief.sh', '0 9 * * *', now + 1800, 'main');

    const res = await get('/api/home/agenda');
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body).toMatchObject({
      updatedAt: expect.any(String),
      externalCalendar: expect.objectContaining({
        connected: false,
        note: expect.any(String),
      }),
      items: expect.any(Array),
    });
    expect(body.items).toEqual([]);
  });
});

describe('GET /api/tasks (scheduled)', () => {
  it('returns { tasks: [] }', async () => {
    const res = await get('/api/tasks');
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body).toMatchObject({ tasks: expect.any(Array) });
  });

  it('updates scheduled task prompt, cron, and agent assignment', async () => {
    createScheduledTask('sched-edit-contract', 'Old prompt', '0 9 * * *', 1000, 'main');
    const res = await app.request('/api/tasks/sched-edit-contract' + Q, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        prompt: 'Updated prompt',
        schedule: '0 8 * * 1-5',
        agent_id: 'main',
      }),
    });
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body.task).toMatchObject({
      id: 'sched-edit-contract',
      prompt: 'Updated prompt',
      schedule: '0 8 * * 1-5',
      agent_id: 'main',
    });
    const saved = getAllScheduledTasks().find((task) => task.id === 'sched-edit-contract');
    expect(saved?.prompt).toBe('Updated prompt');
    expect(saved?.next_run).toBeGreaterThan(1000);
  });

  it('rejects invalid scheduled task cron edits', async () => {
    createScheduledTask('sched-bad-cron-contract', 'Prompt', '0 9 * * *', 1000, 'main');
    const res = await app.request('/api/tasks/sched-bad-cron-contract' + Q, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ schedule: 'bad cron' }),
    });
    expect(res.status).toBe(400);
    expect(await jsonOf(res)).toMatchObject({ ok: false });
  });
});

describe('GET /api/mission/tasks', () => {
  it('returns { tasks: [] }', async () => {
    const res = await get('/api/mission/tasks');
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body).toMatchObject({ tasks: expect.any(Array) });
  });

  it('accepts ?agent and ?status filters', async () => {
    const res = await get('/api/mission/tasks?agent=main&status=queued');
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body.tasks).toBeInstanceOf(Array);
  });
});

describe('GET /api/mission/history', () => {
  it('returns paginated { tasks, total }', async () => {
    const res = await get('/api/mission/history?limit=5&offset=0');
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body).toMatchObject({
      tasks: expect.any(Array),
      total: expect.any(Number),
    });
  });
});

describe('GET /api/agents/:id/avatar', () => {
  it('serves bundled main avatar with cache headers', async () => {
    const res = await get('/api/agents/main/avatar');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('image/png');
    expect(res.headers.get('etag')).toContain('W/');
  });

  it('returns JSON for invalid avatar ids', async () => {
    const res = await get('/api/agents/bad.agent/avatar');
    expect(res.status).toBe(400);
    expect(await jsonOf(res)).toMatchObject({ error: 'invalid id' });
  });

  it('returns JSON when avatar agent does not exist', async () => {
    const res = await get('/api/agents/not-real-agent/avatar');
    expect(res.status).toBe(404);
    expect(await jsonOf(res)).toMatchObject({ error: 'agent not found' });
  });
});

describe('GET /api/review/inbox', () => {
  it('smoke-tests the mission loop: clean completion, real deliverable, and failure routing', async () => {
    const deliverablePath = '/tmp/claudeclaw-loop-smoke-deliverable.md';
    fs.writeFileSync(deliverablePath, '# Smoke deliverable\n\nActual file worked on.\n', { mode: 0o600 });

    createMissionTask('m-loop-clean', 'Clean loop smoke', 'do a small check', 'mason', 'main', 3);
    completeMissionTask('m-loop-clean', 'Completed cleanly. No deliverable and no human action required.', 'completed');

    createMissionTask('m-loop-deliverable', 'Deliverable loop smoke', 'produce a document', 'charter', 'main', 6);
    completeMissionTask('m-loop-deliverable', `Deliverable: ${deliverablePath}\nReady for review.`, 'completed');

    createMissionTask('m-loop-failed', 'Failed loop smoke', 'fail intentionally', 'mason', 'main', 8);
    completeMissionTask('m-loop-failed', null, 'failed', 'Intentional smoke failure.');

    const reviewBody = await jsonOf(await get('/api/review/inbox?limit=50'));
    const clean = reviewBody.items.find((entry: any) => entry.id === 'm-loop-clean');
    const deliverable = reviewBody.items.find((entry: any) => entry.id === 'm-loop-deliverable');
    const failed = reviewBody.items.find((entry: any) => entry.id === 'm-loop-failed');

    expect(clean).toMatchObject({ kind: 'sorted' });
    expect(deliverable).toMatchObject({
      kind: 'needs_action',
      review: expect.objectContaining({ status: 'needs_review' }),
      deliverables: expect.arrayContaining([
        expect.objectContaining({ kind: 'file', target: fs.realpathSync(deliverablePath) }),
      ]),
    });
    expect(failed).toMatchObject({
      kind: 'needs_action',
      status: 'failed',
      review: expect.objectContaining({ status: 'needs_triage' }),
    });

    const attentionBody = await jsonOf(await get('/api/home/attention'));
    expect(attentionBody.items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: expect.stringMatching(/^attention:/),
        source: 'mission',
        title: 'Failed loop smoke',
        href: '/review?task=m-loop-failed',
      }),
    ]));
  });

  it('materializes terminal review state and prevents unresolved cleanup loss', async () => {
    const old = Math.floor(Date.now() / 1000) - 10 * 86400;
    createMissionTask('m-durable-failed-loop', 'Durable failed loop', 'fail', 'mason', 'main', 8);
    completeMissionTask('m-durable-failed-loop', null, 'failed', 'Durable blocker.');
    _setMissionCompletedAtForTest('m-durable-failed-loop', old, 'failed');

    expect(getMissionReview('m-durable-failed-loop')).toMatchObject({ review_status: 'needs_triage' });
    expect(cleanupOldMissionTasks(7)).toBe(0);
    expect(getMissionTask('m-durable-failed-loop')).not.toBeNull();

    const approve = await app.request('/api/review/tasks/m-durable-failed-loop/approve' + Q, { method: 'POST' });
    expect(approve.status).toBe(200);
    expect(cleanupOldMissionTasks(7)).toBe(1);
    expect(getMissionTask('m-durable-failed-loop')).toBeNull();
  });

  it('lets Mission Control append steering instructions without reassigning', async () => {
    createMissionTask('m-steer', 'Steerable mission', 'Original prompt', 'mason', 'dashboard', 5);
    const res = await app.request('/api/mission/tasks/m-steer' + Q, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ instruction: 'Use the smaller scope and report blockers first.' }),
    });
    expect(res.status).toBe(200);
    expect(getMissionTask('m-steer')?.prompt).toContain('Additional instructions from user:');
    expect(getMissionTask('m-steer')?.prompt).toContain('Use the smaller scope');
  });

  it('does not archive review or attention state when deleting a nonterminal mission fails', async () => {
    createMissionTask('m-delete-queued-guard', 'Queued guard', 'do work', 'mason', 'dashboard', 5);
    upsertMissionReview({ taskId: 'm-delete-queued-guard', reviewStatus: 'needs_triage', resolution: null });
    upsertAttentionItem({
      sourceKind: 'mission',
      sourceId: 'm-delete-queued-guard',
      sourceKey: 'mission:m-delete-queued-guard:terminal',
      title: 'Queued guard',
      detail: 'Still active.',
      severity: 'medium',
      href: '/review?task=m-delete-queued-guard',
    });

    const res = await app.request('/api/mission/tasks/m-delete-queued-guard' + Q, { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(await jsonOf(res)).toMatchObject({ ok: false });
    expect(getMissionTask('m-delete-queued-guard')).not.toBeNull();
    expect(getMissionReview('m-delete-queued-guard')).toMatchObject({ review_status: 'needs_triage' });
    expect(getAttentionItemBySourceKey('mission:m-delete-queued-guard:terminal')).toMatchObject({ status: 'open' });
  });

  it('keeps old failed and partial missions in durable Needs Attention until reviewed', async () => {
    const old = Math.floor(Date.now() / 1000) - 48 * 3600;
    createMissionTask('m-old-failed-loop', 'Old failed loop', 'fail', 'mason', 'main', 8);
    completeMissionTask('m-old-failed-loop', null, 'failed', 'Old failure still needs triage.');
    _setMissionCompletedAtForTest('m-old-failed-loop', old, 'failed');

    createMissionTask('m-old-partial-loop', 'Old partial loop', 'partial', 'mason', 'main', 7);
    completeMissionTask('m-old-partial-loop', 'Partial work landed. Blocked: needs exact source file.', 'partial');
    _setMissionCompletedAtForTest('m-old-partial-loop', old, 'partial');

    const attentionBody = await jsonOf(await get('/api/home/attention'));
    expect(attentionBody.items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: expect.stringMatching(/^attention:/),
        source: 'mission',
        title: 'Old failed loop',
        severity: 'high',
        detail: expect.stringContaining('Old failure still needs triage'),
        href: '/review?task=m-old-failed-loop',
      }),
      expect.objectContaining({
        id: expect.stringMatching(/^attention:/),
        source: 'mission',
        title: 'Old partial loop',
        severity: 'medium',
        href: '/review?task=m-old-partial-loop',
      }),
    ]));
  });

  it('archives terminal mission attention when the source review is resolved', async () => {
    createMissionTask('m-resolved-failed-loop', 'Resolved failed loop', 'fail', 'mason', 'main', 8);
    completeMissionTask('m-resolved-failed-loop', null, 'failed', 'Transient failure.');

    const before = await jsonOf(await get('/api/home/attention'));
    expect(before.items.map((item: any) => item.title)).toContain('Resolved failed loop');

    await app.request('/api/review/tasks/m-resolved-failed-loop/archive' + Q, { method: 'POST' });
    const after = await jsonOf(await get('/api/home/attention'));
    expect(after.items.map((item: any) => item.title)).not.toContain('Resolved failed loop');
  });

  it('returns completed mission deliverables for review', async () => {
    fs.writeFileSync('/tmp/review-deliverable.txt', 'Review deliverable body\n', { mode: 0o600 });
    createMissionTask('m-review-1', 'Write Charter deliverable', 'produce output', 'charter', 'dashboard', 6);
    completeMissionTask('m-review-1', 'Review pack prepared at /tmp/review-deliverable.txt for review.', 'completed');

    const res = await get('/api/review/inbox?limit=10');
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body).toMatchObject({
      updatedAt: expect.any(String),
      total: expect.any(Number),
      openTotal: expect.any(Number),
      items: expect.any(Array),
      exportEmailConfigured: expect.any(Boolean),
    });
    expect(body.items[0]).toMatchObject({
      id: 'm-review-1',
      title: 'Write Charter deliverable',
      status: 'completed',
      manifest: expect.objectContaining({
        route: 'needs_review',
        deliverables: expect.any(Array),
        nextAction: expect.any(String),
      }),
      review: expect.objectContaining({ status: 'needs_review' }),
      deliverables: expect.any(Array),
    });
    expect(getMissionManifest(getMissionTask('m-review-1')!)).toMatchObject({
      route: 'needs_review',
      deliverables: expect.arrayContaining([
        expect.objectContaining({ kind: 'file', target: '/tmp/review-deliverable.txt', exists: true }),
      ]),
    });
  });

  it('routes completed missions with missing deliverable files to triage', async () => {
    createMissionTask('m-missing-deliverable', 'Missing file deliverable', 'produce output', 'charter', 'dashboard', 6);
    completeMissionTask('m-missing-deliverable', 'Deliverable: /tmp/claudeclaw-missing-review-file.pdf\nReady for review.', 'completed');

    const res = await get('/api/review/inbox?limit=20');
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    const item = body.items.find((entry: any) => entry.id === 'm-missing-deliverable');
    expect(item).toMatchObject({
      kind: 'needs_action',
      manifest: expect.objectContaining({
        route: 'needs_triage',
        nextAction: 'Fix or provide the missing deliverable path.',
        blockers: expect.arrayContaining([
          'Deliverable file not found: /tmp/claudeclaw-missing-review-file.pdf',
        ]),
      }),
      review: expect.objectContaining({ status: 'needs_triage' }),
    });
  });

  it('does not show routine completed dev history in the review inbox', async () => {
    createMissionTask('m-dev-history', 'Build internal dashboard route', 'code task', 'mason', 'dashboard', 4);
    completeMissionTask('m-dev-history', 'Mission complete. Tests passed and commit landed.', 'completed');

    const res = await get('/api/review/inbox?limit=10');
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body.items.map((item: any) => item.id)).not.toContain('m-dev-history');
  });

  it('does not route dev work to review just because the prompt says deliverable', async () => {
    createMissionTask('m-dev-deliverable-word', 'Build deliverable manifest parser', 'Implement deliverable manifest routing internals', 'mason', 'dashboard', 4);
    completeMissionTask('m-dev-deliverable-word', 'Mission complete. Tests passed and commit landed.', 'completed');

    const res = await get('/api/review/inbox?limit=10');
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body.items.map((item: any) => item.id)).not.toContain('m-dev-deliverable-word');
    expect(getMissionManifest(getMissionTask('m-dev-deliverable-word')!)).toMatchObject({ route: 'sorted' });
  });

  it('does not treat generic Codex review wording as a user review decision', async () => {
    createMissionTask('m-codex-review-history', 'Close Codex review findings', 'address Codex review notes', 'mason', 'dashboard', 4);
    completeMissionTask('m-codex-review-history', 'Codex review fixes landed and tests passed.', 'completed');

    const res = await get('/api/review/inbox?limit=10');
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body.items.map((item: any) => item.id)).not.toContain('m-codex-review-history');
  });

  it('does not show completed Mason work just because it mentions user in the result', async () => {
    createMissionTask('m-mason-ruan-history', 'Build internal thing', 'do code work', 'mason', 'dashboard', 4);
    completeMissionTask('m-mason-ruan-history', 'Done. user can inspect the commit later if needed.', 'completed');

    const res = await get('/api/review/inbox?limit=10');
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body.items.map((item: any) => item.id)).not.toContain('m-mason-ruan-history');
  });

  it('creates a child mission with review instructions and moves parent to waiting_followup', async () => {
    createMissionTask('m-review-fail', 'Fix broken thing', 'original prompt', 'mason', 'dashboard', 6);
    completeMissionTask('m-review-fail', null, 'failed', 'TypeError: broke');

    const res = await app.request('/api/review/tasks/m-review-fail/follow-up' + Q, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        assigned_agent: 'mason',
        mode: 'retry',
        instructions: 'Check the failing route first.',
      }),
    });
    expect(res.status).toBe(201);
    const body = await jsonOf(res);
    expect(body).toMatchObject({
      ok: true,
      task: expect.objectContaining({
        title: 'Retry: Fix broken thing',
        assigned_agent: 'mason',
        status: 'queued',
        prompt: expect.stringContaining('Check the failing route first.'),
      }),
      review: expect.objectContaining({
        review_status: 'waiting_followup',
        resolution: 'retried',
      }),
    });
    expect(getMissionReview('m-review-fail')?.followup_task_id).toBe(body.task.id);
    expect(getMissionTask(body.task.id)?.prompt).toContain('Parent mission: m-review-fail');
  });

  it('appends updated instructions when reusing an existing queued follow-up mission', async () => {
    createMissionTask('m-review-reuse-parent', 'Fix reused follow-up', 'original prompt', 'mason', 'dashboard', 6);
    completeMissionTask('m-review-reuse-parent', null, 'failed', 'Initial blocker.');

    const first = await app.request('/api/review/tasks/m-review-reuse-parent/follow-up' + Q, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        assigned_agent: 'mason',
        mode: 'retry',
        instructions: 'First retry instruction.',
      }),
    });
    expect(first.status).toBe(201);
    const firstBody = await jsonOf(first);

    const second = await app.request('/api/review/tasks/m-review-reuse-parent/follow-up' + Q, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        assigned_agent: 'mason',
        mode: 'retry',
        instructions: 'Second steering note before Mason starts.',
      }),
    });
    expect(second.status).toBe(200);
    const secondBody = await jsonOf(second);
    expect(secondBody).toMatchObject({ ok: true, reused: true });
    expect(secondBody.task.id).toBe(firstBody.task.id);
    expect(getMissionTask(firstBody.task.id)?.prompt).toContain('First retry instruction.');
    expect(getMissionTask(firstBody.task.id)?.prompt).toContain('Second steering note before Mason starts.');
  });

  it('surfaces failed missions for triage even without magic action wording', async () => {
    createMissionTask('m-review-generic-fail', 'Generic failed mission', 'try a thing', 'mason', 'mason', 4);
    completeMissionTask('m-review-generic-fail', null, 'failed', 'Something went wrong. Check the logs and try again.');

    const res = await get('/api/review/inbox?limit=50');
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    const item = body.items.find((entry: any) => entry.id === 'm-review-generic-fail');
    expect(item).toBeTruthy();
    expect(item).toMatchObject({
      status: 'failed',
      kind: 'needs_action',
      review: expect.objectContaining({ status: 'needs_triage' }),
    });
  });

  it('prioritises actionable failures so recent sorted history cannot hide them', async () => {
    const nowSpy = vi.spyOn(Date, 'now');
    try {
      nowSpy.mockReturnValue(1_800_000_000_000);
      createMissionTask('m-hidden-failure', 'Hidden failure', 'fail before routine noise', 'mason', 'main', 8);
      completeMissionTask('m-hidden-failure', null, 'failed', 'Actionable failure that still needs triage.');

      for (let i = 0; i < 60; i += 1) {
        nowSpy.mockReturnValue(1_800_000_001_000 + i * 1000);
        createMissionTask(`m-sorted-${i}`, `Sorted completion ${i}`, 'user-requested status check', 'warden', 'main', 1);
        completeMissionTask(`m-sorted-${i}`, 'Completed cleanly. No deliverable and no human action required.', 'completed');
      }
    } finally {
      nowSpy.mockRestore();
    }

    const res = await get('/api/review/inbox?limit=10');
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body.items.map((entry: any) => entry.id)).toContain('m-hidden-failure');
    expect(body.items.find((entry: any) => entry.id === 'm-hidden-failure')).toMatchObject({ kind: 'needs_action' });
    expect(body.total).toBeGreaterThan(10);
  });

  it('approves review items so they leave the default inbox', async () => {
    createMissionTask('m-review-approve', 'Approve me', 'deliver', 'mason', 'dashboard', 6);
    completeMissionTask('m-review-approve', 'Done.', 'completed');

    const approve = await app.request('/api/review/tasks/m-review-approve/approve' + Q, { method: 'POST' });
    expect(approve.status).toBe(200);
    expect(getMissionReview('m-review-approve')?.review_status).toBe('resolved');

    const res = await get('/api/review/inbox?limit=10');
    const body = await jsonOf(res);
    expect(body.items.map((item: any) => item.id)).not.toContain('m-review-approve');
  });

  // ── Three-category surfacing rules (2026-05-06) ───────────────────────
  // A: needs user's action  →  kind='needs_action'
  // B: he asked, it landed  →  kind='sorted'
  // C: agent-to-agent       →  hidden
  it('Category A: surfaces a completed mason mission whose result asks for user to send', async () => {
    createMissionTask('m-cat-a-mason', 'Draft outreach email', 'write email', 'mason', 'main', 5);
    completeMissionTask('m-cat-a-mason', 'Draft ready. Awaiting your review before sending.', 'completed');

    const res = await get('/api/review/inbox?limit=50');
    const body = await jsonOf(res);
    const item = body.items.find((entry: any) => entry.id === 'm-cat-a-mason');
    expect(item).toBeTruthy();
    expect(item.kind).toBe('needs_action');
  });

  it('Category A: surfaces a completed warden mission with manual-action wording', async () => {
    createMissionTask('m-cat-a-warden', 'Reauth Microsoft Graph', 'fix auth', 'warden', 'main', 8);
    completeMissionTask('m-cat-a-warden', 'Manual step required: please grant permission via the consent URL.', 'completed');

    const res = await get('/api/review/inbox?limit=50');
    const body = await jsonOf(res);
    const item = body.items.find((entry: any) => entry.id === 'm-cat-a-warden');
    expect(item).toBeTruthy();
    expect(item.kind).toBe('needs_action');
  });

  it('Category B: surfaces a user-asked completion (created_by=main) as sorted ✓', async () => {
    createMissionTask('m-cat-b-direct', 'Fix the dashboard bug user flagged', 'fix bug', 'mason', 'main', 5);
    completeMissionTask('m-cat-b-direct', 'Done. Bug fixed and tests passed.', 'completed');

    const res = await get('/api/review/inbox?limit=50');
    const body = await jsonOf(res);
    const item = body.items.find((entry: any) => entry.id === 'm-cat-b-direct');
    expect(item).toBeTruthy();
    expect(item.kind).toBe('sorted');
  });

  it('Category B: surfaces a Home-attention follow-up completion as sorted ✓', async () => {
    createMissionTask(
      'm-cat-b-home',
      'Fix Reminders CalDAV',
      'Needs Attention item from Home dashboard.\nSource: brief:morning\nTitle: Fix Reminders CalDAV',
      'warden',
      'dashboard',
      8,
    );
    completeMissionTask('m-cat-b-home', 'Done. CalDAV reauth completed.', 'completed');

    const res = await get('/api/review/inbox?limit=50');
    const body = await jsonOf(res);
    const item = body.items.find((entry: any) => entry.id === 'm-cat-b-home');
    expect(item).toBeTruthy();
    expect(item.kind).toBe('sorted');
  });

  it('Category B: lineage trace — child completion of a user-originated parent is sorted ✓', async () => {
    createMissionTask('m-parent-ruan', 'Original ask from user', 'do thing', 'mason', 'main', 5);
    createMissionTask(
      'm-cat-b-child',
      'Follow up: Original ask from user',
      'Source mission: m-parent-ruan\nReassigned with extra notes.',
      'mason',
      'review-inbox',
      5,
    );
    completeMissionTask('m-cat-b-child', 'Done.', 'completed');

    const res = await get('/api/review/inbox?limit=50');
    const body = await jsonOf(res);
    const item = body.items.find((entry: any) => entry.id === 'm-cat-b-child');
    expect(item).toBeTruthy();
    expect(item.kind).toBe('sorted');
  });

  it('Category C: hides routine agent-to-agent completion with no user-facing breadcrumb', async () => {
    createMissionTask('m-cat-c-internal', 'Refactor internal helper', 'do code work', 'mason', 'mason', 4);
    completeMissionTask('m-cat-c-internal', 'Refactor done. Tests green.', 'completed');

    const res = await get('/api/review/inbox?limit=50');
    const body = await jsonOf(res);
    expect(body.items.map((entry: any) => entry.id)).not.toContain('m-cat-c-internal');
  });

  it('Category C: hides scheduled-task no-op heartbeat completions', async () => {
    createMissionTask('m-cat-c-heartbeat', 'Cron heartbeat', 'tick', 'main', 'scheduler', 1);
    completeMissionTask('m-cat-c-heartbeat', 'OK. No issues detected.', 'completed');

    const res = await get('/api/review/inbox?limit=50');
    const body = await jsonOf(res);
    expect(body.items.map((entry: any) => entry.id)).not.toContain('m-cat-c-heartbeat');
  });

  it('does NOT exclude mason or warden completions with deliverable wording (regression: agent-blocklist removed)', async () => {
    createMissionTask('m-mason-deliverable', 'Build review pack for compliance', 'work', 'mason', 'main', 5);
    completeMissionTask('m-mason-deliverable', 'Review pack prepared at /tmp/pack.pdf for review.', 'completed');

    const res = await get('/api/review/inbox?limit=50');
    const body = await jsonOf(res);
    const ids = body.items.map((entry: any) => entry.id);
    expect(ids).toContain('m-mason-deliverable');
  });

  it('completedMissionHasFollowUp only suppresses when the follow-up is still active', async () => {
    createMissionTask('m-parent-fu', 'Fix reminders', 'fix', 'warden', 'main', 8);
    completeMissionTask('m-parent-fu', 'Manual step required: grant permission.', 'completed');
    createMissionTask(
      'm-followup-done',
      'Follow up: Fix reminders',
      'Source mission: m-parent-fu',
      'mason',
      'dashboard',
      6,
    );
    completeMissionTask('m-followup-done', 'Follow-up done.', 'completed');

    const res = await get('/api/review/inbox?limit=50');
    const body = await jsonOf(res);
    // Parent must remain visible because the follow-up is no longer active.
    expect(body.items.map((entry: any) => entry.id)).toContain('m-parent-fu');
  });

  it('completedMissionHasFollowUp suppresses parent when follow-up is queued/running', async () => {
    createMissionTask('m-parent-active', 'Send compliance pack', 'send', 'charter', 'main', 8);
    completeMissionTask('m-parent-active', 'Awaiting your review before sending.', 'completed');
    createMissionTask(
      'm-followup-active',
      'Follow up: Send compliance pack',
      'Source mission: m-parent-active',
      'charter',
      'dashboard',
      6,
    );
    // leave m-followup-active in 'queued' state

    const res = await get('/api/review/inbox?limit=50');
    const body = await jsonOf(res);
    // Parent suppressed because an active follow-up is in flight.
    expect(body.items.map((entry: any) => entry.id)).not.toContain('m-parent-active');
  });

  it('removes failed missions from Home attention after a follow-up is created', async () => {
    createMissionTask('m-home-failed-review', 'Mason failed task', 'original prompt', 'mason', 'dashboard', 6);
    completeMissionTask('m-home-failed-review', null, 'failed', 'boom');

    const followup = await app.request('/api/review/tasks/m-home-failed-review/follow-up' + Q, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ assigned_agent: 'mason', mode: 'retry', instructions: 'Try a narrower patch.' }),
    });
    expect(followup.status).toBe(201);

    const res = await get('/api/home/attention');
    const body = await jsonOf(res);
    expect(body.items.map((item: any) => item.id)).not.toContain('mission:m-home-failed-review:terminal');
  });

  it('reopens parent Home attention when a Review Inbox follow-up fails', async () => {
    createMissionTask('m-parent-followup-fails', 'Parent failed task', 'original prompt', 'mason', 'dashboard', 6);
    completeMissionTask('m-parent-followup-fails', null, 'failed', 'first failure');

    const followup = await app.request('/api/review/tasks/m-parent-followup-fails/follow-up' + Q, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ assigned_agent: 'mason', mode: 'retry', instructions: 'Try again.' }),
    });
    const followupBody = await jsonOf(followup);
    expect(followup.status).toBe(201);
    expect(getAttentionItemBySourceKey('mission:m-parent-followup-fails:terminal')).toMatchObject({ status: 'assigned' });

    completeMissionTask(followupBody.task.id, null, 'failed', 'retry failed too');

    const res = await get('/api/home/attention');
    const body = await jsonOf(res);
    expect(getMissionReview('m-parent-followup-fails')).toMatchObject({ review_status: 'needs_triage' });
    expect(getAttentionItemBySourceKey('mission:m-parent-followup-fails:terminal')).toMatchObject({ status: 'open' });
    expect(body.items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        source: 'mission',
        title: 'Parent failed task',
      }),
    ]));
  });

  it('resolves parent Home attention when a Review Inbox follow-up completes', async () => {
    createMissionTask('m-parent-followup-completes', 'Parent retry task', 'original prompt', 'mason', 'dashboard', 6);
    completeMissionTask('m-parent-followup-completes', null, 'failed', 'first failure');

    const followup = await app.request('/api/review/tasks/m-parent-followup-completes/follow-up' + Q, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ assigned_agent: 'mason', mode: 'retry', instructions: 'Try again.' }),
    });
    const followupBody = await jsonOf(followup);
    expect(followup.status).toBe(201);

    completeMissionTask(followupBody.task.id, 'Retry fixed it.', 'completed');

    await get('/api/home/attention');
    expect(getMissionReview('m-parent-followup-completes')).toMatchObject({ review_status: 'resolved' });
    expect(getAttentionItemBySourceKey('mission:m-parent-followup-completes:terminal')).toMatchObject({ status: 'resolved' });
  });

  it('keeps terminal follow-up missions until the parent review refreshes', async () => {
    const old = Math.floor(Date.now() / 1000) - 10 * 86400;
    createMissionTask('m-parent-followup-cleanup', 'Parent cleanup retry', 'original prompt', 'mason', 'dashboard', 6);
    completeMissionTask('m-parent-followup-cleanup', null, 'failed', 'first failure');

    const followup = await app.request('/api/review/tasks/m-parent-followup-cleanup/follow-up' + Q, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ assigned_agent: 'mason', mode: 'retry', instructions: 'Try again.' }),
    });
    const followupBody = await jsonOf(followup);
    expect(followup.status).toBe(201);

    completeMissionTask(followupBody.task.id, 'Retry fixed it.', 'completed');
    _setMissionCompletedAtForTest(followupBody.task.id, old, 'completed');

    expect(cleanupOldMissionTasks(7)).toBe(0);
    expect(getMissionTask(followupBody.task.id)).not.toBeNull();
    expect(getMissionReview('m-parent-followup-cleanup')).toMatchObject({ review_status: 'waiting_followup' });

    await get('/api/home/attention');
    expect(getMissionReview('m-parent-followup-cleanup')).toMatchObject({ review_status: 'resolved' });
    expect(cleanupOldMissionTasks(7)).toBe(1);
    expect(getMissionTask(followupBody.task.id)).toBeNull();
  });

  it('surfaces failed missions in Home Needs Attention with a Review Inbox target', async () => {
    createMissionTask('m-home-failed-visible', 'Visible failed mission', 'original prompt', 'mason', 'mason', 6);
    completeMissionTask('m-home-failed-visible', null, 'failed', 'Something went wrong. Check the logs and try again.');

    const res = await get('/api/home/attention');
    const body = await jsonOf(res);
    expect(body.items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: expect.stringMatching(/^attention:/),
        source: 'mission',
        title: 'Visible failed mission',
        severity: 'high',
        href: '/review?task=m-home-failed-visible',
      }),
    ]));
  });
});

describe('POST /api/review/tasks/:id/email', () => {
  it('uses only the dedicated review export email, not personal owner fallbacks', () => {
    expect(configuredReviewExportEmail(
      { REVIEW_EXPORT_EMAIL: undefined },
      {
        OWNER_EMAIL: 'owner@example.com',
        RUAN_EMAIL: 'personal@example.com',
        APPLE_ID_EMAIL: 'apple@example.com',
        GRAPH_USER_EMAIL: 'graph@example.com',
        MSGRAPH_USER_EMAIL: 'msgraph@example.com',
      },
    )).toBeNull();

    expect(configuredReviewExportEmail(
      { REVIEW_EXPORT_EMAIL: 'work@example.com' },
      { REVIEW_EXPORT_EMAIL: 'file@example.com' },
    )).toBe('work@example.com');
  });

  it('uses only the dedicated review export sender', () => {
    expect(configuredReviewExportFromEmail(
      { REVIEW_EXPORT_FROM_EMAIL: undefined },
      {
        OWNER_EMAIL: 'owner@example.com',
        GRAPH_USER_EMAIL: 'graph@example.com',
      },
    )).toBeNull();

    expect(configuredReviewExportFromEmail(
      { REVIEW_EXPORT_FROM_EMAIL: 'sage@example.com' },
      { REVIEW_EXPORT_FROM_EMAIL: 'file@example.com' },
    )).toBe('sage@example.com');

    expect(configuredReviewExportFromEmail(
      { REVIEW_EXPORT_SHARED_MAILBOX: undefined, REVIEW_EXPORT_FROM_EMAIL: undefined },
      { REVIEW_EXPORT_SHARED_MAILBOX: 'shared@example.com', REVIEW_EXPORT_FROM_EMAIL: 'file@example.com' },
    )).toBe('shared@example.com');
  });

  it('refuses to send review exports from the recipient mailbox', async () => {
    createMissionTask('m-review-same-mailbox', 'Same mailbox deliverable', 'produce output', 'mason', 'dashboard', 6);
    completeMissionTask('m-review-same-mailbox', 'Ready for review.', 'completed');

    const prevTo = process.env.REVIEW_EXPORT_EMAIL;
    const prevFrom = process.env.REVIEW_EXPORT_FROM_EMAIL;
    process.env.REVIEW_EXPORT_EMAIL = 'work@example.com';
    process.env.REVIEW_EXPORT_FROM_EMAIL = 'work@example.com';
    try {
      const res = await app.request('/api/review/tasks/m-review-same-mailbox/email' + Q, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ format: 'docx' }),
      });
      expect(res.status).toBe(400);
      const body = await jsonOf(res);
      expect(body.error).toContain('cannot send from the same mailbox');
    } finally {
      if (prevTo === undefined) delete process.env.REVIEW_EXPORT_EMAIL;
      else process.env.REVIEW_EXPORT_EMAIL = prevTo;
      if (prevFrom === undefined) delete process.env.REVIEW_EXPORT_FROM_EMAIL;
      else process.env.REVIEW_EXPORT_FROM_EMAIL = prevFrom;
    }
  });

  it('respects DASHBOARD_MUTATIONS_ENABLED=false before exporting or sending', async () => {
    createMissionTask('m-review-email', 'Email deliverable', 'produce output', 'mason', 'dashboard', 6);
    completeMissionTask('m-review-email', 'Ready for review.', 'completed');

    const prev = process.env.DASHBOARD_MUTATIONS_ENABLED;
    process.env.DASHBOARD_MUTATIONS_ENABLED = 'false';
    try {
      const res = await app.request('/api/review/tasks/m-review-email/email' + Q, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ format: 'docx' }),
      });
      expect(res.status).toBe(423);
      const body = await jsonOf(res);
      expect(body).toMatchObject({ ok: false, error: expect.any(String) });
    } finally {
      if (prev === undefined) delete process.env.DASHBOARD_MUTATIONS_ENABLED;
      else process.env.DASHBOARD_MUTATIONS_ENABLED = prev;
    }
  });

  it('prefers an actual file deliverable over the generated mission report attachment', async () => {
    const deliverablePath = '/tmp/claudeclaw-contract-deliverable.pdf';
    fs.writeFileSync(deliverablePath, '%PDF-1.3\ncontract test\n', { mode: 0o600 });
    createMissionTask('m-review-real-file', 'Real file deliverable', 'produce output', 'charter', 'dashboard', 6);
    completeMissionTask('m-review-real-file', `Deliverable: \`${deliverablePath}\`\n\nSummary report text.`, 'completed');
    const task = getMissionTask('m-review-real-file')!;

    const attachment = await createReviewEmailAttachment(task, 'docx');
    const resolvedDeliverablePath = fs.realpathSync(deliverablePath);
    expect(attachment).toMatchObject({
      source: 'deliverable',
      path: resolvedDeliverablePath,
      format: 'pdf',
      originalPath: resolvedDeliverablePath,
    });
  });

  it('uses MISSION_RESULT_JSON deliverables as the source of truth for email attachments', async () => {
    const deliverablePath = '/tmp/claudeclaw-contract-json-deliverable.docx';
    fs.writeFileSync(deliverablePath, 'fake docx payload', { mode: 0o600 });
    createMissionTask('m-review-json-file', 'JSON file deliverable', 'produce output', 'charter', 'dashboard', 6);
    completeMissionTask(
      'm-review-json-file',
      [
        'Mission report summary only.',
        '```json',
        JSON.stringify({
          status: 'completed',
          summary: 'Document produced.',
          deliverables: [{ kind: 'file', target: deliverablePath, label: 'Worked document' }],
          source_files: [],
          blockers: [],
          next_action: 'Review the document.',
          follow_up_needed: false,
          review_required: true,
        }),
        '```',
      ].join('\n'),
      'completed',
    );
    const task = getMissionTask('m-review-json-file')!;

    const attachment = await createReviewEmailAttachment(task, 'docx');
    expect(attachment).toMatchObject({
      source: 'deliverable',
      path: fs.realpathSync(deliverablePath),
      originalPath: fs.realpathSync(deliverablePath),
      format: 'docx',
    });
  });

  it('refuses Email deliverable when no real deliverable file exists', async () => {
    createMissionTask('m-review-no-file-email', 'No file email', 'produce output', 'mason', 'dashboard', 6);
    completeMissionTask('m-review-no-file-email', 'Completed cleanly. No deliverable and no human action required.', 'completed');

    const prevTo = process.env.REVIEW_EXPORT_EMAIL;
    const prevFrom = process.env.REVIEW_EXPORT_SHARED_MAILBOX;
    process.env.REVIEW_EXPORT_EMAIL = 'work@example.com';
    process.env.REVIEW_EXPORT_SHARED_MAILBOX = 'sage@example.com';
    try {
      const res = await app.request('/api/review/tasks/m-review-no-file-email/email' + Q, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ format: 'docx' }),
      });
      expect(res.status).toBe(400);
      const body = await jsonOf(res);
      expect(body).toMatchObject({
        ok: false,
        error: expect.stringContaining('No actual deliverable file'),
      });
    } finally {
      if (prevTo === undefined) delete process.env.REVIEW_EXPORT_EMAIL;
      else process.env.REVIEW_EXPORT_EMAIL = prevTo;
      if (prevFrom === undefined) delete process.env.REVIEW_EXPORT_SHARED_MAILBOX;
      else process.env.REVIEW_EXPORT_SHARED_MAILBOX = prevFrom;
    }
  });

  it('can extract and email a deliverable path that contains spaces', async () => {
    const deliverablePath = '/tmp/claudeclaw contract deliverable final.md';
    fs.writeFileSync(deliverablePath, '# Contract deliverable\n\nActual worked-on document.\n', { mode: 0o600 });
    createMissionTask('m-review-spaced-file', 'Spaced file deliverable', 'produce output', 'charter', 'dashboard', 6);
    completeMissionTask('m-review-spaced-file', `Actual deliverable: "${deliverablePath}"\nMission report follows below.`, 'completed');
    const task = getMissionTask('m-review-spaced-file')!;

    const attachment = await createReviewEmailAttachment(task, 'html');
    expect(attachment).toMatchObject({
      source: 'deliverable',
      originalPath: fs.realpathSync(deliverablePath),
      format: 'html',
    });
    expect(path.basename(attachment.path)).toContain('claudeclaw-contract-deliverable-final');
  });

  it('prefers the real document over a mission-report file when both are mentioned', async () => {
    const reportPath = '/tmp/mission-report-debug.md';
    const docPath = '/tmp/client-support-plan-final.docx';
    fs.writeFileSync(reportPath, '# Mission report\n', { mode: 0o600 });
    fs.writeFileSync(docPath, 'fake docx payload', { mode: 0o600 });
    createMissionTask('m-review-best-file', 'Best file deliverable', 'produce output', 'charter', 'dashboard', 6);
    completeMissionTask('m-review-best-file', `Report: ${reportPath}\nDeliverable: ${docPath}`, 'completed');
    const task = getMissionTask('m-review-best-file')!;

    const attachment = await createReviewEmailAttachment(task, 'docx');
    expect(attachment).toMatchObject({
      source: 'deliverable',
      path: fs.realpathSync(docPath),
      originalPath: fs.realpathSync(docPath),
      format: 'docx',
    });
  });
});

describe('POST /api/mission/tasks', () => {
  it('rejects missing title with 400', async () => {
    const res = await app.request('/api/mission/tasks' + Q, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'test prompt' }),
    });
    expect(res.status).toBe(400);
  });

  it('rejects missing prompt with 400', async () => {
    const res = await app.request('/api/mission/tasks' + Q, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'test' }),
    });
    expect(res.status).toBe(400);
  });

  it('creates task with valid input and returns full task shape', async () => {
    const res = await app.request('/api/mission/tasks' + Q, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'contract test', prompt: 'do nothing', priority: 3 }),
    });
    expect(res.status).toBe(201);
    const body = await jsonOf(res);
    expect(body.task).toMatchObject({
      id: expect.any(String),
      title: 'contract test',
      prompt: 'do nothing',
      status: 'queued',
      priority: 3,
      created_by: 'dashboard',
      created_at: expect.any(Number),
    });
  });
});

describe('GET /api/mission/tasks/auto-assign-all route ordering', () => {
  // Regression test: this endpoint was shadowed by /:id/auto-assign for
  // months because route registration order was wrong. Lock it in.
  it('returns 200, not 404, when called as a static path', async () => {
    const res = await app.request('/api/mission/tasks/auto-assign-all' + Q, {
      method: 'POST',
    });
    // Must NOT be 404. May be 200 (assigned: 0) or 400 if no agents.
    expect(res.status).not.toBe(404);
  });
});

describe('GET /api/memories', () => {
  it('returns full memory dashboard payload', async () => {
    const res = await get('/api/memories?chatId=test');
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body).toMatchObject({
      stats: expect.objectContaining({
        total: expect.any(Number),
        pinned: expect.any(Number),
        consolidations: expect.any(Number),
      }),
      fading: expect.any(Array),
      topAccessed: expect.any(Array),
      timeline: expect.any(Array),
      consolidations: expect.any(Array),
    });
  });
});

describe('GET /api/memories/list', () => {
  it('returns paginated memory list', async () => {
    const res = await get('/api/memories/list?chatId=test&limit=10&offset=0');
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body).toMatchObject({
      memories: expect.any(Array),
      total: expect.any(Number),
    });
  });
});

describe('GET /api/tokens', () => {
  it('returns stats + costTimeline + recentUsage', async () => {
    const res = await get('/api/tokens?chatId=test');
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body).toMatchObject({
      stats: expect.any(Object),
      costTimeline: expect.any(Array),
      recentUsage: expect.any(Array),
    });
    expect(body.stats).toMatchObject({
      todayInput: expect.any(Number),
      todayOutput: expect.any(Number),
      todayCost: expect.any(Number),
      todayTurns: expect.any(Number),
      allTimeCost: expect.any(Number),
      allTimeTurns: expect.any(Number),
    });
  });
});

describe('GET /api/hive-mind', () => {
  it('returns { entries: [] }', async () => {
    const res = await get('/api/hive-mind');
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body).toMatchObject({ entries: expect.any(Array) });
  });
});

describe('GET /api/audit', () => {
  it('returns { entries, total }', async () => {
    const res = await get('/api/audit?limit=10&offset=0');
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body).toMatchObject({
      entries: expect.any(Array),
      total: expect.any(Number),
    });
  });
});

describe('GET /api/audit/blocked', () => {
  it('returns { entries: [] }', async () => {
    const res = await get('/api/audit/blocked?limit=5');
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body).toMatchObject({ entries: expect.any(Array) });
  });
});

describe('GET /api/security/status', () => {
  it('returns 200 with an object', async () => {
    const res = await get('/api/security/status');
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body).toBeInstanceOf(Object);
  });
});

describe('GET /api/chat/history', () => {
  it('returns { turns: [] } when chatId is missing', async () => {
    const res = await get('/api/chat/history');
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body).toMatchObject({ turns: expect.any(Array) });
  });

  it('falls back when chatId query is present but empty', async () => {
    const res = await get('/api/chat/history?chatId=&limit=50');
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body).toMatchObject({ turns: expect.any(Array) });
  });

  it('returns { turns: [] } with chatId', async () => {
    const res = await get('/api/chat/history?chatId=test&limit=10');
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body).toMatchObject({ turns: expect.any(Array) });
  });
});

describe('PATCH /api/agents/:id/model', () => {
  it('rejects missing model with 400', async () => {
    const res = await app.request('/api/agents/main/model' + Q, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it('rejects invalid model with 400', async () => {
    const res = await app.request('/api/agents/main/model' + Q, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-5' }),
    });
    expect(res.status).toBe(400);
  });

  it('main response includes restartRequired: false', async () => {
    const res = await app.request('/api/agents/main/model' + Q, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-sonnet-4-6' }),
    });
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body).toMatchObject({
      ok: true,
      agent: 'main',
      model: 'claude-sonnet-4-6',
      restartRequired: false,
    });
  });

  it('main model override is reflected by the agents list', async () => {
    const res = await app.request('/api/agents/main/model' + Q, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-haiku-4-5' }),
    });
    expect(res.status).toBe(200);

    const agentsRes = await get('/api/agents');
    expect(agentsRes.status).toBe(200);
    const body = await jsonOf(agentsRes);
    const main = body.agents.find((agent: { id: string }) => agent.id === 'main');
    expect(main).toMatchObject({
      model: 'claude-haiku-4-5',
      configuredModel: 'claude-haiku-4-5',
    });
  });
});

describe('PATCH /api/agents/:id/provider', () => {
  it('rejects unsupported providers before writing config', async () => {
    const res = await app.request('/api/agents/main/provider' + Q, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'openbrain' }),
    });
    expect(res.status).toBe(400);
    const body = await jsonOf(res);
    expect(body).toMatchObject({ ok: false, error: expect.any(String) });
  });
});

describe('GET /api/warroom/agents', () => {
  it('returns { agents: [...] } with main present', async () => {
    const res = await get('/api/warroom/agents');
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body.agents).toBeInstanceOf(Array);
    expect(body.agents.length).toBeGreaterThanOrEqual(1);
    expect(body.agents[0]).toMatchObject({
      id: expect.any(String),
      name: expect.any(String),
      description: expect.any(String),
    });
  });
});

describe('GET /api/warroom/pin', () => {
  it('returns { ok, agent, mode }', async () => {
    const res = await get('/api/warroom/pin');
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body).toMatchObject({
      ok: expect.any(Boolean),
      mode: expect.any(String),
    });
  });
});

describe('Text War Room API', () => {
  async function createTextRoom(chatId = 'chat-a') {
    const res = await app.request('/api/warroom/text/new' + Q, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chatId }),
    });
    expect(res.status).toBe(200);
    return jsonOf(res);
  }

  it('requires auth for text meeting list', async () => {
    const res = await getNoToken('/api/warroom/text/list');
    expect(res.status).toBe(401);
  });

  it('creates and lists chat-scoped text meetings without leaking into voice meetings', async () => {
    const created = await createTextRoom('chat-a');
    expect(created.meetingId).toMatch(/^wr_/);

    const textList = await get('/api/warroom/text/list?chatId=chat-a');
    expect(textList.status).toBe(200);
    const textBody = await jsonOf(textList);
    expect(textBody.meetings.map((m: any) => m.id)).toContain(created.meetingId);

    const voiceList = await get('/api/warroom/meetings?limit=20');
    const voiceBody = await jsonOf(voiceList);
    expect(voiceBody.meetings.map((m: any) => m.id)).not.toContain(created.meetingId);
  });

  it('does not list every chat scope when chatId is omitted', async () => {
    const a = await createTextRoom('chat-a');
    const b = await createTextRoom('chat-b');

    const res = await get('/api/warroom/text/list');
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    const ids = body.meetings.map((m: any) => m.id);
    expect(ids).not.toContain(a.meetingId);
    expect(ids).not.toContain(b.meetingId);
  });

  it('rejects cross-chat access to a text meeting', async () => {
    const created = await createTextRoom('chat-a');
    const res = await get(`/api/warroom/text/history?meetingId=${created.meetingId}&chatId=chat-b`);
    expect(res.status).toBe(403);
    expect(await jsonOf(res)).toMatchObject({ error: 'chat_mismatch' });
  });

  it('rejects malformed meeting ids before creating a channel', async () => {
    const res = await get('/api/warroom/text/history?meetingId=../../bad&chatId=chat-a');
    expect(res.status).toBe(400);
    expect(await jsonOf(res)).toMatchObject({ error: 'invalid meetingId' });
  });

  it('strips token from the text room page and then renders via auth cookie', async () => {
    const created = await createTextRoom('chat-a');
    const first = await app.request(`/warroom/text?token=${TOKEN}&meetingId=${created.meetingId}&chatId=chat-a`);
    expect(first.status).toBe(302);
    expect(first.headers.get('location')).toBe(`/warroom/text?meetingId=${created.meetingId}&chatId=chat-a`);
    const cookie = first.headers.get('set-cookie')?.split(';')[0] || '';

    const second = await app.request(`/warroom/text?meetingId=${created.meetingId}&chatId=chat-a`, {
      headers: { cookie },
    });
    expect(second.status).toBe(200);
    const html = await second.text();
    expect(html).toContain('War Room');
    expect(html).not.toContain(TOKEN);
  });

  it('does not warm the LLM path when LLM spawning is disabled', async () => {
    const prev = process.env.LLM_SPAWN_ENABLED;
    process.env.LLM_SPAWN_ENABLED = 'false';
    try {
      const res = await app.request('/api/warroom/text/warmup' + Q, { method: 'POST' });
      expect(res.status).toBe(503);
      expect(await jsonOf(res)).toMatchObject({ error: 'LLM spawn is disabled by LLM_SPAWN_ENABLED.' });
    } finally {
      if (prev === undefined) delete process.env.LLM_SPAWN_ENABLED;
      else process.env.LLM_SPAWN_ENABLED = prev;
    }
  });

});

describe('GET /api/meet/sessions', () => {
  it('returns { ok, active, recent }', async () => {
    const res = await get('/api/meet/sessions');
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body).toMatchObject({
      active: expect.any(Array),
      recent: expect.any(Array),
    });
  });
});

describe('Cache-Control on /api/*', () => {
  it('every API response carries Cache-Control: no-store', async () => {
    const res = await get('/api/health');
    expect(res.headers.get('cache-control')).toBe('no-store');
  });
});

describe('Security headers on /', () => {
  it('Referrer-Policy: no-referrer is set', async () => {
    const res = await get('/api/health');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
  });

  it('X-Frame-Options: DENY is set', async () => {
    const res = await get('/api/health');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
  });

  it('X-Content-Type-Options: nosniff is set', async () => {
    const res = await get('/api/health');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });
});
