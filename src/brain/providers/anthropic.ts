import { query, type McpHttpServerConfig, type McpServerConfig } from '@anthropic-ai/claude-agent-sdk';
import { MCP_ACCESS_KEY, OB1_BRAIN_FUNCTION, OB1_SUPABASE_URL } from '../../config.js';
import { logger } from '../../logger.js';

const CAPTURE_SYSTEM = `You are a capture agent for the user's Open Brain memory store. You are given a single item to save. Call the capture_thought tool exactly once with the provided content. Do not ask clarifying questions, do not summarise, do not rewrite the content. After the tool returns, reply with only the tool's confirmation text. End.`;

const SEARCH_SYSTEM = `You are a retrieval agent for the user's Open Brain memory store. You are given a search query. Call the search_thoughts tool once with the query. Reply with only the tool's result. End.`;

function mcpServerSpec(): Record<string, McpServerConfig> {
  if (!OB1_SUPABASE_URL || !MCP_ACCESS_KEY) {
    throw new Error('Anthropic adapter: OB1_SUPABASE_URL and MCP_ACCESS_KEY required');
  }
  const url = `${OB1_SUPABASE_URL.replace(/\/+$/, '')}/functions/v1/${OB1_BRAIN_FUNCTION}`;
  const cfg: McpHttpServerConfig = {
    type: 'http',
    url,
    headers: { 'x-brain-key': MCP_ACCESS_KEY },
  };
  return { 'open-brain': cfg };
}

async function runOnce(systemPrompt: string, userPrompt: string, maxTurns = 3): Promise<string> {
  const mcpServers = mcpServerSpec();
  const chunks: string[] = [];
  for await (const event of query({
    prompt: userPrompt,
    options: {
      model: 'claude-haiku-4-5',
      systemPrompt: { type: 'preset', preset: 'claude_code', append: systemPrompt },
      maxTurns,
      mcpServers,
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      includePartialMessages: false,
    },
  })) {
    const ev = event as Record<string, unknown>;
    if (ev.type === 'assistant') {
      const msg = ev.message as { content?: Array<{ type?: string; text?: string }> } | undefined;
      for (const block of msg?.content ?? []) {
        if (block.type === 'text' && block.text) chunks.push(block.text);
      }
    }
  }
  return chunks.join('').trim();
}

export async function captureViaClaude(content: string): Promise<string> {
  try {
    return await runOnce(CAPTURE_SYSTEM, `Capture this:\n\n${content}`);
  } catch (err) {
    logger.warn({ err }, 'captureViaClaude failed');
    throw err;
  }
}

export async function searchViaClaude(query: string): Promise<string> {
  try {
    return await runOnce(SEARCH_SYSTEM, `Search for:\n\n${query}`);
  } catch (err) {
    logger.warn({ err }, 'searchViaClaude failed');
    throw err;
  }
}
