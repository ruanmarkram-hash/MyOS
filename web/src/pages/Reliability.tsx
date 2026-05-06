import { AlertTriangle, CheckCircle2, RefreshCcw, RotateCcw } from 'lucide-preact';
import type { ComponentChildren } from 'preact';
import { PageHeader } from '@/components/PageHeader';
import { PageState } from '@/components/PageState';
import { Pill, StatusDot } from '@/components/Pill';
import { useFetch } from '@/lib/useFetch';
import { formatRelativeTime } from '@/lib/format';

interface ReliabilityIssue {
  kind: string;
  severity: 'high' | 'medium' | 'low';
  title: string;
  detail: string;
  href: string;
}

interface ReliabilityStatus {
  updatedAt: string;
  ok: boolean;
  summary: {
    openIssues: number;
    stuckWorkers: number;
    failedSchedules: number;
    staleMissions: number;
    telegramDeadLetters: number;
    restartNeeded: boolean;
  };
  issues: ReliabilityIssue[];
  workers: {
    staleScheduled: Array<{ id: string; title: string; agentId: string; ageSeconds: number; href: string }>;
    failedScheduled: Array<{ id: string; title: string; agentId: string; status: string; lastRun: number | null; detail: string; href: string }>;
  };
  missions: {
    stale: Array<{ id: string; title: string; agentId: string | null; status: string; ageSeconds: number; attempts: number; href: string }>;
  };
  telegram: {
    pending: number;
    in_flight: number;
    sent: number;
    failed: number;
    deadLettered: number;
    oldestUnsentAgeSeconds: number | null;
  };
  providers: Array<{ id: string; running: boolean; provider: string; model: string; providerError: string | null }>;
  restart: {
    needed: boolean;
    runtimeSha: string;
    diskSha: string;
    branch: string;
    builtAt: string;
    uptimeSeconds: number;
  };
}

export function Reliability() {
  const status = useFetch<ReliabilityStatus>('/api/reliability/status', 15_000);
  const data = status.data;

  return (
    <div class="flex flex-col h-full">
      <PageHeader
        title="Reliability"
        actions={data && (
          <button
            type="button"
            onClick={() => status.refresh()}
            class="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-[12px] text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-elevated)]"
          >
            <RefreshCcw size={13} /> Refresh
          </button>
        )}
      />

      {status.error && <PageState error={status.error} />}
      {status.loading && !data && <PageState loading />}

      {data && (
        <div class="flex-1 overflow-y-auto p-6 space-y-4">
          <div class="grid grid-cols-2 xl:grid-cols-6 gap-3">
            <Metric label="Open issues" value={String(data.summary.openIssues)} tone={data.ok ? 'done' : 'failed'} />
            <Metric label="Stuck workers" value={String(data.summary.stuckWorkers)} tone={data.summary.stuckWorkers ? 'failed' : 'done'} />
            <Metric label="Failed schedules" value={String(data.summary.failedSchedules)} tone={data.summary.failedSchedules ? 'failed' : 'done'} />
            <Metric label="Stale missions" value={String(data.summary.staleMissions)} tone={data.summary.staleMissions ? 'medium' : 'done'} />
            <Metric label="Dead letters" value={String(data.summary.telegramDeadLetters)} tone={data.summary.telegramDeadLetters ? 'failed' : 'done'} />
            <Metric label="Restart" value={data.summary.restartNeeded ? 'needed' : 'current'} tone={data.summary.restartNeeded ? 'medium' : 'done'} />
          </div>

          <Panel title="Issues">
            {data.issues.length === 0 ? (
              <div class="flex items-center gap-2 text-[13px] text-[var(--color-text-muted)]">
                <CheckCircle2 size={15} class="text-[var(--color-status-done)]" /> No reliability issues currently detected.
              </div>
            ) : (
              <div class="space-y-2">
                {data.issues.map((issue, index) => <IssueLine key={`${issue.kind}-${index}`} issue={issue} />)}
              </div>
            )}
          </Panel>

          <div class="grid grid-cols-1 xl:grid-cols-2 gap-4">
            <Panel title="Workers and Schedules">
              <SectionLines
                empty="No stuck or failed scheduled work."
                rows={[
                  ...data.workers.staleScheduled.map((w) => ({ id: w.id, title: w.title, meta: `${w.agentId} · ${Math.floor(w.ageSeconds / 60)}m running`, tone: 'failed' as const })),
                  ...data.workers.failedScheduled.map((w) => ({ id: w.id, title: w.title, meta: `${w.agentId} · ${w.status} · ${w.lastRun ? formatRelativeTime(w.lastRun) : 'never'}`, tone: 'failed' as const, detail: w.detail })),
                ]}
              />
            </Panel>

            <Panel title="Mission Loop">
              <SectionLines
                empty="No stale missions or notification recovery failures."
                rows={data.missions.stale.map((m) => ({
                  id: m.id,
                  title: m.title,
                  meta: `${m.status} · ${m.agentId || 'unassigned'} · ${Math.floor(m.ageSeconds / 60)}m · ${m.attempts} notify attempts`,
                  tone: m.status === 'running' ? 'failed' : 'medium',
                }))}
              />
            </Panel>

            <Panel title="Telegram Outbox">
              <div class="grid grid-cols-3 gap-2">
                <Mini label="Pending" value={String(data.telegram.pending)} />
                <Mini label="In flight" value={String(data.telegram.in_flight)} />
                <Mini label="Dead" value={String(data.telegram.deadLettered)} />
              </div>
              <div class="mt-3 text-[12px] text-[var(--color-text-muted)]">
                Oldest unsent: {data.telegram.oldestUnsentAgeSeconds == null ? 'none' : `${Math.floor(data.telegram.oldestUnsentAgeSeconds / 60)}m`}
              </div>
            </Panel>

            <Panel title="Provider Health">
              <div class="space-y-2">
                {data.providers.map((provider) => (
                  <div key={provider.id} class="flex items-center justify-between gap-3 border-b border-[var(--color-border)] pb-2 last:border-0">
                    <div class="min-w-0">
                      <div class="flex items-center gap-2">
                        <StatusDot tone={provider.running && !provider.providerError ? 'done' : 'failed'} />
                        <span class="text-[12px] text-[var(--color-text)]">{provider.id}</span>
                        <Pill tone="neutral">{provider.provider}</Pill>
                      </div>
                      <div class="text-[10.5px] text-[var(--color-text-muted)] truncate mt-1">{provider.providerError || provider.model}</div>
                    </div>
                  </div>
                ))}
              </div>
            </Panel>
          </div>

          <Panel title="Restart State">
            <div class="flex items-center gap-3">
              <RotateCcw size={15} class={data.restart.needed ? 'text-[var(--color-status-medium)]' : 'text-[var(--color-status-done)]'} />
              <div class="text-[12px] text-[var(--color-text-muted)]">
                Runtime {data.restart.runtimeSha} · disk {data.restart.diskSha} · {data.restart.branch} · uptime {Math.floor(data.restart.uptimeSeconds / 60)}m
              </div>
            </div>
          </Panel>
        </div>
      )}
    </div>
  );
}

function Panel({ title, children }: { title: string; children: ComponentChildren }) {
  return (
    <section class="bg-[var(--color-card)] border border-[var(--color-border)] rounded-lg p-4">
      <div class="text-[10px] uppercase tracking-wider text-[var(--color-text-faint)] mb-3">{title}</div>
      {children}
    </section>
  );
}

function Metric({ label, value, tone }: { label: string; value: string; tone: 'done' | 'failed' | 'medium' }) {
  return (
    <div class="bg-[var(--color-card)] border border-[var(--color-border)] rounded-lg p-4">
      <div class="flex items-center justify-between mb-2">
        <div class="text-[10px] uppercase tracking-wider text-[var(--color-text-faint)]">{label}</div>
        <StatusDot tone={tone} />
      </div>
      <div class="text-[20px] font-semibold text-[var(--color-text)]">{value}</div>
    </div>
  );
}

function IssueLine({ issue }: { issue: ReliabilityIssue }) {
  return (
    <div class="flex items-start gap-3 border-b border-[var(--color-border)] pb-2 last:border-0">
      <AlertTriangle size={14} class={issue.severity === 'high' ? 'text-[var(--color-status-failed)]' : 'text-[var(--color-status-medium)]'} />
      <div class="min-w-0">
        <div class="text-[12px] text-[var(--color-text)]">{issue.title}</div>
        <div class="text-[11px] text-[var(--color-text-muted)] truncate">{issue.detail}</div>
      </div>
    </div>
  );
}

function SectionLines({ rows, empty }: { rows: Array<{ id: string; title: string; meta: string; tone: 'done' | 'failed' | 'medium'; detail?: string }>; empty: string }) {
  if (rows.length === 0) return <div class="text-[12px] text-[var(--color-text-muted)]">{empty}</div>;
  return (
    <div class="space-y-2">
      {rows.map((row) => (
        <div key={row.id} class="border-b border-[var(--color-border)] pb-2 last:border-0">
          <div class="flex items-center gap-2">
            <StatusDot tone={row.tone} />
            <div class="text-[12px] text-[var(--color-text)] truncate">{row.title}</div>
          </div>
          <div class="text-[10.5px] text-[var(--color-text-muted)] mt-1">{row.meta}</div>
          {row.detail && <div class="text-[10.5px] text-[var(--color-text-faint)] mt-1 line-clamp-2">{row.detail}</div>}
        </div>
      ))}
    </div>
  );
}

function Mini({ label, value }: { label: string; value: string }) {
  return (
    <div class="rounded-md bg-[var(--color-elevated)] border border-[var(--color-border)] px-3 py-2">
      <div class="text-[10px] uppercase tracking-wider text-[var(--color-text-faint)]">{label}</div>
      <div class="text-[16px] text-[var(--color-text)] font-semibold">{value}</div>
    </div>
  );
}
