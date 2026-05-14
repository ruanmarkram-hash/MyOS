// Shared embedding helper for every Node-side brain writer.
//
// Background: 2026-04 the OB1 thoughts.embedding column was migrated to
// vector(1024) via scripts/backfill-bge-embeddings.mjs to lock the brain on
// one canonical embedding space (BGE-M3 served by local llama.cpp). Several
// writers were left calling Gemini at 1536d, which silently produced
// "expected 1024 dimensions, not 1536" insert errors and dropped every new
// jsonl-derived thought on the floor.
//
// All Node writers MUST import from this module so a future encoder swap
// happens in exactly one place. Do not embed inline.
//
// Env (read from ~/myos/.env or process.env):
//   LLAMACPP_EMBEDDING_URL    default http://127.0.0.1:8081/v1/embeddings
//   LLAMACPP_EMBEDDING_MODEL  default bge-m3
//   LLAMACPP_EMBEDDING_DIM    default 1024

import { readFileSync, existsSync } from 'node:fs';

function readEnvFile() {
  const path = '~/myos/.env';
  if (!existsSync(path)) return {};
  return Object.fromEntries(
    readFileSync(path, 'utf-8')
      .split(/\r?\n/)
      .filter((l) => l && !l.trimStart().startsWith('#') && l.includes('='))
      .map((l) => {
        const i = l.indexOf('=');
        let v = l.slice(i + 1).trim();
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
        return [l.slice(0, i).trim(), v];
      }),
  );
}

const fileEnv = readEnvFile();
const ENV = { ...fileEnv, ...process.env };

export const EMBED_URL = ENV.LLAMACPP_EMBEDDING_URL || 'http://127.0.0.1:8081/v1/embeddings';
export const EMBED_MODEL = ENV.LLAMACPP_EMBEDDING_MODEL || 'bge-m3';
export const EMBED_MODEL_NAME = `llamacpp:${EMBED_MODEL}`;
export const EMBED_DIM = Number(ENV.LLAMACPP_EMBEDDING_DIM || 1024);

/**
 * Embed a single text with BGE-M3 (1024d). Truncates aggressively on context
 * overflow. Returns null on persistent failure so callers can record an
 * embed_fail counter without throwing.
 *
 * @param {string} text
 * @param {{ retries?: number, maxChars?: number, throwOnFail?: boolean }} [opts]
 * @returns {Promise<number[] | null>}
 */
export async function embed(text, opts = {}) {
  const retries = opts.retries ?? 3;
  let maxChars = opts.maxChars ?? 24_000;
  const throwOnFail = opts.throwOnFail ?? false;

  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const res = await fetch(EMBED_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: EMBED_MODEL, input: text.slice(0, maxChars) }),
      });
      const body = await res.text();
      if (!res.ok) {
        // Llama.cpp returns 4xx with "input too large to process" for over-long
        // chunks even after our slice. Halve and retry without consuming an
        // attempt slot.
        if (/too large to process|maximum context|context length/i.test(body) && maxChars > 2_000) {
          maxChars = Math.floor(maxChars / 2);
          continue;
        }
        if (attempt === retries - 1) {
          if (throwOnFail) throw new Error(`embed HTTP ${res.status}: ${body.slice(0, 300)}`);
          return null;
        }
        await new Promise((r) => setTimeout(r, 500 * Math.pow(2, attempt)));
        continue;
      }
      const parsed = JSON.parse(body);
      const v = parsed?.data?.[0]?.embedding ?? parsed?.embedding;
      if (!Array.isArray(v) || v.length !== EMBED_DIM) {
        if (throwOnFail) throw new Error(`embed shape mismatch: len=${v?.length}, expected=${EMBED_DIM}`);
        return null;
      }
      return v.map(Number);
    } catch (err) {
      if (attempt === retries - 1) {
        if (throwOnFail) throw err;
        return null;
      }
      await new Promise((r) => setTimeout(r, 500 * Math.pow(2, attempt)));
    }
  }
  return null;
}

export function vecLit(v) {
  return '[' + v.join(',') + ']';
}
