import fs from 'fs';
import os from 'os';
import path from 'path';

export type MissionManifestRoute = 'needs_review' | 'needs_triage' | 'sorted' | 'done';

export interface MissionManifestDeliverable {
  kind: 'file' | 'url';
  target: string;
  label: string;
  exists?: boolean;
}

export interface MissionManifest {
  version: 1;
  status: string;
  route: MissionManifestRoute;
  summary: string;
  deliverables: MissionManifestDeliverable[];
  sourceFiles: string[];
  blockers: string[];
  nextAction: string | null;
  followUpNeeded: boolean | null;
  reviewRequired: boolean | null;
  contractStatus: string | null;
}

const HUMAN_ACTION_PATTERN = new RegExp([
  'needs? (?:your|user)',
  'requires? (?:your|user|approval|review|sign[- ]?off|input|decision|attention|confirmation|authori[sz]ation)',
  'awaiting (?:you|your|user|review|approval|sign[- ]?off|decision|confirmation|input|response)',
  'waiting (?:on|for) (?:you|user|your)',
  'blocked (?:on|by) (?:you|user)',
  'pending (?:your|user|approval|review|sign[- ]?off|decision|confirmation)',
  'please (?:review|send|sign|approve|confirm|decide|choose|grant|authori[sz]e|check|provide)',
  'ready (?:for you|to send|to sign|for review|for approval|for your review|for user)',
  'action required',
  'action needed',
  'manual (?:step|action|fix|refresh|intervention)',
  'requires? manual',
  'full disk access',
  'app[- ]?specific password',
  'grant permission',
  'ready to (?:send|sign|email|publish|share|deliver|submit)',
  'draft (?:ready|prepared|complete|done)',
  'deliverable (?:ready|prepared|landed|attached|for review)',
  'handoff (?:ready|prepared|for review)',
  'review pack',
  'send /restart',
].join('|'), 'i');

const DELIVERABLE_HINT_PATTERN = /(deliverable|handoff|review pack|prepared|draft|response|audit|compliance|support plan|restrictive practice|charter|inquiry|letter|policy|document)/i;
const NO_HUMAN_ACTION_PATTERN = /\b(?:no|none|without)\s+(?:human\s+|manual\s+|your\s+|user\s+)?(?:action|review|approval|follow[- ]?up|intervention)\s+(?:required|needed|pending)|\bno\s+(?:deliverable|human action|manual action|review)\b/i;

function compactText(text: string, limit: number): string {
  const cleaned = text.replace(/\s+/g, ' ').trim();
  return cleaned.length > limit ? `${cleaned.slice(0, limit - 3)}...` : cleaned;
}

function labelForTarget(target: string): string {
  try {
    if (/^https?:\/\//i.test(target)) return new URL(target).hostname;
  } catch {
    // fall through to basename
  }
  return path.basename(target) || target;
}

function expandUserPath(raw: string): string {
  if (raw.startsWith('~/')) return path.join(os.homedir(), raw.slice(2));
  return raw;
}

function fileExists(raw: string): boolean {
  try {
    return fs.statSync(path.resolve(expandUserPath(raw))).isFile();
  } catch {
    return false;
  }
}

function normalizeDeliverable(item: unknown): MissionManifestDeliverable | null {
  if (typeof item === 'string') {
    const target = item.trim();
    if (!target) return null;
    const kind = /^https?:\/\//i.test(target) ? 'url' : 'file';
    return { kind, target, label: labelForTarget(target) };
  }
  if (!item || typeof item !== 'object') return null;
  const record = item as Record<string, unknown>;
  const target = String(record.target || record.path || record.url || record.href || '').trim();
  if (!target) return null;
  const rawKind = String(record.kind || '').toLowerCase();
  const kind = rawKind === 'url' || /^https?:\/\//i.test(target) ? 'url' : 'file';
  const label = String(record.label || record.name || labelForTarget(target)).trim();
  return { kind, target, label: label || labelForTarget(target) };
}

function normalizeStringList(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  return input
    .map((item) => typeof item === 'string' ? item.trim() : '')
    .filter(Boolean)
    .slice(0, 20);
}

function normalizeBoolean(input: unknown): boolean | null {
  if (typeof input === 'boolean') return input;
  if (typeof input === 'string') {
    if (/^(true|yes|y|1)$/i.test(input.trim())) return true;
    if (/^(false|no|n|0)$/i.test(input.trim())) return false;
  }
  return null;
}

type MissionResultContract = {
  status: string | null;
  summary: string | null;
  deliverables: MissionManifestDeliverable[];
  sourceFiles: string[];
  blockers: string[];
  nextAction: string | null;
  followUpNeeded: boolean | null;
  reviewRequired: boolean | null;
};

function normalizeContract(raw: unknown): MissionResultContract | null {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  const source = (record.mission_result && typeof record.mission_result === 'object')
    ? record.mission_result as Record<string, unknown>
    : record;
  const hasContractKey = ['status', 'summary', 'deliverables', 'source_files', 'sourceFiles', 'blockers', 'next_action', 'nextAction', 'follow_up_needed', 'followUpNeeded', 'review_required', 'reviewRequired']
    .some((key) => Object.prototype.hasOwnProperty.call(source, key));
  if (!hasContractKey) return null;
  const deliverables = Array.isArray(source.deliverables)
    ? source.deliverables.map(normalizeDeliverable).filter((item): item is MissionManifestDeliverable => !!item)
    : [];
  const status = typeof source.status === 'string' ? source.status.trim().toLowerCase() : null;
  const summary = typeof source.summary === 'string' ? source.summary.trim() : null;
  const nextActionRaw = source.next_action ?? source.nextAction;
  return {
    status,
    summary,
    deliverables,
    sourceFiles: normalizeStringList(source.source_files ?? source.sourceFiles),
    blockers: normalizeStringList(source.blockers),
    nextAction: typeof nextActionRaw === 'string' && nextActionRaw.trim() ? nextActionRaw.trim() : null,
    followUpNeeded: normalizeBoolean(source.follow_up_needed ?? source.followUpNeeded),
    reviewRequired: normalizeBoolean(source.review_required ?? source.reviewRequired),
  };
}

function parseJsonCandidates(text: string): unknown[] {
  const candidates: string[] = [];
  for (const match of text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) {
    candidates.push(match[1]);
  }
  const marker = text.match(/MISSION_RESULT_JSON\s*:\s*({[\s\S]+})/i);
  if (marker) candidates.push(marker[1]);
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first >= 0 && last > first) candidates.push(text.slice(first, last + 1));
  const parsed: unknown[] = [];
  for (const candidate of candidates) {
    try {
      parsed.push(JSON.parse(candidate.trim()));
    } catch {
      // Ignore prose or malformed examples; this parser is opportunistic.
    }
  }
  return parsed;
}

function parseMissionResultContract(text: string): MissionResultContract | null {
  for (const parsed of parseJsonCandidates(text)) {
    const contract = normalizeContract(parsed);
    if (contract) return contract;
  }
  return null;
}

function extractUrls(text: string): MissionManifestDeliverable[] {
  const out: MissionManifestDeliverable[] = [];
  for (const match of text.matchAll(/\bhttps?:\/\/[^\s)\]}>"']+/gi)) {
    const target = match[0].replace(/[.,;:]+$/, '');
    out.push({ kind: 'url', target, label: labelForTarget(target) });
  }
  return out;
}

function extractFileTargets(text: string): MissionManifestDeliverable[] {
  const out: MissionManifestDeliverable[] = [];
  const patterns = [
    /(?:deliverable|file|path|doc|document|attachment|saved at|written to|created at)\s*:\s*["'`]?((?:\/|~\/)[^"'`\n]+?\.(?:pdf|docx|xlsx|pptx|md|txt|html|csv))["'`]?/gi,
    /["'`]((?:\/|~\/)[^"'`\n]+?\.(?:pdf|docx|xlsx|pptx|md|txt|html|csv))["'`]/gi,
    /\]\(((?:\/|~\/)[^)]+?\.(?:pdf|docx|xlsx|pptx|md|txt|html|csv))\)/gi,
    /((?:\/|~\/)[^\s"'`<>)]+?\.(?:pdf|docx|xlsx|pptx|md|txt|html|csv))\b/gi,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const raw = (match[1] || '').trim().replace(/[.,;:]+$/, '');
      if (!raw) continue;
      out.push({ kind: 'file', target: raw, label: labelForTarget(raw) });
    }
  }
  return out;
}

function dedupeDeliverables(items: MissionManifestDeliverable[]): MissionManifestDeliverable[] {
  const seen = new Set<string>();
  const out: MissionManifestDeliverable[] = [];
  for (const item of items) {
    const key = `${item.kind}:${item.target}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item.kind === 'file' ? { ...item, exists: fileExists(item.target) } : { ...item, exists: true });
  }
  return out.slice(0, 12);
}

function extractBlockers(text: string, status: string, error: string | null | undefined): string[] {
  const out: string[] = [];
  if (error) out.push(compactText(error, 220));
  for (const line of text.split(/\r?\n/)) {
    const cleaned = line.replace(/^[-*•\d.)\s]+/, '').replace(/\*\*/g, '').trim();
    if (!cleaned) continue;
    if (/(blocked|failed|error|missing|permission|auth|timeout|could not|unable|manual|needs|requires)/i.test(cleaned)) {
      out.push(compactText(cleaned, 220));
    }
    if (out.length >= 5) break;
  }
  if ((status === 'failed' || status === 'partial') && out.length === 0) out.push(`${status} mission with no blocker detail recorded`);
  return [...new Set(out)].slice(0, 5);
}

function inferNextAction(text: string, status: string, deliverables: MissionManifestDeliverable[], blockers: string[]): string | null {
  if (deliverables.some((item) => item.kind === 'file' && item.exists === false)) return 'Fix or provide the missing deliverable path.';
  if (status === 'failed' || status === 'partial') return blockers[0] || 'Review failure and decide retry, archive, or reassign.';
  if (NO_HUMAN_ACTION_PATTERN.test(text) && deliverables.length === 0) return null;
  if (HUMAN_ACTION_PATTERN.test(text)) return 'Review and take the requested action.';
  if (deliverables.length > 0 || DELIVERABLE_HINT_PATTERN.test(text)) return 'Review the deliverable.';
  return null;
}

export function buildMissionManifest(input: {
  status: string;
  title: string;
  prompt: string;
  result?: string | null;
  error?: string | null;
}): MissionManifest {
  const outcomeText = [input.result || '', input.error || ''].join('\n') || input.title;
  const contract = parseMissionResultContract(outcomeText);
  const deliverables = dedupeDeliverables([...(contract?.deliverables ?? []), ...extractFileTargets(outcomeText), ...extractUrls(outcomeText)]);
  const missingDeliverableBlockers = deliverables
    .filter((item) => item.kind === 'file' && item.exists === false)
    .map((item) => `Deliverable file not found: ${item.target}`);
  const blockers = [...new Set([
    ...missingDeliverableBlockers,
    ...(contract?.blockers ?? []),
    ...extractBlockers(outcomeText, input.status, input.error),
  ])].slice(0, 5);
  const nextAction = contract?.nextAction || inferNextAction(outcomeText, input.status, deliverables, blockers);
  const hasMissingDeliverable = missingDeliverableBlockers.length > 0;
  const route: MissionManifestRoute =
    input.status === 'failed' || input.status === 'partial' ? 'needs_triage'
    : hasMissingDeliverable ? 'needs_triage'
    : contract?.reviewRequired === true || contract?.followUpNeeded === true ? 'needs_review'
    : contract?.reviewRequired === false && contract?.followUpNeeded === false && deliverables.length === 0 ? 'sorted'
    : nextAction || deliverables.length > 0 || (!NO_HUMAN_ACTION_PATTERN.test(outcomeText) && DELIVERABLE_HINT_PATTERN.test(outcomeText)) ? 'needs_review'
    : input.status === 'completed' ? 'sorted'
    : 'done';

  return {
    version: 1,
    status: input.status,
    route,
    summary: compactText(contract?.summary || input.result || input.error || input.title, 260),
    deliverables,
    sourceFiles: contract?.sourceFiles ?? [],
    blockers,
    nextAction,
    followUpNeeded: contract?.followUpNeeded ?? null,
    reviewRequired: contract?.reviewRequired ?? null,
    contractStatus: contract?.status ?? null,
  };
}

export function parseMissionManifest(raw: string | null | undefined): MissionManifest | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as MissionManifest;
    if (parsed?.version !== 1 || !parsed.route) return null;
    return {
      ...parsed,
      deliverables: Array.isArray(parsed.deliverables) ? parsed.deliverables : [],
      sourceFiles: Array.isArray(parsed.sourceFiles) ? parsed.sourceFiles : [],
      blockers: Array.isArray(parsed.blockers) ? parsed.blockers : [],
      nextAction: parsed.nextAction ?? null,
      followUpNeeded: parsed.followUpNeeded ?? null,
      reviewRequired: parsed.reviewRequired ?? null,
      contractStatus: parsed.contractStatus ?? null,
    };
  } catch {
    return null;
  }
}
