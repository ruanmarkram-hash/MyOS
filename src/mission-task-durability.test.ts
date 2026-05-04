/**
 * Durability tests for the mission-task notify-on-done pipeline:
 *   - recovery sweep replays missed notifications after a crash
 *   - migration upgrade survives a pre-nullable assigned_agent DB
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';

import {
  _initTestDatabase,
  _createSchema,
  _runMigrations,
  _setMissionCompletedAtForTest,
  createMissionTask,
  getMissionTask,
  getMissionTasksNeedingNotificationRecovery,
  setSession,
} from './db.js';
import { _setNotifySpawn, notifyMissionDone } from './mission-notify.js';

describe('mission notify recovery sweep', () => {
  beforeEach(() => {
    _initTestDatabase();
  });
  afterEach(() => {
    _setNotifySpawn(null);
  });

  it('finds terminal tasks with notify_on_done=1 and notified_at=NULL outside the grace window', () => {
    // Hot path: just-completed task should NOT be returned (race protection)
    createMissionTask('hot', 'Hot', 'p', 'mason', 'sage', 0, null, true);
    // Stale crashed task: completed long ago, notification never fired
    createMissionTask('stale', 'Stale', 'p', 'mason', 'sage', 0, null, true);
    // No notify flag — irrelevant
    createMissionTask('quiet', 'Quiet', 'p', 'mason', 'sage', 0, null, false);

    // hot: 30s ago (inside the 60s grace window — recovery should skip it)
    // stale: 3 min ago (outside the grace — recovery picks it up)
    setMissionCompletedAt('hot', Math.floor(Date.now() / 1000) - 30, 'completed');
    setMissionCompletedAt('stale', Math.floor(Date.now() / 1000) - 180, 'completed');

    const all = getMissionTasksNeedingNotificationRecovery(0);
    expect(all.map((t) => t.id).sort()).toEqual(['hot', 'stale']);

    const aged = getMissionTasksNeedingNotificationRecovery(60);
    expect(aged.map((t) => t.id)).toEqual(['stale']);
  });

  it('replays the missed notification: spawn fires and notified_at is set', async () => {
    const calls: Array<{ args: string[] }> = [];
    _setNotifySpawn(async (_script, args) => {
      calls.push({ args });
      return 0;
    });

    setSession('chat-99', 'sess-r', 'sage');
    createMissionTask('crashed', 'Recover me', 'p', 'mason', 'sage', 0, null, true);
    setMissionCompletedAt('crashed', Math.floor(Date.now() / 1000) - 180, 'completed');

    const pending = getMissionTasksNeedingNotificationRecovery();
    expect(pending).toHaveLength(1);

    const fired = await notifyMissionDone(pending[0], 'completed');
    expect(fired).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].args[1]).toBe('chat-99');

    expect(getMissionTask('crashed')!.notified_at).not.toBeNull();
    // Sweep is now empty.
    expect(getMissionTasksNeedingNotificationRecovery()).toHaveLength(0);
  });
});

describe('mission_tasks migration upgrade from old NOT-NULL assigned_agent schema', () => {
  it('upgrades cleanly: additive cols added, NOT NULL relaxed, data preserved', () => {
    // Build a fresh DB with the FULL current schema first so all referenced
    // tables exist for the migration runner.
    const fresh = new Database(':memory:');
    _createSchema(fresh);

    // Now simulate the old shape of mission_tasks: drop the modern table and
    // recreate with NOT NULL assigned_agent and no model/notify_on_done/notified_at.
    fresh.exec(`
      DROP TABLE IF EXISTS mission_tasks;
      CREATE TABLE mission_tasks (
        id              TEXT PRIMARY KEY,
        title           TEXT NOT NULL,
        prompt          TEXT NOT NULL,
        assigned_agent  TEXT NOT NULL,
        status          TEXT NOT NULL DEFAULT 'queued',
        result          TEXT,
        error           TEXT,
        created_by      TEXT NOT NULL DEFAULT 'dashboard',
        priority        INTEGER NOT NULL DEFAULT 0,
        created_at      INTEGER NOT NULL,
        started_at      INTEGER,
        completed_at    INTEGER
      );
    `);
    fresh.prepare(
      `INSERT INTO mission_tasks (id, title, prompt, assigned_agent, status, created_by, priority, created_at)
       VALUES (?,?,?,?,?,?,?,?)`,
    ).run('legacy-1', 'Legacy task', 'do thing', 'mason', 'completed', 'sage', 0, Math.floor(Date.now() / 1000));

    // Run the production migrator. This must succeed.
    expect(() => _runMigrations(fresh)).not.toThrow();

    const cols = fresh.prepare('PRAGMA table_info(mission_tasks)').all() as Array<{ name: string; notnull: number }>;
    const colMap = new Map(cols.map((c) => [c.name, c]));
    expect(colMap.has('model')).toBe(true);
    expect(colMap.has('notify_on_done')).toBe(true);
    expect(colMap.has('notified_at')).toBe(true);
    // assigned_agent is now nullable
    expect(colMap.get('assigned_agent')!.notnull).toBe(0);

    // Original row survived the rebuild
    const row = fresh.prepare('SELECT id, title, assigned_agent, status FROM mission_tasks WHERE id = ?').get('legacy-1') as {
      id: string; title: string; assigned_agent: string; status: string;
    };
    expect(row).toEqual({ id: 'legacy-1', title: 'Legacy task', assigned_agent: 'mason', status: 'completed' });
  });
});

// ── helpers ─────────────────────────────────────────────────────────────

/**
 * Test-only: stamp completed_at and status on an existing mission task so
 * we can simulate "task finished N seconds ago, notification never sent."
 * Done via direct UPDATE through a fresh module function; if not present,
 * we synthesise via the public completeMissionTask + a raw timestamp poke.
 */
function setMissionCompletedAt(id: string, ts: number, status: 'completed' | 'failed' = 'completed'): void {
  _setMissionCompletedAtForTest(id, ts, status);
}
