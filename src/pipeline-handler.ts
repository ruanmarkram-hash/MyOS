// ============================================================
// Pipeline reply handler (Sonke Hub staff-intake pipeline)
//
// Intercepts Telegram text replies on @SonkeSage_bot when the reply
// targets a pipeline deliverable message we previously sent, and
// forwards the resolution to the pipeline-webhook Edge Function.
//
// Scope (Q10 lock): human gates, errors, decisions only. URL-button
// taps on the human-gate inline_keyboard go directly to the webhook
// and never touch the bot runtime. This handler is the text-reply
// complement for when Ruan types back instead of tapping.
//
// Shape contract, from supabase/functions/pipeline-webhook/index.ts:
//   Path 4 (manual service-role POST):
//     POST ${PIPELINE_WEBHOOK_URL}
//     Authorization: Bearer ${SERVICE_ROLE_KEY}
//     Body: { gate_id, resolution: 'advance'|'halt'|'approve',
//             resolved_via: 'telegram-text', resolution_notes }
//
// The bot does the telegram_message_id -> event_id -> open gate_id
// lookup itself and then hits path 4. We chose path 4 over path 3
// (the Telegram-native webhook path) because the bot is in polling
// mode; a Telegram bot token can only do polling OR webhook at once.
// ============================================================

import {
  PIPELINE_ENABLED,
  PIPELINE_SUPABASE_URL,
  PIPELINE_SUPABASE_SERVICE_ROLE_KEY,
  PIPELINE_WEBHOOK_URL,
} from './config.js';
import { logger } from './logger.js';

// ── Keyword parser ──────────────────────────────────────────────
//
// Mirrors supabase/functions/pipeline-webhook/index.ts parseKeyword().
// Halt keywords beat approve keywords: if the user writes both (e.g.
// "approve and hold, wait"), halt wins defensively.

export type PipelineResolution = 'advance' | 'halt' | 'approve';

const HALT_KEYWORDS = ['hold', 'stop', 'pause', 'wait'];
const APPROVE_KEYWORDS = ['approve', 'approved', 'ok', 'go ahead', 'proceed'];

export function parsePipelineKeyword(text: string): PipelineResolution | null {
  const lower = text.toLowerCase();
  for (const w of HALT_KEYWORDS) {
    if (new RegExp(`\\b${escapeRegex(w)}\\b`).test(lower)) return 'halt';
  }
  for (const w of APPROVE_KEYWORDS) {
    if (new RegExp(`\\b${escapeRegex(w)}\\b`).test(lower)) return 'approve';
  }
  return null;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ── Reply lookup ────────────────────────────────────────────────
//
// Given the Telegram message_id the user replied to, find the event
// the deliverable belongs to, then find the single unresolved gate
// for that event. Returns null if no match (message is not a pipeline
// deliverable) or no open gate (gate already resolved, so ignore).

export interface PipelineGateRef {
  gate_id: string;
  event_id: string;
}

export async function findOpenGateForTelegramReply(
  replyToMessageId: number | string,
): Promise<PipelineGateRef | null> {
  if (!PIPELINE_SUPABASE_URL || !PIPELINE_SUPABASE_SERVICE_ROLE_KEY) return null;

  const messageIdStr = String(replyToMessageId);
  const base = PIPELINE_SUPABASE_URL.replace(/\/$/, '');
  const headers = {
    apikey: PIPELINE_SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${PIPELINE_SUPABASE_SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json',
  };

  // Step 1: deliverable by telegram_message_id.
  const delRes = await fetch(
    `${base}/rest/v1/pipeline_deliverables?telegram_message_id=eq.${encodeURIComponent(
      messageIdStr,
    )}&select=event_id&limit=1`,
    { headers },
  );
  if (!delRes.ok) {
    logger.error(
      { status: delRes.status, body: await delRes.text().catch(() => '') },
      'pipeline-handler: deliverable lookup failed',
    );
    return null;
  }
  const delRows = (await delRes.json()) as Array<{ event_id: string }>;
  if (delRows.length === 0) return null;
  const eventId = delRows[0].event_id;

  // Step 2: unresolved gate for that event. resolved_at IS NULL.
  const gateRes = await fetch(
    `${base}/rest/v1/pipeline_gates?event_id=eq.${eventId}&resolved_at=is.null&select=id&limit=1`,
    { headers },
  );
  if (!gateRes.ok) {
    logger.error(
      { status: gateRes.status, body: await gateRes.text().catch(() => '') },
      'pipeline-handler: gate lookup failed',
    );
    return null;
  }
  const gateRows = (await gateRes.json()) as Array<{ id: string }>;
  if (gateRows.length === 0) return null;

  return { gate_id: gateRows[0].id, event_id: eventId };
}

// ── Forward to webhook ──────────────────────────────────────────

export async function forwardPipelineResolution(params: {
  gate_id: string;
  resolution: PipelineResolution;
  notes: string;
}): Promise<{ ok: boolean; status: number; body: unknown }> {
  if (!PIPELINE_WEBHOOK_URL || !PIPELINE_SUPABASE_SERVICE_ROLE_KEY) {
    return { ok: false, status: 0, body: { error: 'pipeline webhook not configured' } };
  }
  const res = await fetch(PIPELINE_WEBHOOK_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${PIPELINE_SUPABASE_SERVICE_ROLE_KEY}`,
    },
    body: JSON.stringify({
      gate_id: params.gate_id,
      resolution: params.resolution,
      resolved_via: 'telegram-text',
      resolution_notes: params.notes.slice(0, 500),
    }),
  });
  const body = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, body };
}

// ── Callback query (inline button tap) ──────────────────────────
//
// Pipeline inline buttons use callback_data of the form
// "pl:<action>:<gate_id>". Format is fixed by pipeline-advance's
// sendTelegramHumanGatePing. When we detect a matching payload the
// bot forwards to pipeline-webhook path 4 with resolved_via set to
// telegram-button (preserving observability) and returns a short
// toast message that the caller passes to answerCallbackQuery.

const PIPELINE_CALLBACK_PREFIX = 'pl:';

export interface PipelineCallbackMatch {
  action: 'approve' | 'halt';
  gate_id: string;
}

export function parsePipelineCallback(
  data: string | undefined,
): PipelineCallbackMatch | null {
  if (!data || !data.startsWith(PIPELINE_CALLBACK_PREFIX)) return null;
  const rest = data.slice(PIPELINE_CALLBACK_PREFIX.length);
  const [action, gate_id] = rest.split(':');
  if (action !== 'approve' && action !== 'halt') return null;
  if (!gate_id) return null;
  return { action, gate_id };
}

export interface PipelineCallbackResult {
  ok: boolean;
  toast: string;
}

/**
 * Forward a pipeline button tap to pipeline-webhook path 4 (manual)
 * declaring resolved_via='telegram-button' so the observability trail
 * records the channel correctly. Returns a short toast string the bot
 * should pass to answerCallbackQuery. Does NOT edit the message itself:
 * that side effect lives in pipeline-advance.resolveGate() so it fires
 * uniformly across every resolution channel.
 */
export async function handlePipelineCallback(
  match: PipelineCallbackMatch,
): Promise<PipelineCallbackResult> {
  if (!PIPELINE_ENABLED) {
    return { ok: false, toast: 'Pipeline disabled.' };
  }
  if (!PIPELINE_WEBHOOK_URL || !PIPELINE_SUPABASE_SERVICE_ROLE_KEY) {
    return { ok: false, toast: 'Pipeline webhook not configured.' };
  }

  const resolution: PipelineResolution = match.action;
  const res = await fetch(PIPELINE_WEBHOOK_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${PIPELINE_SUPABASE_SERVICE_ROLE_KEY}`,
    },
    body: JSON.stringify({
      gate_id: match.gate_id,
      resolution,
      resolved_via: 'telegram-button',
      resolution_notes: `Telegram ${match.action} button tapped`,
    }),
  });
  const body = await res.json().catch(() => ({}));

  if (!res.ok) {
    logger.error(
      { status: res.status, body, gate_id: match.gate_id },
      'pipeline-handler: callback webhook call failed',
    );
    return { ok: false, toast: 'Webhook failed. Check logs.' };
  }

  const toast =
    match.action === 'halt'
      ? '\u26A0\uFE0F Halted'
      : '\u2705 Approved';
  logger.info(
    { gate_id: match.gate_id, action: match.action },
    'pipeline-handler: callback forwarded',
  );
  return { ok: true, toast };
}

// ── Top-level handler ───────────────────────────────────────────
//
// Called from bot.ts before the LLM routing. Returns a string reply
// (the bot should send it and skip further handling) or null (bot
// should continue normal routing: no pipeline reply involved).

export interface PipelineReplyInput {
  text: string;
  replyToMessageId: number | undefined;
}

export async function handlePipelineReply(
  input: PipelineReplyInput,
): Promise<string | null> {
  if (!PIPELINE_ENABLED) return null;
  if (!input.replyToMessageId) return null;

  const resolution = parsePipelineKeyword(input.text);
  if (!resolution) return null;

  const gate = await findOpenGateForTelegramReply(input.replyToMessageId);
  if (!gate) return null;

  const result = await forwardPipelineResolution({
    gate_id: gate.gate_id,
    resolution,
    notes: input.text,
  });

  if (!result.ok) {
    logger.error(
      { status: result.status, body: result.body, gate_id: gate.gate_id },
      'pipeline-handler: webhook call failed',
    );
    return (
      'Pipeline reply detected but webhook failed. ' +
      'Check pipeline-webhook logs; manual override may be needed.'
    );
  }

  logger.info(
    { gate_id: gate.gate_id, resolution },
    'pipeline-handler: resolution forwarded',
  );

  const verb =
    resolution === 'halt'
      ? 'halted'
      : resolution === 'approve'
      ? 'approved'
      : 'advanced';
  return `Pipeline gate ${verb}. Resolution recorded.`;
}
