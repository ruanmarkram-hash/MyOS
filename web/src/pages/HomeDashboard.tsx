import type { ComponentChildren } from 'preact';
import { CalendarDays, Cpu, ListChecks, Radio, ShieldCheck, Sunrise, Users } from 'lucide-preact';
import { useState } from 'preact/hooks';
import { useLocation } from 'wouter-preact';
import { PageHeader } from '@/components/PageHeader';
import { PageState } from '@/components/PageState';
import { Pill, StatusDot } from '@/components/Pill';
import { useFetch } from '@/lib/useFetch';
import { apiPatch, apiPost, chatId } from '@/lib/api';
import { formatRelativeTime } from '@/lib/format';

interface Health {
  contextPct: number;
  turns: number;
  compactions: number;
  sessionAge: string;
  provider: 'claude' | 'codex';
  supportedProviders: Array<'claude' | 'codex'>;
  configuredProvider: string;
  resolvedModel: string;
  telegramConnected: boolean;
  waConnected: boolean;
  slackConnected: boolean;
  killSwitches: Record<string, boolean>;
}

interface MissionTask {
  id: string;
  title: string;
  assigned_agent: string | null;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'partial' | 'cancelled';
  priority: number;
  created_at: number;
  completed_at: number | null;
}

interface Agent {
  id: string;
  name: string;
  running: boolean;
  provider: 'claude' | 'codex';
  resolvedModel: string;
}

interface RuntimeComponent {
  id: string;
  name: string;
  status: 'healthy' | 'degraded' | 'limited' | 'disabled';
  active: string;
}

interface HomeBrief {
  slot: 'morning' | 'midday' | 'evening' | 'other';
  label: string;
  taskId: string;
  title: string;
  agentId: string;
  status: 'active' | 'paused' | 'running';
  schedule: string;
  nextRun: number;
  lastRun: number | null;
  lastStatus: 'success' | 'failed' | 'timeout' | null;
  content: string;
  attentionItems: string[];
  primary: boolean;
}

interface HomeAttentionItem {
  id: string;
  source: 'brief' | 'mission' | 'schedule';
  severity: 'high' | 'medium' | 'low';
  title: string;
  detail: string;
  createdAt: number;
  agentId?: string | null;
  taskId?: string;
  href?: string;
}

interface HomeAgendaItem {
  id: string;
  source: 'calendar' | 'schedule';
  title: string;
  agentId: string | null;
  status: 'active' | 'paused' | 'running';
  dueAt: number;
  overdue: boolean;
  detail: string;
}

interface HomeAgenda {
  externalCalendar: {
    connected: boolean;
    provider: string | null;
    note: string;
  };
  items: HomeAgendaItem[];
}

const TERMINAL = new Set(['completed', 'failed', 'partial', 'cancelled']);

export function HomeDashboard() {
  const [, navigate] = useLocation();
  const [expandedBriefs, setExpandedBriefs] = useState<Record<string, boolean>>({});
  const [switchingProvider, setSwitchingProvider] = useState(false);
  const [providerNote, setProviderNote] = useState<string | null>(null);
  const health = useFetch<Health>(`/api/health?chatId=${encodeURIComponent(chatId)}`, 30_000);
  const missions = useFetch<{ tasks: MissionTask[] }>('/api/mission/tasks', 15_000);
  const briefs = useFetch<{ updatedAt: string; briefs: HomeBrief[]; latest: HomeBrief | null }>('/api/home/briefs', 30_000);
  const attention = useFetch<{ updatedAt: string; items: HomeAttentionItem[] }>('/api/home/attention', 15_000);
  const agenda = useFetch<{ updatedAt: string } & HomeAgenda>('/api/home/agenda', 30_000);
  const agents = useFetch<{ agents: Agent[] }>(`/api/agents?chatId=${encodeURIComponent(chatId)}`, 30_000);
  const runtime = useFetch<{ components: RuntimeComponent[] }>(
    `/api/runtime/stack?chatId=${encodeURIComponent(chatId)}`,
    30_000,
  );

  const error = health.error || missions.error || briefs.error || attention.error || agenda.error || agents.error || runtime.error;
  const loading = (health.loading || missions.loading || briefs.loading || attention.loading || agenda.loading || agents.loading || runtime.loading) && !health.data;

  const activeMissions = (missions.data?.tasks ?? []).filter((task) => !TERMINAL.has(task.status));
  const runningMissions = activeMissions.filter((task) => task.status === 'running');
  const unassigned = activeMissions.filter((task) => !task.assigned_agent);
  const liveAgents = (agents.data?.agents ?? []).filter((agent) => agent.running);
  const stackIssues = (runtime.data?.components ?? []).filter((component) => component.status !== 'healthy');
  const attentionItems = attention.data?.items ?? [];
  const briefItems = briefs.data?.briefs ?? [];
  const agendaItems = agenda.data?.items ?? [];
  const calendarConnected = !!agenda.data?.externalCalendar.connected;
  const personalCalendarItems = calendarConnected ? agendaItems : [];

  async function switchMainProvider() {
    if (!health.data || switchingProvider) return;
    const supported = health.data.supportedProviders?.length ? health.data.supportedProviders : ['claude', 'codex'];
    const next = supported.find((provider) => provider !== health.data?.provider) || (health.data.provider === 'codex' ? 'claude' : 'codex');
    setSwitchingProvider(true);
    setProviderNote(null);
    try {
      const result = await apiPost<{ ok: boolean; provider: 'claude' | 'codex'; message: string; restartRequired: boolean }>('/api/provider/switch', { provider: next });
      setProviderNote(result.restartRequired ? `${result.provider} saved, restart required` : result.message);
      health.refresh();
      runtime.refresh();
    } catch (err: any) {
      setProviderNote(err?.body?.error || err?.message || String(err));
    } finally {
      setSwitchingProvider(false);
    }
  }

  return (
    <div class="flex flex-col h-full">
      <PageHeader
        title="Home"
        actions={health.data && (
          <div class="flex items-center gap-2">
            <Pill tone={health.data.provider === 'codex' ? 'accent' : 'neutral'}>{health.data.provider}</Pill>
            <span class="text-[11px] text-[var(--color-text-muted)]">{todayLabel()}</span>
          </div>
        )}
      />

      {error && <PageState error={error} />}
      {loading && <PageState loading />}

      {!error && health.data && (
        <div class="flex-1 overflow-y-auto p-6 space-y-4">
          <div class="grid grid-cols-2 xl:grid-cols-4 gap-3">
            <Metric icon={<Sunrise size={16} />} label="Today" value={attentionItems.length + ' attention items'} detail={`${activeMissions.length} mission loops · ${runningMissions.length} running · ${unassigned.length} unassigned`} tone={attentionItems.some((item) => item.severity === 'high') ? 'medium' : 'neutral'} onClick={() => navigate('/review')} />
            <Metric icon={<CalendarDays size={16} />} label="Calendar" value={calendarConnected ? 'connected' : 'pending'} detail={calendarConnected ? agenda.data?.externalCalendar.provider || 'personal calendar' : 'personal calendar connector pending'} tone="medium" onClick={() => navigate('/agents')} />
            <Metric icon={<Users size={16} />} label="Agents" value={`${liveAgents.length}/${agents.data?.agents.length ?? 0} live`} detail={liveAgents.map((a) => a.name || a.id).slice(0, 3).join(', ') || 'none live'} onClick={() => navigate('/agents')} />
            <Metric
              icon={<Cpu size={16} />}
              label="Runtime"
              value={health.data.provider}
              detail={providerNote || health.data.resolvedModel}
              tone={stackIssues.length ? 'medium' : 'done'}
              onClick={() => navigate('/runtime')}
              action={
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); void switchMainProvider(); }}
                  disabled={switchingProvider}
                  class="shrink-0 px-2 py-1 rounded border border-[var(--color-border)] bg-[var(--color-elevated)] text-[10.5px] text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:border-[var(--color-border-strong)] disabled:opacity-40"
                >
                  {switchingProvider ? 'Switching...' : `Switch to ${health.data.provider === 'codex' ? 'claude' : 'codex'}`}
                </button>
              }
            />
          </div>

          <div class="grid grid-cols-1 2xl:grid-cols-[minmax(0,1.25fr)_minmax(360px,0.75fr)] gap-4">
            <section class="space-y-4">
              <Panel title="Briefs" icon={<Sunrise size={15} />}>
                {briefItems.length === 0 ? (
                  <EmptyLine text="No recent brief outputs found." />
                ) : (
                  <div class="space-y-3">
                    <BriefAttention items={attentionItems.filter((item) => item.source === 'brief')} />
                    {briefItems.map((brief) => (
                      <BriefCard
                        key={brief.taskId}
                        brief={brief}
                        expanded={!!expandedBriefs[brief.taskId]}
                        onToggle={() => setExpandedBriefs((prev) => ({ ...prev, [brief.taskId]: !prev[brief.taskId] }))}
                      />
                    ))}
                  </div>
                )}
              </Panel>

              <Panel title="Needs Attention" icon={<ShieldCheck size={15} />}>
                <AttentionPanel
                  items={attentionItems}
                  agents={agents.data?.agents ?? []}
                  missions={missions.data?.tasks ?? []}
                  onChange={() => {
                    attention.refresh();
                    missions.refresh();
                  }}
                />
              </Panel>

              <Panel title="Mission Queue" icon={<ListChecks size={15} />} action="/mission" navigate={navigate}>
                {activeMissions.length === 0 ? <EmptyLine text="No active mission tasks." /> : (
                  <div class="space-y-2">
                    {activeMissions.slice(0, 8).map((task) => <MissionLine key={task.id} task={task} />)}
                  </div>
                )}
              </Panel>
            </section>

            <section class="space-y-4">
              <Panel title="Today / Calendar" icon={<CalendarDays size={15} />}>
                {!agenda.data?.externalCalendar.connected && (
                  <div class="rounded-md border border-dashed border-[var(--color-border)] p-3 mb-3">
                    <div class="text-[12px] text-[var(--color-text)]">Personal calendar is not available right now.</div>
                    <div class="text-[11px] text-[var(--color-text-muted)] mt-1">{agenda.data?.externalCalendar.note}</div>
                  </div>
                )}
                {personalCalendarItems.length === 0 ? <EmptyLine text={calendarConnected ? 'No personal calendar items in the next 24 hours.' : 'Personal calendar connector pending. Agent schedules live under Agents.'} /> : (
                  <div class="space-y-2">
                    {personalCalendarItems.map((item) => <ScheduledLine key={item.id} item={item} />)}
                  </div>
                )}
              </Panel>

              <Panel title="OS Controls" icon={<ShieldCheck size={15} />} action="/settings" navigate={navigate}>
                <div class="space-y-2">
                  {Object.entries(health.data.killSwitches).map(([key, on]) => (
                    <ControlLine key={key} label={key.replace(/_ENABLED$/, '').toLowerCase()} on={on} />
                  ))}
                </div>
              </Panel>

              <Panel title="Runtime Stack" icon={<Radio size={15} />} action="/runtime" navigate={navigate}>
                <div class="space-y-2">
                  {(runtime.data?.components ?? []).map((component) => (
                    <div key={component.id} class="flex items-center justify-between gap-3 text-[12px]">
                      <div class="flex items-center gap-2 min-w-0">
                        <StatusDot tone={component.status === 'healthy' ? 'done' : component.status === 'degraded' ? 'failed' : 'medium'} />
                        <span class="text-[var(--color-text)] truncate">{component.name}</span>
                      </div>
                      <span class="text-[var(--color-text-muted)] truncate max-w-[140px]">{component.active}</span>
                    </div>
                  ))}
                </div>
              </Panel>
            </section>
          </div>
        </div>
      )}
    </div>
  );
}

function Metric({
  icon,
  label,
  value,
  detail,
  tone = 'neutral',
  onClick,
  action,
}: {
  icon: ComponentChildren;
  label: string;
  value: string;
  detail: string;
  tone?: 'neutral' | 'done' | 'medium';
  onClick?: () => void;
  action?: ComponentChildren;
}) {
  return (
    <div
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      onClick={onClick}
      onKeyDown={(e) => {
        if (!onClick) return;
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onClick();
        }
      }}
      class={[
        'bg-[var(--color-card)] border border-[var(--color-border)] rounded-lg p-4 transition-colors min-h-[118px]',
        onClick ? 'cursor-pointer hover:border-[var(--color-border-strong)] hover:bg-[var(--color-elevated)] focus:outline-none focus:border-[var(--color-accent)]' : '',
      ].join(' ')}
    >
      <div class="flex items-center justify-between gap-2 mb-3">
        <div class="text-[10px] uppercase tracking-wider text-[var(--color-text-faint)]">{label}</div>
        <div class={tone === 'done' ? 'text-[var(--color-status-done)]' : tone === 'medium' ? 'text-[var(--color-priority-medium)]' : 'text-[var(--color-text-muted)]'}>{icon}</div>
      </div>
      <div class="flex items-start justify-between gap-2">
        <div class="text-[19px] font-semibold text-[var(--color-text)] truncate min-w-0" title={value}>{value}</div>
        {action}
      </div>
      <div class="text-[11px] text-[var(--color-text-muted)] truncate mt-1" title={detail}>{detail}</div>
    </div>
  );
}

function Panel({
  title,
  icon,
  action,
  navigate,
  children,
}: {
  title: string;
  icon: ComponentChildren;
  action?: string;
  navigate?: (path: string) => void;
  children: ComponentChildren;
}) {
  return (
    <div class="bg-[var(--color-card)] border border-[var(--color-border)] rounded-lg p-4">
      <div class="flex items-center gap-2 mb-3">
        <div class="text-[var(--color-text-muted)]">{icon}</div>
        <div class="text-[10px] uppercase tracking-wider text-[var(--color-text-faint)]">{title}</div>
        {action && (
          <button
            type="button"
            onClick={() => navigate?.(action)}
            class="ml-auto text-[11px] text-[var(--color-accent)] hover:text-[var(--color-accent-hover)]"
          >
            Open
          </button>
        )}
      </div>
      {children}
    </div>
  );
}

function MissionLine({ task }: { task: MissionTask }) {
  const tone = task.status === 'running' ? 'running' : 'queued';
  return (
    <div class="flex items-start justify-between gap-3 border-b border-[var(--color-border)] last:border-b-0 pb-2 last:pb-0">
      <div class="min-w-0">
        <div class="text-[12.5px] text-[var(--color-text)] truncate">{task.title}</div>
        <div class="text-[10.5px] text-[var(--color-text-faint)] mt-0.5">
          {task.assigned_agent ? '@' + task.assigned_agent : 'unassigned'} · {formatRelativeTime(task.created_at)}
        </div>
      </div>
      <Pill tone={tone}>{task.status}</Pill>
    </div>
  );
}

function ScheduledLine({ item }: { item: HomeAgendaItem }) {
  return (
    <div class="flex items-start justify-between gap-3 border-b border-[var(--color-border)] last:border-b-0 pb-2 last:pb-0">
      <div class="min-w-0">
        <div class="text-[12.5px] text-[var(--color-text)] line-clamp-1">{item.title}</div>
        <div class="text-[10.5px] text-[var(--color-text-faint)] mt-0.5">@{item.agentId} · {item.detail}</div>
      </div>
      <Pill tone={item.status === 'running' ? 'running' : item.overdue ? 'failed' : 'neutral'}>{formatCountdown(item.dueAt)}</Pill>
    </div>
  );
}

function BriefCard({ brief, expanded, onToggle }: { brief: HomeBrief; expanded: boolean; onToggle: () => void }) {
  return (
    <div
      role="button"
      tabIndex={0}
      aria-expanded={expanded}
      onClick={onToggle}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onToggle();
        }
      }}
      class={(brief.primary ? 'bg-[var(--color-elevated)] border-[var(--color-border-strong)]' : 'bg-[var(--color-card)] border-[var(--color-border)]') + ' rounded-md border p-3 min-w-0 cursor-pointer hover:border-[var(--color-border-strong)] focus:outline-none focus:border-[var(--color-accent)]'}
    >
      <div class="flex items-center justify-between gap-2 mb-2">
        <div class="flex items-center gap-2 min-w-0">
          <div class="text-[10px] uppercase tracking-wider text-[var(--color-text-faint)]">{brief.label}</div>
          {brief.primary && <Pill tone="accent">latest</Pill>}
          <Pill tone="neutral">{expanded ? 'full' : 'click to expand'}</Pill>
        </div>
        <Pill tone={brief.status === 'paused' ? 'cancelled' : brief.lastStatus === 'failed' ? 'failed' : 'done'}>
          {brief.lastRun ? formatRelativeTime(brief.lastRun) : formatCountdown(brief.nextRun)}
        </Pill>
      </div>
      <div class={'text-[12px] text-[var(--color-text-muted)] whitespace-pre-wrap leading-relaxed ' + (expanded ? '' : 'line-clamp-5')}>
        {brief.content}
      </div>
      <div class="text-[10.5px] text-[var(--color-text-faint)] mt-2">
        {brief.title} · @{brief.agentId}
      </div>
    </div>
  );
}

function AttentionLine({ item }: { item: HomeAttentionItem }) {
  return (
    <div class="flex items-start gap-2 text-[12px] text-[var(--color-text-muted)]">
      <span class={(item.severity === 'high' ? 'bg-[var(--color-priority-high)]' : item.severity === 'medium' ? 'bg-[var(--color-priority-medium)]' : 'bg-[var(--color-text-faint)]') + ' mt-1.5 w-1.5 h-1.5 rounded-full shrink-0'} />
      <span><span class="text-[var(--color-text)]">{item.title}: </span>{item.detail}</span>
    </div>
  );
}

function BriefAttention({ items }: { items: HomeAttentionItem[] }) {
  if (items.length === 0) return null;
  return (
    <div class="rounded-md bg-[var(--color-elevated)] border border-[var(--color-border)] p-3">
      <div class="text-[10px] uppercase tracking-wider text-[var(--color-text-faint)] mb-2">Needs attention</div>
      <div class="space-y-1.5">
        {items.slice(0, 6).map((item) => <AttentionLine key={item.id} item={item} />)}
      </div>
    </div>
  );
}

function AttentionPanel({
  items,
  agents,
  missions,
  onChange,
}: {
  items: HomeAttentionItem[];
  agents: Agent[];
  missions: MissionTask[];
  onChange: () => void;
}) {
  const [assigning, setAssigning] = useState<Record<string, string>>({});

  async function assign(item: HomeAttentionItem, agentId: string) {
    if (!agentId) return;
    setAssigning((prev) => ({ ...prev, [item.id]: agentId }));
    try {
      const sourceMission = item.taskId ? missions.find((task) => task.id === item.taskId) : null;
      if (sourceMission && !TERMINAL.has(sourceMission.status)) {
        const result = await apiPatch<{ ok: boolean }>(`/api/mission/tasks/${sourceMission.id}`, { assigned_agent: agentId });
        if (!result.ok) throw new Error('Mission could not be reassigned');
      } else {
        const followUpTitle = `Follow up: ${item.title}`.slice(0, 200);
        const existingFollowUp = missions.find((task) => !TERMINAL.has(task.status) && task.title.toLowerCase() === followUpTitle.toLowerCase());
        if (existingFollowUp) {
          if (existingFollowUp.status === 'running') {
            if (existingFollowUp.assigned_agent !== agentId) {
              throw new Error(`Follow-up is already running with @${existingFollowUp.assigned_agent || 'unassigned'}`);
            }
          } else if (existingFollowUp.assigned_agent !== agentId) {
            const result = await apiPatch<{ ok: boolean }>(`/api/mission/tasks/${existingFollowUp.id}`, { assigned_agent: agentId });
            if (!result.ok) throw new Error('Existing follow-up could not be reassigned');
          }
          onChange();
          return;
        }
        await apiPost('/api/mission/tasks', {
          title: followUpTitle,
          prompt: [
            `Needs Attention item from Home dashboard.`,
            `Title: ${item.title}`,
            `Detail: ${item.detail}`,
            item.taskId ? `Source mission: ${item.taskId}` : '',
            item.href ? `Source link: ${item.href}` : '',
          ].filter(Boolean).join('\n'),
          assigned_agent: agentId,
          priority: item.severity === 'high' ? 9 : item.severity === 'medium' ? 6 : 3,
        });
      }
      onChange();
    } catch (err: any) {
      alert('Assign failed: ' + (err?.message || err));
    } finally {
      setAssigning((prev) => {
        const next = { ...prev };
        delete next[item.id];
        return next;
      });
    }
  }

  if (items.length === 0) return <EmptyLine text="Nothing currently needs attention." />;
  return (
    <div class="space-y-2">
      {items.slice(0, 8).map((item) => (
        <div key={item.id} class="flex items-start justify-between gap-3 border-b border-[var(--color-border)] last:border-b-0 pb-2 last:pb-0">
          <div class="min-w-0">
            <div class="flex items-center gap-2 min-w-0">
              <Pill tone={item.severity === 'high' ? 'failed' : item.severity === 'medium' ? 'medium' : 'neutral'}>{item.source}</Pill>
              <div class="text-[12.5px] text-[var(--color-text)] truncate">{item.title}</div>
            </div>
            <div class="text-[11px] text-[var(--color-text-muted)] mt-1 line-clamp-2">{item.detail}</div>
          </div>
          <div class="shrink-0 flex flex-col items-end gap-1.5">
            <div class="text-[10.5px] text-[var(--color-text-faint)]">{formatRelativeTime(item.createdAt)}</div>
            <select
              value=""
              onChange={(e) => {
                const value = (e.target as HTMLSelectElement).value;
                void assign(item, value);
                (e.target as HTMLSelectElement).value = '';
              }}
              disabled={!!assigning[item.id] || agents.length === 0}
              class="w-[132px] bg-[var(--color-card)] border border-[var(--color-border)] rounded text-[10.5px] text-[var(--color-text-muted)] px-1.5 py-1 outline-none hover:border-[var(--color-border-strong)] disabled:opacity-40"
              title="Assign this attention item"
            >
              <option value="">{assigning[item.id] ? 'Assigning...' : 'Assign to...'}</option>
              {agents.map((agent) => (
                <option key={agent.id} value={agent.id}>{agent.name || agent.id}</option>
              ))}
            </select>
          </div>
        </div>
      ))}
    </div>
  );
}

function ControlLine({ label, on }: { label: string; on: boolean }) {
  return (
    <div class="flex items-center justify-between gap-3 text-[12px]">
      <span class="text-[var(--color-text)]">{label}</span>
      <Pill tone={on ? 'done' : 'failed'}>{on ? 'on' : 'off'}</Pill>
    </div>
  );
}

function EmptyLine({ text }: { text: string }) {
  return <div class="text-[12px] text-[var(--color-text-muted)]">{text}</div>;
}

function todayLabel(): string {
  return new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric' }).format(new Date());
}

function formatCountdown(unixSeconds: number): string {
  const diff = unixSeconds - Date.now() / 1000;
  if (diff < 0) return 'overdue';
  if (diff < 3600) return 'in ' + Math.max(1, Math.floor(diff / 60)) + 'm';
  if (diff < 86400) return 'in ' + Math.floor(diff / 3600) + 'h';
  return 'in ' + Math.floor(diff / 86400) + 'd';
}
