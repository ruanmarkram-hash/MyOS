import fs from 'fs';
import path from 'path';

import { loadAgentConfig, listAgentIds, resolveAgentDir, resolveAgentClaudeMd } from './agent-config.js';
import { createBot } from './bot.js';
import { checkPendingMigrations } from './migrations.js';
import { ALLOWED_CHAT_ID, activeBotToken, STORE_DIR, PROJECT_ROOT, CLAUDECLAW_CONFIG, GOOGLE_API_KEY, setAgentOverrides, SECURITY_PIN_HASH, IDLE_LOCK_MINUTES, EMERGENCY_KILL_PHRASE, WARROOM_ENABLED, WARROOM_PORT, resolveMainClaudeMdPath, LLM_PROVIDER } from './config.js';
import { startDashboard } from './dashboard.js';
import { initDatabase, cleanupOldMissionTasks, insertAuditLog, pruneSentTelegramOutbox, pruneWaMessages, pruneSlackMessages, clearSession } from './db.js';
import { initSecurity, setAuditCallback, getScrubbedSdkEnv } from './security.js';
import { readEnvFile } from './env.js';
import { logger } from './logger.js';
import { cleanupOldUploads } from './media.js';
import { runConsolidation } from './memory-consolidate.js';
import { runDecaySweep } from './memory.js';
import { initOAuthHealthCheck } from './oauth-health.js';
import { initOrchestrator } from './orchestrator.js';
import { initScheduler } from './scheduler.js';
import { setTelegramConnected, setBotInfo } from './state.js';
import { messageQueue } from './message-queue.js';
import { RUNTIME_BUILD_META, createStaleWatcher, shortSha, markShuttingDown } from './build-meta.js';
import { enqueueTelegramSend } from './telegram-outbox.js';
import { getTelegramOutboxRow } from './db.js';
import { createStaleCodeAlerter } from './stale-code-alert.js';
import { normalizeLlmProvider } from './llm-provider.js';

// Parse --agent flag
const agentFlagIndex = process.argv.indexOf('--agent');
const AGENT_ID = agentFlagIndex !== -1 ? process.argv[agentFlagIndex + 1] : 'main';

// Export AGENT_ID to env so child processes (schedule-cli, etc.) inherit it
process.env.CLAUDECLAW_AGENT_ID = AGENT_ID;

if (AGENT_ID !== 'main') {
  const agentConfig = loadAgentConfig(AGENT_ID);
  const agentDir = resolveAgentDir(AGENT_ID);
  const claudeMdPath = resolveAgentClaudeMd(AGENT_ID);
  let systemPrompt: string | undefined;
  if (claudeMdPath) {
    try {
      systemPrompt = fs.readFileSync(claudeMdPath, 'utf-8');
    } catch { /* no CLAUDE.md */ }
  }
  setAgentOverrides({
    agentId: AGENT_ID,
    botToken: agentConfig.botToken,
    cwd: agentDir,
    model: agentConfig.model,
    provider: agentConfig.provider,
    obsidian: agentConfig.obsidian,
    systemPrompt,
    mcpServers: agentConfig.mcpServers,
  });
  logger.info({ agentId: AGENT_ID, name: agentConfig.name }, 'Running as agent');
} else {
  // For main bot: read CLAUDE.md from CLAUDECLAW_CONFIG and inject it as
  // systemPrompt — the same pattern used by sub-agents. Never copy the file
  // into the repo; that defeats the purpose of CLAUDECLAW_CONFIG and risks
  // accidentally committing personal config.
  const mainClaudeMd = resolveMainClaudeMdPath();
  if (fs.existsSync(mainClaudeMd)) {
    let systemPrompt: string | undefined;
    try {
      systemPrompt = fs.readFileSync(mainClaudeMd, 'utf-8');
    } catch { /* unreadable */ }
    if (systemPrompt) {
      setAgentOverrides({
        agentId: 'main',
        botToken: activeBotToken,
        cwd: PROJECT_ROOT,
        systemPrompt,
      });
      logger.info({ source: mainClaudeMd }, 'Loaded main CLAUDE.md');
    }
  } else if (!fs.existsSync(path.join(PROJECT_ROOT, 'CLAUDE.md'))) {
    logger.warn(
      'No CLAUDE.md found. Copy CLAUDE.md.example to %s/CLAUDE.md and customize it.',
      CLAUDECLAW_CONFIG,
    );
  }
}

const PID_FILE = path.join(STORE_DIR, `${AGENT_ID === 'main' ? 'claudeclaw' : `agent-${AGENT_ID}`}.pid`);

function showBanner(): void {
  const bannerPath = path.join(PROJECT_ROOT, 'banner.txt');
  try {
    const banner = fs.readFileSync(bannerPath, 'utf-8');
    console.log('\n' + banner);
  } catch {
    console.log('\n  ClaudeClaw\n');
  }
}

function acquireLock(): void {
  fs.mkdirSync(STORE_DIR, { recursive: true });
  try {
    if (fs.existsSync(PID_FILE)) {
      const old = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10);
      if (!isNaN(old) && old !== process.pid) {
        try {
          process.kill(old, 'SIGTERM');
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
        } catch { /* already dead */ }
      }
    }
  } catch { /* ignore */ }
  fs.writeFileSync(PID_FILE, String(process.pid), { mode: 0o600 });
}

function releaseLock(): void {
  try { fs.unlinkSync(PID_FILE); } catch { /* ignore */ }
}

async function main(): Promise<void> {
  
  checkPendingMigrations(PROJECT_ROOT);

  if (AGENT_ID === 'main') {
    showBanner();
  }

  if (!activeBotToken) {
    if (AGENT_ID === 'main') {
      logger.error('Bot token is not set. Run npm run setup to configure it.');
    } else {
      logger.error({ agentId: AGENT_ID }, `Configuration for agent "${AGENT_ID}" is broken: bot token not set. Check .env or re-run npm run agent:create.`);
    }
    process.exit(1);
  }

  acquireLock();

  try {
    initDatabase();
  } catch (err: any) {
    logger.error('Database initialization failed: %s', err?.message || err);
    if (err?.message?.includes('DB_ENCRYPTION_KEY')) {
      logger.error('Fix: add DB_ENCRYPTION_KEY to .env. Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
    }
    process.exit(1);
  }
  logger.info('Database ready');

  // Initialize security (PIN lock, kill phrase, destructive confirmation, audit)
  initSecurity({
    pinHash: SECURITY_PIN_HASH || undefined,
    idleLockMinutes: IDLE_LOCK_MINUTES,
    killPhrase: EMERGENCY_KILL_PHRASE || undefined,
  });
  setAuditCallback((entry) => {
    insertAuditLog(entry.agentId, entry.chatId, entry.action, entry.detail, entry.blocked);
  });

  initOrchestrator();

  // Decay and consolidation run ONLY in the main process to prevent
  // multi-process over-decay (5x decay on simultaneous restart) and
  // duplicate consolidation records from overlapping memory batches.
  if (AGENT_ID === 'main') {
    runDecaySweep();
    cleanupOldMissionTasks(7);
    pruneSentTelegramOutbox(7);
    // Phase A1: 3-day purge for WhatsApp + Slack message bodies. Bodies
    // are AES-256-GCM encrypted at rest (encryptField/decryptField), so
    // on-disk leak risk is already low — but unbounded retention is
    // still a privacy gap. 3 days is the upstream default and matches
    // the "we use it for context, not archival" pattern.
    const wa1 = pruneWaMessages(3);
    const sl1 = pruneSlackMessages(3);
    const waTotal1 = wa1.messages + wa1.outbox + wa1.map;
    if (waTotal1 > 0 || sl1 > 0) logger.info({ whatsapp: wa1, slack: sl1 }, 'pruned WA/Slack message bodies (startup)');
    setInterval(() => {
      runDecaySweep();
      cleanupOldMissionTasks(7);
      pruneSentTelegramOutbox(7);
      const wa = pruneWaMessages(3);
      const sl = pruneSlackMessages(3);
      const waTotal = wa.messages + wa.outbox + wa.map;
      if (waTotal > 0 || sl > 0) logger.info({ whatsapp: wa, slack: sl }, 'pruned WA/Slack message bodies (daily)');
    }, 24 * 60 * 60 * 1000);

    // Memory consolidation: find patterns across recent memories every 30 minutes
    if (ALLOWED_CHAT_ID && GOOGLE_API_KEY) {
      // Delay first consolidation 2 minutes after startup to let things settle
      setTimeout(() => {
        void runConsolidation(ALLOWED_CHAT_ID).catch((err) =>
          logger.error({ err }, 'Initial consolidation failed'),
        );
      }, 2 * 60 * 1000);
      setInterval(() => {
        void runConsolidation(ALLOWED_CHAT_ID).catch((err) =>
          logger.error({ err }, 'Periodic consolidation failed'),
        );
      }, 30 * 60 * 1000);
      logger.info('Memory consolidation enabled (every 30 min)');
    }
  } else {
    logger.info({ agentId: AGENT_ID }, 'Skipping decay/consolidation (main process owns these)');
  }

  cleanupOldUploads();

  const bot = createBot();

  // Wire the durable Telegram outbox to the bot's API. Every send
  // queued via enqueueTelegramSend() drains through this client.
  const { setTelegramOutboxClient } = await import('./telegram-outbox.js');
  setTelegramOutboxClient(async (method, chatId, params) => {
    const numericChatId = /^-?\d+$/.test(chatId) ? Number(chatId) : chatId;
    // Strip our internal-use marker so it never reaches Telegram.
    const cleanParams: Record<string, unknown> = { ...params };
    delete cleanParams.__meta_alert;
    if (method === 'sendMessage') {
      const resp = await bot.api.sendMessage(
        numericChatId as number,
        String(cleanParams.text ?? ''),
        cleanParams as Parameters<typeof bot.api.sendMessage>[2],
      );
      return { message_id: resp.message_id };
    }
    if (method === 'sendDocument') {
      const resp = await bot.api.sendDocument(
        numericChatId as number,
        cleanParams.document as Parameters<typeof bot.api.sendDocument>[1],
        cleanParams as Parameters<typeof bot.api.sendDocument>[2],
      );
      return { message_id: resp.message_id };
    }
    if (method === 'sendPhoto') {
      const resp = await bot.api.sendPhoto(
        numericChatId as number,
        cleanParams.photo as Parameters<typeof bot.api.sendPhoto>[1],
        cleanParams as Parameters<typeof bot.api.sendPhoto>[2],
      );
      return { message_id: resp.message_id };
    }
    throw new Error(`telegram-outbox: unsupported method ${method}`);
  });

  // Dashboard only runs in the main bot process
  if (AGENT_ID === 'main') {
    startDashboard(bot.api);

    // War Room voice server (auto-start if enabled, with auto-respawn)
    if (WARROOM_ENABLED) {
      // SAFE-SPAWN-EXEMPT: warroom server SDK spawn — getScrubbedSdkEnv with explicit auth re-injection. Pre-Part-3 migration.
      const { spawn } = await import('child_process');
      const venvPython = path.join(PROJECT_ROOT, 'warroom', '.venv', 'bin', 'python');
      const serverScript = path.join(PROJECT_ROOT, 'warroom', 'server.py');

      // Write agent roster to /tmp so the Python server can discover agents dynamically
      try {
        const ids = ['main', ...listAgentIds().filter((id) => id !== 'main')];
        const roster = ids.map((id) => {
          try {
            if (id === 'main') return { id: 'main', name: 'Main', description: 'General ops and triage' };
            const cfg = loadAgentConfig(id);
            return { id, name: cfg.name || id, description: cfg.description || '' };
          } catch { return { id, name: id, description: '' }; }
        });
        fs.writeFileSync('/tmp/warroom-agents.json', JSON.stringify(roster, null, 2));
      } catch (err) {
        logger.warn({ err }, 'Could not write warroom agent roster');
      }

      if (fs.existsSync(venvPython) && fs.existsSync(serverScript)) {
        // Pre-flight: verify Python dependencies are actually installed
        const { safeSpawnSync } = await import('./safe-spawn.js');
        // bare `python -c 'import pipecat'` import probe. No
        // agent-controlled args, no LLM in the loop.
        const depCheck = safeSpawnSync(venvPython, ['-c', 'import pipecat'], {
          envClass: 'system-tool',
          stdio: 'pipe',
          timeout: 10000,
        });
        if (depCheck.status !== 0) {
          const msg = 'War Room Python dependencies not installed. Run:\n\n'
            + 'source warroom/.venv/bin/activate\n'
            + 'pip install -r warroom/requirements.txt\n\n'
            + 'Then restart the bot.';
          logger.error(msg);
          if (ALLOWED_CHAT_ID) {
            const { enqueueTelegramSend } = await import('./telegram-outbox.js');
            enqueueTelegramSend({ agentId: AGENT_ID, chatId: ALLOWED_CHAT_ID, method: 'sendMessage', params: { text: `War Room could not start.\n\n${msg}` } });
          }
        } else {
        // Dedicated log file for the warroom subprocess
        const warroomLogPath = '/tmp/warroom-debug.log';
        let warroomLogFd: number | null = null;
        try {
          warroomLogFd = fs.openSync(warroomLogPath, 'a');
        } catch (err) {
          logger.warn({ err, warroomLogPath }, 'Could not open warroom log');
        }

        const MAX_CRASH_RESPAWNS = 3;
        let respawnAttempts = 0;
        let shuttingDown = false;
        let currentProc: ReturnType<typeof spawn> | null = null;

        const spawnWarroom = (): void => {
          if (shuttingDown) return;
          // SDK-CLASS spawn: the warroom Python server pipes user voice
          // and text to LLM providers (Gemini Live, Deepgram, Cartesia),
          // so a prompt-injected response could attempt to exfil any
          // env-borne secret. Scrub the spawn env to break that chain
          // and re-inject only the API keys the server actually needs.
          const warroomAuth = readEnvFile([
            'GOOGLE_API_KEY',
            'DEEPGRAM_API_KEY',
            'CARTESIA_API_KEY',
          ]);
          // Round-4 structural fix: no natural pass-through. Warroom
          // doesn't need ANTHROPIC_API_KEY directly, but if .env doesn't
          // carry one of these voice keys we still scrub correctly.
          const warroomEnv = getScrubbedSdkEnv(warroomAuth);
          warroomEnv.WARROOM_PORT = String(WARROOM_PORT);
          // SAFE-SPAWN-EXEMPT: warroom SDK spawn, env = getScrubbedSdkEnv(warroomAuth).
          const proc = spawn(venvPython, [serverScript], {
            cwd: PROJECT_ROOT,
            env: warroomEnv as NodeJS.ProcessEnv,
            stdio: ['ignore', 'pipe', 'pipe'],
          });
          currentProc = proc;

          proc.stdout.once('data', (data: Buffer) => {
            try {
              const info = JSON.parse(data.toString().trim());
              logger.info({ port: WARROOM_PORT, ws_url: info.ws_url, pid: proc.pid }, 'War Room server started');
            } catch {
              logger.info({ port: WARROOM_PORT, pid: proc.pid }, 'War Room server started');
            }
            respawnAttempts = 0; // reset backoff once we see a ready line
          });

          // Forward stdout+stderr into the dedicated log file.
          if (warroomLogFd !== null) {
            const write = (buf: Buffer) => { try { fs.writeSync(warroomLogFd!, buf); } catch { /* ok */ } };
            proc.stdout.on('data', write);
            proc.stderr.on('data', write);
          }

          proc.on('exit', (code, signal) => {
            if (shuttingDown) return;
            const wasIntentional = signal === 'SIGTERM' || signal === 'SIGKILL' || signal === 'SIGINT';
            logger.warn({ code, signal, pid: proc.pid, intentional: wasIntentional }, 'War Room server exited');
            let delayMs: number;
            if (wasIntentional) {
              delayMs = 300;
              respawnAttempts = 0;
            } else {
              respawnAttempts += 1;
              if (respawnAttempts > MAX_CRASH_RESPAWNS) {
                logger.error(`War Room crashed ${MAX_CRASH_RESPAWNS} times. Giving up. Check /tmp/warroom-debug.log for errors.`);
                if (ALLOWED_CHAT_ID) {
                  void import('./telegram-outbox.js').then(({ enqueueTelegramSend }) => {
                    enqueueTelegramSend({ agentId: AGENT_ID, chatId: ALLOWED_CHAT_ID, method: 'sendMessage', params: { text: `War Room crashed ${MAX_CRASH_RESPAWNS} times and has been disabled.\n\nCheck /tmp/warroom-debug.log, fix the issue, and restart the bot.` } });
                  });
                }
                return;
              }
              delayMs = Math.min(30000, 500 * 2 ** Math.min(respawnAttempts, 6));
            }
            logger.info({ delayMs, attempt: respawnAttempts }, 'Respawning War Room server');
            setTimeout(spawnWarroom, delayMs);
          });
        };

        spawnWarroom();

        // Clean up on main process exit.
        const shutdownWarroom = () => {
          shuttingDown = true;
          try { currentProc?.kill(); } catch { /* ok */ }
          if (warroomLogFd !== null) { try { fs.closeSync(warroomLogFd); } catch { /* ok */ } }
        };
        process.on('exit', shutdownWarroom);
        process.on('SIGTERM', shutdownWarroom);
        process.on('SIGINT', shutdownWarroom);
        } // end dep check else
      } else {
        const missingVenv = !fs.existsSync(venvPython);
        const missingScript = !fs.existsSync(serverScript);
        const hint = missingVenv
          ? 'Python venv not found. Run:\n\npython3 -m venv warroom/.venv\nsource warroom/.venv/bin/activate\npip install -r warroom/requirements.txt'
          : 'warroom/server.py not found. Make sure the warroom/ directory exists.';
        logger.warn('War Room enabled but cannot start: %s', hint);
        if (ALLOWED_CHAT_ID) {
          const { enqueueTelegramSend } = await import('./telegram-outbox.js');
          enqueueTelegramSend({ agentId: AGENT_ID, chatId: ALLOWED_CHAT_ID, method: 'sendMessage', params: { text: `War Room is enabled but could not start.\n\n${hint}` } });
        }
      }
    }
  }

  if (ALLOWED_CHAT_ID) {
    initScheduler(
      async (text) => {
        // Split long messages to respect Telegram's 4096 char limit.
        // Route through the durable outbox so transient Telegram failures
        // don't drop scheduled-task output.
        const { splitMessage } = await import('./bot.js');
        const { enqueueTelegramSend } = await import('./telegram-outbox.js');
        for (const chunk of splitMessage(text)) {
          enqueueTelegramSend({
            agentId: AGENT_ID,
            chatId: ALLOWED_CHAT_ID,
            method: 'sendMessage',
            params: { text: chunk, parse_mode: 'HTML' },
          });
        }
      },
      AGENT_ID,
    );

    // Proactive OAuth health monitoring — alerts via Telegram before the
    // Claude CLI token expires. OPT-IN as of 2026-04-10: users were getting
    // spammed with "Expiring soon" alerts on fresh installs (reported by
    // Benjamin Elkrieff in Discord), and people who don't monitor their
    // phone can't re-auth in time anyway. Enable only if you actually want
    // the alerts by setting OAUTH_HEALTH_ENABLED=true in .env.
    const oauthHealthEnv = (await import('./env.js')).readEnvFile(['OAUTH_HEALTH_ENABLED']);
    if ((oauthHealthEnv.OAUTH_HEALTH_ENABLED || '').trim().toLowerCase() === 'true') {
      initOAuthHealthCheck(async (text) => {
        const { splitMessage } = await import('./bot.js');
        const { enqueueTelegramSend } = await import('./telegram-outbox.js');
        for (const chunk of splitMessage(text)) {
          enqueueTelegramSend({
            agentId: AGENT_ID,
            chatId: ALLOWED_CHAT_ID,
            method: 'sendMessage',
            params: { text: chunk, parse_mode: 'HTML' },
          });
        }
      });
    } else {
      logger.info('OAuth health check disabled (set OAUTH_HEALTH_ENABLED=true in .env to enable)');
    }
  } else {
    logger.warn('ALLOWED_CHAT_ID not set — scheduler disabled (no destination for results)');
  }

  // Guard against double shutdown: SIGTERM + SIGINT can fire together
  // (e.g. on launchctl kickstart -k followed by user Ctrl+C).
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    // Tell the stale-code watcher we're on the way out so it doesn't fire
    // a final "I'm stale" alert during the drain. The user has already
    // issued the remedy (/restart) — alerting again now panics them.
    markShuttingDown();
    logger.info({ signal }, 'Shutting down...');
    setTelegramConnected(false);

    // STEP 1: Stop intake. Two things must happen before drain has any
    // meaning, otherwise new messages keep arriving and drain reports
    // success while work is still being enqueued:
    //   (a) close the message queue so new enqueue() calls are dropped
    //   (b) stop the Telegram long-poll so grammy stops handing us updates
    messageQueue.close();
    try {
      // bot.stop() also closes the long-poll connection, so no new updates
      // are pulled. Existing handlers continue (they're already inside the
      // queue's promise chains). We DON'T await it here because grammy's
      // stop is itself drain-style and would block us; fire-and-forget,
      // then await later as part of cleanup.
      void bot.stop();
    } catch (err) {
      logger.warn({ err }, 'bot.stop() threw during shutdown — continuing');
    }

    // STEP 2: Drain in-flight message handlers so the assistant's final
    // reply (Telegram send + DB commit) finishes before exit. Without
    // this a SIGTERM mid-reply (eg from `launchctl kickstart -k`) drops
    // the current message and orphans the user turn in conversation_log.
    // 30s ceiling — long enough to flush a long answer, short enough not
    // to hang launchd if a handler is genuinely stuck.
    try {
      const { drained, remaining } = await messageQueue.drain(30_000);
      if (!drained) {
        const activeChatIds = messageQueue.activeChatIds;
        logger.warn({ remaining, activeChatIds }, 'Shutdown drain timed out — handlers still pending, exiting anyway');
        for (const chatId of activeChatIds) {
          try {
            clearSession(chatId, AGENT_ID, normalizeLlmProvider(LLM_PROVIDER));
          } catch (err) {
            logger.error({ err, chatId, agentId: AGENT_ID }, 'Failed to clear resume session during shutdown');
          }
        }
        logger.warn(
          { activeChatIds, agentId: AGENT_ID },
          'Cleared resume sessions for undrained handlers to prevent stale Claude turn replay',
        );
      } else {
        logger.info('Shutdown drain complete — all handlers finished cleanly');
      }
    } catch (err) {
      logger.error({ err }, 'Shutdown drain threw — exiting anyway');
    }
    releaseLock();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  logger.info({ agentId: AGENT_ID }, 'Starting ClaudeClaw...');
  logger.info(
    {
      sha: shortSha(RUNTIME_BUILD_META.sha),
      builtAt: RUNTIME_BUILD_META.builtAt,
      branch: RUNTIME_BUILD_META.branch,
      pid: process.pid,
      agentId: AGENT_ID,
    },
    `ClaudeClaw starting | sha=${shortSha(RUNTIME_BUILD_META.sha)} | builtAt=${RUNTIME_BUILD_META.builtAt} | runtime PID=${process.pid}`,
  );

  // Stale-code watch: every 60s, compare the SHA we loaded at startup
  // against dist/.build-meta.json on disk. If they differ, the live
  // process is running stale in-memory bytes (b15c047 incident: fixes
  // were on disk but the running process kept the cached pre-fix code).
  // Notify ONCE per stale-window — debounced inside createStaleWatcher.
  // Auto-restart for sub-agents only; main is locked by CLAUDE.md and
  // would self-terminate the very supervisor that handles /restart.
  const staleWatcher = createStaleWatcher();
  // STALE_CODE_FALLBACK_MS: how long a stale-code outbox row may sit
  // unsent before we ALSO fprint a [STALE-CODE-FALLBACK] line to stderr
  // (visible in launchctl logs). Default 5min ≈ 2x the worst-case
  // dead-letter window. Defends against the scenario where the outbox
  // itself is broken (DB locked, table missing, sender worker dead) so
  // the alert never reaches Telegram and the agent silently runs stale.
  const STALE_CODE_FALLBACK_MS = parseInt(process.env.STALE_CODE_FALLBACK_MS ?? '300000', 10);
  const staleAlerter = ALLOWED_CHAT_ID
    ? createStaleCodeAlerter({
        enqueue: (text) => enqueueTelegramSend({
          agentId: AGENT_ID,
          chatId: ALLOWED_CHAT_ID,
          method: 'sendMessage',
          params: { text },
        }),
        getRow: getTelegramOutboxRow,
        fallbackMs: STALE_CODE_FALLBACK_MS,
      })
    : null;
  const staleInterval = setInterval(() => {
    // Sweep first — Codex HIGH #2: a previously-tracked outbox row may
    // be stuck unsent. The sweep emits the stderr fallback if so. We
    // call it on EVERY tick (not just when shouldNotify fires) because
    // shouldNotify is debounced by the watcher and would let stuck rows
    // rot indefinitely.
    if (staleAlerter) staleAlerter.sweep();

    const r = staleWatcher.tick();
    if (!r.stale) return;
    const diffMsg = `STALE_CODE_DETECTED runtime_sha=${shortSha(r.runtimeSha)} disk_sha=${shortSha(r.diskSha)}`;
    logger.warn(
      { runtimeSha: r.runtimeSha, diskSha: r.diskSha, agentId: AGENT_ID, suppressedReason: r.suppressedReason },
      diffMsg,
    );
    if (r.shouldNotify && staleAlerter) {
      const tag = AGENT_ID === 'main' ? 'main' : AGENT_ID;
      // staleAlerter handles BOTH paths:
      //   - normal: enqueue to durable outbox
      //   - fallback: if enqueue throws OR the previous row is still
      //     pending past STALE_CODE_FALLBACK_MS, fprint to stderr with
      //     [STALE-CODE-FALLBACK] prefix so launchctl logs surface it.
      // We deliberately do NOT direct-call bot.api.sendMessage — that's
      // the meta-recursion guard pattern (telegram-outbox dead-letters
      // only via stderr too).
      staleAlerter.notify(
        `[${tag} ⚠️] Stale code detected — runtime running ${shortSha(r.runtimeSha)}, disk has ${shortSha(r.diskSha)}. Run /restart to pick up changes.`,
      );
    }
    // Auto-restart for non-main agents is intentionally deferred —
    // Mission B/C/D may also touch the same launchctl path, and we
    // don't want overlapping restart logic landing in parallel.
  }, 60_000);
  // Don't keep the event loop alive on shutdown.
  staleInterval.unref?.();

  // Clear any existing webhook so polling works cleanly (e.g., if token was
  // previously used with a webhook-based bot or another ClaudeClaw instance).
  try {
    await bot.api.deleteWebhook({ drop_pending_updates: false });
  } catch (err) {
    logger.warn({ err }, 'Could not clear webhook (non-fatal)');
  }

  await bot.start({
    onStart: (botInfo) => {
      setTelegramConnected(true);
      setBotInfo(botInfo.username ?? '', botInfo.first_name ?? 'ClaudeClaw');
      logger.info({ username: botInfo.username }, 'ClaudeClaw is running');
      if (AGENT_ID === 'main') {
        console.log(`\n  ClaudeClaw online: @${botInfo.username}`);
        if (!ALLOWED_CHAT_ID) {
          console.log(`  Send /chatid to get your chat ID for ALLOWED_CHAT_ID`);
        }
        console.log();
      } else {
        console.log(`\n  ClaudeClaw agent [${AGENT_ID}] online: @${botInfo.username}\n`);
      }
    },
  });
}

main().catch((err: unknown) => {
  logger.error({ err }, 'Fatal error');
  releaseLock();
  process.exit(1);
});
