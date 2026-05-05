import { useMemo, useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import { Database, Search, Send, Share2 } from 'lucide-preact';
import { PageHeader, Tab } from '@/components/PageHeader';
import { PageState } from '@/components/PageState';
import { Pill } from '@/components/Pill';
import { useFetch } from '@/lib/useFetch';
import { apiGet, apiPost, chatId } from '@/lib/api';
import { formatRelativeTime, safeJsonArray } from '@/lib/format';

type BrainTab = 'overview' | 'search' | 'capture' | 'graph';

interface BrainStatus {
  backend: 'sqlite' | 'ob1';
  openBrain: {
    enabled: boolean;
    configured: boolean;
    functionName: string;
    supabaseConfigured: boolean;
    accessKeyConfigured: boolean;
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
}

interface BrainSearchResponse {
  ok: boolean;
  query: string;
  limit: number;
  threshold: number;
  results: BrainSearchResult[];
  raw: string;
  error?: string;
}

interface CaptureResponse {
  ok: boolean;
  confirmation: string;
  error?: string;
}

const TOPIC_COLORS = ['#8b8af0', '#10b981', '#f59e0b', '#5eb6ff', '#f472b6', '#a78bfa', '#ef4444'];

export function Brain() {
  const [tab, setTab] = useState<BrainTab>('overview');
  const status = useFetch<BrainStatus>(`/api/brain/status?chatId=${encodeURIComponent(chatId)}`, 30_000);
  const memories = useFetch<{ memories: Memory[]; total: number }>(
    `/api/memories/list?chatId=${encodeURIComponent(chatId)}&sort=importance&limit=120&offset=0`,
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
          {tab === 'overview' && <Overview status={status.data} total={memories.data?.total ?? 0} clusters={clusters} />}
          {tab === 'search' && <BrainSearch configured={status.data.openBrain.configured} />}
          {tab === 'capture' && <BrainCapture configured={status.data.openBrain.configured} mutationsEnabled={status.data.mutationsEnabled} />}
          {tab === 'graph' && <BrainGraph memories={memoryRows} clusters={clusters} />}
        </div>
      )}
    </div>
  );
}

function Overview({ status, total, clusters }: { status: BrainStatus; total: number; clusters: TopicCluster[] }) {
  return (
    <div class="space-y-4">
      <div class="grid grid-cols-2 xl:grid-cols-4 gap-3">
        <MetricCard icon={<Database size={16} />} label="Active backend" value={status.backend === 'ob1' ? 'OpenBrain' : 'SQLite'} />
        <MetricCard icon={<Search size={16} />} label="OpenBrain" value={status.openBrain.configured ? 'configured' : 'not configured'} />
        <MetricCard icon={<Share2 size={16} />} label="Topic clusters" value={String(clusters.length)} />
        <MetricCard icon={<Send size={16} />} label="SQLite memories" value={String(total || status.sqlite.totalMemories)} />
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
      const data = await apiGet<BrainSearchResponse>(`/api/brain/search?query=${encodeURIComponent(q)}&limit=8&threshold=0.45`);
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
          <button
            type="button"
            onClick={runSearch}
            disabled={!configured || !query.trim() || loading}
            class="inline-flex items-center gap-1.5 px-3 py-2 rounded-md text-[12px] bg-[var(--color-accent)] text-white hover:bg-[var(--color-accent-hover)] transition-colors disabled:opacity-45 disabled:cursor-not-allowed"
          >
            <Search size={14} />
            {loading ? 'Searching' : 'Search'}
          </button>
        </div>
        {!configured && <div class="mt-2 text-[11px] text-[var(--color-status-failed)]">OpenBrain is not configured in this runtime.</div>}
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
            <div key={index} class="bg-[var(--color-card)] border border-[var(--color-border)] rounded-lg p-4">
              <div class="flex items-start justify-between gap-3 mb-2">
                <div class="flex items-center gap-2 min-w-0">
                  <Pill tone="accent">{hit.match}</Pill>
                  {hit.type && <Pill>{hit.type}</Pill>}
                </div>
                <span class="text-[10px] text-[var(--color-text-faint)] shrink-0">{hit.date}</span>
              </div>
              <div class="text-[13px] text-[var(--color-text)] leading-relaxed whitespace-pre-wrap">{hit.content}</div>
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
            disabled={!configured || !mutationsEnabled || !content.trim() || saving || content.trim().length > 12000}
            class="inline-flex items-center gap-1.5 px-3 py-2 rounded-md text-[12px] bg-[var(--color-accent)] text-white hover:bg-[var(--color-accent-hover)] transition-colors disabled:opacity-45 disabled:cursor-not-allowed"
          >
            <Send size={14} />
            {saving ? 'Capturing' : 'Capture'}
          </button>
        </div>
        {!configured && <div class="mt-2 text-[11px] text-[var(--color-status-failed)]">OpenBrain capture is not configured in this runtime.</div>}
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

interface TopicCluster {
  topic: string;
  count: number;
  avgImportance: number;
  avgSalience: number;
  memories: Memory[];
}

function BrainGraph({ memories, clusters }: { memories: Memory[]; clusters: TopicCluster[] }) {
  if (memories.length === 0) {
    return <PageState empty emptyTitle="No local memories yet" emptyDescription="The graph draws from the local SQLite memory mirror." />;
  }

  return (
    <div class="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_320px] gap-4 min-h-[560px]">
      <div class="bg-[var(--color-card)] border border-[var(--color-border)] rounded-lg p-4 overflow-hidden">
        <div class="relative h-[520px] rounded-md bg-[var(--color-bg)] border border-[var(--color-border)]">
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
  );
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
  const angle = (index / Math.max(1, total)) * Math.PI * 2 - Math.PI / 2;
  const ring = index % 2 === 0 ? 185 : 125;
  const x = 50 + Math.cos(angle) * (ring / 5.2);
  const y = 50 + Math.sin(angle) * (ring / 5.2);
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
