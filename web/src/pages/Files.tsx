// Phase C1.a — Sage main CLAUDE.md editor.
//
// Operator-facing surface for editing the running bot's operating rules without
// SSH. Saves go through PUT /api/agent-files/:id, which:
//   1. Atomic-writes to disk (temp + renameSync).
//   2. Appends a row to agent_file_history (for audit + revert).
//   3. Hot-reloads agentSystemPrompt in the live process so the next agent
//      turn picks up the new rules without a restart.
//
// History panel lists prior revisions (newest first) and a banner confirms
// the hot-reload happened.

import { useEffect, useState } from 'preact/hooks';
import { PageHeader } from '@/components/PageHeader';
import { PageState } from '@/components/PageState';
import { apiGet, apiPut, ApiError } from '@/lib/api';

interface FileResponse {
  id: string;
  label: string;
  path: string;
  content: string;
  contentSha: string;
  exists: boolean;
}

interface HistoryRow {
  id: number;
  file_path: string;
  real_path: string;
  content_sha: string;
  edited_by_chat_id: string | null;
  created_at: number;
  size: number;
}

interface SaveResponse {
  ok: true;
  id: string;
  path: string;
  contentSha: string;
  historyId: number;
  hotReloaded: boolean;
}

const FILE_ID = 'main';

export function Files() {
  const [data, setData] = useState<FileResponse | null>(null);
  const [history, setHistory] = useState<HistoryRow[]>([]);
  const [content, setContent] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<{ kind: 'ok' | 'err'; msg: string } | null>(null);

  async function loadAll() {
    setLoading(true);
    setError(null);
    try {
      const [file, hist] = await Promise.all([
        apiGet<FileResponse>(`/api/agent-files/${FILE_ID}`),
        apiGet<{ history: HistoryRow[] }>(`/api/agent-files/${FILE_ID}/history`),
      ]);
      setData(file);
      setContent(file.content);
      setHistory(hist.history);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void loadAll(); }, []);

  async function onSave() {
    if (!data) return;
    setSaving(true);
    setToast(null);
    try {
      const res = await apiPut<SaveResponse>(`/api/agent-files/${FILE_ID}`, {
        content,
        expectedSha: data.contentSha,
      });
      setToast({
        kind: 'ok',
        msg: res.hotReloaded
          ? 'Saved. Hot-reloaded — next turn will use the new rules.'
          : 'Saved to disk. Hot-reload soft-failed; new sessions still pick up the change.',
      });
      await loadAll();
    } catch (err) {
      const msg =
        err instanceof ApiError
          ? `${err.status}: ${(err.body as any)?.error ?? err.message}`
          : err instanceof Error ? err.message : String(err);
      setToast({ kind: 'err', msg: `Save failed — ${msg}` });
    } finally {
      setSaving(false);
    }
  }

  const dirty = data ? content !== data.content : false;

  return (
    <div class="flex flex-col h-full">
      <PageHeader title="Files" />

      {error && <PageState error={error} />}
      {loading && !data && <PageState loading />}

      {data && (
        <div class="flex-1 overflow-hidden flex">
          <div class="flex-1 flex flex-col min-w-0 p-6 gap-3">
            <div class="flex items-center justify-between gap-3">
              <div>
                <div class="text-[13px] font-semibold text-[var(--color-text)]">{data.label}</div>
                <div class="text-[10.5px] font-mono text-[var(--color-text-faint)] truncate">{data.path}</div>
              </div>
              <div class="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => { if (data) setContent(data.content); }}
                  disabled={!dirty || saving}
                  class="px-3 py-1.5 rounded-md text-[12px] border border-[var(--color-border)] text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-elevated)] disabled:opacity-40 disabled:cursor-not-allowed"
                >Revert</button>
                <button
                  type="button"
                  onClick={() => { void onSave(); }}
                  disabled={!dirty || saving}
                  class="px-3 py-1.5 rounded-md text-[12px] bg-[var(--color-accent)] text-[var(--color-accent-on)] hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed"
                >{saving ? 'Saving…' : 'Save & hot-reload'}</button>
              </div>
            </div>

            {toast && (
              <div
                class={[
                  'rounded-md px-3 py-2 text-[12px] border',
                  toast.kind === 'ok'
                    ? 'border-[var(--color-status-done,#3a3)] text-[var(--color-status-done,#9c9)] bg-[var(--color-card)]'
                    : 'border-[var(--color-status-failed,#a33)] text-[var(--color-status-failed,#c99)] bg-[var(--color-card)]',
                ].join(' ')}
              >{toast.msg}</div>
            )}

            <textarea
              value={content}
              onInput={(e) => setContent((e.currentTarget as HTMLTextAreaElement).value)}
              spellcheck={false}
              class="flex-1 min-h-0 w-full font-mono text-[12px] leading-[1.5] bg-[var(--color-card)] border border-[var(--color-border)] rounded-lg p-3 text-[var(--color-text)] resize-none focus:outline-none focus:border-[var(--color-accent)]"
            />

            <div class="text-[10.5px] text-[var(--color-text-faint)] tabular-nums flex items-center justify-between">
              <span>{content.length.toLocaleString()} chars · sha:{data.contentSha.slice(0, 12)}{dirty ? ' · unsaved' : ''}</span>
              <span>Atomic write · history audited · 256 KiB cap</span>
            </div>
          </div>

          <aside class="w-[320px] shrink-0 border-l border-[var(--color-border)] overflow-y-auto p-4">
            <div class="text-[12px] font-semibold text-[var(--color-text)] mb-2">History</div>
            {history.length === 0 ? (
              <div class="text-[11px] text-[var(--color-text-muted)]">No prior edits yet.</div>
            ) : (
              <div class="space-y-2">
                {history.map((h) => (
                  <div key={h.id} class="bg-[var(--color-card)] border border-[var(--color-border)] rounded-md px-3 py-2">
                    <div class="text-[11px] text-[var(--color-text)] tabular-nums">
                      {new Date(h.created_at * 1000).toLocaleString()}
                    </div>
                    <div class="text-[10.5px] font-mono text-[var(--color-text-faint)]">
                      {h.content_sha.slice(0, 12)} · {h.size.toLocaleString()}b
                    </div>
                    {h.edited_by_chat_id && (
                      <div class="text-[10.5px] text-[var(--color-text-muted)]">by {h.edited_by_chat_id}</div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </aside>
        </div>
      )}
    </div>
  );
}
