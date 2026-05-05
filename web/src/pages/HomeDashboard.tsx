import { useMemo } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import { CalendarDays, Cpu, ListChecks, Radio, ShieldCheck, Sunrise, Users } from 'lucide-preact';
import { useLocation } from 'wouter-preact';
import { PageHeader } from '@/components/PageHeader';
import { PageState } from '@/components/PageState';
import { Pill, StatusDot } from '@/components/Pill';
import { useFetch } from '@/lib/useFetch';
import { chatId } from '@/lib/api';
import { formatRelativeTime } from '@/lib/format';

interface Health {
  contextPct: number;
  turns: number;
  compactions: number;
  sessionAge: string;
  provider: 'claude' | 'codex';
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
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  priority: number;
  created_at: number;
  completed_at: number | null;
}

interface ScheduledTask {
  id: string;
  prompt: string;
  schedule: string;
  next_run: number;
  last_run: number | null;
  last_result: string | null;
  status: 'active' | 'paused' | 'running';
  agent_id: string;
  last_status: 'success' | 'failed' | 'timeout' | null;
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

const TERMINAL = new Set(['completed', 'failed', 'cancelled']);

export function HomeDashboard() {
  const [, navigate] = useLocation();
  const health = useFetch<Health>(`/api/health?chatId=${encodeURIComponent(chatId)}`, 30_000);
  const missions = useFetch<{ tasks: MissionTask[] }>('/api/mission/tasks', 15_000);
  const scheduled = useFetch<{ tasks: ScheduledTask[] }>('/api/tasks', 30_000);
  const agents = useFetch<{ agents: Agent[] }>(`/api/agents?chatId=${encodeURIComponent(chatId)}`, 30_000);
  const runtime = useFetch<{ components: RuntimeComponent[] }>(
    `/api/runtime/stack?chatId=${encodeURIComponent(chatId)}`,
    30_000,
  );

  const error = health.error || missions.error || scheduled.error || agents.error || runtime.error;
  const loading = (health.loading || missions.loading || scheduled.loading || agents.loading || runtime.loading) && !health.data;

  const activeMissions = (missions.data?.tasks ?? []).filter((task) => !TERMINAL.has(task.status));
  const runningMissions = activeMissions.filter((task) => task.status === 'running');
  const unassigned = activeMissions.filter((task) => !task.assigned_agent);
  const nextScheduled = useMemo(
    () => (scheduled.data?.tasks ?? [])
      .filter((task) => task.status !== 'paused')
      .sort((a, b) => a.next_run - b.next_run)
      .slice(0, 6),
    [scheduled.data],
  );
  const briefGroups = useMemo(
    () => groupBriefTasks(scheduled.data?.tasks ?? []),
    [scheduled.data],
  );
  const liveAgents = (agents.data?.agents ?? []).filter((agent) => agent.running);
  const stackIssues = (runtime.data?.components ?? []).filter((component) => component.status !== 'healthy');

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
            <Metric icon={<Sunrise size={16} />} label="Today" value={activeMissions.length + ' open loops'} detail={`${runningMissions.length} running · ${unassigned.length} unassigned`} />
            <Metric icon={<CalendarDays size={16} />} label="Calendar" value="not connected" detail="external calendar connector pending" tone="medium" />
            <Metric icon={<Users size={16} />} label="Agents" value={`${liveAgents.length}/${agents.data?.agents.length ?? 0} live`} detail={liveAgents.map((a) => a.name || a.id).slice(0, 3).join(', ') || 'none live'} />
            <Metric icon={<Cpu size={16} />} label="Runtime" value={health.data.provider} detail={health.data.resolvedModel} tone={stackIssues.length ? 'medium' : 'done'} />
          </div>

          <div class="grid grid-cols-1 2xl:grid-cols-[minmax(0,1.25fr)_minmax(360px,0.75fr)] gap-4">
            <section class="space-y-4">
              <Panel title="Briefs" icon={<Sunrise size={15} />}>
                {briefGroups.length === 0 ? (
                  <EmptyLine text="No recent brief outputs found." />
                ) : (
                  <div class="space-y-3">
                    <BriefAttention briefs={briefGroups} />
                    {briefGroups.map((group) => (
                      <BriefCard key={group.label} label={group.label} task={group.task} primary={group.primary} />
                    ))}
                  </div>
                )}
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
                <div class="rounded-md border border-dashed border-[var(--color-border)] p-3 mb-3">
                  <div class="text-[12px] text-[var(--color-text)]">External calendar is not wired into Mission Control yet.</div>
                  <div class="text-[11px] text-[var(--color-text-muted)] mt-1">Next connector should read Google/Outlook agenda, availability, and meeting prep.</div>
                </div>
                {nextScheduled.length === 0 ? <EmptyLine text="No scheduled OS jobs." /> : (
                  <div class="space-y-2">
                    {nextScheduled.map((task) => <ScheduledLine key={task.id} task={task} />)}
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

function Metric({ icon, label, value, detail, tone = 'neutral' }: { icon: ComponentChildren; label: string; value: string; detail: string; tone?: 'neutral' | 'done' | 'medium' }) {
  return (
    <div class="bg-[var(--color-card)] border border-[var(--color-border)] rounded-lg p-4">
      <div class="flex items-center justify-between gap-2 mb-3">
        <div class="text-[10px] uppercase tracking-wider text-[var(--color-text-faint)]">{label}</div>
        <div class={tone === 'done' ? 'text-[var(--color-status-done)]' : tone === 'medium' ? 'text-[var(--color-priority-medium)]' : 'text-[var(--color-text-muted)]'}>{icon}</div>
      </div>
      <div class="text-[19px] font-semibold text-[var(--color-text)] truncate" title={value}>{value}</div>
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

function ScheduledLine({ task }: { task: ScheduledTask }) {
  return (
    <div class="flex items-start justify-between gap-3 border-b border-[var(--color-border)] last:border-b-0 pb-2 last:pb-0">
      <div class="min-w-0">
        <div class="text-[12.5px] text-[var(--color-text)] line-clamp-1">{scheduleTitle(task.prompt)}</div>
        <div class="text-[10.5px] text-[var(--color-text-faint)] mt-0.5">@{task.agent_id} · {describeCron(task.schedule)}</div>
      </div>
      <Pill tone={task.status === 'running' ? 'running' : 'neutral'}>{formatCountdown(task.next_run)}</Pill>
    </div>
  );
}

function BriefCard({ label, task, primary }: { label: string; task: ScheduledTask; primary?: boolean }) {
  return (
    <div class={(primary ? 'bg-[var(--color-elevated)] border-[var(--color-border-strong)]' : 'bg-[var(--color-card)] border-[var(--color-border)]') + ' rounded-md border p-3 min-w-0'}>
      <div class="flex items-center justify-between gap-2 mb-2">
        <div class="flex items-center gap-2 min-w-0">
          <div class="text-[10px] uppercase tracking-wider text-[var(--color-text-faint)]">{label}</div>
          {primary && <Pill tone="accent">latest</Pill>}
        </div>
        <Pill tone={task.status === 'paused' ? 'cancelled' : 'done'}>
          {task.last_run ? formatRelativeTime(task.last_run) : formatCountdown(task.next_run)}
        </Pill>
      </div>
      <div class="text-[12px] text-[var(--color-text-muted)] whitespace-pre-wrap leading-relaxed line-clamp-5">
        {task.last_result}
      </div>
      <div class="text-[10.5px] text-[var(--color-text-faint)] mt-2">
        {scheduleTitle(task.prompt)} · {describeCron(task.schedule)} · @{task.agent_id}
      </div>
    </div>
  );
}

function AttentionLine({ text }: { text: string }) {
  const urgent = /urgent|overdue|blocked|awaiting|needs|action|failed|missing|error|🚨/i.test(text);
  return (
    <div class="flex items-start gap-2 text-[12px] text-[var(--color-text-muted)]">
      <span class={(urgent ? 'bg-[var(--color-priority-high)]' : 'bg-[var(--color-text-faint)]') + ' mt-1.5 w-1.5 h-1.5 rounded-full shrink-0'} />
      <span>{text}</span>
    </div>
  );
}

function extractAttentionItems(briefs: Array<{ task: ScheduledTask }>): string[] {
  const lines: string[] = [];
  for (const { task } of briefs) {
    for (const line of (task.last_result || '').split(/\r?\n/)) {
      const cleaned = line.replace(/^[-*•]\s*/, '').trim();
      if (!cleaned || /^OK$/i.test(cleaned)) continue;
      if (/urgent|overdue|blocked|awaiting|needs|action|failed|missing|error|🚨|tomorrow top|open threads/i.test(cleaned)) {
        lines.push(cleaned);
      }
      if (lines.length >= 6) return lines;
    }
  }
  return lines;
}

function BriefAttention({ briefs }: { briefs: Array<{ task: ScheduledTask }> }) {
  const items = extractAttentionItems(briefs);
  if (items.length === 0) return null;
  return (
    <div class="rounded-md bg-[var(--color-elevated)] border border-[var(--color-border)] p-3">
      <div class="text-[10px] uppercase tracking-wider text-[var(--color-text-faint)] mb-2">Needs attention</div>
      <div class="space-y-1.5">
        {items.map((item, index) => <AttentionLine key={index} text={item} />)}
      </div>
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

function describeCron(cron: string): string {
  if (cron === '0 9 * * *') return 'Daily at 9am';
  if (cron === '0 8 * * 1-5') return 'Weekdays at 8am';
  if (cron === '0 9 * * 1') return 'Mondays at 9am';
  if (cron === '0 18 * * 0') return 'Sundays at 6pm';
  const hourly = cron.match(/^0 \*\/(\d+) \* \* \*$/);
  if (hourly) return 'Every ' + hourly[1] + 'h';
  return cron;
}

function scheduleTitle(prompt: string): string {
  const firstLine = prompt.split(/\r?\n/).map((line) => line.trim()).find(Boolean) || prompt.trim();
  const beforeMode = firstLine.split('--- SILENT MODE:')[0].trim();
  const execute = beforeMode.match(/Execute exactly:\s*([^—.-]+)/i);
  if (execute?.[1]) return compactCommandTitle(execute[1]);
  const run = beforeMode.match(/Run:\s*([^—.-]+)/i);
  if (run?.[1]) return compactCommandTitle(run[1]);
  return beforeMode.length > 180 ? beforeMode.slice(0, 177) + '...' : beforeMode;
}

function groupBriefTasks(tasks: ScheduledTask[]): Array<{ label: string; task: ScheduledTask; primary?: boolean }> {
  const candidates = tasks
    .filter((task) => task.last_result && !/^OK$/i.test(task.last_result.trim()))
    .filter((task) => /morning|mid.?day|evening|daily|brief|wrap|pulse/i.test(task.prompt));
  const pick = (patterns: RegExp[]) =>
    candidates
      .filter((task) => patterns.some((pattern) => pattern.test(task.prompt)))
      .sort((a, b) => (b.last_run || 0) - (a.last_run || 0))[0] || null;

  const morning = pick([/morning/i]);
  const midday = pick([/mid.?day|afternoon|pulse/i]);
  const evening = pick([/evening|wrap|shutdown/i]);
  const used = new Set([morning?.id, midday?.id, evening?.id].filter(Boolean));
  const other = candidates.filter((task) => !used.has(task.id)).sort((a, b) => (b.last_run || 0) - (a.last_run || 0))[0] || null;
  const groups = [
    morning && { label: 'Morning', task: morning },
    midday && { label: 'Midday', task: midday },
    evening && { label: 'Evening', task: evening },
    other && { label: 'Other', task: other },
  ].filter(Boolean) as Array<{ label: string; task: ScheduledTask; primary?: boolean }>;
  const latestId = groups
    .map((group) => group.task)
    .sort((a, b) => (b.last_run || 0) - (a.last_run || 0))[0]?.id;

  return groups.map((group) => ({ ...group, primary: group.task.id === latestId }));
}

function compactCommandTitle(command: string): string {
  const cleaned = command.replace(/^python3\s+/, '').replace(/^bash\s+/, '').trim();
  const parts = cleaned.split('/');
  const file = parts[parts.length - 1] || cleaned;
  return file.replace(/\.(py|sh)$/i, '').replace(/[-_]/g, ' ');
}

function formatCountdown(unixSeconds: number): string {
  const diff = unixSeconds - Date.now() / 1000;
  if (diff < 0) return 'overdue';
  if (diff < 3600) return 'in ' + Math.max(1, Math.floor(diff / 60)) + 'm';
  if (diff < 86400) return 'in ' + Math.floor(diff / 3600) + 'h';
  return 'in ' + Math.floor(diff / 86400) + 'd';
}
