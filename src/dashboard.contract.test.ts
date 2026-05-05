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

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { _initTestDatabase, completeMissionTask, createMissionTask, createScheduledTask, updateTaskAfterRun } from './db.js';
import { buildDashboardApp } from './dashboard.js';
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

  it('responds 204 to OPTIONS preflight without token check', async () => {
    const res = await app.request('/api/health', { method: 'OPTIONS' });
    expect(res.status).toBe(204);
  });
});

describe('GET /api/health', () => {
  it('returns the documented shape', async () => {
    const res = await get('/api/health');
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
      components: expect.any(Array),
    });
    expect(body.components.map((c: any) => c.id)).toEqual(expect.arrayContaining([
      'provider-adapter',
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
    createScheduledTask('brief-evening', 'Produce Ruan evening wrap', '0 18 * * *', now + 3600, 'main');
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

  it('suppresses brief items once a matching mission task exists', async () => {
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
    expect(body.items.map((item: any) => item.title)).toEqual(expect.arrayContaining([
      'Fix Reminders CalDAV auth',
      'Fix iMessage digest access',
      'CA-05 support plans recovery',
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

  it('does not surface old dev completed missions just because their result contains critical review text', async () => {
    createMissionTask('m-dev-critical', 'Stream2-M2: full-chain integration tests', 'dev work', 'mason', 'dashboard', 5);
    const { completeMissionTask } = await import('./db.js');
    completeMissionTask('m-dev-critical', 'CRITICAL #1 fixed: test harness issue closed.', 'completed');

    const res = await get('/api/home/attention');
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body.items.map((item: any) => item.title)).not.toContain('Stream2-M2: full-chain integration tests');
  });

  it('returns OS scheduled work for the home agenda while calendar is unwired', async () => {
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
    expect(body.items[0]).toMatchObject({
      id: 'agenda-1',
      source: 'schedule',
      title: expect.any(String),
      dueAt: expect.any(Number),
      overdue: expect.any(Boolean),
    });
  });
});

describe('GET /api/tasks (scheduled)', () => {
  it('returns { tasks: [] }', async () => {
    const res = await get('/api/tasks');
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body).toMatchObject({ tasks: expect.any(Array) });
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

describe('GET /api/review/inbox', () => {
  it('returns completed mission deliverables for review', async () => {
    createMissionTask('m-review-1', 'Write deliverable', 'produce output', 'mason', 'dashboard', 6);
    completeMissionTask('m-review-1', 'Created /tmp/review-deliverable.txt', 'completed');

    const res = await get('/api/review/inbox?limit=10');
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body).toMatchObject({
      updatedAt: expect.any(String),
      total: expect.any(Number),
      items: expect.any(Array),
      exportEmailConfigured: expect.any(Boolean),
    });
    expect(body.items[0]).toMatchObject({
      id: 'm-review-1',
      title: 'Write deliverable',
      status: 'completed',
      deliverables: expect.any(Array),
    });
  });
});

describe('POST /api/review/tasks/:id/email', () => {
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
  it('rejects missing chatId with 400', async () => {
    const res = await get('/api/chat/history');
    expect(res.status).toBe(400);
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
