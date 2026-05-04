import { GoogleGenAI } from '@google/genai';
import Anthropic from '@anthropic-ai/sdk';
import { query } from '@anthropic-ai/claude-agent-sdk';

import { GOOGLE_API_KEY } from './config.js';
import { readEnvFile } from './env.js';
import { getScrubbedSdkEnv } from './security.js';
import { logger } from './logger.js';

// ── Gemini client (primary for text generation, always for embeddings) ──

let geminiClient: GoogleGenAI | null = null;

function getGeminiClient(): GoogleGenAI | null {
  if (geminiClient) return geminiClient;
  if (!GOOGLE_API_KEY) return null;
  geminiClient = new GoogleGenAI({ apiKey: GOOGLE_API_KEY });
  return geminiClient;
}

// ── Anthropic/Haiku client (fallback for text generation) ──

let anthropicClient: Anthropic | null = null;

function getAnthropicClient(): Anthropic | null {
  if (anthropicClient) return anthropicClient;
  const secrets = readEnvFile(['ANTHROPIC_API_KEY']);
  const apiKey = secrets.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  // OAuth tokens (sk-ant-oat01-*) use authToken; API keys use apiKey
  if (apiKey.startsWith('sk-ant-oat')) {
    anthropicClient = new Anthropic({ authToken: apiKey });
  } else {
    anthropicClient = new Anthropic({ apiKey });
  }
  return anthropicClient;
}

/**
 * Generate text content. Tries Gemini first; falls back to Haiku if Gemini
 * fails (quota exhausted, network error, missing key, etc).
 *
 * All callers (memory ingest, consolidation, relevance eval, dashboard
 * classification) benefit from the fallback automatically.
 *
 * Embeddings remain on Gemini (separate endpoint/quota) via embeddings.ts.
 */
export async function generateContent(
  prompt: string,
  model = 'gemini-2.5-flash',
): Promise<string> {
  // ── Try Gemini first (with retry on transient errors) ──
  const gemini = getGeminiClient();
  if (gemini) {
    const MAX_RETRIES = 2;
    const RETRY_DELAYS = [2000, 4000]; // ms
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const response = await gemini.models.generateContent({
          model,
          contents: prompt,
          config: {
            temperature: 0.1,
            responseMimeType: 'application/json',
          },
        });
        if (response.text) return response.text;
        logger.warn({ model }, 'Gemini returned empty response, falling back to Haiku');
        break; // empty response is not retryable
      } catch (err: any) {
        const status = err?.status ?? err?.httpStatusCode ?? 0;
        const isRetryable = status === 503 || status === 429 || status === 500;
        if (isRetryable && attempt < MAX_RETRIES) {
          const delay = RETRY_DELAYS[attempt] ?? 4000;
          logger.warn({ model, status, attempt: attempt + 1 }, `Gemini ${status}, retrying in ${delay}ms`);
          await new Promise(r => setTimeout(r, delay));
          continue;
        }
        logger.warn({ err, model, attempt }, 'Gemini generateContent failed, falling back to Haiku');
        break;
      }
    }
  }

  // ── Fallback path 1: Anthropic Messages API (only if real API key set) ──
  const anthropic = getAnthropicClient();
  if (anthropic) {
    try {
      const response = await anthropic.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 512,
        messages: [{ role: 'user', content: prompt }],
        system: 'You are a structured data extraction agent. Always respond with valid JSON only. No markdown, no explanation, just the JSON object.',
      });

      const textBlock = response.content.find((b) => b.type === 'text');
      if (!textBlock || textBlock.type !== 'text') {
        logger.warn('Haiku returned no text content, trying Agent SDK fallback');
      } else {
        return textBlock.text;
      }
    } catch (err) {
      logger.warn({ err }, 'Haiku Messages-API fallback failed, trying Agent SDK');
    }
  }

  // ── Fallback path 2: Claude Code Agent SDK (uses OAuth subscription) ──
  // This works when no ANTHROPIC_API_KEY is set but CLAUDE_CODE_OAUTH_TOKEN is.
  // Single-turn, no tools, no MCP, no settings — pure text completion.
  try {
    let collected = '';
    // Scrub secrets from the subprocess env. The SDK does not need
    // DASHBOARD_TOKEN, DB_ENCRYPTION_KEY, third-party API keys, etc.
    const sdkEnv = getScrubbedSdkEnv(
      readEnvFile(['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY']),
    );
    for await (const event of query({
      prompt,
      options: {
        model: 'claude-haiku-4-5',
        maxTurns: 1,
        settingSources: [],            // do NOT load CLAUDE.md or skills
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        env: sdkEnv,
      },
    })) {
      const ev = event as Record<string, unknown>;
      if (ev['type'] === 'assistant') {
        const msg = ev['message'] as Record<string, unknown> | undefined;
        const content = msg?.['content'] as Array<{ type: string; text?: string }> | undefined;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === 'text' && typeof block.text === 'string') {
              collected += block.text;
            }
          }
        }
      }
    }
    if (!collected) {
      logger.error('Agent SDK fallback returned empty response');
      throw new Error('All extraction paths failed: Gemini, Haiku, and Agent SDK all returned nothing.');
    }
    logger.info({ chars: collected.length }, 'Agent SDK fallback succeeded');
    return collected;
  } catch (err) {
    logger.error({ err }, 'Agent SDK fallback failed');
    throw err;
  }
}

/**
 * Parse a JSON response, with fallback on malformed output.
 * Returns null if parsing fails.
 */
export function parseJsonResponse<T>(text: string): T | null {
  try {
    // Strip markdown code fences if present
    const cleaned = text
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/i, '')
      .trim();
    return JSON.parse(cleaned) as T;
  } catch (err) {
    logger.warn({ err, text: text.slice(0, 200) }, 'Failed to parse JSON response');
    return null;
  }
}
