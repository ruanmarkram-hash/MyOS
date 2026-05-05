import { Download, ExternalLink, FileText, Mail, RefreshCcw } from 'lucide-preact';
import { useState } from 'preact/hooks';
import { PageHeader } from '@/components/PageHeader';
import { PageState } from '@/components/PageState';
import { Pill } from '@/components/Pill';
import { useFetch } from '@/lib/useFetch';
import { apiPost, dashboardToken } from '@/lib/api';
import { formatRelativeTime } from '@/lib/format';

interface Deliverable {
  id: string;
  kind: 'file' | 'url' | 'text';
  label: string;
  target: string;
  href: string | null;
  exists: boolean;
  sizeBytes: number | null;
}

interface ReviewItem {
  id: string;
  title: string;
  agentId: string | null;
  status: 'completed' | 'failed' | 'partial' | 'cancelled';
  priority: number;
  createdAt: number;
  completedAt: number | null;
  summary: string;
  result: string | null;
  error: string | null;
  deliverables: Deliverable[];
}

interface ReviewInboxPayload {
  updatedAt: string;
  items: ReviewItem[];
  total: number;
  exportEmailConfigured: boolean;
}

export function ReviewInbox() {
  const inbox = useFetch<ReviewInboxPayload>('/api/review/inbox?limit=75', 15_000);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [sending, setSending] = useState<Record<string, string>>({});

  async function emailExport(item: ReviewItem) {
    setSending((prev) => ({ ...prev, [item.id]: 'Exporting...' }));
    try {
      const result = await apiPost<{ ok: boolean; to: string; exported: { format: string } }>(`/api/review/tasks/${item.id}/email`, { format: 'docx' });
      setSending((prev) => ({ ...prev, [item.id]: `Sent ${result.exported.format} to ${result.to}` }));
    } catch (err: any) {
      setSending((prev) => ({ ...prev, [item.id]: err?.body?.error || err?.message || String(err) }));
    }
  }

  return (
    <div class="flex flex-col h-full">
      <PageHeader
        title="Review Inbox"
        actions={
          <button
            type="button"
            onClick={inbox.refresh}
            class="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded text-[12px] text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-elevated)] transition-colors"
          >
            <RefreshCcw size={13} /> Refresh
          </button>
        }
      />

      {inbox.error && <PageState error={inbox.error} />}
      {inbox.loading && !inbox.data && <PageState loading />}

      {inbox.data && (
        <div class="flex-1 overflow-y-auto p-6 space-y-4">
          <div class="grid grid-cols-3 gap-3">
            <Metric label="Awaiting review" value={String(inbox.data.items.length)} />
            <Metric label="Deliverables" value={String(inbox.data.items.reduce((n, item) => n + item.deliverables.length, 0))} />
            <Metric label="Email export" value={inbox.data.exportEmailConfigured ? 'configured' : 'not configured'} />
          </div>

          <div class="space-y-3">
            {inbox.data.items.length === 0 && (
              <div class="bg-[var(--color-card)] border border-[var(--color-border)] rounded-lg p-6 text-[12px] text-[var(--color-text-muted)]">
                No mission deliverables are waiting for review.
              </div>
            )}

            {inbox.data.items.map((item) => {
              const isOpen = !!expanded[item.id];
              return (
                <div key={item.id} class="bg-[var(--color-card)] border border-[var(--color-border)] rounded-lg p-4">
                  <div class="flex items-start gap-3">
                    <div class="w-9 h-9 rounded-md bg-[var(--color-elevated)] border border-[var(--color-border)] flex items-center justify-center text-[var(--color-accent)] shrink-0">
                      <FileText size={17} />
                    </div>
                    <button
                      type="button"
                      onClick={() => setExpanded((prev) => ({ ...prev, [item.id]: !prev[item.id] }))}
                      class="flex-1 min-w-0 text-left"
                    >
                      <div class="flex items-center gap-2 min-w-0">
                        <Pill tone={item.status as any}>{item.status}</Pill>
                        {item.agentId && <Pill tone="neutral">@{item.agentId}</Pill>}
                        <span class="text-[10px] text-[var(--color-text-faint)] tabular-nums uppercase tracking-wider">{item.id.slice(0, 6)}</span>
                        <span class="ml-auto text-[10px] text-[var(--color-text-faint)] shrink-0">{formatRelativeTime(item.completedAt || item.createdAt)}</span>
                      </div>
                      <div class="text-[14px] font-medium text-[var(--color-text)] mt-2 line-clamp-2">{item.title}</div>
                      <div class={'text-[12px] text-[var(--color-text-muted)] mt-1 leading-relaxed whitespace-pre-wrap ' + (isOpen ? '' : 'line-clamp-2')}>
                        {isOpen ? (item.result || item.error || item.summary) : item.summary}
                      </div>
                    </button>
                  </div>

                  <div class="mt-3 flex flex-wrap gap-2">
                    {item.deliverables.map((deliverable) => (
                      <DeliverableAction key={deliverable.id} deliverable={deliverable} />
                    ))}
                    <button
                      type="button"
                      onClick={() => void emailExport(item)}
                      class="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded border border-[var(--color-border)] text-[11.5px] text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-elevated)] transition-colors"
                    >
                      <Mail size={12} /> Email export
                    </button>
                  </div>

                  {sending[item.id] && (
                    <div class="mt-2 text-[10.5px] text-[var(--color-text-faint)]">{sending[item.id]}</div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function DeliverableAction({ deliverable }: { deliverable: Deliverable }) {
  if (deliverable.kind === 'url' && deliverable.href) {
    return (
      <a
        href={deliverable.href}
        target="_blank"
        rel="noreferrer"
        class="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded border border-[var(--color-border)] text-[11.5px] text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-elevated)] transition-colors"
      >
        <ExternalLink size={12} /> {deliverable.label}
      </a>
    );
  }

  if (deliverable.kind === 'file' && deliverable.href) {
    const href = `${deliverable.href}${deliverable.href.includes('?') ? '&' : '?'}token=${encodeURIComponent(dashboardToken)}`;
    return (
      <a
        href={href}
        target="_blank"
        rel="noreferrer"
        class="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded border border-[var(--color-border)] text-[11.5px] text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-elevated)] transition-colors"
      >
        <Download size={12} /> {deliverable.label}
      </a>
    );
  }

  return (
    <span class="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded border border-[var(--color-border)] text-[11.5px] text-[var(--color-text-faint)]">
      <FileText size={12} /> {deliverable.label}
    </span>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div class="bg-[var(--color-card)] border border-[var(--color-border)] rounded-lg p-4 min-w-0">
      <div class="text-[10px] uppercase tracking-wider text-[var(--color-text-faint)] mb-1.5">{label}</div>
      <div class="text-[19px] font-semibold text-[var(--color-text)] truncate" title={value}>{value}</div>
    </div>
  );
}
