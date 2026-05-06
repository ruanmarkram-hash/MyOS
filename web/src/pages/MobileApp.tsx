import type { ComponentChildren } from 'preact';
import { useState } from 'preact/hooks';
import { Check, Home, Inbox, LayoutGrid, MessageSquare, Users, Wand2 } from 'lucide-preact';
import { Pill } from '@/components/Pill';
import { PageState } from '@/components/PageState';
import { useFetch } from '@/lib/useFetch';
import { apiPatch, apiPost, chatId } from '@/lib/api';
import { formatRelativeTime } from '@/lib/format';

type Tab = 'today' | 'missions' | 'review' | 'agents' | 'chat';

interface Health {
  provider: 'claude' | 'codex';
  resolvedModel: string;
}

interface AttentionItem {
  id: string;
  severity: 'high' | 'medium' | 'low';
  title: string;
  detail: string;
  createdAt: number;
  href?: string;
}

interface MissionTask {
  id: string;
  title: string;
  assigned_agent: string | null;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'partial' | 'cancelled';
  priority: number;
  created_at: number;
  started_at: number | null;
  completed_at: number | null;
  result: string | null;
  error: string | null;
}

interface ReviewItem {
  id: string;
  title: string;
  agentId: string | null;
  status: 'completed' | 'failed' | 'partial' | 'cancelled';
  summary: string;
  kind: 'needs_action' | 'sorted';
  completedAt: number | null;
  createdAt: number;
  deliverables: Array<{ id: string; label: string; href: string | null; exists: boolean }>;
  review: { status: string };
}

interface Agent {
  id: string;
  name: string;
  running: boolean;
  provider: 'claude' | 'codex';
  resolvedModel: string;
}

const TERMINAL = new Set<MissionTask['status']>(['completed', 'failed', 'partial', 'cancelled']);

export function MobileApp() {
  const [tab, setTab] = useState<Tab>('today');
  const health = useFetch<Health>(`/api/health?chatId=${encodeURIComponent(chatId)}`, 30_000);
  const attention = useFetch<{ items: AttentionItem[] }>('/api/home/attention', 15_000);
  const missions = useFetch<{ tasks: MissionTask[] }>('/api/mission/tasks', 15_000);
  const review = useFetch<{ items: ReviewItem[]; openTotal: number }>('/api/review/inbox?limit=30', 15_000);
  const agents = useFetch<{ agents: Agent[] }>(`/api/agents?chatId=${encodeURIComponent(chatId)}`, 30_000);
  const error = health.error || attention.error || missions.error || review.error || agents.error;
  const loading = (health.loading || attention.loading || missions.loading || review.loading || agents.loading) && !health.data;

  const missionItems = missions.data?.tasks ?? [];
  const activeMissions = missionItems.filter((task) => !TERMINAL.has(task.status));
  const running = activeMissions.filter((task) => task.status === 'running');
  const unassigned = activeMissions.filter((task) => !task.assigned_agent);
  const reviewNeedsAction = (review.data?.items ?? []).filter((item) => item.kind !== 'sorted');
  const agentItems = agents.data?.agents ?? [];

  return (
    <div class="mobile-app min-h-screen bg-[var(--color-bg)] text-[var(--color-text)]">
      <header class="sticky top-0 z-30 border-b border-[var(--color-border)] bg-[color-mix(in_srgb,var(--color-bg)_94%,transparent)] px-4 py-3 backdrop-blur">
        <div class="flex items-center gap-3">
          <div class="h-9 w-9 rounded-lg bg-[var(--color-accent-soft)] text-[var(--color-accent)] flex items-center justify-center">
            <Home size={18} />
          </div>
          <div class="min-w-0 flex-1">
            <div class="text-[15px] font-semibold">ClaudeClaw Mobile</div>
            <div class="truncate text-[11px] text-[var(--color-text-muted)]">
              {health.data ? `${health.data.provider} · ${health.data.resolvedModel}` : 'Loading runtime'}
            </div>
          </div>
          {health.data && <Pill tone={health.data.provider === 'codex' ? 'accent' : 'neutral'}>{health.data.provider}</Pill>}
        </div>
      </header>

      {error && <PageState error={error} />}
      {loading && <PageState loading />}

      {!error && !loading && (
        <main class="px-4 py-4 pb-24 space-y-4">
          <section class="grid grid-cols-2 gap-2">
            <Glance label="Attention" value={String(attention.data?.items.length ?? 0)} detail="needs your eyes" tone={(attention.data?.items.length ?? 0) ? 'medium' : 'done'} />
            <Glance label="Running" value={String(running.length)} detail="active missions" tone={running.length ? 'medium' : 'neutral'} />
            <Glance label="Inbox" value={String(unassigned.length)} detail="needs dispatch" tone={unassigned.length ? 'medium' : 'done'} />
            <Glance label="Review" value={String(reviewNeedsAction.length)} detail="action cards" tone={reviewNeedsAction.length ? 'medium' : 'done'} />
          </section>

          {tab === 'today' && (
            <MobilePanel title="Today">
              <AttentionList items={attention.data?.items ?? []} />
            </MobilePanel>
          )}
          {tab === 'missions' && (
            <MobilePanel title="Mission Loop">
              <MissionList tasks={missionItems} agents={agentItems} onChange={missions.refresh} />
            </MobilePanel>
          )}
          {tab === 'review' && (
            <MobilePanel title="Review Inbox">
              <ReviewList items={reviewNeedsAction} onChange={review.refresh} />
            </MobilePanel>
          )}
          {tab === 'agents' && (
            <MobilePanel title="Agents">
              <AgentList agents={agentItems} />
            </MobilePanel>
          )}
          {tab === 'chat' && (
            <MobilePanel title="Chat">
              <a class="mobile-primary" href="/v2/chat">Open full chat</a>
            </MobilePanel>
          )}
        </main>
      )}

      <nav class="fixed inset-x-0 bottom-0 z-40 grid grid-cols-5 border-t border-[var(--color-border)] bg-[color-mix(in_srgb,var(--color-sidebar)_96%,transparent)] px-2 pt-1.5 pb-[calc(0.5rem+env(safe-area-inset-bottom))] backdrop-blur">
        <MobileTab id="today" label="Today" icon={<Home size={17} />} active={tab === 'today'} onClick={setTab} />
        <MobileTab id="missions" label="Missions" icon={<LayoutGrid size={17} />} active={tab === 'missions'} onClick={setTab} />
        <MobileTab id="review" label="Review" icon={<Inbox size={17} />} active={tab === 'review'} onClick={setTab} />
        <MobileTab id="agents" label="Agents" icon={<Users size={17} />} active={tab === 'agents'} onClick={setTab} />
        <MobileTab id="chat" label="Chat" icon={<MessageSquare size={17} />} active={tab === 'chat'} onClick={setTab} />
      </nav>
    </div>
  );
}

function Glance({ label, value, detail, tone }: { label: string; value: string; detail: string; tone: 'neutral' | 'done' | 'medium' }) {
  return (
    <div class="rounded-lg border border-[var(--color-border)] bg-[var(--color-card)] p-3 min-h-[82px]">
      <div class="text-[9.5px] uppercase tracking-wider text-[var(--color-text-faint)]">{label}</div>
      <div class={tone === 'done' ? 'text-[var(--color-status-done)]' : tone === 'medium' ? 'text-[var(--color-priority-medium)]' : 'text-[var(--color-text)]'}>
        <span class="text-[22px] font-semibold tabular-nums">{value}</span>
      </div>
      <div class="text-[10.5px] text-[var(--color-text-muted)]">{detail}</div>
    </div>
  );
}

function MobilePanel({ title, children }: { title: string; children: ComponentChildren }) {
  return (
    <section class="rounded-lg border border-[var(--color-border)] bg-[var(--color-card)] overflow-hidden">
      <div class="border-b border-[var(--color-border)] px-3 py-2.5 text-[11px] uppercase tracking-wider text-[var(--color-text-faint)]">{title}</div>
      {children}
    </section>
  );
}

function AttentionList({ items }: { items: AttentionItem[] }) {
  if (!items.length) return <Empty text="Nothing currently needs attention." />;
  return (
    <div class="divide-y divide-[var(--color-border)]">
      {items.map((item) => (
        <a key={item.id} href={mobileHref(item.href, '/review')} class="block px-3 py-3">
          <div class="flex items-center gap-2">
            <Pill tone={item.severity === 'high' ? 'failed' : item.severity === 'medium' ? 'medium' : 'neutral'}>{item.severity}</Pill>
            <span class="ml-auto text-[10px] text-[var(--color-text-faint)]">{formatRelativeTime(item.createdAt)}</span>
          </div>
          <div class="mt-1 text-[13px] text-[var(--color-text)]">{item.title}</div>
          <div class="mt-1 text-[11.5px] text-[var(--color-text-muted)] line-clamp-2">{item.detail}</div>
        </a>
      ))}
    </div>
  );
}

function mobileHref(href: string | undefined | null, fallback: string): string {
  const target = href || fallback;
  if (/^(https?:|mailto:|tel:)/i.test(target)) return target;
  if (target.startsWith('/v2/') || target === '/v2') return target;
  if (target.startsWith('/api/') || target.startsWith('/warroom')) return target;
  if (target.startsWith('/')) return `/v2${target}`;
  return target;
}

function MissionList({ tasks, agents, onChange }: { tasks: MissionTask[]; agents: Agent[]; onChange: () => void }) {
  const visible = tasks.filter((task) => !TERMINAL.has(task.status) || (task.completed_at && Date.now() / 1000 - task.completed_at < 1800));
  if (!visible.length) return <Empty text="No active mission loop items." />;
  return (
    <div class="divide-y divide-[var(--color-border)]">
      {visible.map((task) => <MissionRow key={task.id} task={task} agents={agents} onChange={onChange} />)}
    </div>
  );
}

function MissionRow({ task, agents, onChange }: { task: MissionTask; agents: Agent[]; onChange: () => void }) {
  const [busy, setBusy] = useState(false);
  async function assign(agentId: string) {
    if (!agentId) return;
    setBusy(true);
    try {
      await apiPatch(`/api/mission/tasks/${task.id}`, { assigned_agent: agentId });
      onChange();
    } catch (err: any) {
      alert('Assign failed: ' + (err?.message || err));
    } finally {
      setBusy(false);
    }
  }
  async function autoAssign() {
    setBusy(true);
    try {
      await apiPost(`/api/mission/tasks/${task.id}/auto-assign`);
      onChange();
    } catch (err: any) {
      alert('Auto-assign failed: ' + (err?.message || err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div class="px-3 py-3">
      <div class="flex items-center gap-2">
        <Pill tone={task.status as any}>{task.status}</Pill>
        {task.priority > 0 && <Pill tone={task.priority >= 7 ? 'high' : task.priority >= 4 ? 'medium' : 'low'}>P{task.priority}</Pill>}
        <span class="ml-auto text-[10px] text-[var(--color-text-faint)]">{formatRelativeTime(task.completed_at || task.started_at || task.created_at)}</span>
      </div>
      <div class="mt-1 text-[13px] text-[var(--color-text)]">{task.title}</div>
      <div class="mt-2 flex gap-1.5">
        {!task.assigned_agent && (
          <button class="mobile-soft" type="button" disabled={busy} onClick={autoAssign}><Wand2 size={12} /> Auto</button>
        )}
        {task.status !== 'running' && !TERMINAL.has(task.status) && (
          <select class="mobile-select" value={task.assigned_agent || ''} disabled={busy} onChange={(event) => void assign((event.target as HTMLSelectElement).value)}>
            <option value="">Assign...</option>
            {agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name || agent.id}</option>)}
          </select>
        )}
      </div>
    </div>
  );
}

function ReviewList({ items, onChange }: { items: ReviewItem[]; onChange: () => void }) {
  if (!items.length) return <Empty text="No review action cards." />;
  return (
    <div class="divide-y divide-[var(--color-border)]">
      {items.map((item) => <ReviewRow key={item.id} item={item} onChange={onChange} />)}
    </div>
  );
}

function ReviewRow({ item, onChange }: { item: ReviewItem; onChange: () => void }) {
  const [busy, setBusy] = useState(false);
  async function approve() {
    setBusy(true);
    try {
      await apiPost(`/api/review/tasks/${item.id}/approve`);
      onChange();
    } catch (err: any) {
      alert('Approve failed: ' + (err?.message || err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div class="px-3 py-3">
      <div class="flex items-center gap-2">
        <Pill tone={item.review.status === 'needs_triage' ? 'failed' : 'accent'}>{item.review.status}</Pill>
        {item.agentId && <Pill tone="neutral">@{item.agentId}</Pill>}
        <span class="ml-auto text-[10px] text-[var(--color-text-faint)]">{formatRelativeTime(item.completedAt || item.createdAt)}</span>
      </div>
      <div class="mt-1 text-[13px] text-[var(--color-text)]">{item.title}</div>
      <div class="mt-1 text-[11.5px] text-[var(--color-text-muted)] line-clamp-2">{item.summary}</div>
      <div class="mt-2 flex gap-1.5">
        <a class="mobile-soft" href={`/v2/review?task=${encodeURIComponent(item.id)}`}>Open</a>
        <button class="mobile-soft" type="button" disabled={busy} onClick={approve}><Check size={12} /> Done</button>
      </div>
    </div>
  );
}

function AgentList({ agents }: { agents: Agent[] }) {
  if (!agents.length) return <Empty text="No agents loaded." />;
  return (
    <div class="divide-y divide-[var(--color-border)]">
      {agents.map((agent) => (
        <div key={agent.id} class="px-3 py-3 flex items-center gap-3">
          <div class="h-8 w-8 rounded-full border border-[var(--color-accent)] text-[var(--color-accent)] flex items-center justify-center">{(agent.name || agent.id).slice(0, 1)}</div>
          <div class="min-w-0 flex-1">
            <div class="text-[13px] text-[var(--color-text)]">{agent.name || agent.id}</div>
            <div class="truncate text-[10.5px] text-[var(--color-text-muted)]">{agent.provider} · {agent.resolvedModel}</div>
          </div>
          <Pill tone={agent.running ? 'done' : 'cancelled'}>{agent.running ? 'live' : 'off'}</Pill>
        </div>
      ))}
    </div>
  );
}

function MobileTab({ id, label, icon, active, onClick }: { id: Tab; label: string; icon: ComponentChildren; active: boolean; onClick: (tab: Tab) => void }) {
  return (
    <button
      type="button"
      onClick={() => onClick(id)}
      class={(active ? 'text-[var(--color-accent)] bg-[var(--color-accent-soft)]' : 'text-[var(--color-text-muted)]') + ' rounded-md py-1.5 flex flex-col items-center gap-0.5 text-[10px]'}
    >
      {icon}
      {label}
    </button>
  );
}

function Empty({ text }: { text: string }) {
  return <div class="px-3 py-8 text-center text-[12px] text-[var(--color-text-faint)]">{text}</div>;
}
