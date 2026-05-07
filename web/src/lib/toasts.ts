import { signal } from '@preact/signals';

export interface Toast {
  id: number;
  tone: 'info' | 'success' | 'warn' | 'error';
  title: string;
  description?: string;
  action?: { label: string; run: () => Promise<void> | void };
  durationMs?: number;
}

let nextId = 1;
export const toasts = signal<Toast[]>([]);

export function pushToast(toast: Omit<Toast, 'id'>): number {
  const id = nextId++;
  const full: Toast = {
    id,
    durationMs: toast.tone === 'error' ? 0 : 4000,
    ...toast,
  };
  toasts.value = [...toasts.value, full];
  if (full.durationMs && full.durationMs > 0) {
    window.setTimeout(() => dismissToast(id), full.durationMs);
  }
  return id;
}

export function dismissToast(id: number) {
  toasts.value = toasts.value.filter((toast) => toast.id !== id);
}
