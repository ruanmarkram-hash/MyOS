import { BRAIN, MCP_ACCESS_KEY, OB1_BRAIN_FUNCTION, OB1_GRAPH_FUNCTION, OB1_SUPABASE_URL } from '../config.js';
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

function endpoint(functionName = OB1_BRAIN_FUNCTION): string {
  if (!OB1_SUPABASE_URL) throw new Error('OB1_SUPABASE_URL not configured');
  if (!MCP_ACCESS_KEY) throw new Error('MCP_ACCESS_KEY not configured');
  return `${OB1_SUPABASE_URL.replace(/\/+$/, '')}/functions/v1/${functionName}`;
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

async function rpc(
  method: string,
  params: Record<string, unknown>,
  timeoutMs = 20_000,
  functionName = OB1_BRAIN_FUNCTION,
): Promise<unknown> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(endpoint(functionName), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
        'x-brain-key': MCP_ACCESS_KEY,
        'x-access-key': MCP_ACCESS_KEY,
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

function parseJsonToolText<T>(text: string): T {
  const trimmed = text.trim();
  if (!trimmed) throw new Error('brain graph: empty tool response');
  return JSON.parse(trimmed) as T;
}

export interface GraphNode {
  id: string;
  label: string;
  node_type: string;
  properties?: Record<string, unknown>;
  thought_id?: string | null;
  created_at?: string;
  updated_at?: string;
}

export interface GraphEdgeType {
  relationship_type: string;
  count: number;
}

export interface GraphEdge {
  id?: string;
  edge_id?: string;
  relationship_type: string;
  weight?: number;
  properties?: Record<string, unknown>;
  edge_properties?: Record<string, unknown>;
  direction?: string;
  neighbor?: GraphNode;
}

async function callGraphTool<T>(name: string, args: Record<string, unknown>): Promise<T> {
  const result = await rpc('tools/call', { name, arguments: args }, 20_000, OB1_GRAPH_FUNCTION);
  return parseJsonToolText<T>(extractText(result));
}

export async function searchGraphNodes(args: {
  query?: string;
  node_type?: string;
  limit?: number;
}): Promise<{ success: boolean; count: number; nodes: GraphNode[]; error?: string }> {
  return callGraphTool('search_nodes', {
    query: args.query,
    node_type: args.node_type,
    limit: args.limit ?? 40,
  });
}

export async function listGraphEdgeTypes(): Promise<{ success: boolean; edge_types?: GraphEdgeType[]; types?: GraphEdgeType[]; error?: string }> {
  return callGraphTool('list_edge_types', {});
}

export async function createGraphNode(args: {
  label: string;
  node_type?: string;
  properties?: Record<string, unknown>;
  thought_id?: string;
}): Promise<{ success: boolean; node: GraphNode; error?: string }> {
  return callGraphTool('create_node', {
    label: args.label,
    node_type: args.node_type,
    properties: JSON.stringify(args.properties ?? {}),
    thought_id: args.thought_id,
  });
}

export async function createGraphEdge(args: {
  source_node_id: string;
  target_node_id: string;
  relationship_type: string;
  weight?: number;
  properties?: Record<string, unknown>;
}): Promise<{ success: boolean; edge?: GraphEdge; error?: string }> {
  return callGraphTool('create_edge', {
    source_node_id: args.source_node_id,
    target_node_id: args.target_node_id,
    relationship_type: args.relationship_type,
    weight: args.weight ?? 1,
    properties: JSON.stringify(args.properties ?? {}),
  });
}

export async function getGraphNeighbors(args: {
  node_id: string;
  relationship_type?: string;
  direction?: 'outgoing' | 'incoming' | 'both';
}): Promise<{ success: boolean; count: number; neighbors?: GraphEdge[]; results?: GraphEdge[]; error?: string }> {
  return callGraphTool('get_neighbors', {
    node_id: args.node_id,
    relationship_type: args.relationship_type,
    direction: args.direction ?? 'both',
  });
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

export async function pingGraph(): Promise<boolean> {
  try {
    const r = await fetch(endpoint(OB1_GRAPH_FUNCTION), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
        'x-brain-key': MCP_ACCESS_KEY,
        'x-access-key': MCP_ACCESS_KEY,
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
    logger.warn({ err }, 'brain graph ping failed');
    return false;
  }
}

export function brainEnabled(): boolean {
  return BRAIN === 'ob1' && !!OB1_SUPABASE_URL && !!MCP_ACCESS_KEY;
}
