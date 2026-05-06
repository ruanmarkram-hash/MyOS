import { GoogleGenAI } from '@google/genai';

import {
  EMBEDDING_MODEL,
  EMBEDDING_PROVIDER,
  GOOGLE_API_KEY,
  LLAMACPP_EMBEDDING_MODEL,
  LLAMACPP_EMBEDDING_URL,
  type EmbeddingProvider,
} from './config.js';

let client: GoogleGenAI | null = null;

function getClient(): GoogleGenAI {
  if (client) return client;
  if (!GOOGLE_API_KEY) {
    throw new Error('GOOGLE_API_KEY is not set.');
  }
  client = new GoogleGenAI({ apiKey: GOOGLE_API_KEY });
  return client;
}

function assertSupportedProvider(provider: string): asserts provider is EmbeddingProvider {
  if (provider !== 'gemini' && provider !== 'llamacpp') {
    throw new Error(`Unsupported embedding provider: ${provider}`);
  }
}

function normalizeEmbedding(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => Number(item))
    .filter((item) => Number.isFinite(item));
}

async function embedWithGemini(text: string): Promise<number[]> {
  const ai = getClient();
  const result = await ai.models.embedContent({
    model: EMBEDDING_MODEL,
    contents: text,
  });
  return result.embeddings?.[0]?.values ?? [];
}

async function embedWithLlamaCpp(text: string): Promise<number[]> {
  const res = await fetch(LLAMACPP_EMBEDDING_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: LLAMACPP_EMBEDDING_MODEL,
      input: text,
    }),
  });
  const bodyText = await res.text();
  if (!res.ok) {
    throw new Error(`llama.cpp embedding HTTP ${res.status}: ${bodyText.slice(0, 300)}`);
  }
  const body = JSON.parse(bodyText) as {
    data?: Array<{ embedding?: unknown }>;
    embedding?: unknown;
  };
  const embedding = normalizeEmbedding(body.data?.[0]?.embedding ?? body.embedding);
  if (embedding.length === 0) throw new Error('llama.cpp embedding response did not contain a vector.');
  return embedding;
}

export function getEmbeddingModelName(): string {
  assertSupportedProvider(EMBEDDING_PROVIDER);
  return EMBEDDING_PROVIDER === 'llamacpp'
    ? `llamacpp:${LLAMACPP_EMBEDDING_MODEL}`
    : EMBEDDING_MODEL;
}

export function getCompatibleEmbeddingModelNames(): string[] {
  assertSupportedProvider(EMBEDDING_PROVIDER);
  if (EMBEDDING_PROVIDER === 'llamacpp') return [getEmbeddingModelName()];
  return Array.from(new Set([EMBEDDING_MODEL, 'embedding-001', 'gemini-embedding-001']));
}

/**
 * Generate an embedding vector for a text string.
 * Returns a float array from the configured embedding provider.
 */
export async function embedText(text: string): Promise<number[]> {
  assertSupportedProvider(EMBEDDING_PROVIDER);
  if (EMBEDDING_PROVIDER === 'llamacpp') return embedWithLlamaCpp(text);
  return embedWithGemini(text);
}

/**
 * Cosine similarity between two vectors. Returns -1 to 1.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  if (denom === 0) return 0;
  return dot / denom;
}
