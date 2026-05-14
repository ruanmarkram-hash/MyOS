import { Modal } from '@/components/Modal';

interface ConfirmModalProps {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  body?: string;
  detail?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
}

export function ConfirmModal({
  open,
  onClose,
  onConfirm,
  title,
  body,
  detail,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  destructive = false,
}: ConfirmModalProps) {
  if (!open) return null;
  return (
    <Modal
      open
      onClose={onClose}
      title={title}
      width={460}
      footer={
        <>
          <button
            type="button"
            onClick={onClose}
            class="rounded px-3 py-1.5 text-[12.5px] text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-elevated)] hover:text-[var(--color-text)]"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            onClick={() => { onConfirm(); onClose(); }}
            class={[
              'ml-auto rounded px-3 py-1.5 text-[12.5px] font-medium text-white transition-colors',
              destructive
                ? 'bg-[var(--color-status-failed)] hover:opacity-90'
                : 'bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)]',
            ].join(' ')}
          >
            {confirmLabel}
          </button>
        </>
      }
    >
      {body && <div class="text-[13px] leading-relaxed text-[var(--color-text)]">{body}</div>}
      {detail && <div class="mt-2 text-[11.5px] leading-relaxed text-[var(--color-text-muted)]">{detail}</div>}
    </Modal>
  );
}
