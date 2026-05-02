// Unit tests for the brain-watcher JSONL parser.
//
// Origin: 2026-04-29 morning — brain-watcher silently produced zero ingested
// pairs because modern Claude Code (post SDK 0.2.119) splits one logical
// assistant turn into many JSONL events (thinking-only, tool_use-only, text).
// The pre-fix parser flipped lastState='assistant' on every assistant event
// regardless of whether it contributed text, which caused the next user event
// to flush a half-built turn and clobber the buffered user text.
//
// These fixtures lock the fix in: any future regression that flips
// lastState='assistant' on empty-text events will fail at least one of these
// cases.

import { describe, it, expect } from 'vitest';
// @ts-expect-error -- importing a .mjs module from TS; vitest resolves it fine.
import { parseTurnPairsFromText } from '../scripts/brain-watcher-parser.mjs';

// ── helpers ────────────────────────────────────────────────────────────

type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string };

let _ts = Date.parse('2026-04-29T00:00:00Z');
function nextTs(): string {
  _ts += 1000;
  return new Date(_ts).toISOString();
}

function userEvent(text: string) {
  return JSON.stringify({
    type: 'user',
    timestamp: nextTs(),
    message: { role: 'user', content: text },
  });
}

function userToolResultEvent(toolUseId: string, result: string) {
  return JSON.stringify({
    type: 'user',
    timestamp: nextTs(),
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: toolUseId, content: result }],
    },
  });
}

function asstEvent(blocks: ContentBlock[]) {
  return JSON.stringify({
    type: 'assistant',
    timestamp: nextTs(),
    message: { role: 'assistant', content: blocks },
  });
}

function asstThinkingOnly(thinking = 'pondering...') {
  return asstEvent([{ type: 'thinking', thinking }]);
}

function asstToolUseOnly(name = 'Bash', input: Record<string, unknown> = { command: 'ls' }) {
  return asstEvent([{ type: 'tool_use', id: `toolu_${++_ts}`, name, input }]);
}

function asstTextOnly(text: string) {
  return asstEvent([{ type: 'text', text }]);
}

function stream(...lines: string[]): string {
  return lines.join('\n') + '\n';
}

// ── tests ──────────────────────────────────────────────────────────────

describe('parseTurnPairs (brain-watcher)', () => {
  it('happy path: classic interleaved user/assistant turns parse to N pairs', () => {
    const raw = stream(
      userEvent('Question one. ' + 'x'.repeat(50)),
      asstTextOnly('Answer one. ' + 'y'.repeat(50)),
      userEvent('Question two. ' + 'x'.repeat(50)),
      asstTextOnly('Answer two. ' + 'y'.repeat(50)),
      userEvent('Question three. ' + 'x'.repeat(50)),
      asstTextOnly('Answer three. ' + 'y'.repeat(50))
    );
    const { pairs } = parseTurnPairsFromText(raw);
    expect(pairs).toHaveLength(3);
    expect(pairs[0].user).toContain('Question one.');
    expect(pairs[0].asst).toContain('Answer one.');
    expect(pairs[2].user).toContain('Question three.');
    expect(pairs[2].asst).toContain('Answer three.');
  });

  it('bug case: one logical assistant turn split into thinking + tool_use + text events parses to exactly 1 pair', () => {
    // This is the exact pattern that broke production on 2026-04-28.
    const raw = stream(
      userEvent('Run the migration.'),
      asstThinkingOnly('Need to check the schema first.'),
      asstToolUseOnly('Bash', { command: 'sqlite3 db.sqlite .schema' }),
      userToolResultEvent('toolu_x', 'CREATE TABLE thoughts(...);'),
      asstThinkingOnly('Schema looks fine, proceed.'),
      asstToolUseOnly('Bash', { command: 'node migrate.mjs' }),
      userToolResultEvent('toolu_y', 'migration applied'),
      asstTextOnly('Migration applied successfully.')
    );
    const { pairs } = parseTurnPairsFromText(raw);
    // The original user prompt MUST be preserved. The broken parser would
    // flush the (user, []) pair on the second user tool_result event after
    // lastState was wrongly flipped to 'assistant' by the thinking-only
    // event, dropping the real user prompt.
    expect(pairs).toHaveLength(1);
    expect(pairs[0].user).toBe('Run the migration.');
    expect(pairs[0].asst).toBe('Migration applied successfully.');
  });

  it('user text followed by thinking-only event then later text: 1 pair, user text preserved', () => {
    const raw = stream(
      userEvent('Explain async iterators.'),
      asstThinkingOnly(''), // explicitly empty thinking
      asstThinkingOnly('Considering edge cases.'),
      asstTextOnly('Async iterators are objects with [Symbol.asyncIterator].')
    );
    const { pairs } = parseTurnPairsFromText(raw);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].user).toBe('Explain async iterators.');
    expect(pairs[0].asst).toBe('Async iterators are objects with [Symbol.asyncIterator].');
  });

  it('assistant tool_use with no text does NOT flip state to assistant: subsequent user event must not flush', () => {
    const raw = stream(
      userEvent('Read the config.'),
      asstToolUseOnly('Read', { file_path: '/etc/config' }),
      userToolResultEvent('toolu_z', 'config contents here'),
      asstTextOnly('Config has 3 keys: a, b, c.')
    );
    const { pairs } = parseTurnPairsFromText(raw);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].user).toBe('Read the config.');
    expect(pairs[0].asst).toBe('Config has 3 keys: a, b, c.');
  });

  it('multiple consecutive empty-text assistant events before real text: 1 pair, no clobbering', () => {
    const raw = stream(
      userEvent('Build the report.'),
      asstThinkingOnly('plan'),
      asstToolUseOnly(),
      asstThinkingOnly('more thinking'),
      asstToolUseOnly('Read'),
      asstThinkingOnly(),
      asstToolUseOnly('Grep'),
      asstTextOnly('Report built.')
    );
    const { pairs } = parseTurnPairsFromText(raw);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].user).toBe('Build the report.');
    expect(pairs[0].asst).toBe('Report built.');
  });

  it('real text event after several empty-text events terminates the assistant turn correctly', () => {
    // Two full logical turns, each composed of many sub-events. The boundary
    // between turns is the user message after the first text event.
    const raw = stream(
      userEvent('First request.'),
      asstThinkingOnly(),
      asstToolUseOnly(),
      asstTextOnly('First answer.'),
      userEvent('Second request.'),
      asstThinkingOnly(),
      asstToolUseOnly(),
      asstThinkingOnly(),
      asstTextOnly('Second answer.')
    );
    const { pairs } = parseTurnPairsFromText(raw);
    expect(pairs).toHaveLength(2);
    expect(pairs[0]).toEqual({ user: 'First request.', asst: 'First answer.' });
    expect(pairs[1]).toEqual({ user: 'Second request.', asst: 'Second answer.' });
  });

  it('multi-text assistant events in one logical turn are concatenated', () => {
    // Assistant sometimes emits text, then tool_use, then more text.
    const raw = stream(
      userEvent('Summarise the code.'),
      asstTextOnly('Reading file...'),
      asstToolUseOnly('Read'),
      asstTextOnly('Done. Three functions defined.')
    );
    const { pairs } = parseTurnPairsFromText(raw);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].user).toBe('Summarise the code.');
    expect(pairs[0].asst).toContain('Reading file...');
    expect(pairs[0].asst).toContain('Done. Three functions defined.');
  });

  it('tool_result-only user events between assistant sub-events do not start a new pair', () => {
    // Real Claude Code stream: user prompt -> asst tool_use -> user tool_result
    // -> asst text. The middle user event has no text content, only a
    // tool_result block, so it should not seed a new user buffer.
    const raw = stream(
      userEvent('Check disk space.'),
      asstToolUseOnly('Bash', { command: 'df -h' }),
      userToolResultEvent('toolu_a', 'Filesystem  Size  Used'),
      asstTextOnly('Disk is 60% full.')
    );
    const { pairs } = parseTurnPairsFromText(raw);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].user).toBe('Check disk space.');
    expect(pairs[0].asst).toBe('Disk is 60% full.');
  });

  it('non-user/non-assistant event types (queue-operation, attachment, last-prompt) are ignored', () => {
    // Real Claude Code .jsonl files include records with other type values
    // interleaved with user/assistant. The parser must skip them, not flush.
    const raw = stream(
      JSON.stringify({ type: 'queue-operation', timestamp: nextTs(), operation: 'enqueue' }),
      userEvent('Real prompt.'),
      JSON.stringify({ type: 'attachment', timestamp: nextTs(), attachment: {} }),
      asstThinkingOnly(),
      asstToolUseOnly(),
      JSON.stringify({ type: 'attachment', timestamp: nextTs(), attachment: {} }),
      asstTextOnly('Real answer.'),
      JSON.stringify({ type: 'last-prompt', timestamp: nextTs() })
    );
    const { pairs } = parseTurnPairsFromText(raw);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]).toEqual({ user: 'Real prompt.', asst: 'Real answer.' });
  });

  it('first timestamp is captured from the first event with a timestamp field', () => {
    const raw = stream(
      userEvent('hi'),
      asstTextOnly('hello back')
    );
    const { firstTs } = parseTurnPairsFromText(raw);
    expect(firstTs).toBeTruthy();
    expect(typeof firstTs).toBe('string');
  });

  it('malformed JSON lines are skipped without breaking the parse', () => {
    const raw = [
      'this is not json',
      userEvent('valid prompt'),
      '{not valid json either',
      asstTextOnly('valid answer'),
      '',
    ].join('\n');
    const { pairs } = parseTurnPairsFromText(raw);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]).toEqual({ user: 'valid prompt', asst: 'valid answer' });
  });

  it('regression guard: bug case produces > 0 pairs (parser does not silently swallow input)', () => {
    // The original symptom was newTurns=0 on real session files. Belt-and-
    // braces: any non-empty interleaved stream must produce at least one
    // pair.
    const raw = stream(
      userEvent('hello world'),
      asstThinkingOnly(),
      asstToolUseOnly(),
      asstTextOnly('hi back')
    );
    const { pairs } = parseTurnPairsFromText(raw);
    expect(pairs.length).toBeGreaterThan(0);
  });
});
