// Pure classifier for the brain-monitor "growth in window" signal.
//
// Origin: 2026-05-07 morning. Warden's daily audit fires CRITICAL "ob1-brain:
// monitor-brain.mjs reported last 4h growth: +0" at the start of Brisbane
// work hours, even when ingestion is healthy. The actual cause is innocent:
// Ruan sleeps, no Claude Code / Codex sessions are active, the brain-watcher
// has nothing to ingest, and the next monitor tick legitimately sees 0 new
// thoughts. Patching the watcher is wrong — the bug is the alert threshold.
//
// Distinguish "ingestion broken" from "no input arrived" by comparing the
// growth window against the count of NEW upstream jsonl files (Claude Code
// session logs + Codex archived sessions) whose mtime falls inside the same
// window. If there was no input, growth=0 is expected, not a failure.
//
// Pure / no I/O so it stays unit-testable. Callers handle file discovery.

/**
 * @param {{ recentThoughts: number, newInputFiles: number, windowHours: number }} args
 * @returns {{ level: 'ok'|'info'|'critical', message: string }}
 */
export function classifyGrowth({ recentThoughts, newInputFiles, windowHours }) {
  if (recentThoughts > 0) {
    return {
      level: 'ok',
      message: `+${recentThoughts} thoughts in last ${windowHours}h`,
    };
  }
  if (newInputFiles === 0) {
    return {
      level: 'info',
      message: `no input arrived in last ${windowHours}h (0 upstream jsonl files modified) — growth=0 expected`,
    };
  }
  return {
    level: 'critical',
    message: `${newInputFiles} upstream jsonl file(s) modified in last ${windowHours}h but 0 thoughts ingested — watcher dropping data`,
  };
}
