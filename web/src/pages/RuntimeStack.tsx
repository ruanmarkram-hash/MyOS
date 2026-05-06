import { Cpu, Database, LockKeyhole, Plug, RotateCcw, ShieldCheck } from 'lucide-preact';
import { useState } from 'preact/hooks';
import { PageHeader } from '@/components/PageHeader';
import { PageState } from '@/components/PageState';
import { Pill, StatusDot } from '@/components/Pill';
import { useFetch } from '@/lib/useFetch';
import { apiPost, chatId } from '@/lib/api';

interface RuntimeComponent {
  id: string;
  name: string;
  category: string;
  status: 'healthy' | 'degraded' | 'limited' | 'disabled';
  active: string;
  configured: string;
  implementations: string[];
  contract: string[];
  signals: Record<string, unknown>;
  actions: Record<string, string>;
  error: string | null;
}

interface RuntimeStackPayload {
  updatedAt: string;
  runtime: {
    activeProvider: 'claude' | 'codex';
    configuredProvider: string;
    supportedProviders: Array<'claude' | 'codex'>;
    configuredModel: string;
    resolvedModel: string;
    hasSession: boolean;
    sessionShort: string | null;
    providerError: string | null;
  };
  agentRoutes: Array<{
    agentId: string;
    name: string;
    provider: 'claude' | 'codex';
    configuredProvider: string;
    providerError: string | null;
    model: string;
    restartRequired: boolean;
  }>;
  components: RuntimeComponent[];
}

const ICONS: Record<string, typeof Cpu> = {
  'provider-adapter': Cpu,
  'local-model-readiness': Plug,
  'memory-backend': Database,
  'tool-boundary': Plug,
  'session-store': LockKeyhole,
  'safety-gates': ShieldCheck,
};

export function RuntimeStack() {
  const stack = useFetch<RuntimeStackPayload>(
    `/api/runtime/stack?chatId=${encodeURIComponent(chatId)}`,
    30_000,
  );
  const { data, loading, error } = stack;
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  async function switchProvider(provider: 'claude' | 'codex') {
    if (!data || provider === data.runtime.activeProvider || busy) return;
    setBusy(`switch-${provider}`);
    setNote(null);
    try {
      const result = await apiPost<{ provider: string; message: string; restartRequired: boolean }>('/api/provider/switch', { provider });
      setNote(result.restartRequired ? `${result.provider} saved. Restart Sage to activate it.` : result.message);
      stack.refresh();
    } catch (err: any) {
      setNote(err?.body?.error || err?.message || String(err));
    } finally {
      setBusy(null);
    }
  }

  async function smokeProvider(provider: 'claude' | 'codex') {
    if (busy) return;
    setBusy(`smoke-${provider}`);
    setNote(null);
    try {
      const result = await apiPost<{ ok: boolean; provider: string; resolvedModel: string; error?: string }>('/api/provider/smoke', { provider });
      setNote(result.ok ? `${provider} smoke passed on ${result.resolvedModel}` : `${provider} smoke failed: ${result.error || 'unknown error'}`);
    } catch (err: any) {
      setNote(err?.body?.error || err?.message || String(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div class="flex flex-col h-full">
      <PageHeader
        title="Runtime Stack"
        actions={data && (
          <div class="flex items-center gap-2">
            <Pill tone="accent">{data.runtime.activeProvider}</Pill>
            <span class="text-[11px] text-[var(--color-text-muted)]">{data.runtime.resolvedModel}</span>
          </div>
        )}
      />

      {error && <PageState error={error} />}
      {loading && !data && <PageState loading />}

      {data && (
        <div class="flex-1 overflow-y-auto p-6 space-y-4">
          <div class="grid grid-cols-2 xl:grid-cols-4 gap-3">
            <StackMetric label="Active provider" value={data.runtime.activeProvider} />
            <StackMetric label="Configured provider" value={data.runtime.configuredProvider} />
            <StackMetric label="Runtime model" value={compact(data.runtime.resolvedModel)} />
            <StackMetric label="Session" value={data.runtime.sessionShort || 'fresh'} />
          </div>

          <div class="bg-[var(--color-card)] border border-[var(--color-border)] rounded-lg p-4">
            <div class="flex items-center justify-between gap-3 mb-3">
              <div>
                <div class="text-[10px] uppercase tracking-wider text-[var(--color-text-faint)]">Main LLM provider</div>
                <div class="text-[12px] text-[var(--color-text-muted)] mt-1">Default runtime for Sage. Per-agent and local model routing will sit on this same provider adapter.</div>
              </div>
              <button
                type="button"
                onClick={() => stack.refresh()}
                class="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded text-[12px] text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-elevated)] transition-colors"
              >
                <RotateCcw size={13} /> Refresh
              </button>
            </div>
            <div class="flex flex-wrap gap-2">
              {data.runtime.supportedProviders.map((provider) => (
                <div key={provider} class="flex items-center gap-1.5 rounded-md border border-[var(--color-border)] bg-[var(--color-elevated)] p-1">
                  <button
                    type="button"
                    onClick={() => void switchProvider(provider)}
                    disabled={busy !== null || provider === data.runtime.activeProvider}
                    class="px-2.5 py-1.5 rounded text-[12px] text-[var(--color-text)] hover:bg-[var(--color-card)] disabled:opacity-45 disabled:cursor-not-allowed"
                  >
                    {provider === data.runtime.activeProvider ? `${provider} active` : `Use ${provider}`}
                  </button>
                  <button
                    type="button"
                    onClick={() => void smokeProvider(provider)}
                    disabled={busy !== null}
                    class="px-2 py-1.5 rounded text-[11px] text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-card)] disabled:opacity-45"
                  >
                    {busy === `smoke-${provider}` ? 'Testing...' : 'Smoke'}
                  </button>
                </div>
              ))}
            </div>
            {note && <div class="mt-3 text-[11px] text-[var(--color-text-muted)]">{note}</div>}
            {data.runtime.providerError && <div class="mt-3 text-[11px] text-[var(--color-status-failed)]">{data.runtime.providerError}</div>}
          </div>

          <div class="bg-[var(--color-card)] border border-[var(--color-border)] rounded-lg p-4">
            <div class="flex items-center justify-between gap-3 mb-3">
              <div>
                <div class="text-[10px] uppercase tracking-wider text-[var(--color-text-faint)]">Agent provider routes</div>
                <div class="text-[12px] text-[var(--color-text-muted)] mt-1">Each agent can run on a different provider while keeping provider-scoped sessions separate.</div>
              </div>
            </div>
            <div class="grid gap-2" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 220px), 1fr))' }}>
              {data.agentRoutes.map((route) => (
                <div key={route.agentId} class="rounded-md border border-[var(--color-border)] bg-[var(--color-elevated)] px-3 py-2">
                  <div class="flex items-center justify-between gap-2">
                    <div class="min-w-0">
                      <div class="text-[12px] text-[var(--color-text)] truncate">{route.name || route.agentId}</div>
                      <div class="text-[10px] text-[var(--color-text-faint)] uppercase tracking-wider">{route.agentId}</div>
                    </div>
                    <Pill tone={route.provider === data.runtime.activeProvider ? 'accent' : 'neutral'}>{route.provider}</Pill>
                  </div>
                  <div class="mt-2 text-[11px] text-[var(--color-text-muted)] truncate" title={route.model}>{compact(route.model)}</div>
                  {route.providerError && <div class="mt-1 text-[10.5px] text-[var(--color-status-failed)] truncate">{route.providerError}</div>}
                </div>
              ))}
            </div>
          </div>

          <div class="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 340px), 1fr))' }}>
            {data.components.map((component) => (
              <ComponentCard key={component.id} component={component} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function ComponentCard({ component }: { component: RuntimeComponent }) {
  const Icon = ICONS[component.id] || Cpu;
  const tone = component.status === 'healthy' ? 'done' : component.status === 'degraded' ? 'failed' : 'medium';

  return (
    <div class="bg-[var(--color-card)] border border-[var(--color-border)] rounded-lg p-4">
      <div class="flex items-start gap-3">
        <div class="w-9 h-9 rounded-md bg-[var(--color-elevated)] border border-[var(--color-border)] flex items-center justify-center text-[var(--color-accent)] shrink-0">
          <Icon size={17} />
        </div>
        <div class="flex-1 min-w-0">
          <div class="flex items-center gap-2">
            <StatusDot tone={tone} />
            <div class="text-[13px] font-medium text-[var(--color-text)]">{component.name}</div>
            <Pill tone={tone}>{component.status}</Pill>
          </div>
          <div class="text-[10px] uppercase tracking-wider text-[var(--color-text-faint)] mt-0.5">{component.category}</div>
        </div>
      </div>

      <div class="grid grid-cols-2 gap-3 mt-4">
        <Mini label="Active" value={component.active} />
        <Mini label="Configured" value={component.configured} align="right" />
      </div>

      <div class="mt-3 flex flex-wrap gap-1.5">
        {component.implementations.map((implementation) => (
          <Pill key={implementation} tone={implementation.toLowerCase() === component.active.toLowerCase() ? 'accent' : 'neutral'}>
            {implementation}
          </Pill>
        ))}
      </div>

      <div class="mt-4 pt-3 border-t border-[var(--color-border)]">
        <div class="text-[10px] uppercase tracking-wider text-[var(--color-text-faint)] mb-2">Contract</div>
        <div class="space-y-1.5">
          {component.contract.map((item) => (
            <div key={item} class="flex items-start gap-2 text-[12px] text-[var(--color-text-muted)]">
              <span class="mt-1.5 w-1 h-1 rounded-full bg-[var(--color-text-faint)] shrink-0" />
              <span>{item}</span>
            </div>
          ))}
        </div>
      </div>

      <div class="mt-4 pt-3 border-t border-[var(--color-border)]">
        <div class="text-[10px] uppercase tracking-wider text-[var(--color-text-faint)] mb-2">Signals</div>
        <div class="grid grid-cols-2 gap-2">
          {Object.entries(component.signals).map(([key, value]) => (
            <Mini key={key} label={key} value={formatSignal(value)} />
          ))}
        </div>
      </div>

      {component.error && (
        <div class="mt-3 text-[11px] text-[var(--color-status-failed)]">{component.error}</div>
      )}
    </div>
  );
}

function StackMetric({ label, value }: { label: string; value: string }) {
  return (
    <div class="bg-[var(--color-card)] border border-[var(--color-border)] rounded-lg p-4">
      <div class="text-[10px] uppercase tracking-wider text-[var(--color-text-faint)] mb-1.5">{label}</div>
      <div class="text-[18px] font-semibold text-[var(--color-text)] truncate" title={value}>{value}</div>
    </div>
  );
}

function Mini({ label, value, align = 'left' }: { label: string; value: string; align?: 'left' | 'right' }) {
  return (
    <div class={align === 'right' ? 'text-right min-w-0' : 'min-w-0'}>
      <div class="text-[10px] uppercase tracking-wider text-[var(--color-text-faint)] truncate">{label}</div>
      <div class="text-[12px] text-[var(--color-text)] truncate" title={value}>{value}</div>
    </div>
  );
}

function formatSignal(value: unknown): string {
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return Number.isInteger(value) ? String(value) : value.toFixed(2);
  if (value === null || value === undefined) return '-';
  return String(value);
}

function compact(model: string): string {
  return model.replace(/^claude-/, '').replace(/^gpt-/, 'gpt ');
}
