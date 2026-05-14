import { useEffect, useState } from 'preact/hooks';
import { CheckSquare, Clock, LayoutGrid, List, Pause, Pencil, Play, Trash2 } from 'lucide-preact';
import { PageHeader } from '@/components/PageHeader';
import { Pill } from '@/components/Pill';
import { PageState } from '@/components/PageState';
import { Modal } from '@/components/Modal';
import { useFetch } from '@/lib/useFetch';
import { apiDelete, apiPatch, apiPost } from '@/lib/api';
import { formatRelativeTime } from '@/lib/format';

interface ScheduledTask {
  id: string;
  prompt: string;
  schedule: string;
  next_run: number;
  last_run: number | null;
  last_result: string | null;
  status: 'active' | 'paused' | 'running';
  created_at: number;
  agent_id: string;
  started_at: number | null;
  last_status: 'success' | 'failed' | 'timeout' | null;
}

interface AgentOption { id: string; name: string; }

type ViewMode = 'cards' | 'list';

const VIEW_KEY = 'myos.scheduled.view';

function loadView(): ViewMode {
  try {
    const value = localStorage.getItem(VIEW_KEY);
    if (value === 'cards' || value === 'list') return value;
  } catch {}
  return 'cards';
}

function describeCron(cron: string): string {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return cron;
  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;
  if (minute === '0' && hour === '9' && dayOfMonth === '*' && month === '*' && dayOfWeek === '*') return 'Daily at 9 AM';
  if (minute === '0' && hour === '8' && dayOfMonth === '*' && month === '*' && dayOfWeek === '1-5') return 'Weekdays at 8 AM';
  if (minute === '0' && hour === '9' && dayOfMonth === '*' && month === '*' && dayOfWeek === '1') return 'Mondays at 9 AM';
  if (minute === '0' && hour === '18' && dayOfMonth === '*' && month === '*' && dayOfWeek === '0') return 'Sundays at 6 PM';
  const hourly = cron.match(/^0 \*\/(\d+) \* \* \*$/);
  if (hourly) return `Every ${hourly[1]} hour${hourly[1] === '1' ? '' : 's'}`;
  const everyMinute = cron.match(/^\*\/(\d+) \* \* \* \*$/);
  if (everyMinute) return `Every ${everyMinute[1]} minutes`;
  return cron;
}

function formatCountdown(unixSeconds: number): string {
  const diff = unixSeconds - Date.now() / 1000;
  if (diff < 0) return 'overdue';
  if (diff < 60) return 'in ' + Math.floor(diff) + 's';
  if (diff < 3600) return 'in ' + Math.floor(diff / 60) + 'm';
  if (diff < 86400) return 'in ' + Math.floor(diff / 3600) + 'h';
  return 'in ' + Math.floor(diff / 86400) + 'd';
}

export function Scheduled() {
  return (
    <div class="flex flex-col h-full">
      <ScheduledTasksPanel fullPage />
    </div>
  );
}

export function ScheduledTasksPanel({ fullPage = false }: { fullPage?: boolean }) {
  const { data, loading, error, refresh } = useFetch<{ tasks: ScheduledTask[] }>('/api/tasks', 30_000);
  const agents = useFetch<{ agents: AgentOption[] }>('/api/agents', 60_000);
  const tasks = data?.tasks ?? [];
  const [view, setView] = useState<ViewMode>(loadView());
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<ScheduledTask | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    setSelected((prev) => new Set([...prev].filter((id) => tasks.some((task) => task.id === id))));
  }, [tasks.length]);

  function setViewPersisted(next: ViewMode) {
    setView(next);
    try { localStorage.setItem(VIEW_KEY, next); } catch {}
  }

  function toggleSelected(id: string) {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  }

  function toggleAll() {
    if (selected.size === tasks.length) setSelected(new Set());
    else setSelected(new Set(tasks.map((task) => task.id)));
  }

  async function action(task: ScheduledTask, act: 'pause' | 'resume' | 'delete') {
    if (act === 'delete' && !confirm('Delete this scheduled task?')) return;
    setBusy(`${act}:${task.id}`);
    try {
      if (act === 'pause') await apiPost(`/api/tasks/${task.id}/pause`);
      if (act === 'resume') await apiPost(`/api/tasks/${task.id}/resume`);
      if (act === 'delete') await apiDelete(`/api/tasks/${task.id}`);
      refresh();
    } catch (err: any) {
      alert(act + ' failed: ' + (err?.body?.error || err?.message || err));
    } finally {
      setBusy(null);
    }
  }

  async function deleteSelected() {
    if (selected.size === 0) return;
    if (!confirm(`Delete ${selected.size} scheduled task${selected.size === 1 ? '' : 's'}?`)) return;
    setBusy('bulk-delete');
    try {
      for (const id of selected) await apiDelete(`/api/tasks/${id}`);
      setSelected(new Set());
      refresh();
    } catch (err: any) {
      alert('Bulk delete failed: ' + (err?.body?.error || err?.message || err));
    } finally {
      setBusy(null);
    }
  }

  const agentOptions = (agents.data?.agents ?? []).map((a) => ({ id: a.id, name: a.name || a.id }));
  const fullActions = (
    <>
      <span class="text-[11px] text-[var(--color-text-muted)] tabular-nums">
        {tasks.length} scheduled{selected.size > 0 ? ` · ${selected.size} selected` : ''}
      </span>
      {selected.size > 0 && (
        <button
          type="button"
          onClick={deleteSelected}
          disabled={busy !== null}
          class="inline-flex items-center gap-1 px-2.5 py-1.5 rounded text-[12px] text-white bg-[var(--color-status-failed)] hover:opacity-90 disabled:opacity-40 transition-opacity"
        >
          <Trash2 size={12} /> Delete
        </button>
      )}
      <ViewSwitcher view={view} onChange={setViewPersisted} />
    </>
  );

  return (
    <>
      {fullPage ? (
        <PageHeader title="Scheduled" actions={fullActions} />
      ) : (
        <div class="flex items-center justify-between mb-3">
          <div>
            <div class="text-[12px] font-medium text-[var(--color-text)]">Scheduled</div>
            <div class="text-[11px] text-[var(--color-text-muted)]">Recurring agent and OS jobs</div>
          </div>
          <span class="text-[11px] text-[var(--color-text-muted)] tabular-nums">{tasks.length} scheduled</span>
        </div>
      )}

      {error && <PageState error={error} />}
      {loading && !data && <PageState loading />}
      {!loading && !error && tasks.length === 0 && (
        <PageState
          empty
          emptyTitle="No scheduled tasks"
          emptyDescription="Ask the bot to create a recurring task. It will show up here when scheduled."
        />
      )}

      {tasks.length > 0 && (
        <div class={fullPage ? 'flex-1 min-h-0 overflow-y-auto p-4 md:p-6' : ''}>
          {fullPage && view === 'list' ? (
            <ScheduledList
              tasks={tasks}
              selected={selected}
              busy={busy}
              onToggleAll={toggleAll}
              onToggleSelected={toggleSelected}
              onEdit={setEditing}
              onAction={action}
            />
          ) : (
            <div class="grid gap-2" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 300px), 1fr))' }}>
              {tasks.map((task) => (
                <TaskCard
                  key={task.id}
                  task={task}
                  selected={selected.has(task.id)}
                  busy={busy}
                  showSelect={fullPage}
                  onToggleSelected={toggleSelected}
                  onEdit={setEditing}
                  onAction={action}
                />
              ))}
            </div>
          )}
        </div>
      )}

      <EditScheduleModal
        task={editing}
        agents={agentOptions}
        onClose={() => setEditing(null)}
        onSaved={() => { setEditing(null); refresh(); }}
      />
    </>
  );
}

function ViewSwitcher({ view, onChange }: { view: ViewMode; onChange: (view: ViewMode) => void }) {
  return (
    <div class="inline-flex bg-[var(--color-elevated)] border border-[var(--color-border)] rounded p-0.5">
      <button
        type="button"
        onClick={() => onChange('cards')}
        class={[
          'inline-flex items-center justify-center w-7 h-7 rounded transition-colors',
          view === 'cards' ? 'bg-[var(--color-accent)] text-white' : 'text-[var(--color-text-muted)] hover:text-[var(--color-text)]',
        ].join(' ')}
        title="Card view"
      >
        <LayoutGrid size={13} />
      </button>
      <button
        type="button"
        onClick={() => onChange('list')}
        class={[
          'inline-flex items-center justify-center w-7 h-7 rounded transition-colors',
          view === 'list' ? 'bg-[var(--color-accent)] text-white' : 'text-[var(--color-text-muted)] hover:text-[var(--color-text)]',
        ].join(' ')}
        title="List view"
      >
        <List size={13} />
      </button>
    </div>
  );
}

function ScheduledList({
  tasks, selected, busy, onToggleAll, onToggleSelected, onEdit, onAction,
}: {
  tasks: ScheduledTask[];
  selected: Set<string>;
  busy: string | null;
  onToggleAll: () => void;
  onToggleSelected: (id: string) => void;
  onEdit: (task: ScheduledTask) => void;
  onAction: (task: ScheduledTask, act: 'pause' | 'resume' | 'delete') => void;
}) {
  const allSelected = tasks.length > 0 && selected.size === tasks.length;
  return (
    <div class="overflow-x-auto border border-[var(--color-border)] rounded-lg">
      <table class="w-full min-w-[760px] text-[12px]">
        <thead class="bg-[var(--color-card)] border-b border-[var(--color-border)]">
          <tr class="text-left">
            <th class="px-3 py-2 w-10">
              <button type="button" onClick={onToggleAll} class="text-[var(--color-text-faint)] hover:text-[var(--color-text)]">
                <CheckSquare size={14} class={allSelected ? 'text-[var(--color-accent)]' : ''} />
              </button>
            </th>
            <th class="px-3 py-2 font-medium text-[10px] uppercase tracking-wider text-[var(--color-text-faint)]">Prompt</th>
            <th class="px-3 py-2 font-medium text-[10px] uppercase tracking-wider text-[var(--color-text-faint)]">Schedule</th>
            <th class="px-3 py-2 font-medium text-[10px] uppercase tracking-wider text-[var(--color-text-faint)]">Next</th>
            <th class="px-3 py-2 font-medium text-[10px] uppercase tracking-wider text-[var(--color-text-faint)]">Status</th>
            <th class="px-3 py-2 font-medium text-[10px] uppercase tracking-wider text-[var(--color-text-faint)]">Agent</th>
            <th class="px-3 py-2 font-medium text-[10px] uppercase tracking-wider text-[var(--color-text-faint)] text-right">Actions</th>
          </tr>
        </thead>
        <tbody>
          {tasks.map((task) => (
            <tr key={task.id} class="border-b border-[var(--color-border)] hover:bg-[var(--color-elevated)]">
              <td class="px-3 py-2">
                <input
                  type="checkbox"
                  checked={selected.has(task.id)}
                  onChange={() => onToggleSelected(task.id)}
                  class="accent-[var(--color-accent)]"
                />
              </td>
              <td class="px-3 py-2 max-w-[360px]">
                <button type="button" onClick={() => onEdit(task)} class="text-left text-[var(--color-text)] line-clamp-2 hover:text-[var(--color-accent)]">
                  {task.prompt}
                </button>
              </td>
              <td class="px-3 py-2 text-[var(--color-text-muted)] whitespace-nowrap">{describeCron(task.schedule)}</td>
              <td class="px-3 py-2 text-[var(--color-text-faint)] tabular-nums whitespace-nowrap">{task.status === 'active' ? formatCountdown(task.next_run) : '-'}</td>
              <td class="px-3 py-2 whitespace-nowrap"><TaskStatus task={task} /></td>
              <td class="px-3 py-2 font-mono text-[11px] text-[var(--color-text-muted)] whitespace-nowrap">@{task.agent_id}</td>
              <td class="px-3 py-2 text-right whitespace-nowrap">
                <TaskActions task={task} busy={busy} onAction={(act) => onAction(task, act)} onEdit={() => onEdit(task)} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function TaskCard({
  task, selected, busy, showSelect, onToggleSelected, onEdit, onAction,
}: {
  task: ScheduledTask;
  selected: boolean;
  busy: string | null;
  showSelect: boolean;
  onToggleSelected: (id: string) => void;
  onEdit: (task: ScheduledTask) => void;
  onAction: (task: ScheduledTask, act: 'pause' | 'resume' | 'delete') => void;
}) {
  const [showResult, setShowResult] = useState(false);
  return (
    <div class={[
      'bg-[var(--color-card)] border rounded-lg p-3 hover:border-[var(--color-border-strong)] transition-colors',
      selected ? 'border-[var(--color-accent)]' : 'border-[var(--color-border)]',
    ].join(' ')}>
      <div class="flex items-start gap-2 mb-2">
        {showSelect && (
          <input
            type="checkbox"
            checked={selected}
            onChange={() => onToggleSelected(task.id)}
            class="mt-1 shrink-0 accent-[var(--color-accent)]"
          />
        )}
        <button type="button" onClick={() => onEdit(task)} class="flex-1 min-w-0 text-left">
          <div class="text-[12.5px] text-[var(--color-text)] line-clamp-2 leading-snug mb-1 hover:text-[var(--color-accent)]">
            {task.prompt}
          </div>
          <div class="flex items-center gap-2 text-[10.5px] text-[var(--color-text-faint)] flex-wrap">
            <span class="inline-flex items-center gap-1">
              <Clock size={10} />
              {describeCron(task.schedule)}
            </span>
            {task.status === 'active' && (
              <span class="text-[var(--color-accent)] tabular-nums">{formatCountdown(task.next_run)}</span>
            )}
            <TaskStatus task={task} />
            {task.agent_id !== 'main' && <span class="font-mono">@{task.agent_id}</span>}
          </div>
        </button>
        <TaskActions task={task} busy={busy} onAction={(act) => onAction(task, act)} onEdit={() => onEdit(task)} />
      </div>
      {task.last_result && (
        <div class="mt-2 pt-2 border-t border-[var(--color-border)]">
          <button
            type="button"
            onClick={() => setShowResult((v) => !v)}
            class="text-[10.5px] text-[var(--color-text-faint)] hover:text-[var(--color-text-muted)]"
          >
            {showResult ? 'Hide' : 'Show'} last result · {formatRelativeTime(task.last_run || 0)}
          </button>
          {showResult && (
            <div class="mt-1.5 text-[11px] text-[var(--color-text-muted)] whitespace-pre-wrap font-mono leading-relaxed line-clamp-6">
              {task.last_result}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function TaskStatus({ task }: { task: ScheduledTask }) {
  const statusTone = task.status === 'running' ? 'running' : task.status === 'paused' ? 'cancelled' : 'done';
  return (
    <>
      <Pill tone={statusTone}>{task.status}</Pill>
      {task.last_status && (
        <Pill tone={task.last_status === 'success' ? 'done' : task.last_status === 'timeout' ? 'medium' : 'failed'}>
          last: {task.last_status}
        </Pill>
      )}
    </>
  );
}

function TaskActions({
  task, busy, onAction, onEdit,
}: {
  task: ScheduledTask;
  busy: string | null;
  onAction: (act: 'pause' | 'resume' | 'delete') => void;
  onEdit: () => void;
}) {
  const disabled = busy !== null;
  return (
    <div class="inline-flex items-center gap-1 shrink-0" onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        onClick={onEdit}
        disabled={disabled}
        class="p-1.5 rounded text-[var(--color-text-muted)] hover:text-[var(--color-accent)] hover:bg-[var(--color-elevated)] transition-colors disabled:opacity-40"
        title="Edit"
      >
        <Pencil size={12} />
      </button>
      {task.status === 'active' && (
        <button
          type="button"
          onClick={() => onAction('pause')}
          disabled={disabled}
          class="p-1.5 rounded text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-elevated)] transition-colors disabled:opacity-40"
          title="Pause"
        >
          <Pause size={12} />
        </button>
      )}
      {task.status === 'paused' && (
        <button
          type="button"
          onClick={() => onAction('resume')}
          disabled={disabled}
          class="p-1.5 rounded text-[var(--color-text-muted)] hover:text-[var(--color-accent)] hover:bg-[var(--color-elevated)] transition-colors disabled:opacity-40"
          title="Resume"
        >
          <Play size={12} />
        </button>
      )}
      <button
        type="button"
        onClick={() => onAction('delete')}
        disabled={disabled}
        class="p-1.5 rounded text-[var(--color-text-muted)] hover:text-[var(--color-status-failed)] hover:bg-[var(--color-elevated)] transition-colors disabled:opacity-40"
        title="Delete"
      >
        <Trash2 size={12} />
      </button>
    </div>
  );
}

function EditScheduleModal({
  task, agents, onClose, onSaved,
}: {
  task: ScheduledTask | null;
  agents: AgentOption[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [prompt, setPrompt] = useState('');
  const [schedule, setSchedule] = useState('');
  const [agentId, setAgentId] = useState('main');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!task) return;
    setPrompt(task.prompt);
    setSchedule(task.schedule);
    setAgentId(task.agent_id || 'main');
  }, [task?.id]);

  async function save() {
    if (!task) return;
    setSaving(true);
    try {
      await apiPatch(`/api/tasks/${task.id}`, {
        prompt,
        schedule,
        agent_id: agentId,
      });
      onSaved();
    } catch (err: any) {
      alert('Save failed: ' + (err?.body?.error || err?.message || err));
    } finally {
      setSaving(false);
    }
  }

  const options = [{ id: 'main', name: 'Main' }, ...agents.filter((a) => a.id !== 'main')];
  return (
    <Modal
      open={task !== null}
      onClose={onClose}
      title="Edit scheduled task"
      width={620}
      footer={
        <>
          <button
            type="button"
            onClick={onClose}
            class="px-3 py-1.5 rounded text-[12.5px] text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-elevated)] transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={save}
            disabled={saving || !prompt.trim() || !schedule.trim()}
            class="ml-auto px-3 py-1.5 rounded text-[12.5px] font-medium bg-[var(--color-accent)] text-white hover:bg-[var(--color-accent-hover)] disabled:opacity-40 transition-colors"
          >
            {saving ? 'Saving...' : 'Save'}
          </button>
        </>
      }
    >
      <div class="grid gap-3">
        <label class="grid gap-1.5">
          <span class="text-[10px] uppercase tracking-wider text-[var(--color-text-faint)]">Prompt</span>
          <textarea
            value={prompt}
            onInput={(e) => setPrompt((e.target as HTMLTextAreaElement).value)}
            rows={5}
            class="w-full bg-[var(--color-elevated)] border border-[var(--color-border)] rounded px-3 py-2 text-[12.5px] text-[var(--color-text)] outline-none focus:border-[var(--color-accent)] resize-y"
          />
        </label>
        <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
          <label class="grid gap-1.5">
            <span class="text-[10px] uppercase tracking-wider text-[var(--color-text-faint)]">Cron schedule</span>
            <input
              value={schedule}
              onInput={(e) => setSchedule((e.target as HTMLInputElement).value)}
              class="w-full bg-[var(--color-elevated)] border border-[var(--color-border)] rounded px-3 py-2 text-[12.5px] text-[var(--color-text)] outline-none focus:border-[var(--color-accent)] font-mono"
            />
            <span class="text-[10.5px] text-[var(--color-text-faint)]">{describeCron(schedule)}</span>
          </label>
          <label class="grid gap-1.5 content-start">
            <span class="text-[10px] uppercase tracking-wider text-[var(--color-text-faint)]">Agent</span>
            <select
              value={agentId}
              onChange={(e) => setAgentId((e.target as HTMLSelectElement).value)}
              class="w-full bg-[var(--color-elevated)] border border-[var(--color-border)] rounded px-3 py-2 text-[12.5px] text-[var(--color-text)] outline-none focus:border-[var(--color-accent)]"
            >
              {options.map((agent) => (
                <option key={agent.id} value={agent.id}>{agent.name || agent.id}</option>
              ))}
            </select>
          </label>
        </div>
      </div>
    </Modal>
  );
}
