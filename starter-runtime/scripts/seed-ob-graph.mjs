#!/usr/bin/env node
import fs from 'node:fs';

function readEnv() {
  const env = {};
  const raw = fs.existsSync('.env') ? fs.readFileSync('.env', 'utf8') : '';
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue;
    const index = trimmed.indexOf('=');
    const key = trimmed.slice(0, index);
    const value = trimmed.slice(index + 1).replace(/^['"]|['"]$/g, '');
    env[key] = value;
  }
  return { ...env, ...process.env };
}

const env = readEnv();
const functionName = env.OB1_GRAPH_FUNCTION || 'ob-graph-mcp';
if (!env.OB1_SUPABASE_URL || !env.MCP_ACCESS_KEY) {
  console.error('Missing OB1_SUPABASE_URL or MCP_ACCESS_KEY.');
  process.exit(1);
}

const endpoint = `${env.OB1_SUPABASE_URL.replace(/\/+$/, '')}/functions/v1/${functionName}`;

let rpcId = 0;
async function callTool(name, args = {}) {
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'accept': 'application/json, text/event-stream',
      'x-access-key': env.MCP_ACCESS_KEY,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: ++rpcId,
      method: 'tools/call',
      params: { name, arguments: args },
    }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${name} HTTP ${res.status}: ${text.slice(0, 300)}`);
  const dataLine = text.split(/\r?\n/).find((line) => line.startsWith('data:'));
  const payload = JSON.parse((dataLine || text).replace(/^data:\s*/, ''));
  const toolText = payload.result?.content?.[0]?.text || '{}';
  const parsed = JSON.parse(toolText);
  if (parsed.success === false) throw new Error(`${name}: ${parsed.error || toolText}`);
  return parsed;
}

async function ensureNode(label, node_type, properties = {}) {
  const existing = await callTool('search_nodes', { query: label, node_type, limit: 10 });
  const exact = (existing.nodes || []).find((node) => node.label === label && node.node_type === node_type);
  if (exact) return exact;
  const created = await callTool('create_node', {
    label,
    node_type,
    properties: JSON.stringify(properties),
  });
  return created.node;
}

async function ensureEdge(source, target, relationship_type, properties = {}) {
  try {
    await callTool('create_edge', {
      source_node_id: source.id,
      target_node_id: target.id,
      relationship_type,
      weight: properties.weight ?? 1,
      properties: JSON.stringify(properties),
    });
    return true;
  } catch (err) {
    if (String(err.message || err).includes('duplicate key value')) return false;
    throw err;
  }
}

const nodes = {};
for (const [key, label, type, properties] of [
  ['os', 'ClaudeClaw OS', 'system', { source: 'mission-control-seed' }],
  ['mc', 'Mission Control', 'interface', { source: 'mission-control-seed' }],
  ['brain', 'OpenBrain', 'memory_system', { source: 'mission-control-seed' }],
  ['graph', 'OB-Graph', 'knowledge_graph', { source: 'mission-control-seed' }],
  ['supabase', 'Supabase', 'platform', { source: 'mission-control-seed' }],
  ['agents', 'Agent Runtime', 'runtime', { source: 'mission-control-seed' }],
  ['review', 'Review Inbox', 'workflow', { source: 'mission-control-seed' }],
  ['attention', 'Needs Attention', 'workflow', { source: 'mission-control-seed' }],
  ['provider', 'LLM Provider Router', 'runtime', { source: 'mission-control-seed' }],
  ['sqlite', 'SQLite Local Fallback', 'storage', { source: 'mission-control-seed' }],
]) {
  nodes[key] = await ensureNode(label, type, properties);
}

const edges = [
  ['os', 'mc', 'controlled_by'],
  ['os', 'agents', 'runs'],
  ['os', 'provider', 'routes_models_with'],
  ['mc', 'review', 'surfaces'],
  ['mc', 'attention', 'surfaces'],
  ['mc', 'brain', 'queries'],
  ['brain', 'graph', 'visualises_relationships_with'],
  ['brain', 'supabase', 'stores_remote_memory_in'],
  ['brain', 'sqlite', 'falls_back_to'],
  ['agents', 'brain', 'retrieves_context_from'],
  ['review', 'agents', 'closes_loop_with'],
  ['attention', 'agents', 'dispatches_followups_to'],
];

let createdEdges = 0;
for (const [source, target, relationship] of edges) {
  if (await ensureEdge(nodes[source], nodes[target], relationship, { source: 'mission-control-seed', confidence: 0.95 })) {
    createdEdges++;
  }
}

console.log(JSON.stringify({
  ok: true,
  functionName,
  nodes: Object.keys(nodes).length,
  createdEdges,
}, null, 2));
