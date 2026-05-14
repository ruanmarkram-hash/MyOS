import { useEffect, useState } from 'preact/hooks';
import { Save, Zap } from 'lucide-preact';
import { PageHeader } from '@/components/PageHeader';
import { PageState } from '@/components/PageState';
import { AgentAvatar } from '@/components/AgentAvatar';
import { apiGet, apiPost } from '@/lib/api';

interface VoiceRow {
  agent: string;
  gemini_voice: string;
  voice_id: string;
  elevenlabs_name?: string;
  name: string;
  is_default: boolean;
  voice_id_default?: boolean;
}
interface CatalogEntry { name: string; style: string; }
interface ElevenLabsVoice { voice_id: string; name: string; category?: string; labels?: Record<string, string>; }
interface VoiceEdit { voice_id?: string; gemini_voice?: string; name?: string; }

export function Voices() {
  const [rows, setRows] = useState<VoiceRow[]>([]);
  const [catalog, setCatalog] = useState<CatalogEntry[]>([]);
  const [elevenCatalog, setElevenCatalog] = useState<ElevenLabsVoice[]>([]);
  const [dirty, setDirty] = useState<Set<string>>(new Set());
  const [edits, setEdits] = useState<Record<string, VoiceEdit>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [applying, setApplying] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [mode, setMode] = useState('live');
  const [provider, setProvider] = useState('gemini-live');
  const [voicesPath, setVoicesPath] = useState('');
  const [elevenError, setElevenError] = useState<string | null>(null);
  const isElevenLabsActive = provider === 'elevenlabs';

  async function load() {
    try {
      setLoading(true);
      const data = await apiGet<{
        ok: boolean;
        voices: VoiceRow[];
        gemini_catalog: CatalogEntry[];
        elevenlabs_catalog?: ElevenLabsVoice[];
        elevenlabs_catalog_error?: string | null;
        tts_provider?: string;
        mode?: string;
        voices_path?: string;
        error?: string;
      }>('/api/warroom/voices');
      if (!data.ok) throw new Error(data.error || 'Failed to load voices');
      setRows(data.voices);
      setCatalog(data.gemini_catalog);
      setElevenCatalog(data.elevenlabs_catalog || []);
      setElevenError(data.elevenlabs_catalog_error || null);
      setProvider(data.tts_provider || 'gemini-live');
      setMode(data.mode || 'live');
      setVoicesPath(data.voices_path || '');
      setEdits({});
      setDirty(new Set());
    } catch (err: any) { setError(err?.message || String(err)); }
    finally { setLoading(false); }
  }

  useEffect(() => { void load(); }, []);

  function updateEdit(agent: string, patch: VoiceEdit) {
    const row = rows.find((r) => r.agent === agent);
    if (!row) return;
    const nextEdit = { ...(edits[agent] || {}), ...patch };
    setEdits((prev) => ({ ...prev, [agent]: nextEdit }));
    setDirty((prev) => {
      const next = new Set(prev);
      const changed =
        (nextEdit.voice_id !== undefined && nextEdit.voice_id !== row.voice_id) ||
        (nextEdit.gemini_voice !== undefined && nextEdit.gemini_voice !== row.gemini_voice) ||
        (nextEdit.name !== undefined && nextEdit.name !== row.name);
      if (changed) next.add(agent); else next.delete(agent);
      return next;
    });
    setStatus(null);
  }

  function changeElevenVoice(agent: string, voiceId: string) {
    const selected = elevenCatalog.find((v) => v.voice_id === voiceId);
    updateEdit(agent, { voice_id: voiceId, name: selected?.name || undefined });
  }

  async function save(thenApply: boolean) {
    if (dirty.size === 0) return;
    setSaving(true); setStatus(null);
    try {
      const updates = Array.from(dirty).map((agent) => ({ agent, ...(edits[agent] || {}) }));
      const res = await apiPost<{ ok: boolean; error?: string }>('/api/warroom/voices', { updates });
      if (!res.ok) throw new Error(res.error || 'Save failed');
      setStatus('Saved.');
      await load();
      if (thenApply) await apply();
    } catch (err: any) { setError(err?.message || String(err)); }
    finally { setSaving(false); }
  }

  async function apply() {
    setApplying(true); setStatus('Applying — bouncing voice subprocess…');
    try {
      const res = await apiPost<{ ok: boolean; killed_pids?: number[]; error?: string }>('/api/warroom/voices/apply');
      if (!res.ok) throw new Error(res.error || 'Apply failed');
      setStatus(`Applied. Bounced ${res.killed_pids?.length || 0} subprocess(es).`);
    } catch (err: any) { setError(err?.message || String(err)); }
    finally { applying && setTimeout(() => setApplying(false), 5000); setApplying(false); }
  }

  function effective(agent: string, field: keyof VoiceEdit): string {
    const edit = edits[agent]?.[field];
    if (edit !== undefined) return edit;
    const row = rows.find((r) => r.agent === agent);
    return (row?.[field as keyof VoiceRow] as string | undefined) || '';
  }

  function describeVoice(v: ElevenLabsVoice): string {
    const labels = v.labels || {};
    return [labels.gender, labels.accent, labels.descriptive || labels.use_case, v.category]
      .filter(Boolean)
      .join(' / ');
  }

  return (
    <div class="flex flex-col h-full">
      <PageHeader
        title="Voices"
        actions={
          <>
            {status && <span class="text-[11px] text-[var(--color-text-muted)]">{status}</span>}
            <button
              type="button"
              onClick={() => save(false)}
              disabled={dirty.size === 0 || saving || applying}
              class="inline-flex items-center gap-1 px-2.5 py-1.5 rounded text-[12px] bg-[var(--color-elevated)] text-[var(--color-text-muted)] hover:text-[var(--color-text)] border border-[var(--color-border)] disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              <Save size={13} /> {saving ? 'Saving…' : `Save${dirty.size > 0 ? ` (${dirty.size})` : ''}`}
            </button>
            <button
              type="button"
              onClick={() => save(true)}
              disabled={dirty.size === 0 || saving || applying}
              class="inline-flex items-center gap-1 px-2.5 py-1.5 rounded text-[12px] font-medium bg-[var(--color-accent)] text-white hover:bg-[var(--color-accent-hover)] disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              <Zap size={13} /> Save & Apply
            </button>
          </>
        }
      />

      {error && <PageState error={error} />}
      {loading && rows.length === 0 && <PageState loading />}
      {!loading && rows.length === 0 && (
        <PageState empty emptyTitle="Voice War Room not enabled" emptyDescription="Set WARROOM_ENABLED=true in .env and restart to enable voice meetings." />
      )}

      {rows.length > 0 && (
        <div class="flex-1 overflow-y-auto p-6 max-w-4xl">
          <div class="mb-4 rounded border border-[var(--color-border)] bg-[var(--color-card)] p-3">
            <div class="flex flex-wrap items-center gap-2 text-[11px] text-[var(--color-text-muted)]">
              <span class="uppercase tracking-[0.08em] text-[var(--color-text-faint)]">Runtime</span>
              <span class="rounded bg-[var(--color-elevated)] px-2 py-0.5 text-[var(--color-text)]">{mode}</span>
              <span class="uppercase tracking-[0.08em] text-[var(--color-text-faint)]">TTS</span>
              <span class="rounded bg-[var(--color-elevated)] px-2 py-0.5 text-[var(--color-text)]">{provider}</span>
              <span class="uppercase tracking-[0.08em] text-[var(--color-text-faint)]">ElevenLabs</span>
              <span class={elevenCatalog.length > 0 ? 'text-emerald-400' : 'text-amber-400'}>
                {elevenCatalog.length > 0 ? `${elevenCatalog.length} voices available` : elevenError || 'catalog unavailable'}
              </span>
            </div>
            <div class="mt-2 text-[10px] text-[var(--color-text-faint)] truncate">
              Personal voice IDs save to <code class="font-mono">{voicesPath}</code>. {isElevenLabsActive ? 'ElevenLabs is the active voice path. Gemini fallback is stored but hidden here.' : 'Gemini native audio is active.'}
            </div>
          </div>
          <div class="space-y-1.5">
            {rows.map((r) => {
              const isDirty = dirty.has(r.agent);
              const selectedVoiceId = effective(r.agent, 'voice_id');
              const selectedVoice = elevenCatalog.find((v) => v.voice_id === selectedVoiceId);
              return (
                <div
                  key={r.agent}
                  class={[
                    'grid gap-3 px-4 py-3 rounded-lg border transition-colors',
                    isElevenLabsActive ? 'md:grid-cols-[180px_minmax(320px,1fr)]' : 'md:grid-cols-[180px_minmax(260px,1fr)_180px]',
                    isDirty
                      ? 'bg-[var(--color-accent-soft)] border-[var(--color-accent)]'
                      : 'bg-[var(--color-card)] border-[var(--color-border)]',
                  ].join(' ')}
                >
                  <div class="flex items-center gap-3 min-w-0">
                    <AgentAvatar agentId={r.agent} size={28} running />
                    <div class="min-w-0">
                      <div class="text-[12.5px] text-[var(--color-text)] font-medium truncate">{r.agent}</div>
                      <div class="text-[10px] text-[var(--color-text-faint)] truncate">
                        {isDirty ? 'modified' : r.voice_id_default ? 'using global default' : selectedVoice?.name || r.name || 'configured'}
                      </div>
                    </div>
                  </div>

                  <div class="min-w-0 space-y-2">
                    {elevenCatalog.length > 0 ? (
                      <select
                        value={selectedVoiceId}
                        onChange={(e) => changeElevenVoice(r.agent, (e.target as HTMLSelectElement).value)}
                        class="w-full bg-[var(--color-elevated)] border border-[var(--color-border)] rounded px-2 py-1.5 text-[12px] text-[var(--color-text)] outline-none focus:border-[var(--color-accent)]"
                      >
                        <option value="">Select ElevenLabs voice…</option>
                        {elevenCatalog.map((v) => (
                          <option key={v.voice_id} value={v.voice_id}>
                            {v.name}{describeVoice(v) ? ` — ${describeVoice(v)}` : ''}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <input
                        value={selectedVoiceId}
                        onInput={(e) => updateEdit(r.agent, { voice_id: (e.target as HTMLInputElement).value })}
                        placeholder="ElevenLabs voice ID"
                        class="w-full bg-[var(--color-elevated)] border border-[var(--color-border)] rounded px-2 py-1.5 text-[12px] text-[var(--color-text)] outline-none focus:border-[var(--color-accent)]"
                      />
                    )}
                    <input
                      value={effective(r.agent, 'name')}
                      onInput={(e) => updateEdit(r.agent, { name: (e.target as HTMLInputElement).value })}
                      placeholder="Display label"
                      class="w-full bg-transparent border border-[var(--color-border)] rounded px-2 py-1 text-[11px] text-[var(--color-text-muted)] outline-none focus:border-[var(--color-accent)]"
                    />
                    {isElevenLabsActive && (
                      <div class="text-[10px] text-[var(--color-text-faint)] truncate">
                        Gemini fallback: {effective(r.agent, 'gemini_voice') || 'unset'}
                      </div>
                    )}
                  </div>

                  {!isElevenLabsActive && (
                    <select
                      value={effective(r.agent, 'gemini_voice')}
                      onChange={(e) => updateEdit(r.agent, { gemini_voice: (e.target as HTMLSelectElement).value })}
                      class="w-full bg-[var(--color-elevated)] border border-[var(--color-border)] rounded px-2 py-1.5 text-[12px] text-[var(--color-text)] outline-none focus:border-[var(--color-accent)]"
                    >
                      {catalog.map((c) => (
                        <option key={c.name} value={c.name}>
                          Gemini {c.name} - {c.style}
                        </option>
                      ))}
                    </select>
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
