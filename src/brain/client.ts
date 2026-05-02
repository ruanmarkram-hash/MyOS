import { BRAIN, MCP_ACCESS_KEY, OB1_BRAIN_FUNCTION, OB1_SUPABASE_URL } from '../config.js';
import { logger } from '../logger.js';

export interface BrainThought {
  content: string;
  metadata: Record<string, unknown>;
  similarity?: number;
  created_at: string;
}

export interface CaptureResult {
  ok: boolean;
  confirmation: string;
}

export interface SearchArgs {
  query: string;
  limit?: number;
  threshold?: number;
}

export interface CaptureArgs {
  content: string;
}

let rpcId = 0;
function nextId(): number {
  rpcId = (rpcId + 1) % Number.MAX_SAFE_INTEGER;
  return rpcId;
}

function endpoint(): string {
  if (!OB1_SUPABASE_URL) throw new Error('OB1_SUPABASE_URL not configured');
  if (!MCP_ACCESS_KEY) throw new Error('MCP_ACCESS_KEY not configured');
  return `${OB1_SUPABASE_URL.replace(/\/+$/, '')}/functions/v1/${OB1_BRAIN_FUNCTION}`;
}

function parseResponse(raw: string): unknown {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error('brain: empty response');
  if (trimmed.startsWith('{')) return JSON.parse(trimmed);
  for (const line of trimmed.split(/\r?\n/)) {
    if (line.startsWith('data:')) {
      const payload = line.slice(5).trim();
      if (payload && payload !== '[DONE]') return JSON.parse(payload);
    }
  }
  throw new Error(`brain: unparseable response: ${trimmed.slice(0, 200)}`);
}

async function rpc(method: string, params: Record<string, unknown>, timeoutMs = 20_000): Promise<unknown> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(endpoint(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
        'x-brain-key': MCP_ACCESS_KEY,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: nextId(), method, params }),
      signal: ctrl.signal,
    });
    const text = await r.text();
    if (!r.ok) throw new Error(`brain HTTP ${r.status}: ${text.slice(0, 200)}`);
    const msg = parseResponse(text) as { result?: unknown; error?: { message?: string } };
    if (msg.error) throw new Error(`brain RPC error: ${msg.error.message ?? JSON.stringify(msg.error)}`);
    return msg.result;
  } finally {
    clearTimeout(timer);
  }
}

function extractText(result: unknown): string {
  const r = result as { content?: Array<{ type?: string; text?: string }>; isError?: boolean };
  if (r?.isError) {
    const msg = r.content?.[0]?.text ?? 'unknown tool error';
    throw new Error(`brain tool error: ${msg}`);
  }
  return r?.content?.[0]?.text ?? '';
}

export async function captureThought(args: CaptureArgs): Promise<CaptureResult> {
  const result = await rpc('tools/call', { name: 'capture_thought', arguments: args });
  return { ok: true, confirmation: extractText(result) };
}

export async function searchThoughts(args: SearchArgs): Promise<string> {
  const result = await rpc('tools/call', {
    name: 'search_thoughts',
    arguments: {
      query: args.query,
      limit: args.limit ?? 5,
      threshold: args.threshold ?? 0.5,
    },
  });
  return extractText(result);
}

export async function pingBrain(): Promise<boolean> {
  try {
    const r = await fetch(endpoint(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
        'x-brain-key': MCP_ACCESS_KEY,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: nextId(),
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'claudeclaw', version: '1.0' },
        },
      }),
    });
    return r.ok;
  } catch (err) {
    logger.warn({ err }, 'brain ping failed');
    return false;
  }
}

export function brainEnabled(): boolean {
  return BRAIN === 'ob1' && !!OB1_SUPABASE_URL && !!MCP_ACCESS_KEY;
}
