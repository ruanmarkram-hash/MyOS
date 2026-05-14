// Pure parsing helpers for brain-watcher.mjs.
//
// Extracted into a side-effect-free module so unit tests can import the
// parser without triggering the watcher's top-level sqlite / pg / env
// initialisation. brain-watcher.mjs re-exports the runtime by importing
// from here, so production behaviour is unchanged.

import { readFileSync } from 'node:fs';

// Folder-name filter shared between brain-watcher.mjs (which uses it to decide
// what to ingest) and monitor-brain.mjs (which uses it to count "upstream
// jsonl files" so the false-alarm classifier in monitor-brain-classify.mjs
// only fires when the watcher actually skipped data it should have ingested.)
//
// Folder names come from `~/.claude/projects/<dir>` where Codex encodes
// the project cwd by replacing slashes with hyphens (e.g. `~/myos` →
// `-Users-sc-HQ`).
export function isJsonlIncluded(folderName) {
  if (folderName.includes('claude-worktrees')) return false;
  const stripped = folderName.replace(/^-Users-[^-]+-?-?/, '').replace(/^-/, '');
  if (stripped === '') return true;
  if (/^HQ(-|$)/.test(stripped)) return true;
  if (/^sonke-hub/.test(stripped)) return true;
  if (/^openclaw/.test(stripped)) return true;
  return false;
}

export function eventText(evt) {
  const msg = evt?.message;
  if (!msg) return '';
  const c = msg.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    return c
      .filter((b) => b?.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('\n');
  }
  return '';
}

export function stripInjectedContext(text) {
  if (!text) return text;
  return text
    .replace(
      /\[(Memory context|Team activity[^\]]*|Conversation history recall|Obsidian context)\][\s\S]*?\[End[^\]]+\]\s*/g,
      ''
    )
    .trim();
}

// Parse a Codex JSONL session file into user/assistant turn pairs.
//
// Modern Codex splits one logical assistant turn into many JSONL
// events (thinking-only, tool_use-only, text). We must NOT mark
// `lastState='assistant'` on empty-text events, otherwise the next user
// event triggers a flush and clobbers buffered user text.
export function parseTurnPairs(filepath) {
  let raw;
  try {
    raw = readFileSync(filepath, 'utf-8');
  } catch {
    return { pairs: [], firstTs: null };
  }
  return parseTurnPairsFromText(raw);
}

// Same as parseTurnPairs but takes the raw JSONL text directly. Useful
// for tests that want to assemble a stream in-memory without touching
// the filesystem.
export function parseTurnPairsFromText(raw) {
  const pairs = [];
  let userBuf = [];
  let asstBuf = [];
  let firstTs = null;
  let lastState = null;

  function flush() {
    if (!userBuf.length || !asstBuf.length) return;
    const user = stripInjectedContext(userBuf.join('\n').trim());
    const asst = asstBuf.join('\n').trim();
    if (user && asst) pairs.push({ user, asst });
  }

  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (!firstTs && o.timestamp) firstTs = o.timestamp;
    const t = o.type;
    if (t === 'user') {
      if (lastState === 'assistant') {
        flush();
        userBuf = [];
        asstBuf = [];
      }
      const tx = eventText(o);
      if (tx) userBuf.push(tx);
      lastState = 'user';
    } else if (t === 'assistant') {
      // Only mark a real assistant turn boundary when this event
      // contributed text. Modern Codex splits one logical
      // assistant turn into many events (thinking-only, tool_use-only,
      // text); empty-text events would otherwise spuriously trigger a
      // flush on the next user event and clobber buffered user text.
      const tx = eventText(o);
      if (tx) {
        asstBuf.push(tx);
        lastState = 'assistant';
      }
    }
  }
  flush();
  return { pairs, firstTs };
}
