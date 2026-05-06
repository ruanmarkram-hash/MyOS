import path from 'path';

export type MissionManifestRoute = 'needs_review' | 'needs_triage' | 'sorted' | 'done';

export interface MissionManifestDeliverable {
  kind: 'file' | 'url';
  target: string;
  label: string;
}

export interface MissionManifest {
  version: 1;
  status: string;
  route: MissionManifestRoute;
  summary: string;
  deliverables: MissionManifestDeliverable[];
  blockers: string[];
  nextAction: string | null;
}

const HUMAN_ACTION_PATTERN = new RegExp([
  'needs? (?:your|ruan)',
  'requires? (?:your|ruan|approval|review|sign[- ]?off|input|decision|attention|confirmation|authori[sz]ation)',
  'awaiting (?:you|your|ruan|review|approval|sign[- ]?off|decision|confirmation|input|response)',
  'waiting (?:on|for) (?:you|ruan|your)',
  'blocked (?:on|by) (?:you|ruan)',
  'pending (?:your|ruan|approval|review|sign[- ]?off|decision|confirmation)',
  'please (?:review|send|sign|approve|confirm|decide|choose|grant|authori[sz]e|check|provide)',
  'ready (?:for you|to send|to sign|for review|for approval|for your review|for ruan)',
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
    out.push(item);
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
  if (status === 'failed' || status === 'partial') return blockers[0] || 'Review failure and decide retry, archive, or reassign.';
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
  const text = [input.title, input.prompt, input.result || '', input.error || ''].join('\n');
  const outcomeText = [input.result || '', input.error || ''].join('\n') || input.title;
  const deliverables = dedupeDeliverables([...extractFileTargets(text), ...extractUrls(text)]);
  const blockers = extractBlockers(outcomeText, input.status, input.error);
  const nextAction = inferNextAction(outcomeText, input.status, deliverables, blockers);
  const route: MissionManifestRoute =
    input.status === 'failed' || input.status === 'partial' ? 'needs_triage'
    : nextAction || deliverables.length > 0 || DELIVERABLE_HINT_PATTERN.test(outcomeText) ? 'needs_review'
    : input.status === 'completed' ? 'sorted'
    : 'done';

  return {
    version: 1,
    status: input.status,
    route,
    summary: compactText(input.result || input.error || input.title, 260),
    deliverables,
    blockers,
    nextAction,
  };
}

export function parseMissionManifest(raw: string | null | undefined): MissionManifest | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as MissionManifest;
    if (parsed?.version !== 1 || !parsed.route) return null;
    return parsed;
  } catch {
    return null;
  }
}
