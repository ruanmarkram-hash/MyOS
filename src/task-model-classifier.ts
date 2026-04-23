/**
 * Task Model Classifier
 *
 * Determines the appropriate Claude model for scheduled and mission tasks
 * based on prompt analysis. Uses keyword heuristics to classify tasks into
 * three tiers:
 *
 *   - haiku:  Routine/mechanical tasks (checks, scans, status, sweeps)
 *   - sonnet: Tasks requiring reasoning or summarisation
 *   - opus:   Complex multi-step tasks requiring judgment or decision-making
 *
 * Falls back to sonnet when uncertain (safe middle ground).
 */

export type ModelTier = 'claude-haiku-4-5' | 'claude-sonnet-4-5' | 'claude-opus-4-7';

/** Keywords that indicate a lightweight, mechanical task. */
const HAIKU_KEYWORDS = [
  'check', 'scan', 'count', 'list', 'status', 'ping', 'sweep', 'purge',
  'clean', 'delete old', 'remove expired', 'health check', 'uptime',
  'disk usage', 'disk space', 'memory usage', 'reminder', 'notify',
  'send reminder', 'log', 'backup status', 'certificate expir',
  'cron', 'heartbeat', 'fetch and store', 'poll', 'rotate',
];

/** Keywords that indicate moderate reasoning is needed. */
const SONNET_KEYWORDS = [
  'summari', 'draft', 'review', 'triage', 'analy', 'compare',
  'digest', 'report', 'brief', 'outline', 'categoris', 'categoriz',
  'extract', 'parse', 'interpret', 'rank', 'prioriti', 'filter',
  'assess', 'audit', 'compile', 'consolidat', 'research',
];

/** Keywords that indicate complex judgment or multi-step work. */
const OPUS_KEYWORDS = [
  'decide', 'strategy', 'plan', 'evaluate', 'respond on my behalf',
  'negotiate', 'recommend', 'architect', 'design', 'refactor',
  'debug', 'troubleshoot', 'investigate', 'root cause', 'incident',
  'write code', 'implement', 'build', 'create feature', 'complex',
  'multi-step', 'workflow', 'orchestrat', 'delegate', 'coordinate',
];

function promptContains(prompt: string, keywords: string[]): boolean {
  const lower = prompt.toLowerCase();
  return keywords.some((kw) => lower.includes(kw));
}

/**
 * Classify a task prompt and return the appropriate model identifier.
 *
 * Priority: opus > sonnet > haiku > default (sonnet).
 * If a prompt matches multiple tiers, the highest tier wins.
 */
export function classifyTaskModel(prompt: string): ModelTier {
  if (promptContains(prompt, OPUS_KEYWORDS)) return 'claude-opus-4-7';
  if (promptContains(prompt, SONNET_KEYWORDS)) return 'claude-sonnet-4-5';
  if (promptContains(prompt, HAIKU_KEYWORDS)) return 'claude-haiku-4-5';
  // When uncertain, sonnet is the safe middle ground
  return 'claude-sonnet-4-5';
}

/**
 * Human-readable label for a model tier.
 */
export function modelTierLabel(model: string | null | undefined): string {
  switch (model) {
    case 'claude-haiku-4-5': return 'haiku';
    case 'claude-sonnet-4-5': return 'sonnet';
    case 'claude-opus-4-7': return 'opus';
    default: return model ?? 'auto';
  }
}
