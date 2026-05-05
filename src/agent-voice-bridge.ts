/**
 * Agent Voice Bridge
 *
 * Lightweight CLI script that the War Room Pipecat server calls to invoke
 * a ClaudeClaw agent via the active LLM provider and return the text response.
 *
 * Usage: node dist/agent-voice-bridge.js --agent research --message "What did you find?"
 *
 * Outputs JSON to stdout: {"response": "...", "usage": {...}, "error": null}
 *
 * The Pipecat server spawns this as a subprocess for each agent turn,
 * reads the JSON response, and pipes the text to TTS.
 */

import fs from 'fs';
import { initDatabase, getSession, setSession } from './db.js';
import { buildMemoryContext } from './memory.js';
import { getActiveProviderName, runAgent } from './agent.js';
import { loadAgentConfig, resolveAgentClaudeMd, resolveAgentDir } from './agent-config.js';
import { activeBotToken, PROJECT_ROOT, resolveMainClaudeMdPath, setAgentOverrides } from './config.js';

// The voice bridge is a standalone subprocess — initialize the DB
// connection before any getSession/setSession calls run. Without this,
// db is undefined and every call fails with "Cannot read properties of
// undefined (reading 'prepare')".
initDatabase();

// Parse CLI args
const args = process.argv.slice(2);
let agentId = 'main';
let message = '';
let chatId = 'warroom';
let quickMode = false;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--agent' && args[i + 1]) {
    agentId = args[++i];
  } else if (args[i] === '--message' && args[i + 1]) {
    message = args[++i];
  } else if (args[i] === '--chat-id' && args[i + 1]) {
    chatId = args[++i];
  } else if (args[i] === '--quick') {
    // Quick mode is used by warroom auto-routing where voice latency
    // matters more than thoroughness. The prompt below asks for a short
    // spoken answer and the provider call gets a tighter timeout.
    quickMode = true;
  }
}

if (!message) {
  console.error(JSON.stringify({ response: null, usage: null, error: 'No --message provided' }));
  process.exit(1);
}

async function main() {
  try {
    // Validate agent ID format (prevent path traversal)
    if (agentId !== 'main' && !/^[a-z][a-z0-9_-]{0,29}$/.test(agentId)) {
      throw new Error(`Invalid agent ID: ${agentId}`);
    }

    let agentDir = PROJECT_ROOT;
    let systemPrompt: string | undefined;
    let model: string | undefined;
    let mcpAllowlist: string[] | undefined;

    if (agentId === 'main') {
      const mainClaudeMd = resolveMainClaudeMdPath();
      if (fs.existsSync(mainClaudeMd)) {
        systemPrompt = fs.readFileSync(mainClaudeMd, 'utf-8');
      }
      setAgentOverrides({
        agentId: 'main',
        botToken: activeBotToken,
        cwd: PROJECT_ROOT,
        systemPrompt,
      });
    } else {
      const agentConfig = loadAgentConfig(agentId);
      agentDir = resolveAgentDir(agentId);
      model = agentConfig.model;
      mcpAllowlist = agentConfig.mcpServers;
      const claudeMdPath = resolveAgentClaudeMd(agentId);
      if (claudeMdPath) {
        systemPrompt = fs.readFileSync(claudeMdPath, 'utf-8');
      }
      setAgentOverrides({
        agentId,
        botToken: agentConfig.botToken,
        cwd: agentDir,
        model,
        obsidian: agentConfig.obsidian,
        systemPrompt,
        mcpServers: mcpAllowlist,
      });
    }

    const activeProvider = getActiveProviderName();
    process.stderr.write(`[voice-bridge] agent=${agentId} provider=${activeProvider} mcpAllowlist=${JSON.stringify(mcpAllowlist ?? null)}\n`);

    // Resume session if one exists for this chat+agent
    const sessionId = getSession(chatId, agentId, activeProvider) ?? undefined;

    // Build memory context
    const { contextText: memCtx } = await buildMemoryContext(chatId, message, agentId);
    const parts: string[] = [];
    if (memCtx) parts.push(memCtx);

    // Add voice-meeting context hint. Quick mode is stricter because
    // Gemini Live will read the answer verbatim over voice —
    // long responses break the meeting feel.
    if (quickMode) {
      parts.push('[War Room auto-routing: the user is in a voice meeting and this answer will be read aloud verbatim. Respond in 1-2 short sentences. No preamble, no caveats, no lists. If the question genuinely needs a long answer, say "I need to dig into this, want me to queue it" so the user can choose to delegate the full task.]');
    } else {
      parts.push('[Voice meeting mode: Keep responses concise and conversational. Aim for 2-3 sentences unless asked for detail. Start with a brief acknowledgment.]');
    }
    parts.push(message);
    const fullMessage = parts.join('\n\n');

    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), quickMode ? 45_000 : 180_000);
    const result = await runAgent(
      fullMessage,
      sessionId,
      () => {},
      undefined,
      model,
      abortController,
      undefined,
      mcpAllowlist,
      undefined,
      systemPrompt,
    );
    clearTimeout(timeout);

    // Save session for continuity
    if (result.newSessionId) {
      setSession(chatId, result.newSessionId, agentId, activeProvider);
    }

    const usage = result.usage ? {
      input_tokens: result.usage.inputTokens,
      output_tokens: result.usage.outputTokens,
      cost_usd: result.usage.totalCostUsd,
    } : {};

    console.log(JSON.stringify({
      response: result.text,
      usage,
      error: null,
    }));
  } catch (err) {
    console.log(JSON.stringify({
      response: null,
      usage: null,
      error: err instanceof Error ? err.message : String(err),
    }));
    process.exit(1);
  }
}

main();
