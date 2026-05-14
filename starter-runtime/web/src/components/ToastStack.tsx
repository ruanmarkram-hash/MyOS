import { useState } from 'preact/hooks';
import { AlertCircle, AlertTriangle, Check, Info, X } from 'lucide-preact';
import { dismissToast, toasts, type Toast } from '@/lib/toasts';

const TONE: Record<Toast['tone'], { icon: any; color: string }> = {
  info: { icon: Info, color: 'var(--color-accent)' },
  success: { icon: Check, color: 'var(--color-status-done)' },
  warn: { icon: AlertTriangle, color: 'var(--color-priority-medium)' },
  error: { icon: AlertCircle, color: 'var(--color-status-failed)' },
};

export function ToastStack() {
  const list = toasts.value;
  if (list.length === 0) return null;
  return (
    <div class="toast-stack fixed bottom-4 right-4 z-[110] flex max-w-[calc(100vw-2rem)] flex-col gap-2 pointer-events-none">
      {list.map((toast) => <ToastCard key={toast.id} toast={toast} />)}
    </div>
  );
}

function ToastCard({ toast }: { toast: Toast }) {
  const [running, setRunning] = useState(false);
  const tone = TONE[toast.tone];
  const Icon = tone.icon;

  async function runAction() {
    if (!toast.action) return;
    setRunning(true);
    try {
      await toast.action.run();
      dismissToast(toast.id);
    } finally {
      setRunning(false);
    }
  }

  return (
    <div
      class="pointer-events-auto flex w-[min(24rem,calc(100vw-2rem))] items-start gap-2.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-card)] px-3 py-2.5 shadow-2xl"
      style={{ borderLeft: `3px solid ${tone.color}` }}
    >
      <Icon size={14} class="mt-0.5 shrink-0" style={{ color: tone.color }} />
      <div class="min-w-0 flex-1">
        <div class="text-[12.5px] font-medium leading-snug text-[var(--color-text)]">{toast.title}</div>
        {toast.description && (
          <div class="mt-0.5 text-[11.5px] leading-snug text-[var(--color-text-muted)]">{toast.description}</div>
        )}
        {toast.action && (
          <button
            type="button"
            onClick={runAction}
            disabled={running}
            class="mt-1.5 inline-flex items-center rounded bg-[var(--color-accent-soft)] px-2 py-0.5 text-[11px] font-medium text-[var(--color-accent)] transition-colors hover:bg-[var(--color-accent)] hover:text-white disabled:opacity-50"
          >
            {running ? '...' : toast.action.label}
          </button>
        )}
      </div>
      <button
        type="button"
        onClick={() => dismissToast(toast.id)}
        class="rounded p-0.5 text-[var(--color-text-faint)] hover:text-[var(--color-text)]"
        aria-label="Dismiss"
      >
        <X size={11} />
      </button>
    </div>
  );
}
