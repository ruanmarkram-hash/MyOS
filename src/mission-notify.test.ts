import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import {
  _initTestDatabase,
  _setMissionCompletedAtForTest,
  _setMissionNotifyAttemptCountForTest,
  createMissionTask,
  getMissionTask,
  getMissionTasksNeedingNotificationRecovery,
  markMissionNotified,
  setSession,
  type MissionTask,
} from './db.js';
import {
  escapeTelegramHtml,
  formatNotifyMessage,
  notifyMissionDone,
  _setNotifySpawn,
} from './mission-notify.js';

type SpawnCall = { script: string; args: string[] };

function captureSpawns(exitCode = 0): { calls: SpawnCall[] } {
  const calls: SpawnCall[] = [];
  _setNotifySpawn(async (script, args) => {
    calls.push({ script, args });
    return exitCode;
  });
  return { calls };
}

describe('mission-notify', () => {
  beforeEach(() => {
    _initTestDatabase();
  });
  afterEach(() => {
    _setNotifySpawn(null);
  });

  describe('escapeTelegramHtml', () => {
    it('escapes &, <, >', () => {
      expect(escapeTelegramHtml('<a href="x">click</a>')).toBe(
        '&lt;a href=&quot;x&quot;&gt;click&lt;/a&gt;',
      );
    });
    it('escapes script tags', () => {
      expect(escapeTelegramHtml('<script>evil</script>')).toBe(
        '&lt;script&gt;evil&lt;/script&gt;',
      );
    });
    it('escapes ampersand first to avoid double-encoding', () => {
      expect(escapeTelegramHtml('a & b < c')).toBe('a &amp; b &lt; c');
    });
    it('passes plain text through unchanged', () => {
      expect(escapeTelegramHtml('Refactor mapper')).toBe('Refactor mapper');
    });
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
      expect(msg.endsWith('x'.repeat(200))).toBe(true);
      expect(msg).not.toContain('x'.repeat(201));
    });

    it('omits trailing colon when there is no detail', () => {
      expect(formatNotifyMessage(base, 'completed')).toBe('[sage ✓] Refactor mapper');
    });

    it('escapes HTML in title and snippet to prevent injection', () => {
      const msg = formatNotifyMessage(
        { created_by: 'sage', title: '<a href="evil">x</a>', result: '<script>hi</script>', error: null },
        'completed',
      );
      expect(msg).toContain('&lt;a href=&quot;evil&quot;&gt;x&lt;/a&gt;');
      expect(msg).toContain('&lt;script&gt;hi&lt;/script&gt;');
      expect(msg).not.toContain('<script>');
      expect(msg).not.toContain('<a href');
    });
  });

  describe('notifyMissionDone', () => {
    function loadTask(id: string): MissionTask {
      const t = getMissionTask(id);
      if (!t) throw new Error('task missing');
      return t;
    }

    it('no-ops when notify_on_done is 0', async () => {
      const { calls } = captureSpawns();
      createMissionTask('m1', 'Title', 'prompt', 'mason', 'sage', 0, null, false);
      const ok = await notifyMissionDone(loadTask('m1'), 'completed', 'done');
      expect(ok).toBe(false);
      expect(calls).toHaveLength(0);
      expect(loadTask('m1').notified_at).toBeNull();
    });

    it('fires once when notify_on_done = 1, marks notified_at, and is idempotent', async () => {
      const { calls } = captureSpawns();
      createMissionTask('m2', 'Refactor mapper', 'prompt', 'mason', 'sage', 0, null, true);
      setSession('chat-42', 'sess-x', 'sage');

      const fired1 = await notifyMissionDone(loadTask('m2'), 'completed', 'All green');
      expect(fired1).toBe(true);
      expect(calls).toHaveLength(1);
      expect(calls[0].script).toMatch(/scripts\/notify\.sh$/);
      expect(calls[0].args[0]).toBe('[sage ✓] Refactor mapper: All green');
      expect(calls[0].args[1]).toBe('chat-42');

      const fired2 = await notifyMissionDone(loadTask('m2'), 'completed', 'All green');
      expect(fired2).toBe(false);
      expect(calls).toHaveLength(1);
      expect(loadTask('m2').notified_at).not.toBeNull();
    });

    it('skips delivery and marks DELIVERED when no chat_id is registered for the agent', async () => {
      const { calls } = captureSpawns();
      createMissionTask('m3', 'Lonely task', 'prompt', 'mason', 'ghost-agent', 0, null, true);
      const fired = await notifyMissionDone(loadTask('m3'), 'failed', 'Boom');
      expect(fired).toBe(false);
      expect(calls).toHaveLength(0);
      // delivered_at stamped (not just notified_at) so the recovery sweep
      // ignores this row going forward — there's no chat to deliver to.
      expect(loadTask('m3').delivered_at).not.toBeNull();
    });

    it('leaves notified_at NULL and delivered_at NULL when notify.sh exits non-zero (retry-able)', async () => {
      const { calls } = captureSpawns(1);
      createMissionTask('m4', 'Flaky task', 'prompt', 'mason', 'sage', 0, null, true);
      setSession('chat-7', 'sess-y', 'sage');
      const fired = await notifyMissionDone(loadTask('m4'), 'completed', 'output');
      expect(fired).toBe(false);
      expect(calls).toHaveLength(1);
      // claim released so the sweep can re-fire, delivery never confirmed
      expect(loadTask('m4').notified_at).toBeNull();
      expect(loadTask('m4').delivered_at).toBeNull();
    });

    it('successful delivery sets BOTH notified_at and delivered_at', async () => {
      captureSpawns(0);
      createMissionTask('m6', 'Happy task', 'prompt', 'mason', 'sage', 0, null, true);
      setSession('chat-h', 'sess-h', 'sage');
      const fired = await notifyMissionDone(loadTask('m6'), 'completed', 'all good');
      expect(fired).toBe(true);
      const t = loadTask('m6');
      expect(t.notified_at).not.toBeNull();
      expect(t.delivered_at).not.toBeNull();
    });

    // HIGH 1 — crash-mid-spawn simulation. We mark the row notified
    // (claim) but force a throw before/at spawn so delivered_at is
    // never set. The recovery sweep must still pick this row up.
    it('recovers a row whose claim was stamped but delivery never landed (crash-mid-spawn)', async () => {
      createMissionTask('m7', 'Crashy task', 'prompt', 'mason', 'sage', 0, null, true);
      setSession('chat-c', 'sess-c', 'sage');
      // First attempt: claim succeeds, but spawn throws before delivery.
      _setNotifySpawn(async () => { throw new Error('process died'); });
      await notifyMissionDone(loadTask('m7'), 'completed', 'x');
      // Simulate the row being terminal + aged past the grace window.
      _setMissionCompletedAtForTest('m7', Math.floor(Date.now() / 1000) - 120, 'completed');
      // Sweep finds the row even though notified_at was momentarily set
      // (resetMissionNotified releases it). The key invariant is that
      // delivered_at IS NULL keeps the row visible to the sweep.
      const pending = getMissionTasksNeedingNotificationRecovery();
      expect(pending.find(t => t.id === 'm7')).toBeTruthy();
      expect(loadTask('m7').delivered_at).toBeNull();

      // Now the second attempt succeeds; sweep replays it.
      const { calls } = captureSpawns(0);
      const fired = await notifyMissionDone(loadTask('m7'), 'completed', 'x');
      expect(fired).toBe(true);
      expect(calls).toHaveLength(1);
      expect(loadTask('m7').delivered_at).not.toBeNull();
    });

    // Stronger crash-mid-spawn: claim is stamped and the process dies
    // BEFORE resetMissionNotified can run. Sweep must still recover.
    it('recovers a row even when notified_at was never reset (true crash)', async () => {
      createMissionTask('m8', 'True crash', 'prompt', 'mason', 'sage', 0, null, true);
      setSession('chat-d', 'sess-d', 'sage');
      // Simulate: the process claimed the row then died. notified_at set,
      // delivered_at NULL, no reset call ever ran.
      expect(markMissionNotified('m8')).toBe(true);
      _setMissionCompletedAtForTest('m8', Math.floor(Date.now() / 1000) - 120, 'completed');
      expect(loadTask('m8').notified_at).not.toBeNull();
      expect(loadTask('m8').delivered_at).toBeNull();

      const pending = getMissionTasksNeedingNotificationRecovery();
      expect(pending.find(t => t.id === 'm8')).toBeTruthy();

      // Sweep replays. The new claim filter is delivered_at IS NULL,
      // so re-claim succeeds even though notified_at was already set.
      const { calls } = captureSpawns(0);
      const fired = await notifyMissionDone(loadTask('m8'), 'completed', 'x');
      expect(fired).toBe(true);
      expect(calls).toHaveLength(1);
      expect(loadTask('m8').delivered_at).not.toBeNull();
    });

    // MEDIUM 1 — bounded retry. After the cap, the sweep stops returning
    // the row even if delivery never landed.
    it('bounded retry: rows past notify_attempt_count cap are dropped from the sweep', async () => {
      createMissionTask('m9', 'Permabroken', 'prompt', 'mason', 'sage', 0, null, true);
      setSession('chat-e', 'sess-e', 'sage');
      _setMissionCompletedAtForTest('m9', Math.floor(Date.now() / 1000) - 120, 'completed');
      // Below cap: visible.
      _setMissionNotifyAttemptCountForTest('m9', 4);
      expect(getMissionTasksNeedingNotificationRecovery().find(t => t.id === 'm9')).toBeTruthy();
      // At/above cap: invisible.
      _setMissionNotifyAttemptCountForTest('m9', 5);
      expect(getMissionTasksNeedingNotificationRecovery().find(t => t.id === 'm9')).toBeFalsy();
    });

    it('releases the claim when spawn throws', async () => {
      _setNotifySpawn(async () => { throw new Error('boom'); });
      createMissionTask('m5', 'Throw task', 'prompt', 'mason', 'sage', 0, null, true);
      setSession('chat-9', 'sess-z', 'sage');
      const fired = await notifyMissionDone(loadTask('m5'), 'completed', 'x');
      expect(fired).toBe(false);
      expect(loadTask('m5').notified_at).toBeNull();
    });
  });
});
