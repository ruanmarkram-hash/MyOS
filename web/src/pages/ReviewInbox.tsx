import { Archive, Check, ChevronDown, ChevronRight, Download, ExternalLink, FileText, Mail, RefreshCcw, RotateCcw, Send } from 'lucide-preact';
import { useEffect, useState } from 'preact/hooks';
import { useLocation } from 'wouter-preact';
import { PageHeader } from '@/components/PageHeader';
import { PageState } from '@/components/PageState';
import { Pill } from '@/components/Pill';
import { useFetch } from '@/lib/useFetch';
import { apiPost, dashboardToken } from '@/lib/api';
import { formatRelativeTime } from '@/lib/format';

interface Agent { id: string; name: string; running: boolean; }

interface Deliverable {
  id: string;
  kind: 'file' | 'url' | 'text';
  label: string;
  target: string;
  href: string | null;
  exists: boolean;
  sizeBytes: number | null;
}

interface ReviewState {
  status: 'needs_review' | 'needs_triage' | 'waiting_followup' | 'resolved' | 'archived' | 'snoozed';
  resolution: string | null;
  followupTaskId: string | null;
  instruction: string | null;
  snoozedUntil: number | null;
  reviewedAt: number | null;
  updatedAt: number;
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
  kind: 'needs_action' | 'sorted';
  manifest: {
    route: 'needs_review' | 'needs_triage' | 'sorted' | 'done';
    summary: string;
    blockers: string[];
    nextAction: string | null;
  };
  deliverables: Deliverable[];
  review: ReviewState;
}

interface ReviewInboxPayload {
  updatedAt: string;
  items: ReviewItem[];
  total: number;
  openTotal: number;
  exportEmailConfigured: boolean;
}

const REVIEW_LABEL: Record<ReviewState['status'], string> = {
  needs_review: 'Needs review',
  needs_triage: 'Needs triage',
  waiting_followup: 'Waiting follow-up',
  resolved: 'Resolved',
  archived: 'Archived',
  snoozed: 'Snoozed',
};

export function ReviewInbox() {
  const [location] = useLocation();
  const inbox = useFetch<ReviewInboxPayload>('/api/review/inbox?limit=100', 15_000);
  const agents = useFetch<{ agents: Agent[] }>('/api/agents', 60_000);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [instructions, setInstructions] = useState<Record<string, string>>({});
  const [selectedAgent, setSelectedAgent] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<Record<string, string>>({});
  const [sortedOpen, setSortedOpen] = useState(false);
  const [sortedClearing, setSortedClearing] = useState(false);
  const [sortedMessage, setSortedMessage] = useState('');

  const agentList = agents.data?.agents ?? [];
  const allItems = inbox.data?.items ?? [];
  const actionItems = allItems.filter((item) => item.kind !== 'sorted');
  const sortedItems = allItems.filter((item) => item.kind === 'sorted');
  const grouped = groupItems(actionItems);

  useEffect(() => {
    const taskId = new URL(window.location.href).searchParams.get('task');
    if (!taskId) return;
    setExpanded((prev) => ({ ...prev, [taskId]: true }));
    window.setTimeout(() => document.getElementById(`review-${taskId}`)?.scrollIntoView({ block: 'center' }), 50);
  }, [location, inbox.data?.updatedAt]);

  async function mutate(item: ReviewItem, label: string, fn: () => Promise<unknown>, refresh = true) {
    setBusy((prev) => ({ ...prev, [item.id]: label }));
    setMessage((prev) => ({ ...prev, [item.id]: '' }));
    try {
      await fn();
      if (refresh) inbox.refresh();
    } catch (err: any) {
      setMessage((prev) => ({ ...prev, [item.id]: err?.body?.error || err?.message || String(err) }));
    } finally {
      setBusy((prev) => {
        const next = { ...prev };
        delete next[item.id];
        return next;
      });
    }
  }

  async function emailExport(item: ReviewItem) {
    await mutate(item, 'Emailing...', async () => {
      const result = await apiPost<{ from?: string; to: string; exported: { format: string; source?: string } }>(`/api/review/tasks/${item.id}/email`, { format: 'docx' });
      const from = result.from ? ` from ${result.from}` : '';
      const source = result.exported.source === 'deliverable' ? 'deliverable' : 'report';
      setMessage((prev) => ({ ...prev, [item.id]: `Sent ${source} ${result.exported.format}${from} to ${result.to}` }));
    }, false);
  }

  async function approve(item: ReviewItem) {
    await mutate(item, 'Approving...', () => apiPost(`/api/review/tasks/${item.id}/approve`));
  }

  async function archive(item: ReviewItem) {
    await mutate(item, 'Archiving...', () => apiPost(`/api/review/tasks/${item.id}/archive`));
  }

  async function clearAllSorted() {
    if (sortedClearing || sortedItems.length === 0) return;
    setSortedClearing(true);
    setSortedMessage('');
    try {
      const result = await apiPost<{ archived: number }>('/api/review/sorted/clear');
      setSortedMessage(`Cleared ${result.archived} sorted item${result.archived === 1 ? '' : 's'}.`);
      inbox.refresh();
    } catch (err: any) {
      setSortedMessage(err?.body?.error || err?.message || String(err));
    } finally {
      setSortedClearing(false);
    }
  }

  async function sendFollowup(item: ReviewItem, mode: 'retry' | 'followup') {
    const assigned = selectedAgent[item.id] || item.agentId || agentList[0]?.id || '';
    if (!assigned) {
      setMessage((prev) => ({ ...prev, [item.id]: 'Choose an agent first.' }));
      return;
    }
    await mutate(item, mode === 'retry' ? 'Retrying...' : 'Sending...', () => apiPost(`/api/review/tasks/${item.id}/follow-up`, {
      assigned_agent: assigned,
      instructions: instructions[item.id] || '',
      mode,
    }));
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
          <div class="grid grid-cols-4 gap-3">
            <Metric label="Needs your action" value={String(actionItems.length)} />
            <Metric label="Needs triage" value={String((grouped.needs_triage ?? []).length)} />
            <Metric label="Waiting follow-up" value={String((grouped.waiting_followup ?? []).length)} />
            <Metric label="Sorted ✓" value={String(sortedItems.length)} />
          </div>

          {inbox.data.items.length === 0 && (
            <div class="bg-[var(--color-card)] border border-[var(--color-border)] rounded-lg p-6 text-[12px] text-[var(--color-text-muted)]">
              No open review decisions.
            </div>
          )}

          <ReviewSection title="Needs triage" items={grouped.needs_triage ?? []}>
            {(item) => (
              <ReviewCard
                item={item}
                agents={agentList}
                expanded={!!expanded[item.id]}
                instructions={instructions[item.id] || ''}
                selectedAgent={selectedAgent[item.id] || item.agentId || ''}
                busy={busy[item.id]}
                message={message[item.id]}
                onToggle={() => setExpanded((prev) => ({ ...prev, [item.id]: !prev[item.id] }))}
                onInstructions={(value) => setInstructions((prev) => ({ ...prev, [item.id]: value }))}
                onAgent={(value) => setSelectedAgent((prev) => ({ ...prev, [item.id]: value }))}
                onRetry={() => void sendFollowup(item, 'retry')}
                onFollowup={() => void sendFollowup(item, 'followup')}
                onApprove={() => void approve(item)}
                onArchive={() => void archive(item)}
                onEmail={() => void emailExport(item)}
              />
            )}
          </ReviewSection>

          <ReviewSection title="Waiting follow-up" items={grouped.waiting_followup ?? []}>
            {(item) => <WaitingCard item={item} onArchive={() => void archive(item)} busy={busy[item.id]} />}
          </ReviewSection>

          <ReviewSection title="Deliverables ready" items={grouped.needs_review ?? []}>
            {(item) => (
              <ReviewCard
                item={item}
                agents={agentList}
                expanded={!!expanded[item.id]}
                instructions={instructions[item.id] || ''}
                selectedAgent={selectedAgent[item.id] || item.agentId || ''}
                busy={busy[item.id]}
                message={message[item.id]}
                onToggle={() => setExpanded((prev) => ({ ...prev, [item.id]: !prev[item.id] }))}
                onInstructions={(value) => setInstructions((prev) => ({ ...prev, [item.id]: value }))}
                onAgent={(value) => setSelectedAgent((prev) => ({ ...prev, [item.id]: value }))}
                onRetry={() => void sendFollowup(item, 'retry')}
                onFollowup={() => void sendFollowup(item, 'followup')}
                onApprove={() => void approve(item)}
                onArchive={() => void archive(item)}
                onEmail={() => void emailExport(item)}
              />
            )}
          </ReviewSection>

          {sortedItems.length > 0 && (
            <section class="bg-[var(--color-card)] border border-[var(--color-border)] rounded-lg">
              <div class="flex items-center gap-2 px-4 py-3">
                <button
                  type="button"
                  onClick={() => setSortedOpen(!sortedOpen)}
                  class="flex items-center gap-2 flex-1 min-w-0 text-left"
                >
                  {sortedOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                  <span class="text-[12px] text-[var(--color-text-muted)]">
                    ✓ {sortedItems.length} sorted (no action needed)
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => void clearAllSorted()}
                  disabled={sortedClearing}
                  class="review-btn shrink-0"
                  title="Archive all sorted items"
                >
                  <Archive size={12} /> {sortedClearing ? 'Clearing...' : 'Clear all'}
                </button>
              </div>
              {sortedMessage && (
                <div class="px-4 pb-2 text-[10.5px] text-[var(--color-text-faint)]">{sortedMessage}</div>
              )}
              {sortedOpen && (
                <div class="border-t border-[var(--color-border)] p-3 space-y-2">
                  {sortedItems.map((item) => (
                    <SortedCard
                      key={item.id}
                      item={item}
                      busy={busy[item.id]}
                      message={message[item.id]}
                      onApprove={() => void approve(item)}
                      onArchive={() => void archive(item)}
                    />
                  ))}
                </div>
              )}
            </section>
          )}
        </div>
      )}
    </div>
  );
}

function ReviewCard({
  item,
  agents,
  expanded,
  instructions,
  selectedAgent,
  busy,
  message,
  onToggle,
  onInstructions,
  onAgent,
  onRetry,
  onFollowup,
  onApprove,
  onArchive,
  onEmail,
}: {
  item: ReviewItem;
  agents: Agent[];
  expanded: boolean;
  instructions: string;
  selectedAgent: string;
  busy?: string;
  message?: string;
  onToggle: () => void;
  onInstructions: (value: string) => void;
  onAgent: (value: string) => void;
  onRetry: () => void;
  onFollowup: () => void;
  onApprove: () => void;
  onArchive: () => void;
  onEmail: () => void;
}) {
  const triage = item.review.status === 'needs_triage';
  return (
    <div class="bg-[var(--color-card)] border border-[var(--color-border)] rounded-lg p-4">
      <div id={`review-${item.id}`} class="sr-only" />
      <div class="flex items-start gap-3">
        <div class="w-9 h-9 rounded-md bg-[var(--color-elevated)] border border-[var(--color-border)] flex items-center justify-center text-[var(--color-accent)] shrink-0">
          <FileText size={17} />
        </div>
        <button type="button" onClick={onToggle} class="flex-1 min-w-0 text-left">
          <div class="flex items-center gap-2 min-w-0">
            <Pill tone={triage ? 'failed' : 'accent'}>{REVIEW_LABEL[item.review.status]}</Pill>
            <Pill tone={item.status as any}>{item.status}</Pill>
            {item.agentId && <Pill tone="neutral">@{item.agentId}</Pill>}
            <span class="text-[10px] text-[var(--color-text-faint)] tabular-nums uppercase tracking-wider">{item.id.slice(0, 6)}</span>
            <span class="ml-auto text-[10px] text-[var(--color-text-faint)] shrink-0">{formatRelativeTime(item.completedAt || item.createdAt)}</span>
          </div>
          <div class="text-[14px] font-medium text-[var(--color-text)] mt-2 line-clamp-2">{item.title}</div>
          <div class={'text-[12px] text-[var(--color-text-muted)] mt-1 leading-relaxed whitespace-pre-wrap ' + (expanded ? '' : 'line-clamp-2')}>
            {expanded ? (item.result || item.error || item.summary) : item.summary}
          </div>
          {(item.manifest.nextAction || item.manifest.blockers.length > 0) && (
            <div class="mt-2 rounded-md border border-[var(--color-border)] bg-[var(--color-elevated)] px-2.5 py-2">
              {item.manifest.nextAction && (
                <div class="text-[11px] text-[var(--color-text)]">
                  <span class="text-[var(--color-text-faint)] uppercase tracking-wider">Next </span>{item.manifest.nextAction}
                </div>
              )}
              {item.manifest.blockers.slice(0, 2).map((blocker) => (
                <div key={blocker} class="mt-1 text-[11px] text-[var(--color-status-failed)] line-clamp-2">{blocker}</div>
              ))}
            </div>
          )}
        </button>
      </div>

      <div class="mt-3 flex flex-wrap gap-2">
        {item.deliverables.map((deliverable) => <DeliverableAction key={deliverable.id} deliverable={deliverable} />)}
        <button type="button" onClick={onEmail} disabled={!!busy} class="review-btn">
          <Mail size={12} /> Email deliverable
        </button>
        <button type="button" onClick={onApprove} disabled={!!busy} class="review-btn">
          <Check size={12} /> Approve
        </button>
        <button type="button" onClick={onArchive} disabled={!!busy} class="review-btn">
          <Archive size={12} /> Archive
        </button>
      </div>

      <div class="mt-3 grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_180px] gap-2">
        <textarea
          value={instructions}
          onInput={(e) => onInstructions((e.target as HTMLTextAreaElement).value)}
          placeholder="Instructions for follow-up. What should the agent do differently or check this time?"
          rows={3}
          class="w-full bg-[var(--color-elevated)] border border-[var(--color-border)] rounded-md px-2.5 py-2 text-[12px] text-[var(--color-text)] outline-none focus:border-[var(--color-accent)] resize-none"
        />
        <div class="space-y-2">
          <select
            value={selectedAgent}
            onChange={(e) => onAgent((e.target as HTMLSelectElement).value)}
            class="w-full bg-[var(--color-elevated)] border border-[var(--color-border)] rounded-md px-2 py-1.5 text-[12px] text-[var(--color-text)] outline-none"
          >
            <option value="">Assign to...</option>
            {agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name || agent.id}</option>)}
          </select>
          <button type="button" onClick={triage ? onRetry : onFollowup} disabled={!!busy} class="w-full review-primary">
            {triage ? <RotateCcw size={13} /> : <Send size={13} />}
            {triage ? 'Retry with instructions' : 'Send follow-up'}
          </button>
          {triage && (
            <button type="button" onClick={onFollowup} disabled={!!busy} class="w-full review-btn justify-center">
              <Send size={12} /> Assign follow-up
            </button>
          )}
        </div>
      </div>

      {(busy || message) && (
        <div class="mt-2 text-[10.5px] text-[var(--color-text-faint)]">{busy || message}</div>
      )}
    </div>
  );
}

function SortedCard({
  item,
  busy,
  message,
  onApprove,
  onArchive,
}: {
  item: ReviewItem;
  busy?: string;
  message?: string;
  onApprove: () => void;
  onArchive: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div class="bg-[var(--color-card)] border border-[var(--color-border)] rounded-lg p-4">
      <div class="flex items-center gap-2">
        <Pill tone="accent">Sorted ✓</Pill>
        <Pill tone={item.status as any}>{item.status}</Pill>
        {item.agentId && <Pill tone="neutral">@{item.agentId}</Pill>}
        <span class="ml-auto text-[10px] text-[var(--color-text-faint)]">{formatRelativeTime(item.completedAt || item.createdAt)}</span>
      </div>
      <button type="button" onClick={() => setOpen(!open)} class="block w-full text-left mt-2">
        <div class="text-[14px] font-medium text-[var(--color-text)]">{item.title}</div>
        <div class={'text-[12px] text-[var(--color-text-muted)] mt-1 leading-relaxed whitespace-pre-wrap ' + (open ? '' : 'line-clamp-2')}>
          {open ? (item.result || item.error || item.summary) : item.summary}
        </div>
      </button>
      <div class="mt-3 flex flex-wrap gap-2">
        {item.deliverables.map((deliverable) => <DeliverableAction key={deliverable.id} deliverable={deliverable} />)}
        <button type="button" onClick={onApprove} disabled={!!busy} class="review-btn">
          <Check size={12} /> Mark seen
        </button>
        <button type="button" onClick={onArchive} disabled={!!busy} class="review-btn">
          <Archive size={12} /> Archive
        </button>
      </div>
      {(busy || message) && (
        <div class="mt-2 text-[10.5px] text-[var(--color-text-faint)]">{busy || message}</div>
      )}
    </div>
  );
}

function WaitingCard({ item, busy, onArchive }: { item: ReviewItem; busy?: string; onArchive: () => void }) {
  return (
    <div class="bg-[var(--color-card)] border border-[var(--color-border)] rounded-lg p-4">
      <div class="flex items-center gap-2">
        <Pill tone="medium">Waiting follow-up</Pill>
        {item.review.followupTaskId && <Pill tone="neutral">child {item.review.followupTaskId.slice(0, 6)}</Pill>}
        <span class="ml-auto text-[10px] text-[var(--color-text-faint)]">{formatRelativeTime(item.review.updatedAt)}</span>
      </div>
      <div class="text-[14px] font-medium text-[var(--color-text)] mt-2">{item.title}</div>
      <div class="text-[12px] text-[var(--color-text-muted)] mt-1 line-clamp-2">{item.review.instruction || item.summary}</div>
      <button type="button" onClick={onArchive} disabled={!!busy} class="review-btn mt-3">
        <Archive size={12} /> Archive
      </button>
    </div>
  );
}

function ReviewSection({ title, items, children }: { title: string; items: ReviewItem[]; children: (item: ReviewItem) => preact.ComponentChildren }) {
  if (items.length === 0) return null;
  return (
    <section class="space-y-2">
      <div class="flex items-center gap-2">
        <div class="text-[10px] uppercase tracking-wider text-[var(--color-text-faint)]">{title}</div>
        <span class="text-[10px] text-[var(--color-text-muted)] tabular-nums">{items.length}</span>
      </div>
      <div class="space-y-3">{items.map((item) => children(item))}</div>
    </section>
  );
}

function DeliverableAction({ deliverable }: { deliverable: Deliverable }) {
  if (deliverable.kind === 'url' && deliverable.href) {
    return (
      <a href={deliverable.href} target="_blank" rel="noreferrer" class="review-btn">
        <ExternalLink size={12} /> {deliverable.label}
      </a>
    );
  }

  if (deliverable.kind === 'file' && deliverable.href) {
    const href = `${deliverable.href}${deliverable.href.includes('?') ? '&' : '?'}token=${encodeURIComponent(dashboardToken)}`;
    return (
      <a href={href} target="_blank" rel="noreferrer" class="review-btn">
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

function groupItems(items: ReviewItem[]): Partial<Record<ReviewState['status'], ReviewItem[]>> {
  return items.reduce<Partial<Record<ReviewState['status'], ReviewItem[]>>>((acc, item) => {
    (acc[item.review.status] ??= []).push(item);
    return acc;
  }, {});
}
