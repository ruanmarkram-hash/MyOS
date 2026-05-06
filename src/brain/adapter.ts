import { captureThought, searchThoughts } from './client.js';
import { BRAIN, MCP_ACCESS_KEY, OB1_BRAIN_FUNCTION, OB1_SUPABASE_URL } from '../config.js';
import { logger } from '../logger.js';

export function ob1Available(): boolean {
  return BRAIN === 'ob1' && !!OB1_SUPABASE_URL && !!MCP_ACCESS_KEY && !!OB1_BRAIN_FUNCTION;
}

export interface Ob1ParsedResult {
  match: string;
  date: string;
  type: string;
  topics: string[];
  people: string[];
  content: string;
}

const UNREADABLE_CONTENT_FALLBACK = 'OpenBrain returned this hit without readable thought content.';

function looksLikeVectorGarbage(line: string): boolean {
  const compact = line.replace(/\s+/g, '');
  if (!compact) return true;

  const alphaNumeric = compact.match(/[a-z0-9]/gi)?.length ?? 0;
  const pipeCount = compact.match(/\|/g)?.length ?? 0;
  const commaCount = compact.match(/,/g)?.length ?? 0;
  const digitCount = compact.match(/\d/g)?.length ?? 0;

  if (pipeCount > 12 && alphaNumeric === 0) return true;
  if (compact.length > 80 && pipeCount / compact.length > 0.45) return true;
  if (/^embedding\s*[:=]/i.test(line)) return true;
  if (compact.length > 160 && commaCount > 20 && digitCount / compact.length > 0.35) return true;
  if (/^\[?[-+0-9.,eE\s]+\]?$/.test(line) && commaCount > 20) return true;

  return false;
}

function sanitizeThoughtContent(content: string): string {
  const lines = content
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !looksLikeVectorGarbage(line));

  const cleaned = lines.join('\n').trim();
  return cleaned || UNREADABLE_CONTENT_FALLBACK;
}

/**
 * Parse the human-readable text block that OB1's search_thoughts tool returns.
 * Format is:
 *   Found N thought(s):
 *
 *   --- Result 1 (XX.X% match) ---
 *   Captured: M/D/YYYY
 *   Type: xxx
 *   Topics: a, b, c
 *   People: d, e
 *
 *   <content>
 *
 *   --- Result 2 ...
 */
export function parseSearchText(text: string): Ob1ParsedResult[] {
  const results: Ob1ParsedResult[] = [];
  const blocks = text.split(/^--- Result \d+ \(([^)]+)\) ---$/gm);
  for (let i = 1; i < blocks.length; i += 2) {
    const match = blocks[i].trim();
    const body = blocks[i + 1] ?? '';
    const lines = body.split('\n').map((l) => l.trim()).filter(Boolean);

    let date = '', type = '', topics: string[] = [], people: string[] = [];
    const contentLines: string[] = [];
    let inHeader = true;

    for (const line of lines) {
      if (inHeader) {
        if (line.startsWith('Captured:')) { date = line.slice(9).trim(); continue; }
        if (line.startsWith('Type:')) { type = line.slice(5).trim(); continue; }
        if (line.startsWith('Topics:')) { topics = line.slice(7).split(',').map((s) => s.trim()).filter(Boolean); continue; }
        if (line.startsWith('People:')) { people = line.slice(7).split(',').map((s) => s.trim()).filter(Boolean); continue; }
        if (line.startsWith('Actions:')) { continue; }
        inHeader = false;
      }
      contentLines.push(line);
    }

    results.push({ match, date, type, topics, people, content: sanitizeThoughtContent(contentLines.join('\n')) });
  }
  return results;
}

/**
 * Build a memory-context block from OB1 search results.
 * Same shape as the SQLite path's `[Memory context]` block:
 *   [Memory context]
 *   Relevant memories:
 *   - [0.8] summary text (topics)
 *   - ...
 *   [End memory context]
 *
 * Filters out type=conversation hits — those are raw Q&A turns from the
 * migrated conversation_log and are semantic noise (short "ok"/"where is it"
 * fragments that match any query). Distilled memories always win.
 */
const NOISE_TYPES = new Set(['conversation']);

export async function buildMemoryContextOb1(
  userMessage: string,
  limit = 5,
  threshold = 0.5,
): Promise<string> {
  // Over-fetch so we have enough after filtering out conversation noise
  const text = await searchThoughts({ query: userMessage, limit: limit * 3, threshold });
  if (!text || /^No thoughts found/i.test(text.trim())) return '';

  const allHits = parseSearchText(text);
  const hits = allHits.filter((h) => !NOISE_TYPES.has(h.type.toLowerCase())).slice(0, limit);
  if (hits.length === 0) return '';

  const lines: string[] = ['[Memory context]', 'Relevant memories:'];
  for (const h of hits) {
    const pct = parseFloat(h.match.replace(/[^\d.]/g, '')) || 0;
    const score = (pct / 100).toFixed(1);
    const topicStr = h.topics.length ? ` (${h.topics.join(', ')})` : '';
    const oneLine = h.content.replace(/\s+/g, ' ').trim().slice(0, 280);
    lines.push(`- [${score}] ${oneLine}${topicStr}`);
  }
  lines.push('[End memory context]');
  return lines.join('\n');
}

/**
 * Write an extracted memory to OB1 via capture_thought.
 * Uses the MCP endpoint which runs Gemini extraction + embedding server-side,
 * so we send just the summary text. Metadata from our extraction becomes
 * a prefix/context for OB1's own metadata extractor.
 */
export async function ingestMemoryOb1(args: {
  chatId: string;
  agentId: string;
  summary: string;
  topics: string[];
  entities: string[];
  importance: number;
  rawText: string;
}): Promise<boolean> {
  try {
    await captureThought({ content: args.summary });
    logger.debug(
      { chatId: args.chatId, agentId: args.agentId, importance: args.importance },
      'ob1 capture_thought succeeded',
    );
    return true;
  } catch (err) {
    logger.warn({ err, agentId: args.agentId }, 'ob1 capture_thought failed');
    return false;
  }
}
