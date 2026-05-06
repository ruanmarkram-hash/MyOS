import { useMemo, useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import { Database, Search, Send, Share2, RefreshCcw } from 'lucide-preact';
import { PageHeader, Tab } from '@/components/PageHeader';
import { PageState } from '@/components/PageState';
import { Pill } from '@/components/Pill';
import { useFetch, type FetchState } from '@/lib/useFetch';
import { apiGet, apiPost, chatId } from '@/lib/api';
import { formatRelativeTime, safeJsonArray } from '@/lib/format';

type BrainTab = 'overview' | 'browse' | 'search' | 'capture' | 'graph';

interface BrainStatus {
  backend: 'sqlite' | 'ob1';
  openBrain: {
    enabled: boolean;
    configured: boolean;
    ready: boolean;
    missing: string[];
    functionName: string;
    graphFunctionName: string;
    graphConfigured: boolean;
    supabaseConfigured: boolean;
    accessKeyConfigured: boolean;
  };
  localFallback: boolean;
  ingestion: {
    pending: number;
    sources: {
      missionManifests: number;
      briefOutputs: number;
      decisions: number;
    };
  };
  mutationsEnabled: boolean;
  sqlite: {
    enabled: boolean;
    chatId: string;
    totalMemories: number;
    pinned: number;
    avgSalience: number;
  };
  notes: string;
}

interface Memory {
  id: number;
  source: string;
  raw_text: string;
  summary: string;
  topics: string;
  importance: number;
  salience: number;
  created_at: number;
  accessed_at: number;
}

interface BrainSearchResult {
  match: string;
  date: string;
  type: string;
  topics: string[];
  people: string[];
  content: string;
  source?: string;
  confidence?: number;
  rawPreview?: string;
}

interface BrainSearchResponse {
  ok: boolean;
  query: string;
  limit: number;
  threshold: number;
  results: BrainSearchResult[];
  raw: string;
  error?: string;
  backend?: 'sqlite' | 'ob1';
}

interface CaptureResponse {
  ok: boolean;
  confirmation: string;
  backend?: 'sqlite' | 'ob1';
  localMemoryId?: number;
  error?: string;
}

interface OpenBrainThought {
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
}

interface OpenBrainThoughtList {
  ok: boolean;
  thoughts: OpenBrainThought[];
  total: number;
  limit: number;
  offset: number;
  error?: string;
}

interface OpenBrainStatsResponse {
  ok: boolean;
  stats: {
    total?: number;
    top_types?: Array<{ type: string | null; count: number }>;
    top_topics?: Array<{ topic: string; count: number }>;
  } | null;
  error?: string;
}

interface OpenBrainConnectionsResponse {
  ok: boolean;
  connections: Array<{
    id: string;
    type: string | null;
    importance: number | null;
    preview: string;
    created_at: string;
    shared_topics?: string[];
    shared_people?: string[];
    overlap_count?: number;
  }>;
  error?: string;
}

interface BrainGraphNode {
  id: string;
  label: string;
  node_type: string;
  properties?: Record<string, unknown>;
  thought_id?: string | null;
  created_at?: string;
  updated_at?: string;
}

interface BrainGraphNeighbor {
  direction?: string;
  relationship_type: string;
  weight?: number;
  edge_properties?: Record<string, unknown>;
  neighbor?: BrainGraphNode;
}

interface BrainGraphResponse {
  ok: boolean;
  configured: boolean;
  ready: boolean;
  functionName: string;
  nodes: BrainGraphNode[];
  count: number;
  error?: string;
}

interface BrainGraphNeighborsResponse {
  ok: boolean;
  configured: boolean;
  ready: boolean;
  functionName: string;
  neighbors: BrainGraphNeighbor[];
  count: number;
  error?: string;
}

interface WholeBrainGraphNode {
  id: string;
  label: string;
  kind: 'database' | 'type' | 'source' | 'topic' | 'person' | 'time' | 'sensitivity';
  count: number;
  score: number;
  sampleThoughtIds: string[];
  metadata: Record<string, unknown>;
}

interface WholeBrainGraphEdge {
  source: string;
  target: string;
  relationship: string;
  weight: number;
  count: number;
}

interface WholeBrainGraphResponse {
  ok: boolean;
  configured: boolean;
  source: string;
  total: number;
  represented: number;
  truncated: boolean;
  coverage: number;
  nodes: WholeBrainGraphNode[];
  edges: WholeBrainGraphEdge[];
  hiddenNodes: number;
  generatedAt: string;
  error?: string;
}

const TOPIC_COLORS = ['#8b8af0', '#10b981', '#f59e0b', '#5eb6ff', '#f472b6', '#a78bfa', '#ef4444'];
const UNREADABLE_BRAIN_HIT = 'OpenBrain returned this hit without readable thought content.';

function looksLikeUnreadableBrainLine(line: string): boolean {
  const compact = line.replace(/\s+/g, '');
  if (!compact) return true;

  const alphaNumeric = compact.match(/[a-z0-9]/gi)?.length ?? 0;
  const pipeCount = compact.match(/\|/g)?.length ?? 0;
  const commaCount = compact.match(/,/g)?.length ?? 0;
  const digitCount = compact.match(/\d/g)?.length ?? 0;

  if (pipeCount > 0 && alphaNumeric === 0) return true;
  if (compact.length > 80 && pipeCount / compact.length > 0.45) return true;
  if (/^embedding\s*[:=]/i.test(line)) return true;
  if (compact.length > 160 && commaCount > 20 && digitCount / compact.length > 0.35) return true;
  if (/^\[?[-+0-9.,eE\s]+\]?$/.test(line) && commaCount > 20) return true;

  return false;
}

function readableBrainHit(content: string): string {
  const cleaned = content
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !looksLikeUnreadableBrainLine(line))
    .join('\n')
    .trim();

  if (!cleaned) return UNREADABLE_BRAIN_HIT;
  return cleaned.length > 1400 ? `${cleaned.slice(0, 1400).trim()}...` : cleaned;
}

export function Brain() {
  const [tab, setTab] = useState<BrainTab>('overview');
  const status = useFetch<BrainStatus>(`/api/brain/status?chatId=${encodeURIComponent(chatId)}`, 30_000);
  const memories = useFetch<{ memories: Memory[]; total: number }>(
    `/api/memories/list?chatId=${encodeURIComponent(chatId)}&sort=importance&limit=120&offset=0`,
    30_000,
  );
  const graph = useFetch<BrainGraphResponse>('/api/brain/graph/nodes?limit=60', 30_000);
  const wholeGraph = useFetch<WholeBrainGraphResponse>(
    status.data?.openBrain.configured ? '/api/brain/map' : null,
    60_000,
  );
  const openBrainStats = useFetch<OpenBrainStatsResponse>(
    status.data?.openBrain.configured ? '/api/brain/stats/openbrain' : null,
    30_000,
  );
  const recentThoughts = useFetch<OpenBrainThoughtList>(
    status.data?.openBrain.configured ? '/api/brain/thoughts?limit=8&offset=0' : null,
    30_000,
  );

  const memoryRows = memories.data?.memories ?? [];
  const clusters = useMemo(() => buildTopicClusters(memoryRows), [memoryRows]);

  return (
    <div class="flex flex-col h-full">
      <PageHeader
        title="Brain"
        actions={
          <div class="flex items-center gap-2">
            <Pill tone={status.data?.backend === 'ob1' ? 'accent' : 'neutral'}>
              {status.data?.backend === 'ob1' ? 'OpenBrain' : 'SQLite'}
            </Pill>
            <span class="text-[11px] text-[var(--color-text-muted)] tabular-nums">
              {memories.data?.total ?? status.data?.sqlite.totalMemories ?? 0} local memories
            </span>
          </div>
        }
        tabs={
          <>
            <Tab label="Overview" active={tab === 'overview'} onClick={() => setTab('overview')} />
            <Tab label="Browse" active={tab === 'browse'} onClick={() => setTab('browse')} />
            <Tab label="Search" active={tab === 'search'} onClick={() => setTab('search')} />
            <Tab label="Capture" active={tab === 'capture'} onClick={() => setTab('capture')} />
            <Tab label="Graph" active={tab === 'graph'} onClick={() => setTab('graph')} />
          </>
        }
      />

      {(status.error || memories.error) && <PageState error={status.error || memories.error} />}
      {!status.error && !memories.error && status.loading && !status.data && <PageState loading />}

      {status.data && (
        <div class="flex-1 overflow-y-auto p-6">
          {tab === 'overview' && (
            <Overview
              status={status.data}
              total={memories.data?.total ?? 0}
              clusters={clusters}
              openBrainStats={openBrainStats.data}
              recentThoughts={recentThoughts.data?.thoughts ?? []}
              refresh={() => { status.refresh(); memories.refresh(); openBrainStats.refresh(); recentThoughts.refresh(); }}
            />
          )}
          {tab === 'browse' && <BrainBrowse configured={status.data.openBrain.configured} />}
          {tab === 'search' && <BrainSearch configured={status.data.openBrain.configured} />}
          {tab === 'capture' && <BrainCapture configured={status.data.openBrain.configured} mutationsEnabled={status.data.mutationsEnabled} />}
          {tab === 'graph' && <BrainGraph memories={memoryRows} clusters={clusters} graph={graph.data} wholeGraph={wholeGraph} />}
        </div>
      )}
    </div>
  );
}

function Overview({
  status,
  total,
  clusters,
  openBrainStats,
  recentThoughts,
  refresh,
}: {
  status: BrainStatus;
  total: number;
  clusters: TopicCluster[];
  openBrainStats: OpenBrainStatsResponse | null;
  recentThoughts: OpenBrainThought[];
  refresh: () => void;
}) {
  const [ingesting, setIngesting] = useState(false);
  const [ingestNote, setIngestNote] = useState<string | null>(null);

  async function ingest() {
    if (ingesting) return;
    setIngesting(true);
    setIngestNote(null);
    try {
      const result = await apiPost<{ localSaved: number; remoteCaptured: number; errors?: string[] }>('/api/brain/ingest');
      setIngestNote(`${result.localSaved} local records ingested${result.remoteCaptured ? ` · ${result.remoteCaptured} OpenBrain captures` : ''}${result.errors?.length ? ` · ${result.errors[0]}` : ''}`);
      refresh();
    } catch (err: any) {
      setIngestNote(err?.body?.error || err?.message || String(err));
    } finally {
      setIngesting(false);
    }
  }

  return (
    <div class="space-y-4">
      <div class="grid grid-cols-2 xl:grid-cols-4 gap-3">
        <MetricCard icon={<Database size={16} />} label="Active backend" value={status.backend === 'ob1' ? 'OpenBrain' : 'SQLite'} />
        <MetricCard icon={<Search size={16} />} label="OpenBrain thoughts" value={String(openBrainStats?.stats?.total ?? 'unknown')} />
        <MetricCard icon={<Share2 size={16} />} label="Graph" value={status.openBrain.graphConfigured ? 'configured' : 'not configured'} />
        <MetricCard icon={<Send size={16} />} label="SQLite memories" value={String(total || status.sqlite.totalMemories)} />
      </div>

      {openBrainStats?.stats && (
        <div class="grid grid-cols-1 xl:grid-cols-2 gap-4">
          <div class="bg-[var(--color-card)] border border-[var(--color-border)] rounded-lg p-4">
            <div class="text-[10px] uppercase tracking-wider text-[var(--color-text-faint)] mb-3">OpenBrain types</div>
            <div class="space-y-2">
              {(openBrainStats.stats.top_types || []).slice(0, 8).map((row) => (
                <div key={String(row.type)} class="flex items-center justify-between gap-3 text-[12px]">
                  <span class="text-[var(--color-text)]">{row.type || 'unknown'}</span>
                  <span class="text-[var(--color-text-muted)] tabular-nums">{row.count}</span>
                </div>
              ))}
            </div>
          </div>
          <div class="bg-[var(--color-card)] border border-[var(--color-border)] rounded-lg p-4">
            <div class="text-[10px] uppercase tracking-wider text-[var(--color-text-faint)] mb-3">OpenBrain topics</div>
            <div class="flex flex-wrap gap-1.5">
              {(openBrainStats.stats.top_topics || []).slice(0, 18).map((row) => (
                <span key={row.topic} class="inline-flex items-center gap-1 text-[11px] bg-[var(--color-elevated)] border border-[var(--color-border)] rounded px-2 py-1">
                  {row.topic}
                  <span class="text-[var(--color-text-faint)]">{row.count}</span>
                </span>
              ))}
            </div>
          </div>
        </div>
      )}

      {recentThoughts.length > 0 && (
        <div class="bg-[var(--color-card)] border border-[var(--color-border)] rounded-lg p-4">
          <div class="text-[10px] uppercase tracking-wider text-[var(--color-text-faint)] mb-3">Recent OpenBrain thoughts</div>
          <ThoughtRows thoughts={recentThoughts} />
        </div>
      )}

      <div class="bg-[var(--color-card)] border border-[var(--color-border)] rounded-lg p-4">
        <div class="flex items-center justify-between gap-3">
          <div>
            <div class="text-[10px] uppercase tracking-wider text-[var(--color-text-faint)] mb-1">Ingestion</div>
            <div class="text-[13px] text-[var(--color-text)]">{status.ingestion.pending} pending source records</div>
            <div class="text-[11px] text-[var(--color-text-muted)] mt-1">
              {status.ingestion.sources.missionManifests} missions · {status.ingestion.sources.briefOutputs} briefs · {status.ingestion.sources.decisions} decisions
            </div>
          </div>
          <button
            type="button"
            onClick={ingest}
            disabled={ingesting || status.ingestion.pending === 0}
            class="inline-flex items-center gap-1.5 px-3 py-2 rounded-md text-[12px] bg-[var(--color-accent)] text-white hover:bg-[var(--color-accent-hover)] transition-colors disabled:opacity-45 disabled:cursor-not-allowed"
          >
            <RefreshCcw size={14} />
            {ingesting ? 'Ingesting' : 'Ingest'}
          </button>
        </div>
        {ingestNote && <div class="mt-3 text-[11px] text-[var(--color-text-muted)]">{ingestNote}</div>}
      </div>

      <div class="bg-[var(--color-card)] border border-[var(--color-border)] rounded-lg p-4">
        <div class="text-[10px] uppercase tracking-wider text-[var(--color-text-faint)] mb-2">Runtime notes</div>
        <div class="text-[13px] text-[var(--color-text-muted)] leading-relaxed">{status.notes}</div>
        <div class="grid grid-cols-2 xl:grid-cols-4 gap-3 mt-4">
          <Stat label="Function" value={status.openBrain.functionName || 'brain-mcp'} />
          <Stat label="Supabase URL" value={status.openBrain.supabaseConfigured ? 'set' : 'missing'} />
          <Stat label="Access key" value={status.openBrain.accessKeyConfigured ? 'set' : 'missing'} />
          <Stat label="Avg salience" value={status.sqlite.avgSalience.toFixed(2)} />
        </div>
      </div>

      {clusters.length > 0 && (
        <div class="bg-[var(--color-card)] border border-[var(--color-border)] rounded-lg p-4">
          <div class="text-[10px] uppercase tracking-wider text-[var(--color-text-faint)] mb-3">Strongest local topics</div>
          <div class="grid grid-cols-1 xl:grid-cols-2 gap-3">
            {clusters.slice(0, 8).map((cluster, index) => (
              <TopicBar key={cluster.topic} cluster={cluster} color={TOPIC_COLORS[index % TOPIC_COLORS.length]} max={clusters[0].count} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function BrainSearch({ configured }: { configured: boolean }) {
  const [query, setQuery] = useState('');
  const [mode, setMode] = useState<'semantic' | 'text'>('semantic');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<BrainSearchResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function runSearch() {
    const q = query.trim();
    if (!q || loading) return;
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const data = await apiGet<BrainSearchResponse>(`/api/brain/search?query=${encodeURIComponent(q)}&mode=${mode}&limit=12&threshold=0.45`);
      setResult(data);
    } catch (err: any) {
      setError(err?.body?.error || err?.message || String(err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div class="space-y-4">
      <div class="bg-[var(--color-card)] border border-[var(--color-border)] rounded-lg p-4">
        <div class="flex items-center gap-2">
          <input
            value={query}
            onInput={(e) => setQuery((e.currentTarget as HTMLInputElement).value)}
            onKeyDown={(e) => { if (e.key === 'Enter') runSearch(); }}
            placeholder="Search OpenBrain"
            class="flex-1 min-w-0 bg-[var(--color-elevated)] border border-[var(--color-border)] rounded-md px-3 py-2 text-[13px] outline-none focus:border-[var(--color-accent)]"
          />
          <div class="inline-flex bg-[var(--color-elevated)] border border-[var(--color-border)] rounded-md p-0.5">
            {(['semantic', 'text'] as const).map((item) => (
              <button
                key={item}
                type="button"
                onClick={() => setMode(item)}
                class={'px-2.5 py-1.5 rounded text-[11px] capitalize ' + (mode === item ? 'bg-[var(--color-accent-soft)] text-[var(--color-accent)]' : 'text-[var(--color-text-muted)]')}
              >
                {item}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={runSearch}
            disabled={!query.trim() || loading}
            class="inline-flex items-center gap-1.5 px-3 py-2 rounded-md text-[12px] bg-[var(--color-accent)] text-white hover:bg-[var(--color-accent-hover)] transition-colors disabled:opacity-45 disabled:cursor-not-allowed"
          >
            <Search size={14} />
            {loading ? 'Searching' : 'Search'}
          </button>
        </div>
        {!configured && <div class="mt-2 text-[11px] text-[var(--color-text-muted)]">OpenBrain is not configured. Search will use the local brain mirror.</div>}
        {error && <div class="mt-2 text-[11px] text-[var(--color-status-failed)]">{error}</div>}
      </div>

      {result && (
        <div class="space-y-3">
          {result.results.length === 0 && (
            <div class="text-[12px] text-[var(--color-text-muted)] bg-[var(--color-card)] border border-[var(--color-border)] rounded-lg p-4">
              {result.raw || 'No OpenBrain thoughts matched this search.'}
            </div>
          )}
          {result.results.map((hit, index) => (
            <div key={(hit as any).id || index} class="bg-[var(--color-card)] border border-[var(--color-border)] rounded-lg p-4">
              <div class="flex items-start justify-between gap-3 mb-2">
                <div class="flex items-center gap-2 min-w-0">
                  <Pill tone="accent">{hit.match}</Pill>
                  {hit.type && <Pill>{hit.type}</Pill>}
                  {hit.confidence !== undefined && <Pill tone="neutral">{Math.round(hit.confidence * 100)}% confidence</Pill>}
                </div>
                <span class="text-[10px] text-[var(--color-text-faint)] shrink-0">{hit.date}</span>
              </div>
              <div class="text-[13px] text-[var(--color-text)] leading-relaxed whitespace-pre-wrap">{readableBrainHit(hit.content)}</div>
              {(hit as any).id && <ThoughtDetailInline id={(hit as any).id} />}
              {hit.source && <div class="mt-2 text-[10.5px] text-[var(--color-text-faint)]">source: {hit.source}</div>}
              {hit.topics.length > 0 && (
                <div class="flex flex-wrap gap-1 mt-3">
                  {hit.topics.map((topic) => <TopicPill key={topic} topic={topic} />)}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function BrainCapture({ configured, mutationsEnabled }: { configured: boolean; mutationsEnabled: boolean }) {
  const [content, setContent] = useState('');
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<CaptureResponse | null>(null);

  async function capture() {
    const text = content.trim();
    if (!text || saving) return;
    setSaving(true);
    setResult(null);
    try {
      const data = await apiPost<CaptureResponse>('/api/brain/capture', { content: text });
      setResult(data);
      if (data.ok) setContent('');
    } catch (err: any) {
      setResult({ ok: false, confirmation: '', error: err?.body?.error || err?.message || String(err) });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div class="space-y-4">
      <div class="bg-[var(--color-card)] border border-[var(--color-border)] rounded-lg p-4">
        <textarea
          value={content}
          onInput={(e) => setContent((e.currentTarget as HTMLTextAreaElement).value)}
          placeholder="Capture a durable thought into OpenBrain"
          rows={8}
          class="w-full resize-y bg-[var(--color-elevated)] border border-[var(--color-border)] rounded-md px-3 py-2 text-[13px] leading-relaxed outline-none focus:border-[var(--color-accent)]"
        />
        <div class="flex items-center justify-between gap-3 mt-3">
          <div class="text-[11px] text-[var(--color-text-muted)] tabular-nums">{content.trim().length} / 12000</div>
          <button
            type="button"
            onClick={capture}
            disabled={!mutationsEnabled || !content.trim() || saving || content.trim().length > 12000}
            class="inline-flex items-center gap-1.5 px-3 py-2 rounded-md text-[12px] bg-[var(--color-accent)] text-white hover:bg-[var(--color-accent-hover)] transition-colors disabled:opacity-45 disabled:cursor-not-allowed"
          >
            <Send size={14} />
            {saving ? 'Capturing' : 'Capture'}
          </button>
        </div>
        {!configured && <div class="mt-2 text-[11px] text-[var(--color-text-muted)]">OpenBrain is not configured. Captures will land in the local brain mirror.</div>}
        {configured && !mutationsEnabled && <div class="mt-2 text-[11px] text-[var(--color-status-failed)]">Dashboard mutations are disabled in this runtime.</div>}
        {result && (
          <div class={'mt-3 text-[12px] leading-relaxed ' + (result.ok ? 'text-[var(--color-text-muted)]' : 'text-[var(--color-status-failed)]')}>
            {result.ok ? result.confirmation : result.error}
          </div>
        )}
      </div>
    </div>
  );
}

function BrainBrowse({ configured }: { configured: boolean }) {
  const [offset, setOffset] = useState(0);
  const [type, setType] = useState('');
  const [source, setSource] = useState('');
  const limit = 25;
  const params = new URLSearchParams({ limit: String(limit), offset: String(offset) });
  if (type) params.set('type', type);
  if (source) params.set('source', source);
  const thoughts = useFetch<OpenBrainThoughtList>(configured ? `/api/brain/thoughts?${params.toString()}` : null, 30_000);

  if (!configured) {
    return <PageState empty emptyTitle="OpenBrain is not configured" emptyDescription="Browse requires direct OpenBrain table access." />;
  }

  return (
    <div class="space-y-4">
      <div class="bg-[var(--color-card)] border border-[var(--color-border)] rounded-lg p-4">
        <div class="flex flex-wrap items-center gap-2">
          <select
            value={type}
            onChange={(e) => { setType((e.currentTarget as HTMLSelectElement).value); setOffset(0); }}
            class="bg-[var(--color-elevated)] border border-[var(--color-border)] rounded-md px-3 py-2 text-[12px] outline-none"
          >
            <option value="">All types</option>
            {['idea', 'task', 'person_note', 'reference', 'decision', 'lesson', 'meeting', 'journal', 'project'].map((item) => (
              <option key={item} value={item}>{item}</option>
            ))}
          </select>
          <input
            value={source}
            onInput={(e) => { setSource((e.currentTarget as HTMLInputElement).value); setOffset(0); }}
            placeholder="Source filter"
            class="min-w-[180px] bg-[var(--color-elevated)] border border-[var(--color-border)] rounded-md px-3 py-2 text-[12px] outline-none focus:border-[var(--color-accent)]"
          />
          <button type="button" onClick={thoughts.refresh} class="inline-flex items-center gap-1.5 px-3 py-2 rounded-md text-[12px] bg-[var(--color-elevated)] border border-[var(--color-border)] text-[var(--color-text)]">
            <RefreshCcw size={13} />
            Refresh
          </button>
          <div class="ml-auto text-[11px] text-[var(--color-text-muted)] tabular-nums">{thoughts.data?.total ?? 0} thoughts</div>
        </div>
      </div>

      {thoughts.error && <PageState error={thoughts.error} />}
      {thoughts.loading && !thoughts.data && <PageState loading />}
      {thoughts.data && (
        <>
          <ThoughtRows thoughts={thoughts.data.thoughts} />
          <div class="flex items-center justify-between">
            <button
              type="button"
              disabled={offset === 0}
              onClick={() => setOffset(Math.max(0, offset - limit))}
              class="px-3 py-1.5 rounded-md text-[12px] bg-[var(--color-elevated)] border border-[var(--color-border)] disabled:opacity-40"
            >
              Previous
            </button>
            <div class="text-[11px] text-[var(--color-text-muted)]">Page {Math.floor(offset / limit) + 1}</div>
            <button
              type="button"
              disabled={offset + limit >= thoughts.data.total}
              onClick={() => setOffset(offset + limit)}
              class="px-3 py-1.5 rounded-md text-[12px] bg-[var(--color-elevated)] border border-[var(--color-border)] disabled:opacity-40"
            >
              Next
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function ThoughtRows({ thoughts }: { thoughts: OpenBrainThought[] }) {
  const [selected, setSelected] = useState<string | null>(null);
  const selectedId = selected || thoughts[0]?.id || null;
  return (
    <div class="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_360px] gap-4">
      <div class="bg-[var(--color-card)] border border-[var(--color-border)] rounded-lg overflow-hidden">
        <table class="w-full text-[12px]">
          <thead>
            <tr class="border-b border-[var(--color-border)] text-[var(--color-text-faint)] uppercase tracking-wider text-[10px]">
              <th class="text-left px-4 py-3 font-medium">Content</th>
              <th class="text-left px-4 py-3 font-medium w-28">Type</th>
              <th class="text-left px-4 py-3 font-medium w-24">Source</th>
              <th class="text-left px-4 py-3 font-medium w-24">Quality</th>
              <th class="text-left px-4 py-3 font-medium w-28">Date</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-[var(--color-border)]">
            {thoughts.map((thought) => (
              <tr key={thought.id} onClick={() => setSelected(thought.id)} class="hover:bg-[var(--color-elevated)] cursor-pointer">
                <td class="px-4 py-3 text-[var(--color-text)]">
                  <div class="line-clamp-2">{readableBrainHit(thought.content).slice(0, 180)}</div>
                </td>
                <td class="px-4 py-3"><Pill>{thought.type || 'unknown'}</Pill></td>
                <td class="px-4 py-3 text-[var(--color-text-muted)] truncate">{thought.source_type || String(thought.metadata?.source || '')}</td>
                <td class="px-4 py-3 text-[var(--color-text-muted)] tabular-nums">{thought.quality_score ?? thought.importance ?? '-'}</td>
                <td class="px-4 py-3 text-[var(--color-text-faint)]">{new Date(thought.created_at).toLocaleDateString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ThoughtDetail id={selectedId} onSelect={setSelected} />
    </div>
  );
}

function ThoughtDetailInline({ id }: { id: string }) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState(id);
  return (
    <div class="mt-3">
      <button type="button" onClick={() => setOpen((v) => !v)} class="text-[11px] text-[var(--color-accent)]">
        {open ? 'Hide detail' : 'Open detail'}
      </button>
      {open && <div class="mt-3"><ThoughtDetail id={selected} onSelect={setSelected} /></div>}
    </div>
  );
}

function ThoughtDetail({ id, onSelect }: { id: string | null; onSelect?: (id: string) => void }) {
  const detail = useFetch<{ ok: boolean; thought: OpenBrainThought }>(id ? `/api/brain/thoughts/${encodeURIComponent(id)}` : null, 0);
  const connections = useFetch<OpenBrainConnectionsResponse>(id ? `/api/brain/thoughts/${encodeURIComponent(id)}/connections` : null, 0);

  if (!id) {
    return <div class="bg-[var(--color-card)] border border-[var(--color-border)] rounded-lg p-4 text-[12px] text-[var(--color-text-muted)]">Select a thought.</div>;
  }
  if (detail.loading && !detail.data) return <div class="bg-[var(--color-card)] border border-[var(--color-border)] rounded-lg p-4 text-[12px] text-[var(--color-text-muted)]">Loading thought</div>;
  if (detail.error || !detail.data?.thought) return <div class="bg-[var(--color-card)] border border-[var(--color-border)] rounded-lg p-4 text-[12px] text-[var(--color-status-failed)]">{detail.error || 'Thought unavailable'}</div>;

  const thought = detail.data.thought;
  const topics = Array.isArray(thought.metadata?.topics) ? thought.metadata.topics.map(String) : [];
  const people = Array.isArray(thought.metadata?.people) ? thought.metadata.people.map(String) : [];
  return (
    <div class="bg-[var(--color-card)] border border-[var(--color-border)] rounded-lg p-4 max-h-[620px] overflow-y-auto">
      <div class="flex items-center gap-2 mb-3">
        <Pill tone="accent">{thought.type || 'unknown'}</Pill>
        {thought.source_type && <Pill>{thought.source_type}</Pill>}
        {thought.sensitivity_tier && <Pill>{thought.sensitivity_tier}</Pill>}
      </div>
      <div class="text-[13px] text-[var(--color-text)] leading-relaxed whitespace-pre-wrap">{readableBrainHit(thought.content)}</div>
      <div class="grid grid-cols-2 gap-3 mt-4 text-[11px]">
        <Stat label="Importance" value={String(thought.importance ?? '-')} />
        <Stat label="Quality" value={String(thought.quality_score ?? '-')} />
        <Stat label="Created" value={new Date(thought.created_at).toLocaleString()} />
        <Stat label="ID" value={thought.id} />
      </div>
      {(topics.length > 0 || people.length > 0) && (
        <div class="flex flex-wrap gap-1 mt-4">
          {[...topics, ...people].map((topic) => <TopicPill key={topic} topic={topic} />)}
        </div>
      )}
      <div class="mt-5 pt-4 border-t border-[var(--color-border)]">
        <div class="text-[10px] uppercase tracking-wider text-[var(--color-text-faint)] mb-2">Connections</div>
        {connections.loading && !connections.data && <div class="text-[11px] text-[var(--color-text-muted)]">Loading connections</div>}
        {connections.data?.connections?.length ? (
          <div class="space-y-2">
            {connections.data.connections.slice(0, 8).map((conn) => (
              <button
                type="button"
                key={conn.id}
                onClick={() => onSelect?.(conn.id)}
                disabled={!onSelect}
                class="block w-full text-left bg-[var(--color-elevated)] border border-[var(--color-border)] rounded-md p-2"
              >
                <div class="flex items-center gap-2">
                  <Pill>{conn.type || 'thought'}</Pill>
                  <span class="text-[10px] text-[var(--color-text-faint)] ml-auto">{conn.overlap_count ?? 0} shared</span>
                </div>
                <div class="mt-1 text-[11px] text-[var(--color-text-muted)] line-clamp-2">{conn.preview}</div>
              </button>
            ))}
          </div>
        ) : (
          <div class="text-[11px] text-[var(--color-text-muted)]">No metadata connections returned.</div>
        )}
      </div>
    </div>
  );
}

interface TopicCluster {
  topic: string;
  count: number;
  avgImportance: number;
  avgSalience: number;
  memories: Memory[];
}

function BrainGraph({
  memories,
  clusters,
  graph,
  wholeGraph,
}: {
  memories: Memory[];
  clusters: TopicCluster[];
  graph: BrainGraphResponse | null;
  wholeGraph: FetchState<WholeBrainGraphResponse>;
}) {
  const [ingesting, setIngesting] = useState(false);
  const [ingestNote, setIngestNote] = useState<string | null>(null);

  async function ingestGraph() {
    if (ingesting) return;
    setIngesting(true);
    setIngestNote(null);
    try {
      const result = await apiPost<{ nodesCreated: number; edgesCreated: number; edgesSkipped: number; errors?: string[] }>('/api/brain/graph/ingest');
      setIngestNote(`${result.nodesCreated} nodes created · ${result.edgesCreated} edges created · ${result.edgesSkipped} existing/skipped`);
    } catch (err: any) {
      setIngestNote(err?.body?.error || err?.message || String(err));
    } finally {
      setIngesting(false);
    }
  }

  if (wholeGraph.loading && !wholeGraph.data) return <PageState loading />;
  if (wholeGraph.error || wholeGraph.data?.error) return <PageState error={wholeGraph.error || wholeGraph.data?.error} />;
  if (wholeGraph.data?.nodes?.length) {
    return <WholeOpenBrainGraph graph={wholeGraph.data} legacyGraph={graph} refresh={wholeGraph.refresh} ingestGraph={ingestGraph} ingesting={ingesting} ingestNote={ingestNote} />;
  }

  if (memories.length === 0) {
    return (
      <PageState
        empty
        emptyTitle={graph?.configured ? 'No OpenBrain graph nodes yet' : 'OB-Graph not deployed yet'}
        emptyDescription={graph?.configured ? 'OpenBrain graph is reachable, but no graph nodes were returned.' : 'Deploy the OB-Graph schema and edge function to turn this from a local topic map into real graph traversal.'}
      />
    );
  }

  return (
    <div class="space-y-3">
      <div class="bg-[var(--color-card)] border border-[var(--color-border)] rounded-lg p-3">
        <div class="flex items-start justify-between gap-3">
          <div>
            <div class="text-[11px] text-[var(--color-text-muted)]">
              {graph?.configured
                ? `OB-Graph function ${graph.functionName} is configured but not returning graph nodes yet. Showing the local memory topic map.`
                : `OB-Graph is not deployed yet. Showing the local memory topic map until ${graph?.functionName || 'ob-graph-mcp'} is available.`}
            </div>
            {ingestNote && <div class="mt-1 text-[11px] text-[var(--color-text-muted)]">{ingestNote}</div>}
          </div>
          {graph?.configured && (
            <button
              type="button"
              onClick={ingestGraph}
              disabled={ingesting}
              class="inline-flex items-center gap-1.5 px-3 py-2 rounded-md text-[12px] bg-[var(--color-accent)] text-white hover:bg-[var(--color-accent-hover)] transition-colors disabled:opacity-45 disabled:cursor-not-allowed"
            >
              <RefreshCcw size={14} />
              {ingesting ? 'Ingesting' : 'Ingest OS graph'}
            </button>
          )}
        </div>
        {graph?.error && <div class="mt-1 text-[11px] text-[var(--color-status-failed)]">{graph.error}</div>}
      </div>
      <div class="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_320px] gap-4 min-h-[560px]">
      <div class="bg-[var(--color-card)] border border-[var(--color-border)] rounded-lg p-4 overflow-hidden">
        <div class="relative h-[520px] rounded-md bg-[var(--color-bg)] border border-[var(--color-border)]">
          <svg class="absolute inset-0 w-full h-full pointer-events-none" viewBox="0 0 100 100" preserveAspectRatio="none">
            {buildGraphEdges(clusters.slice(0, 18)).map((edge) => (
              <line
                key={`${edge.a.topic}-${edge.b.topic}`}
                x1={edge.a.x}
                y1={edge.a.y}
                x2={edge.b.x}
                y2={edge.b.y}
                stroke="color-mix(in srgb, var(--color-accent) 28%, transparent)"
                stroke-width={Math.min(0.7, 0.18 + edge.weight * 0.08)}
              />
            ))}
          </svg>
          {clusters.slice(0, 18).map((cluster, index) => (
            <GraphCluster
              key={cluster.topic}
              cluster={cluster}
              index={index}
              total={Math.min(18, clusters.length)}
              color={TOPIC_COLORS[index % TOPIC_COLORS.length]}
            />
          ))}
        </div>
      </div>
      <div class="bg-[var(--color-card)] border border-[var(--color-border)] rounded-lg p-4 overflow-y-auto max-h-[552px]">
        <div class="text-[10px] uppercase tracking-wider text-[var(--color-text-faint)] mb-3">Recent high-signal memories</div>
        <div class="space-y-3">
          {memories.slice(0, 12).map((memory) => (
            <div key={memory.id} class="border-b border-[var(--color-border)] pb-3 last:border-b-0">
              <div class="text-[12px] text-[var(--color-text)] leading-snug">{memory.summary}</div>
              <div class="flex items-center justify-between mt-2 text-[10px] text-[var(--color-text-faint)]">
                <span>{formatRelativeTime(memory.accessed_at || memory.created_at)}</span>
                <span class="font-mono">i {memory.importance.toFixed(2)} · s {memory.salience.toFixed(2)}</span>
              </div>
            </div>
          ))}
        </div>
      </div>
      </div>
    </div>
  );
}

function WholeOpenBrainGraph({
  graph,
  legacyGraph,
  refresh,
  ingestGraph,
  ingesting,
  ingestNote,
}: {
  graph: WholeBrainGraphResponse;
  legacyGraph: BrainGraphResponse | null;
  refresh: () => void;
  ingestGraph: () => void;
  ingesting: boolean;
  ingestNote: string | null;
}) {
  const [selectedId, setSelectedId] = useState(graph.nodes[0]?.id || 'database:ob1');
  const selected = graph.nodes.find((node) => node.id === selectedId) || graph.nodes[0] || null;
  const layout = useMemo(() => layoutWholeBrainGraph(graph.nodes), [graph.nodes]);
  const nodeById = useMemo(() => new Map(graph.nodes.map((node) => [node.id, node])), [graph.nodes]);
  const coverage = Math.round((graph.coverage || 0) * 1000) / 10;
  const visibleEdges = graph.edges
    .filter((edge) => layout.has(edge.source) && layout.has(edge.target))
    .slice(0, 420);

  return (
    <div class="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_360px] gap-4 min-h-[620px]">
      <div class="bg-[var(--color-card)] border border-[var(--color-border)] rounded-lg p-4 overflow-hidden">
        <div class="flex items-center justify-between gap-3 mb-3">
          <div>
            <div class="text-[10px] uppercase tracking-wider text-[var(--color-text-faint)]">Whole OB1 Database Graph</div>
            <div class="text-[12px] text-[var(--color-text-muted)]">
              {graph.represented.toLocaleString()} of {graph.total.toLocaleString()} thoughts represented · {coverage}% coverage
              {graph.truncated ? ' · truncated' : ''}
            </div>
          </div>
          <div class="flex items-center gap-2">
            <Pill tone="done">actual OB1</Pill>
            <button
              type="button"
              onClick={refresh}
              class="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-[11px] bg-[var(--color-elevated)] text-[var(--color-text)] border border-[var(--color-border)] hover:border-[var(--color-accent)] transition-colors"
            >
              <RefreshCcw size={13} />
              Refresh
            </button>
          </div>
        </div>
        <div class="relative h-[560px] rounded-md bg-[var(--color-bg)] border border-[var(--color-border)] overflow-hidden">
          <svg class="absolute inset-0 w-full h-full pointer-events-none" viewBox="0 0 100 100" preserveAspectRatio="none">
            {visibleEdges.map((edge) => {
              const a = layout.get(edge.source);
              const b = layout.get(edge.target);
              if (!a || !b) return null;
              const intensity = Math.min(0.7, 0.12 + Math.log10(edge.count + 1) * 0.16);
              return (
                <line
                  key={`${edge.source}-${edge.target}-${edge.relationship}`}
                  x1={a.x}
                  y1={a.y}
                  x2={b.x}
                  y2={b.y}
                  stroke={`color-mix(in srgb, var(--color-accent) ${Math.round(intensity * 100)}%, transparent)`}
                  stroke-width={Math.min(0.65, 0.12 + Math.log10(edge.count + 1) * 0.08)}
                />
              );
            })}
          </svg>
          {graph.nodes.filter((node) => layout.has(node.id)).map((node) => {
            const point = layout.get(node.id)!;
            const isSelected = selected?.id === node.id;
            return (
              <button
                key={node.id}
                type="button"
                onClick={() => setSelectedId(node.id)}
                title={`${node.label}: ${node.count} thoughts`}
                class={'absolute -translate-x-1/2 -translate-y-1/2 rounded-full border flex flex-col items-center justify-center text-center px-2 transition-transform hover:scale-105 ' + (isSelected ? 'z-20' : 'z-10')}
                style={{
                  left: point.x + '%',
                  top: point.y + '%',
                  width: point.size + 'px',
                  height: point.size + 'px',
                  color: wholeGraphColor(node.kind),
                  borderColor: isSelected ? 'var(--color-accent)' : 'color-mix(in srgb, currentColor 62%, transparent)',
                  backgroundColor: isSelected ? 'color-mix(in srgb, var(--color-accent) 26%, var(--color-bg))' : 'color-mix(in srgb, currentColor 14%, var(--color-bg))',
                }}
              >
                <span class="text-[11px] text-[var(--color-text)] leading-tight max-w-[108px] truncate">{node.label}</span>
                <span class="text-[10px] font-mono text-[var(--color-text-faint)]">{node.count.toLocaleString()}</span>
              </button>
            );
          })}
        </div>
        <div class="mt-3 flex flex-wrap gap-2 text-[11px] text-[var(--color-text-muted)]">
          {(['type', 'source', 'topic', 'person', 'time', 'sensitivity'] as WholeBrainGraphNode['kind'][]).map((kind) => (
            <span key={kind} class="inline-flex items-center gap-1.5">
              <span class="w-2 h-2 rounded-full" style={{ backgroundColor: wholeGraphColor(kind) }} />
              {kind}
            </span>
          ))}
        </div>
      </div>

      <div class="bg-[var(--color-card)] border border-[var(--color-border)] rounded-lg p-4 overflow-y-auto max-h-[620px]">
        <div class="text-[10px] uppercase tracking-wider text-[var(--color-text-faint)] mb-3">Selected cluster</div>
        {selected ? (
          <>
            <div class="border-b border-[var(--color-border)] pb-3">
              <div class="flex items-center gap-2 min-w-0">
                <Pill>{selected.kind}</Pill>
                <div class="text-[13px] text-[var(--color-text)] truncate">{selected.label}</div>
              </div>
              <div class="mt-2 text-[24px] font-semibold text-[var(--color-text)] tabular-nums">{selected.count.toLocaleString()}</div>
              <div class="text-[11px] text-[var(--color-text-muted)]">thoughts in this cluster</div>
              <div class="mt-3 space-y-1">
                {Object.entries(selected.metadata || {}).slice(0, 8).map(([key, value]) => (
                  <div key={key} class="flex items-start justify-between gap-3 text-[11px]">
                    <span class="text-[var(--color-text-faint)]">{key}</span>
                    <span class="text-[var(--color-text-muted)] text-right break-all">{Array.isArray(value) ? value.join(', ') : String(value)}</span>
                  </div>
                ))}
              </div>
            </div>
            <div class="mt-4">
              <div class="text-[10px] uppercase tracking-wider text-[var(--color-text-faint)] mb-2">Strongest links</div>
              <div class="space-y-2">
                {graph.edges
                  .filter((edge) => edge.source === selected.id || edge.target === selected.id)
                  .sort((a, b) => b.count - a.count)
                  .slice(0, 14)
                  .map((edge) => {
                    const other = nodeById.get(edge.source === selected.id ? edge.target : edge.source);
                    if (!other) return null;
                    return (
                      <button
                        type="button"
                        key={`${edge.source}-${edge.target}-${edge.relationship}`}
                        onClick={() => setSelectedId(other.id)}
                        class="block w-full text-left bg-[var(--color-elevated)] border border-[var(--color-border)] rounded-md p-2 hover:border-[var(--color-accent)]"
                      >
                        <div class="flex items-center gap-2">
                          <Pill>{other.kind}</Pill>
                          <span class="text-[11px] text-[var(--color-text)] truncate">{other.label}</span>
                          <span class="text-[10px] text-[var(--color-text-faint)] ml-auto">{edge.count.toLocaleString()}</span>
                        </div>
                        <div class="mt-1 text-[10px] text-[var(--color-text-faint)]">{edge.relationship}</div>
                      </button>
                    );
                  })}
              </div>
            </div>
            {selected.sampleThoughtIds.length > 0 && (
              <div class="mt-4">
                <div class="text-[10px] uppercase tracking-wider text-[var(--color-text-faint)] mb-2">Sample thoughts</div>
                <div class="space-y-2">
                  {selected.sampleThoughtIds.slice(0, 5).map((id) => <ThoughtDetailInline key={id} id={id} />)}
                </div>
              </div>
            )}
          </>
        ) : (
          <div class="text-[11px] text-[var(--color-text-muted)]">Select a graph node.</div>
        )}
        <div class="mt-4 pt-3 border-t border-[var(--color-border)] text-[11px] text-[var(--color-text-muted)] leading-relaxed">
          This graph is built from the actual OB1 `thoughts` table. The separate OB-Graph layer currently has {legacyGraph?.count ?? 0} manual nodes and should be treated as auxiliary structure, not the source of truth.
          {ingestNote && <div class="mt-2">{ingestNote}</div>}
          {legacyGraph?.configured && (
            <button
              type="button"
              onClick={ingestGraph}
              disabled={ingesting}
              class="mt-3 inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-[11px] bg-[var(--color-elevated)] text-[var(--color-text)] border border-[var(--color-border)] hover:border-[var(--color-accent)] transition-colors disabled:opacity-45"
            >
              <RefreshCcw size={13} />
              {ingesting ? 'Ingesting auxiliary graph' : 'Update auxiliary graph'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function wholeGraphColor(kind: WholeBrainGraphNode['kind']): string {
  switch (kind) {
    case 'database': return '#e5e7eb';
    case 'type': return '#8b8af0';
    case 'source': return '#10b981';
    case 'topic': return '#5eb6ff';
    case 'person': return '#f472b6';
    case 'time': return '#f59e0b';
    case 'sensitivity': return '#ef4444';
  }
}

function layoutWholeBrainGraph(nodes: WholeBrainGraphNode[]): Map<string, { x: number; y: number; size: number }> {
  const groups: Record<WholeBrainGraphNode['kind'], WholeBrainGraphNode[]> = {
    database: [],
    type: [],
    source: [],
    topic: [],
    person: [],
    time: [],
    sensitivity: [],
  };
  for (const node of nodes) groups[node.kind]?.push(node);
  const layout = new Map<string, { x: number; y: number; size: number }>();
  const maxCount = Math.max(1, ...nodes.map((node) => node.count));
  const rings: Array<{ kind: WholeBrainGraphNode['kind']; radius: number; start: number; cap: number }> = [
    { kind: 'database', radius: 0, start: 0, cap: 1 },
    { kind: 'type', radius: 16, start: -110, cap: 18 },
    { kind: 'source', radius: 25, start: -35, cap: 24 },
    { kind: 'sensitivity', radius: 32, start: 55, cap: 8 },
    { kind: 'time', radius: 37, start: 130, cap: 30 },
    { kind: 'person', radius: 41, start: 205, cap: 36 },
    { kind: 'topic', radius: 45, start: 285, cap: 145 },
  ];

  for (const ring of rings) {
    const rows = groups[ring.kind].sort((a, b) => b.count - a.count).slice(0, ring.cap);
    if (ring.kind === 'database') {
      for (const node of rows) layout.set(node.id, { x: 50, y: 50, size: 118 });
      continue;
    }
    for (let index = 0; index < rows.length; index++) {
      const angle = ((index / Math.max(1, rows.length)) * Math.PI * 2) + (ring.start * Math.PI / 180);
      const countScale = Math.log10(rows[index].count + 1) / Math.log10(maxCount + 1);
      layout.set(rows[index].id, {
        x: 50 + Math.cos(angle) * ring.radius,
        y: 50 + Math.sin(angle) * ring.radius,
        size: Math.round(44 + countScale * 64),
      });
    }
  }
  return layout;
}

function OpenBrainGraph({
  graph,
  localMemories,
  ingestGraph,
  ingesting,
  ingestNote,
}: {
  graph: BrainGraphResponse;
  localMemories: Memory[];
  ingestGraph: () => void;
  ingesting: boolean;
  ingestNote: string | null;
}) {
  const [selected, setSelected] = useState<BrainGraphNode | null>(graph.nodes[0] || null);
  const neighbors = useFetch<BrainGraphNeighborsResponse>(
    selected ? `/api/brain/graph/nodes/${encodeURIComponent(selected.id)}/neighbors` : null,
    30_000,
  );
  const nodes = graph.nodes.slice(0, 36);
  const grouped = groupGraphNodes(nodes);
  return (
    <div class="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_340px] gap-4 min-h-[560px]">
      <div class="bg-[var(--color-card)] border border-[var(--color-border)] rounded-lg p-4 overflow-hidden">
        <div class="flex items-center justify-between gap-3 mb-3">
          <div>
            <div class="text-[10px] uppercase tracking-wider text-[var(--color-text-faint)]">OpenBrain Graph</div>
            <div class="text-[12px] text-[var(--color-text-muted)]">{graph.count} nodes from {graph.functionName}</div>
          </div>
          <div class="flex items-center gap-2">
            <Pill tone={graph.ready ? 'done' : 'medium'}>{graph.ready ? 'ready' : 'degraded'}</Pill>
            <button
              type="button"
              onClick={ingestGraph}
              disabled={ingesting}
              class="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-[11px] bg-[var(--color-elevated)] text-[var(--color-text)] border border-[var(--color-border)] hover:border-[var(--color-accent)] transition-colors disabled:opacity-45 disabled:cursor-not-allowed"
            >
              <RefreshCcw size={13} />
              {ingesting ? 'Ingesting' : 'Ingest'}
            </button>
          </div>
        </div>
        {ingestNote && <div class="mb-3 text-[11px] text-[var(--color-text-muted)]">{ingestNote}</div>}
        <div class="h-[500px] rounded-md bg-[var(--color-bg)] border border-[var(--color-border)] overflow-auto p-3">
          <div class="grid grid-cols-1 md:grid-cols-2 2xl:grid-cols-3 gap-3">
            {grouped.map((group) => (
              <div key={group.type} class="bg-[var(--color-card)] border border-[var(--color-border)] rounded-md overflow-hidden">
                <div class="flex items-center justify-between px-3 py-2 border-b border-[var(--color-border)]">
                  <div class="text-[10px] uppercase tracking-wider text-[var(--color-text-faint)]">{group.type}</div>
                  <div class="text-[10px] text-[var(--color-text-muted)] tabular-nums">{group.nodes.length}</div>
                </div>
                <div class="divide-y divide-[var(--color-border)]">
                  {group.nodes.slice(0, 10).map((node) => (
                    <button
                      key={node.id}
                      type="button"
                      onClick={() => setSelected(node)}
                      class={'block w-full text-left px-3 py-2 transition-colors ' + (selected?.id === node.id ? 'bg-[var(--color-accent-soft)]' : 'hover:bg-[var(--color-elevated)]')}
                    >
                      <div class="text-[12px] text-[var(--color-text)] truncate">{node.label}</div>
                      <div class="mt-0.5 text-[10px] text-[var(--color-text-faint)] truncate">{String(node.properties?.source || node.properties?.stableKey || node.id)}</div>
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
      <div class="bg-[var(--color-card)] border border-[var(--color-border)] rounded-lg p-4 overflow-y-auto max-h-[552px]">
        <div class="text-[10px] uppercase tracking-wider text-[var(--color-text-faint)] mb-3">Selected node</div>
        {selected ? (
          <>
            <div class="border-b border-[var(--color-border)] pb-3">
              <div class="flex items-center gap-2 min-w-0">
                <Pill>{selected.node_type || 'entity'}</Pill>
                <div class="text-[13px] text-[var(--color-text)] truncate">{selected.label}</div>
              </div>
              <div class="mt-2 text-[10px] text-[var(--color-text-faint)] font-mono break-all">{selected.id}</div>
              {selected.properties && (
                <div class="mt-3 space-y-1">
                  {Object.entries(selected.properties).slice(0, 8).map(([key, value]) => (
                    <div key={key} class="flex items-start justify-between gap-3 text-[11px]">
                      <span class="text-[var(--color-text-faint)]">{key}</span>
                      <span class="text-[var(--color-text-muted)] text-right break-all">{String(value)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div class="mt-4">
              <div class="text-[10px] uppercase tracking-wider text-[var(--color-text-faint)] mb-2">Relationships</div>
              {neighbors.error && <div class="text-[11px] text-[var(--color-status-failed)]">{neighbors.error}</div>}
              {neighbors.loading && !neighbors.data && <div class="text-[11px] text-[var(--color-text-muted)]">Loading relationships</div>}
              <div class="space-y-2">
                {(neighbors.data?.neighbors || []).slice(0, 16).map((edge, index) => (
                  <div key={`${edge.relationship_type}-${index}`} class="bg-[var(--color-elevated)] border border-[var(--color-border)] rounded-md p-2">
                    <div class="flex items-center justify-between gap-2">
                      <span class="text-[11px] text-[var(--color-text)]">{edge.relationship_type}</span>
                      {edge.direction && <span class="text-[10px] text-[var(--color-text-faint)]">{edge.direction}</span>}
                    </div>
                    <div class="mt-1 text-[11px] text-[var(--color-text-muted)] truncate">{edge.neighbor?.label || 'Unknown node'}</div>
                  </div>
                ))}
              </div>
              {neighbors.data && neighbors.data.neighbors.length === 0 && (
                <div class="text-[11px] text-[var(--color-text-muted)]">No relationships returned for this node yet.</div>
              )}
            </div>
          </>
        ) : (
          <div class="text-[11px] text-[var(--color-text-muted)]">Select a graph node.</div>
        )}
        <div class="mt-4 pt-3 border-t border-[var(--color-border)] text-[11px] text-[var(--color-text-muted)] leading-relaxed">
          Local mirror still has {localMemories.length} memories for fallback search and outage resilience.
        </div>
      </div>
    </div>
  );
}

function groupGraphNodes(nodes: BrainGraphNode[]): Array<{ type: string; nodes: BrainGraphNode[] }> {
  const map = new Map<string, BrainGraphNode[]>();
  for (const node of nodes) {
    const type = node.node_type || 'entity';
    map.set(type, [...(map.get(type) || []), node]);
  }
  return [...map.entries()]
    .map(([type, rows]) => ({ type, nodes: rows.sort((a, b) => a.label.localeCompare(b.label)) }))
    .sort((a, b) => b.nodes.length - a.nodes.length || a.type.localeCompare(b.type));
}

function GraphNodeBubble({
  node,
  index,
  total,
  color,
  selected,
  onClick,
}: {
  node: BrainGraphNode;
  index: number;
  total: number;
  color: string;
  selected: boolean;
  onClick: () => void;
}) {
  const { x, y } = clusterPoint(index, Math.max(1, total));
  const size = node.node_type === 'project' ? 112 : node.node_type === 'person' ? 92 : 76;
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') onClick(); }}
      class="absolute -translate-x-1/2 -translate-y-1/2 rounded-full border flex flex-col items-center justify-center text-center px-2 cursor-pointer transition-transform hover:scale-105"
      style={{
        left: x + '%',
        top: y + '%',
        width: size + 'px',
        height: size + 'px',
        color,
        borderColor: selected ? 'var(--color-accent)' : 'color-mix(in srgb, currentColor 60%, transparent)',
        backgroundColor: selected ? 'color-mix(in srgb, var(--color-accent) 22%, transparent)' : 'color-mix(in srgb, currentColor 13%, transparent)',
      }}
      title={`${node.label} (${node.node_type})`}
    >
      <span class="text-[11px] text-[var(--color-text)] leading-tight max-w-[90px] truncate">{node.label}</span>
      <span class="text-[10px] font-mono text-[var(--color-text-faint)]">{node.node_type}</span>
    </div>
  );
}

function clusterPoint(index: number, total: number) {
  const angle = (index / Math.max(1, total)) * Math.PI * 2 - Math.PI / 2;
  const ring = index % 2 === 0 ? 185 : 125;
  return {
    x: 50 + Math.cos(angle) * (ring / 5.2),
    y: 50 + Math.sin(angle) * (ring / 5.2),
  };
}

function buildGraphEdges(clusters: TopicCluster[]) {
  const total = Math.min(18, clusters.length);
  const rows: Array<{ a: TopicCluster & { x: number; y: number }; b: TopicCluster & { x: number; y: number }; weight: number }> = [];
  const memoryIds = clusters.map((cluster) => new Set(cluster.memories.map((memory) => memory.id)));
  for (let i = 0; i < total; i++) {
    for (let j = i + 1; j < total; j++) {
      let shared = 0;
      for (const id of memoryIds[i]) if (memoryIds[j].has(id)) shared++;
      if (shared === 0) continue;
      rows.push({
        a: { ...clusters[i], ...clusterPoint(i, total) },
        b: { ...clusters[j], ...clusterPoint(j, total) },
        weight: shared,
      });
    }
  }
  return rows.sort((a, b) => b.weight - a.weight).slice(0, 32);
}

function buildTopicClusters(memories: Memory[]): TopicCluster[] {
  const map = new Map<string, { memories: Memory[]; importance: number; salience: number }>();
  for (const memory of memories) {
    const topics = safeJsonArray<string>(memory.topics).filter(Boolean);
    const keys = topics.length ? topics : [memory.source || 'untagged'];
    for (const topic of keys.slice(0, 6)) {
      const existing = map.get(topic) || { memories: [], importance: 0, salience: 0 };
      existing.memories.push(memory);
      existing.importance += memory.importance || 0;
      existing.salience += memory.salience || 0;
      map.set(topic, existing);
    }
  }
  return [...map.entries()]
    .map(([topic, value]) => ({
      topic,
      count: value.memories.length,
      avgImportance: value.importance / Math.max(1, value.memories.length),
      avgSalience: value.salience / Math.max(1, value.memories.length),
      memories: value.memories,
    }))
    .sort((a, b) => (b.count * b.avgImportance) - (a.count * a.avgImportance));
}

function GraphCluster({ cluster, index, total, color }: { cluster: TopicCluster; index: number; total: number; color: string }) {
  const { x, y } = clusterPoint(index, total);
  const size = Math.max(54, Math.min(124, 42 + cluster.count * 9));
  return (
    <div
      class="absolute -translate-x-1/2 -translate-y-1/2 rounded-full border flex flex-col items-center justify-center text-center px-2"
      style={{
        left: x + '%',
        top: y + '%',
        width: size + 'px',
        height: size + 'px',
        color,
        borderColor: 'color-mix(in srgb, currentColor 60%, transparent)',
        backgroundColor: 'color-mix(in srgb, currentColor 13%, transparent)',
      }}
      title={`${cluster.topic}: ${cluster.count} memories`}
    >
      <span class="text-[11px] text-[var(--color-text)] leading-tight max-w-[96px] truncate">{cluster.topic}</span>
      <span class="text-[10px] font-mono text-[var(--color-text-faint)]">{cluster.count}</span>
    </div>
  );
}

function MetricCard({ icon, label, value }: { icon: ComponentChildren; label: string; value: string }) {
  return (
    <div class="bg-[var(--color-card)] border border-[var(--color-border)] rounded-lg p-4">
      <div class="flex items-center justify-between mb-3">
        <div class="text-[10px] uppercase tracking-wider text-[var(--color-text-faint)]">{label}</div>
        <div class="text-[var(--color-text-muted)]">{icon}</div>
      </div>
      <div class="text-[20px] font-semibold text-[var(--color-text)] truncate" title={value}>{value}</div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div class="text-[10px] uppercase tracking-wider text-[var(--color-text-faint)] mb-0.5">{label}</div>
      <div class="text-[12.5px] text-[var(--color-text)] truncate" title={value}>{value}</div>
    </div>
  );
}

function TopicBar({ cluster, color, max }: { cluster: TopicCluster; color: string; max: number }) {
  return (
    <div>
      <div class="flex items-center justify-between gap-2 mb-1">
        <div class="text-[12px] text-[var(--color-text)] truncate">{cluster.topic}</div>
        <div class="text-[10px] text-[var(--color-text-faint)] tabular-nums">{cluster.count}</div>
      </div>
      <div class="h-1.5 rounded-full bg-[var(--color-elevated)] overflow-hidden">
        <div class="h-full rounded-full" style={{ width: Math.max(4, (cluster.count / Math.max(1, max)) * 100) + '%', backgroundColor: color }} />
      </div>
    </div>
  );
}

function TopicPill({ topic }: { topic: string }) {
  return (
    <span class="font-mono text-[10px] text-[var(--color-text-muted)] bg-[var(--color-elevated)] border border-[var(--color-border)] px-1.5 py-0.5 rounded">
      {topic}
    </span>
  );
}
