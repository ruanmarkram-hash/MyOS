import { BRAIN, MCP_ACCESS_KEY, OB1_BRAIN_FUNCTION, OB1_GRAPH_FUNCTION, OB1_SUPABASE_SERVICE_KEY, OB1_SUPABASE_URL } from '../config.js';
import { EMBEDDING_PROVIDER } from '../config.js';
import { embedText, getEmbeddingModelName } from '../embeddings.js';
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

export interface OpenBrainThought {
  id: string;
  content: string;
  type: string | null;
  source_type: string | null;
  importance: number | null;
  quality_score: number | null;
  sensitivity_tier: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at?: string;
  similarity?: number;
  rank?: number;
  total_count?: number;
}

export interface OpenBrainThoughtList {
  thoughts: OpenBrainThought[];
  total: number;
  limit: number;
  offset: number;
}

export interface OpenBrainMapThought {
  id: string;
  type: string | null;
  source_type: string | null;
  importance: number | null;
  quality_score: number | null;
  sensitivity_tier: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface OpenBrainMap {
  thoughts: OpenBrainMapThought[];
  total: number;
  represented: number;
  truncated: boolean;
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

function restEndpoint(path: string): string {
  if (!OB1_SUPABASE_URL) throw new Error('OB1_SUPABASE_URL not configured');
  return `${OB1_SUPABASE_URL.replace(/\/+$/, '')}/rest/v1/${path.replace(/^\/+/, '')}`;
}

function serviceHeaders(extra: Record<string, string> = {}): Record<string, string> {
  if (!OB1_SUPABASE_SERVICE_KEY) throw new Error('OB1_SUPABASE_SERVICE_KEY not configured');
  return {
    apikey: OB1_SUPABASE_SERVICE_KEY,
    authorization: `Bearer ${OB1_SUPABASE_SERVICE_KEY}`,
    ...extra,
  };
}

function contentRangeTotal(range: string | null, fallback: number): number {
  const total = range?.match(/\/(\d+)$/)?.[1];
  return total ? Number(total) : fallback;
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
  if (EMBEDDING_PROVIDER === 'llamacpp') return captureThoughtWithLocalEmbedding(args);
  const result = await rpc('tools/call', { name: 'capture_thought', arguments: args });
  return { ok: true, confirmation: extractText(result) };
}

export async function searchThoughts(args: SearchArgs): Promise<string> {
  if (EMBEDDING_PROVIDER === 'llamacpp') return searchThoughtsWithLocalEmbedding(args);
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

async function captureThoughtWithLocalEmbedding(args: CaptureArgs): Promise<CaptureResult> {
  const content = args.content.trim();
  if (!content) throw new Error('content required');
  const embedding = await embedText(content);
  const metadata = {
    source: 'hq-local-bge',
    embedding_model: getEmbeddingModelName(),
    type: 'observation',
    topics: ['local-capture'],
  };
  const upsert = await fetch(restEndpoint('rpc/upsert_thought'), {
    method: 'POST',
    headers: serviceHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify({
      p_content: content,
      p_payload: { metadata },
    }),
  });
  const upsertText = await upsert.text();
  if (!upsert.ok) throw new Error(`OpenBrain local capture upsert HTTP ${upsert.status}: ${upsertText.slice(0, 300)}`);
  const upsertBody = JSON.parse(upsertText) as { id?: string };
  if (!upsertBody.id) throw new Error('OpenBrain local capture did not return a thought id.');
  const patch = await fetch(restEndpoint(`thoughts?id=eq.${encodeURIComponent(upsertBody.id)}`), {
    method: 'PATCH',
    headers: serviceHeaders({ 'content-type': 'application/json', prefer: 'return=minimal' }),
    body: JSON.stringify({
      embedding,
      metadata,
    }),
  });
  const patchText = await patch.text();
  if (!patch.ok) throw new Error(`OpenBrain local capture embedding HTTP ${patch.status}: ${patchText.slice(0, 300)}`);
  return { ok: true, confirmation: `Captured with ${getEmbeddingModelName()} as ${upsertBody.id}` };
}

async function searchThoughtsWithLocalEmbedding(args: SearchArgs): Promise<string> {
  const query = args.query.trim();
  if (!query) throw new Error('query required');
  const queryEmbedding = await embedText(query);
  const limit = Math.max(1, Math.min(args.limit ?? 5, 50));
  const threshold = args.threshold ?? 0.5;
  const res = await fetch(restEndpoint('rpc/match_thoughts'), {
    method: 'POST',
    headers: serviceHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify({
      query_embedding: queryEmbedding,
      match_threshold: threshold,
      match_count: limit,
      filter: {},
    }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`OpenBrain local search HTTP ${res.status}: ${text.slice(0, 300)}`);
  const rows = JSON.parse(text) as Array<{
    content: string;
    metadata?: Record<string, unknown>;
    similarity: number;
    created_at: string;
  }>;
  if (rows.length === 0) return `No thoughts found matching "${query}".`;
  return rows.map((row, index) => {
    const metadata = row.metadata || {};
    const lines = [
      `--- Result ${index + 1} (${(row.similarity * 100).toFixed(1)}% match) ---`,
      `Captured: ${new Date(row.created_at).toLocaleDateString()}`,
      `Type: ${metadata.type || 'unknown'}`,
    ];
    if (Array.isArray(metadata.topics) && metadata.topics.length) lines.push(`Topics: ${metadata.topics.join(', ')}`);
    if (Array.isArray(metadata.people) && metadata.people.length) lines.push(`People: ${metadata.people.join(', ')}`);
    lines.push('', row.content);
    return lines.join('\n');
  }).join('\n\n');
}

export async function listOpenBrainThoughts(args: {
  limit?: number;
  offset?: number;
  type?: string;
  source_type?: string;
  importance_min?: number;
} = {}): Promise<OpenBrainThoughtList> {
  const limit = Math.max(1, Math.min(args.limit ?? 25, 100));
  const offset = Math.max(0, args.offset ?? 0);
  const params = new URLSearchParams();
  params.set('select', 'id,content,type,source_type,importance,quality_score,sensitivity_tier,metadata,created_at,updated_at');
  params.set('order', 'created_at.desc');
  params.set('limit', String(limit));
  params.set('offset', String(offset));
  if (args.type) params.set('type', `eq.${args.type}`);
  if (args.source_type) params.set('source_type', `eq.${args.source_type}`);
  if (args.importance_min !== undefined) params.set('importance', `gte.${args.importance_min}`);

  const res = await fetch(restEndpoint(`thoughts?${params.toString()}`), {
    headers: serviceHeaders({ prefer: 'count=exact' }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`OpenBrain thoughts HTTP ${res.status}: ${text.slice(0, 300)}`);
  const thoughts = JSON.parse(text) as OpenBrainThought[];
  return {
    thoughts,
    total: contentRangeTotal(res.headers.get('content-range'), thoughts.length),
    limit,
    offset,
  };
}

export async function getOpenBrainThought(id: string): Promise<OpenBrainThought | null> {
  const params = new URLSearchParams();
  params.set('select', 'id,content,type,source_type,importance,quality_score,sensitivity_tier,metadata,created_at,updated_at');
  params.set('id', `eq.${id}`);
  params.set('limit', '1');
  const res = await fetch(restEndpoint(`thoughts?${params.toString()}`), {
    headers: serviceHeaders(),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`OpenBrain thought HTTP ${res.status}: ${text.slice(0, 300)}`);
  const rows = JSON.parse(text) as OpenBrainThought[];
  return rows[0] ?? null;
}

export async function searchOpenBrainText(args: {
  query: string;
  limit?: number;
  offset?: number;
  filter?: Record<string, unknown>;
}): Promise<OpenBrainThoughtList> {
  const limit = Math.max(1, Math.min(args.limit ?? 25, 100));
  const offset = Math.max(0, args.offset ?? 0);
  const res = await fetch(restEndpoint('rpc/search_thoughts_text'), {
    method: 'POST',
    headers: serviceHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify({
      p_query: args.query,
      p_limit: limit,
      p_filter: args.filter ?? {},
      p_offset: offset,
    }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`OpenBrain text search HTTP ${res.status}: ${text.slice(0, 300)}`);
  const rows = JSON.parse(text) as OpenBrainThought[];
  return {
    thoughts: rows,
    total: Number(rows[0]?.total_count ?? rows.length),
    limit,
    offset,
  };
}

export async function getOpenBrainStats(): Promise<Record<string, unknown>> {
  const res = await fetch(restEndpoint('rpc/brain_stats_aggregate'), {
    method: 'POST',
    headers: serviceHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify({ p_since_days: 30, p_exclude_restricted: true }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`OpenBrain stats HTTP ${res.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text) as Record<string, unknown>;
}

export async function getOpenBrainThoughtConnections(id: string, limit = 20): Promise<Array<Record<string, unknown>>> {
  const res = await fetch(restEndpoint('rpc/get_thought_connections'), {
    method: 'POST',
    headers: serviceHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify({ p_thought_id: id, p_limit: limit, p_exclude_restricted: true }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`OpenBrain connections HTTP ${res.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text) as Array<Record<string, unknown>>;
}

export async function getOpenBrainMap(maxRows = 10_000): Promise<OpenBrainMap> {
  const pageSize = 1000;
  const rows: OpenBrainMapThought[] = [];
  let total = 0;

  for (let offset = 0; offset < maxRows; offset += pageSize) {
    const params = new URLSearchParams();
    params.set('select', 'id,type,source_type,importance,quality_score,sensitivity_tier,metadata,created_at');
    params.set('order', 'created_at.desc');
    const upper = Math.min(offset + pageSize - 1, maxRows - 1);
    const res = await fetch(restEndpoint(`thoughts?${params.toString()}`), {
      headers: serviceHeaders({
        prefer: 'count=exact',
        range: `${offset}-${upper}`,
      }),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`OpenBrain map HTTP ${res.status}: ${text.slice(0, 300)}`);
    const page = JSON.parse(text) as OpenBrainMapThought[];
    rows.push(...page);
    total = contentRangeTotal(res.headers.get('content-range'), rows.length);
    if (page.length < pageSize || rows.length >= total) break;
  }

  return {
    thoughts: rows,
    total,
    represented: rows.length,
    truncated: total > rows.length,
  };
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
