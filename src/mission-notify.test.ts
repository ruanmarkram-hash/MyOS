import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import {
  _initTestDatabase,
  createMissionTask,
  getMissionTask,
  setSession,
  type MissionTask,
} from './db.js';
import {
  formatNotifyMessage,
  notifyMissionDone,
  _setNotifySpawn,
} from './mission-notify.js';

type SpawnCall = { script: string; args: string[] };

function captureSpawns(): { calls: SpawnCall[] } {
  const calls: SpawnCall[] = [];
  _setNotifySpawn((script, args) => { calls.push({ script, args }); });
  return { calls };
}

describe('mission-notify', () => {
  beforeEach(() => {
    _initTestDatabase();
  });
  afterEach(() => {
    _setNotifySpawn(null);
  });

  describe('formatNotifyMessage', () => {
    const base = { created_by: 'sage', title: 'Refactor mapper', result: null, error: null };

    it('formats completed with checkmark + snippet', () => {
      expect(formatNotifyMessage({ ...base, result: 'Done.' }, 'completed'))
        .toBe('[sage ✓] Refactor mapper: Done.');
    });

    it('formats failed with cross + error', () => {
      expect(formatNotifyMessage({ ...base, error: 'Boom' }, 'failed'))
        .toBe('[sage ✗] Refactor mapper: Boom');
    });

    it('formats timed_out with stopwatch', () => {
      expect(formatNotifyMessage(base, 'timed_out', 'Timed out after 10 minutes'))
        .toBe('[sage ⏱] Refactor mapper: Timed out after 10 minutes');
    });

    it('truncates long snippet to 200 chars and collapses whitespace', () => {
      const long = 'x'.repeat(300);
      const msg = formatNotifyMessage({ ...base, result: long }, 'completed');
      // Prefix is "[sage ✓] Refactor mapper: " then 200 x's
      expect(msg.endsWith('x'.repeat(200))).toBe(true);
      expect(msg).not.toContain('x'.repeat(201));
    });

    it('omits trailing colon when there is no detail', () => {
      expect(formatNotifyMessage(base, 'completed')).toBe('[sage ✓] Refactor mapper');
    });
  });

  describe('notifyMissionDone', () => {
    function loadTask(id: string): MissionTask {
      const t = getMissionTask(id);
      if (!t) throw new Error('task missing');
      return t;
    }

    it('no-ops when notify_on_done is 0', () => {
      const { calls } = captureSpawns();
      createMissionTask('m1', 'Title', 'prompt', 'mason', 'sage', 0, null, false);
      const ok = notifyMissionDone(loadTask('m1'), 'completed', 'done');
      expect(ok).toBe(false);
      expect(calls).toHaveLength(0);
      expect(loadTask('m1').notified_at).toBeNull();
    });

    it('fires once when notify_on_done = 1, marks notified_at, and is idempotent', () => {
      const { calls } = captureSpawns();
      createMissionTask('m2', 'Refactor mapper', 'prompt', 'mason', 'sage', 0, null, true);
      // Pretend the agent has chatted before so the chat_id lookup succeeds.
      setSession('chat-42', 'sess-x', 'sage');

      const fired1 = notifyMissionDone(loadTask('m2'), 'completed', 'All green');
      expect(fired1).toBe(true);
      expect(calls).toHaveLength(1);
      expect(calls[0].script).toMatch(/scripts\/notify\.sh$/);
      // [message, chat_id]
      expect(calls[0].args[0]).toBe('[sage ✓] Refactor mapper: All green');
      expect(calls[0].args[1]).toBe('chat-42');

      // Second call (e.g. a retry in the scheduler) must not re-fire.
      const fired2 = notifyMissionDone(loadTask('m2'), 'completed', 'All green');
      expect(fired2).toBe(false);
      expect(calls).toHaveLength(1);
      expect(loadTask('m2').notified_at).not.toBeNull();
    });

    it('omits chat_id arg when no session exists for the creating agent', () => {
      const { calls } = captureSpawns();
      createMissionTask('m3', 'Lonely task', 'prompt', 'mason', 'ghost-agent', 0, null, true);
      const fired = notifyMissionDone(loadTask('m3'), 'failed', 'Boom');
      expect(fired).toBe(true);
      expect(calls[0].args).toHaveLength(1);
      expect(calls[0].args[0]).toBe('[ghost-agent ✗] Lonely task: Boom');
    });
  });
});
