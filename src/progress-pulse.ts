/**
 * progress-pulse — low-frequency "agent still alive" heartbeat for the
 * dashboard.
 *
 * Yesterday (2026-05-04) we removed the per-tool `tool_active` Telegram
 * mirror because it pinged on every Bash/Read/Edit during long
 * sessions. The fix was correct for Telegram but it left a different
 * gap: the dashboard now has nothing to render between user messages
 * and the final reply when streaming is off. The user-facing surface
 * goes silent for minutes at a time on big multi-tool tasks.
 *
 * This module is the replacement signal. It coalesces per-tool activity
 * into a paced pulse:
 *   - emit one pulse every N tool calls, OR
 *   - emit one pulse every M ms since the last user-visible event,
 *   whichever fires first.
 *
 * Telegram surface stays muted (the bot.ts onProgress handler already
 * drops `tool_active` mirrors and that lock holds). The pulse goes
 * exclusively through emitChatEvent for the dashboard / SSE
 * subscribers. Defaults are env-tunable.
 *
 * Lifecycle: one pulse instance per run (created in bot.ts per
 * incoming message). `onTool()` is called from the per-tool branch.
 * `onUserVisibleEvent()` is called whenever the user just got a real
 * signal — final reply, streamed text chunk, task lifecycle event —
 * so the pulse timer / counter resets and we don't fire one redundant
 * pulse 50ms after the user already saw something.
 */

const DEFAULT_EVERY_N_TOOLS = 8;
const DEFAULT_EVERY_MS = 45_000;

export interface ProgressPulseOptions {
  /** Emit a pulse after this many tool calls since the last pulse / user-visible event. */
  everyNTools?: number;
  /** Emit a pulse after this many ms since the last pulse / user-visible event. */
  everyMs?: number;
  /** Time source — overridable for tests. */
  now?: () => number;
  /**
   * Sink for the pulse. Receives a description suitable for
   * emitChatEvent({ type: 'progress', description }). The caller wraps
   * with chatId/agentId. Kept as a callback so this module stays
   * independent of state.ts and easy to unit-test.
   */
  emit: (description: string) => void;
}

export interface ProgressPulse {
  /** Record a tool call. May trigger a pulse. */
  onTool: (toolDescription?: string) => void;
  /**
   * Record any event the user already sees (streamed chunk, task
   * lifecycle, final reply). Resets the pulse window so we don't
   * emit a redundant heartbeat right after.
   */
  onUserVisibleEvent: () => void;
  /**
   * Stop the background interval timer. Caller MUST invoke this when
   * the request finishes (handleMessage returns) or the timer leaks
   * for the life of the process. Codex HIGH #1: without an
   * independent timer, a single long-running tool with no further
   * events left the dashboard silent for >everyMs; the timer fixes
   * that, but the cleanup is the caller's responsibility.
   */
  dispose: () => void;
  /** @internal — for tests. */
  _state: () => { tools: number; lastEmitAt: number };
}

export function readProgressPulseDefaults(): { everyNTools: number; everyMs: number } {
  const n = parseInt(process.env.PROGRESS_PULSE_EVERY_N_TOOLS || '', 10);
  const ms = parseInt(process.env.PROGRESS_PULSE_EVERY_MS || '', 10);
  return {
    everyNTools: Number.isFinite(n) && n > 0 ? n : DEFAULT_EVERY_N_TOOLS,
    everyMs: Number.isFinite(ms) && ms > 0 ? ms : DEFAULT_EVERY_MS,
  };
}

export function createProgressPulse(opts: ProgressPulseOptions): ProgressPulse {
  const everyNTools = opts.everyNTools ?? DEFAULT_EVERY_N_TOOLS;
  const everyMs = opts.everyMs ?? DEFAULT_EVERY_MS;
  const now = opts.now ?? (() => Date.now());

  // Initialise lastEmitAt to "now" — we don't want a pulse immediately
  // on the first tool call. The user just sent a message; they
  // wouldn't expect a heartbeat 200ms in.
  let lastEmitAt = now();
  let toolsSinceEmit = 0;
  let lastToolDesc = '';

  function fire(reason: 'count' | 'time'): void {
    // Compose a short, useful description. Dashboard rendering picks
    // up `description` and shows it in the activity panel.
    const ageSec = Math.round((now() - lastEmitAt) / 1000);
    const sample = lastToolDesc ? ` · last: ${lastToolDesc.slice(0, 60)}` : '';
    const desc = reason === 'count'
      ? `pulse · ${toolsSinceEmit} tool calls${sample}`
      : `pulse · ${ageSec}s active${sample}`;
    opts.emit(desc);
    lastEmitAt = now();
    toolsSinceEmit = 0;
  }

  // Independent timer for the time-based pulse. Codex HIGH #1: without
  // this, a tool that runs longer than everyMs with no further events
  // (e.g. a long agent_browser session, a slow shell command) leaves
  // the dashboard silent the whole time. The timer pings at half-period
  // (so we never miss a fire by more than that), and the fire condition
  // re-checks both counters so it stays consistent with the event-driven
  // path. unref so the timer never blocks process exit.
  // Tests pass `now: () => N` to freeze time; under such a test the
  // setInterval still uses real time, but they exercise dispose()
  // separately so the leak doesn't matter for them.
  const timerPeriodMs = Math.max(250, Math.floor(everyMs / 2));
  const timer = setInterval(() => {
    if (toolsSinceEmit === 0) return; // No activity to pulse about.
    if (now() - lastEmitAt >= everyMs) fire('time');
  }, timerPeriodMs);
  timer.unref?.();

  return {
    onTool(toolDescription?: string): void {
      toolsSinceEmit++;
      if (toolDescription) lastToolDesc = toolDescription;
      if (toolsSinceEmit >= everyNTools) {
        fire('count');
        return;
      }
      if (now() - lastEmitAt >= everyMs) {
        fire('time');
      }
    },
    onUserVisibleEvent(): void {
      // The user just got a fresh signal — reset both counters so the
      // next pulse only fires after another full window of silence.
      lastEmitAt = now();
      toolsSinceEmit = 0;
    },
    dispose(): void {
      clearInterval(timer);
    },
    _state(): { tools: number; lastEmitAt: number } {
      return { tools: toolsSinceEmit, lastEmitAt };
    },
  };
}
