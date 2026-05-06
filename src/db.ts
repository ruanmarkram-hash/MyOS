import Database from 'better-sqlite3';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import { DB_ENCRYPTION_KEY, STORE_DIR } from './config.js';
import { cosineSimilarity, getCompatibleEmbeddingModelNames, getEmbeddingModelName } from './embeddings.js';
import { logger } from './logger.js';
import { buildMissionManifest, parseMissionManifest, type MissionManifest } from './mission-manifest.js';

// ── Field-Level Encryption (AES-256-GCM) ────────────────────────────
// All message bodies (WhatsApp, Slack) are encrypted before storage
// and decrypted on read. The key lives in .env (DB_ENCRYPTION_KEY).

let encryptionKey: Buffer | null = null;

function getEncryptionKey(): Buffer {
  if (encryptionKey) return encryptionKey;
  const hex = DB_ENCRYPTION_KEY;
  if (!hex || hex.length < 32) {
    throw new Error(
      'DB_ENCRYPTION_KEY is missing or too short. Run: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))" and add to .env',
    );
  }
  encryptionKey = Buffer.from(hex, 'hex');
  return encryptionKey;
}

/**
 * Encrypt a plaintext string with AES-256-GCM.
 * Returns a compact string: iv:authTag:ciphertext (all hex-encoded).
 */
export function encryptField(plaintext: string): string {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
}

/**
 * Decrypt a string produced by encryptField().
 * Returns the original plaintext. If decryption fails (wrong key, tampered),
 * returns the raw input unchanged (graceful fallback for pre-encryption data).
 */
export function decryptField(ciphertext: string): string {
  try {
    const parts = ciphertext.split(':');
    if (parts.length !== 3) return ciphertext; // Not encrypted, return as-is
    const [ivHex, authTagHex, dataHex] = parts;
    if (!ivHex || !authTagHex || !dataHex) return ciphertext;

    const key = getEncryptionKey();
    const iv = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(authTagHex, 'hex');
    const data = Buffer.from(dataHex, 'hex');

    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);
    const decrypted = Buffer.concat([decipher.update(data), decipher.final()]);
    return decrypted.toString('utf8');
  } catch {
    // Decryption failed: probably pre-encryption plaintext data
    return ciphertext;
  }
}

let db: Database.Database;

function createSchema(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS scheduled_tasks (
      id          TEXT PRIMARY KEY,
      prompt      TEXT NOT NULL,
      schedule    TEXT NOT NULL,
      next_run    INTEGER NOT NULL,
      last_run    INTEGER,
      last_result TEXT,
      status      TEXT NOT NULL DEFAULT 'active',
      created_at  INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_tasks_next_run ON scheduled_tasks(status, next_run);

    CREATE TABLE IF NOT EXISTS schema_state (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      chat_id    TEXT NOT NULL,
      agent_id   TEXT NOT NULL DEFAULT 'main',
      provider   TEXT NOT NULL DEFAULT 'claude',
      session_id TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (chat_id, agent_id, provider)
    );

    CREATE TABLE IF NOT EXISTS memories (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id       TEXT NOT NULL,
      source        TEXT NOT NULL DEFAULT 'conversation',
      raw_text      TEXT NOT NULL,
      summary       TEXT NOT NULL,
      entities      TEXT NOT NULL DEFAULT '[]',
      topics        TEXT NOT NULL DEFAULT '[]',
      connections   TEXT NOT NULL DEFAULT '[]',
      importance    REAL NOT NULL DEFAULT 0.5,
      salience      REAL NOT NULL DEFAULT 1.0,
      consolidated  INTEGER NOT NULL DEFAULT 0,
      embedding     TEXT,
      created_at    INTEGER NOT NULL,
      accessed_at   INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_memories_chat ON memories(chat_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS consolidations (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id       TEXT NOT NULL,
      source_ids    TEXT NOT NULL,
      summary       TEXT NOT NULL,
      insight       TEXT NOT NULL,
      created_at    INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_consolidations_chat ON consolidations(chat_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS wa_message_map (
      telegram_msg_id INTEGER PRIMARY KEY,
      wa_chat_id      TEXT NOT NULL,
      contact_name    TEXT NOT NULL,
      created_at      INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS wa_outbox (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      to_chat_id  TEXT NOT NULL,
      body        TEXT NOT NULL,
      created_at  INTEGER NOT NULL,
      sent_at     INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_wa_outbox_unsent ON wa_outbox(sent_at) WHERE sent_at IS NULL;

    CREATE TABLE IF NOT EXISTS wa_messages (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id      TEXT NOT NULL,
      contact_name TEXT NOT NULL,
      body         TEXT NOT NULL,
      timestamp    INTEGER NOT NULL,
      is_from_me   INTEGER NOT NULL DEFAULT 0,
      created_at   INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_wa_messages_chat ON wa_messages(chat_id, timestamp DESC);

    CREATE TABLE IF NOT EXISTS conversation_log (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id     TEXT NOT NULL,
      session_id  TEXT,
      role        TEXT NOT NULL,
      content     TEXT NOT NULL,
      created_at  INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_convo_log_chat ON conversation_log(chat_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS token_usage (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id         TEXT NOT NULL,
      session_id      TEXT,
      input_tokens    INTEGER NOT NULL DEFAULT 0,
      output_tokens   INTEGER NOT NULL DEFAULT 0,
      cache_read      INTEGER NOT NULL DEFAULT 0,
      context_tokens  INTEGER NOT NULL DEFAULT 0,
      cost_usd        REAL NOT NULL DEFAULT 0,
      did_compact     INTEGER NOT NULL DEFAULT 0,
      created_at      INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_token_usage_session ON token_usage(session_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_token_usage_chat ON token_usage(chat_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS slack_messages (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      channel_id   TEXT NOT NULL,
      channel_name TEXT NOT NULL,
      user_name    TEXT NOT NULL,
      body         TEXT NOT NULL,
      timestamp    TEXT NOT NULL,
      is_from_me   INTEGER NOT NULL DEFAULT 0,
      created_at   INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_slack_messages_channel ON slack_messages(channel_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS hive_mind (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id    TEXT NOT NULL,
      chat_id     TEXT NOT NULL,
      action      TEXT NOT NULL,
      summary     TEXT NOT NULL,
      artifacts   TEXT,
      created_at  INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_hive_mind_agent ON hive_mind(agent_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_hive_mind_time ON hive_mind(created_at DESC);

    CREATE TABLE IF NOT EXISTS inter_agent_tasks (
      id            TEXT PRIMARY KEY,
      from_agent    TEXT NOT NULL,
      to_agent      TEXT NOT NULL,
      chat_id       TEXT NOT NULL,
      prompt        TEXT NOT NULL,
      status        TEXT NOT NULL DEFAULT 'pending',
      result        TEXT,
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at  TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_inter_agent_tasks_status ON inter_agent_tasks(status, created_at DESC);

    CREATE TABLE IF NOT EXISTS mission_tasks (
      id              TEXT PRIMARY KEY,
      title           TEXT NOT NULL,
      prompt          TEXT NOT NULL,
      assigned_agent  TEXT,
      status          TEXT NOT NULL DEFAULT 'queued',
      result          TEXT,
      error           TEXT,
      created_by      TEXT NOT NULL DEFAULT 'dashboard',
      priority        INTEGER NOT NULL DEFAULT 0,
      created_at      INTEGER NOT NULL,
      started_at      INTEGER,
      completed_at    INTEGER,
      manifest_json   TEXT,
      notify_on_done  INTEGER NOT NULL DEFAULT 0,
      notified_at     INTEGER,
      delivered_at    INTEGER,
      notify_attempt_count INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_mission_status
      ON mission_tasks(assigned_agent, status, priority DESC, created_at ASC);

    CREATE TABLE IF NOT EXISTS mission_reviews (
      task_id          TEXT PRIMARY KEY,
      review_status    TEXT NOT NULL,
      resolution       TEXT,
      followup_task_id TEXT,
      instruction      TEXT,
      snoozed_until    INTEGER,
      reviewed_at      INTEGER,
      created_at       INTEGER NOT NULL,
      updated_at       INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_mission_reviews_status
      ON mission_reviews(review_status, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_mission_reviews_followup
      ON mission_reviews(followup_task_id);

    CREATE TABLE IF NOT EXISTS attention_items (
      id                TEXT PRIMARY KEY,
      source_kind       TEXT NOT NULL,
      source_id         TEXT NOT NULL,
      source_key        TEXT NOT NULL UNIQUE,
      title             TEXT NOT NULL,
      detail            TEXT NOT NULL,
      severity          TEXT NOT NULL,
      status            TEXT NOT NULL DEFAULT 'open',
      linked_mission_id TEXT,
      assigned_agent    TEXT,
      href              TEXT,
      created_at        INTEGER NOT NULL,
      updated_at        INTEGER NOT NULL,
      resolved_at       INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_attention_status
      ON attention_items(status, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_attention_source
      ON attention_items(source_kind, source_id);
    CREATE INDEX IF NOT EXISTS idx_attention_mission
      ON attention_items(linked_mission_id);

    CREATE TABLE IF NOT EXISTS meet_sessions (
      id              TEXT PRIMARY KEY,         -- session id from the provider's join response
      agent_id        TEXT NOT NULL,            -- which agent is in the meeting
      meet_url        TEXT NOT NULL,
      bot_name        TEXT NOT NULL,
      platform        TEXT NOT NULL DEFAULT 'google_meet',
      provider        TEXT NOT NULL DEFAULT 'pika',  -- pika (avatar) | recall (voice-only)
      status          TEXT NOT NULL DEFAULT 'joining', -- joining | live | left | failed
      voice_id        TEXT,
      image_path      TEXT,                     -- avatar image used for this session (pika only)
      brief_path      TEXT,                     -- path to the frozen system prompt file
      created_at      INTEGER NOT NULL,
      joined_at       INTEGER,
      left_at         INTEGER,
      post_notes      TEXT,                     -- post-meeting notes, fetched after leave
      error           TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_meet_status ON meet_sessions(status, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_meet_agent ON meet_sessions(agent_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS warroom_meetings (
      id          TEXT PRIMARY KEY,
      started_at  INTEGER NOT NULL,
      ended_at    INTEGER,
      duration_s  INTEGER,
      mode        TEXT NOT NULL DEFAULT 'direct',  -- direct | auto
      pinned_agent TEXT DEFAULT 'main',
      entry_count INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_warroom_meetings_time ON warroom_meetings(started_at DESC);

    CREATE TABLE IF NOT EXISTS warroom_transcript (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      meeting_id  TEXT NOT NULL,
      speaker     TEXT NOT NULL,     -- 'user' | agent id | 'system'
      text        TEXT NOT NULL,
      created_at  INTEGER NOT NULL,
      FOREIGN KEY (meeting_id) REFERENCES warroom_meetings(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_warroom_transcript_meeting ON warroom_transcript(meeting_id, created_at);

    CREATE TABLE IF NOT EXISTS audit_log (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id    TEXT NOT NULL DEFAULT 'main',
      chat_id     TEXT NOT NULL DEFAULT '',
      action      TEXT NOT NULL,
      detail      TEXT NOT NULL DEFAULT '',
      blocked     INTEGER NOT NULL DEFAULT 0,
      created_at  INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );
    CREATE INDEX IF NOT EXISTS idx_audit_time ON audit_log(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_audit_agent ON audit_log(agent_id, created_at DESC);

    CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
      summary,
      raw_text,
      entities,
      topics,
      content=memories,
      content_rowid=id
    );

    CREATE TRIGGER IF NOT EXISTS memories_fts_insert AFTER INSERT ON memories BEGIN
      INSERT INTO memories_fts(rowid, summary, raw_text, entities, topics)
        VALUES (new.id, new.summary, new.raw_text, new.entities, new.topics);
    END;

    CREATE TRIGGER IF NOT EXISTS memories_fts_delete AFTER DELETE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, summary, raw_text, entities, topics)
        VALUES ('delete', old.id, old.summary, old.raw_text, old.entities, old.topics);
    END;

    CREATE TRIGGER IF NOT EXISTS memories_fts_update AFTER UPDATE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, summary, raw_text, entities, topics)
        VALUES ('delete', old.id, old.summary, old.raw_text, old.entities, old.topics);
      INSERT INTO memories_fts(rowid, summary, raw_text, entities, topics)
        VALUES (new.id, new.summary, new.raw_text, new.entities, new.topics);
    END;

    -- Phase 2.4: Compaction event tracking
    CREATE TABLE IF NOT EXISTS compaction_events (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id  TEXT NOT NULL,
      pre_tokens  INTEGER NOT NULL DEFAULT 0,
      post_tokens INTEGER NOT NULL DEFAULT 0,
      turn_count  INTEGER NOT NULL DEFAULT 0,
      created_at  INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );
    CREATE INDEX IF NOT EXISTS idx_compaction_session ON compaction_events(session_id, created_at DESC);

    -- Phase 4.2: Skill health checks
    CREATE TABLE IF NOT EXISTS skill_health (
      skill_id    TEXT PRIMARY KEY,
      status      TEXT NOT NULL DEFAULT 'unchecked',
      error_msg   TEXT NOT NULL DEFAULT '',
      last_check  INTEGER NOT NULL DEFAULT 0,
      created_at  INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );

    -- Phase 4.3: Skill usage analytics
    CREATE TABLE IF NOT EXISTS skill_usage (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      skill_id    TEXT NOT NULL,
      chat_id     TEXT NOT NULL DEFAULT '',
      agent_id    TEXT NOT NULL DEFAULT 'main',
      triggered_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      tokens_used INTEGER NOT NULL DEFAULT 0,
      succeeded   INTEGER NOT NULL DEFAULT 1
    );
    CREATE INDEX IF NOT EXISTS idx_skill_usage_skill ON skill_usage(skill_id, triggered_at DESC);

    -- Telegram durable outbox: every Telegram send is queued here so a
    -- transient API failure (rate limit, network blip, Telegram outage)
    -- doesn't drop the message. A scheduler-driven worker drains pending
    -- rows with retries + dead-letter, the same model that mission-notify
    -- uses for delivery confirmation but generalised to ALL sends.
    CREATE TABLE IF NOT EXISTS telegram_outbox (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id            TEXT NOT NULL,
      chat_id             TEXT NOT NULL,
      payload             TEXT NOT NULL,
      status              TEXT NOT NULL DEFAULT 'pending',
      attempt_count       INTEGER NOT NULL DEFAULT 0,
      last_error          TEXT,
      last_attempt_at     INTEGER,
      next_retry_at       INTEGER,
      lease_expires_at    INTEGER,
      telegram_message_id INTEGER,
      created_at          INTEGER NOT NULL,
      sent_at             INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_telegram_outbox_pending
      ON telegram_outbox(status, next_retry_at);
    -- idx_telegram_outbox_inflight is created in the migration block below
    -- (after lease_expires_at is added to existing DBs).

    -- Phase 6.2: Session summaries
    CREATE TABLE IF NOT EXISTS session_summaries (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id  TEXT NOT NULL UNIQUE,
      summary     TEXT NOT NULL,
      key_decisions TEXT NOT NULL DEFAULT '[]',
      turn_count  INTEGER NOT NULL DEFAULT 0,
      total_cost  REAL NOT NULL DEFAULT 0,
      created_at  INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );

    -- Operation notifications: durable replacement for ScheduleWakeup.
    -- An agent can promise "I'll check back in X" by enqueuing a row here;
    -- the scheduler tick reads, fires, and stamps status='fired'. Survives
    -- the agent's session ending (unlike ScheduleWakeup, which is cancelled
    -- the moment the user replies).
    CREATE TABLE IF NOT EXISTS operation_notifications (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id      TEXT NOT NULL,
      chat_id       TEXT NOT NULL,
      operation_id  TEXT NOT NULL,
      fire_at       INTEGER NOT NULL,
      status        TEXT NOT NULL DEFAULT 'pending',
      payload       TEXT NOT NULL,
      fired_at      INTEGER,
      cancelled_at  INTEGER,
      created_at    INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_op_notifications_pending
      ON operation_notifications(status, fire_at);
    CREATE INDEX IF NOT EXISTS idx_op_notifications_op
      ON operation_notifications(operation_id);

    -- Agent file edit history (Phase C1.a). Every successful save of a
    -- gated agent file (initially just /HQ/CLAUDE.md, expands in C1.b)
    -- appends a row here so we can revert from the dashboard and audit
    -- who-changed-what. file_path is the user-facing logical path; real_path
    -- is the post-realpath() absolute path written to disk (matters once
    -- C1.b adds symlink-resolved per-agent files).
    CREATE TABLE IF NOT EXISTS agent_file_history (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      file_path          TEXT NOT NULL,
      real_path          TEXT NOT NULL,
      content            TEXT NOT NULL,
      content_sha        TEXT NOT NULL,
      edited_by_chat_id  TEXT,
      created_at         INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_agent_file_history_path_time
      ON agent_file_history(file_path, created_at DESC);
  `);
}

export interface AgentFileHistoryRow {
  id: number;
  file_path: string;
  real_path: string;
  content: string;
  content_sha: string;
  edited_by_chat_id: string | null;
  created_at: number;
}

/**
 * Append a row to agent_file_history. Returns the inserted row id.
 * Caller is responsible for sha computation so the value stored here
 * matches the bytes actually written to disk (atomic-write boundary).
 */
export function appendAgentFileHistory(row: {
  filePath: string;
  realPath: string;
  content: string;
  contentSha: string;
  editedByChatId?: string | null;
}): number {
  // Encrypt content at rest. CLAUDE.md may contain operational rules,
  // endpoints, kill-switch logic, or chat IDs. Same pattern as message stores.
  // content_sha stays plaintext so the listing endpoint can show version IDs.
  const now = Math.floor(Date.now() / 1000);
  const result = db
    .prepare(
      `INSERT INTO agent_file_history
         (file_path, real_path, content, content_sha, edited_by_chat_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      row.filePath,
      row.realPath,
      encryptField(row.content),
      row.contentSha,
      row.editedByChatId ?? null,
      now,
    );
  return Number(result.lastInsertRowid);
}

/** Most-recent-first history for a single file_path. Decrypts content on read. */
export function listAgentFileHistory(filePath: string, limit = 50): AgentFileHistoryRow[] {
  const rows = db
    .prepare(
      `SELECT id, file_path, real_path, content, content_sha, edited_by_chat_id, created_at
         FROM agent_file_history
        WHERE file_path = ?
        ORDER BY created_at DESC, id DESC
        LIMIT ?`,
    )
    .all(filePath, limit) as AgentFileHistoryRow[];
  return rows.map((r) => ({
    ...r,
    content: decryptField(r.content),
  }));
}

export function initDatabase(): void {
  fs.mkdirSync(STORE_DIR, { recursive: true });
  const dbPath = path.join(STORE_DIR, 'claudeclaw.db');

  // Validate encryption key is available before proceeding
  getEncryptionKey();

  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  createSchema(db);
  runMigrations(db);

  // Restrict database file permissions (owner-only read/write)
  try {
    for (const suffix of ['', '-wal', '-shm']) {
      const f = dbPath + suffix;
      if (fs.existsSync(f)) fs.chmodSync(f, 0o600);
    }
    fs.chmodSync(STORE_DIR, 0o700);
  } catch { /* non-fatal on platforms that don't support chmod */ }
}

/** Add columns that may not exist in older databases.
 * @internal — exported for migration upgrade tests.
 */
export function _runMigrations(database: Database.Database): void {
  return runMigrations(database);
}

/** Add columns that may not exist in older databases. */
function runMigrations(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_state (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  // Add context_tokens column to token_usage (introduced for accurate context tracking)
  const cols = database.prepare(`PRAGMA table_info(token_usage)`).all() as Array<{ name: string }>;
  const hasContextTokens = cols.some((c) => c.name === 'context_tokens');
  if (!hasContextTokens) {
    database.exec(`ALTER TABLE token_usage ADD COLUMN context_tokens INTEGER NOT NULL DEFAULT 0`);
  }

  // Multi-agent and multi-provider: sessions are isolated by chat, agent,
  // and provider. Existing unscoped sessions were created before provider
  // switching existed, so preserve continuity by treating them as Claude
  // sessions. A one-shot repair also normalises any rows produced by the
  // short-lived guessed-provider migration before this marker existed.
  const migrateSessions = (): void => {
    database.exec('BEGIN IMMEDIATE');
    try {
      const marker = database
        .prepare(`SELECT value FROM schema_state WHERE key = ?`)
        .get('sessions_provider_scope_v2') as { value: string } | undefined;
      if (marker?.value === 'complete') {
        database.exec('COMMIT');
        return;
      }

      const sessionCols = database.prepare(`PRAGMA table_info(sessions)`).all() as Array<{ name: string; pk: number }>;
      const hasSessionAgentId = sessionCols.some((c) => c.name === 'agent_id');
      const hasSessionProvider = sessionCols.some((c) => c.name === 'provider');
      const pkCount = sessionCols.filter((c) => c.pk > 0).length;
      const tempTable = `sessions_new_${process.pid}_${Date.now()}`;
      const agentExpr = hasSessionAgentId ? `COALESCE(agent_id, 'main')` : `'main'`;
      const providerExpr = hasSessionProvider ? `COALESCE(provider, 'claude')` : `'claude'`;

      database.exec(`
        CREATE TABLE ${tempTable} (
          chat_id    TEXT NOT NULL,
          agent_id   TEXT NOT NULL DEFAULT 'main',
          provider   TEXT NOT NULL DEFAULT 'claude',
          session_id TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (chat_id, agent_id, provider)
        );
      `);

      if (!hasSessionAgentId || !hasSessionProvider || pkCount < 3) {
        database.exec(`
          INSERT OR IGNORE INTO ${tempTable} (chat_id, agent_id, provider, session_id, updated_at)
            SELECT chat_id, ${agentExpr}, ${providerExpr}, session_id, updated_at FROM sessions;
          DROP TABLE sessions;
          ALTER TABLE ${tempTable} RENAME TO sessions;
        `);
      } else {
        database.exec(`
          INSERT OR IGNORE INTO ${tempTable} (chat_id, agent_id, provider, session_id, updated_at)
            SELECT chat_id, agent_id,
              CASE
                WHEN provider = 'legacy' THEN 'claude'
                WHEN provider = 'codex'
                  AND session_id NOT LIKE '019_____-____-____-____-____________'
                  THEN 'claude'
                ELSE COALESCE(provider, 'claude')
              END,
              session_id, updated_at
            FROM sessions
            ORDER BY CASE provider WHEN 'claude' THEN 0 ELSE 1 END;
          DROP TABLE sessions;
          ALTER TABLE ${tempTable} RENAME TO sessions;
        `);
      }

      database
        .prepare(`INSERT OR REPLACE INTO schema_state (key, value) VALUES (?, ?)`)
        .run('sessions_provider_scope_v2', 'complete');
      database.exec('COMMIT');
    } catch (err) {
      try { database.exec('ROLLBACK'); } catch { /* ignore */ }
      throw err;
    }
  };
  migrateSessions();

  const taskCols = database.prepare(`PRAGMA table_info(scheduled_tasks)`).all() as Array<{ name: string }>;
  if (!taskCols.some((c) => c.name === 'agent_id')) {
    database.exec(`ALTER TABLE scheduled_tasks ADD COLUMN agent_id TEXT NOT NULL DEFAULT 'main'`);
  }

  const usageCols = database.prepare(`PRAGMA table_info(token_usage)`).all() as Array<{ name: string }>;
  if (!usageCols.some((c) => c.name === 'agent_id')) {
    database.exec(`ALTER TABLE token_usage ADD COLUMN agent_id TEXT NOT NULL DEFAULT 'main'`);
  }

  const convoCols = database.prepare(`PRAGMA table_info(conversation_log)`).all() as Array<{ name: string }>;
  if (!convoCols.some((c) => c.name === 'agent_id')) {
    database.exec(`ALTER TABLE conversation_log ADD COLUMN agent_id TEXT NOT NULL DEFAULT 'main'`);
  }

  // Task state machine: add started_at and last_status columns
  const taskColNames = taskCols.map((c) => c.name);
  if (!taskColNames.includes('started_at')) {
    database.exec(`ALTER TABLE scheduled_tasks ADD COLUMN started_at INTEGER`);
  }
  if (!taskColNames.includes('last_status')) {
    database.exec(`ALTER TABLE scheduled_tasks ADD COLUMN last_status TEXT`);
  }
  if (!taskColNames.includes('model')) {
    database.exec(`ALTER TABLE scheduled_tasks ADD COLUMN model TEXT`);
  }
  if (!taskColNames.includes('silent')) {
    database.exec(`ALTER TABLE scheduled_tasks ADD COLUMN silent INTEGER NOT NULL DEFAULT 0`);
  }

  // Mission tasks: add model column for per-task model selection
  const missionColNames = (database.prepare(`PRAGMA table_info(mission_tasks)`).all() as Array<{ name: string }>).map((c) => c.name);
  if (missionColNames.length > 0 && !missionColNames.includes('model')) {
    database.exec(`ALTER TABLE mission_tasks ADD COLUMN model TEXT`);
  }
  if (missionColNames.length > 0 && !missionColNames.includes('manifest_json')) {
    database.exec(`ALTER TABLE mission_tasks ADD COLUMN manifest_json TEXT`);
  }
  // Mission tasks: --notify-on-done flag + notified_at timestamp (idempotency guard)
  if (missionColNames.length > 0 && !missionColNames.includes('notify_on_done')) {
    database.exec(`ALTER TABLE mission_tasks ADD COLUMN notify_on_done INTEGER NOT NULL DEFAULT 0`);
  }
  if (missionColNames.length > 0 && !missionColNames.includes('notified_at')) {
    database.exec(`ALTER TABLE mission_tasks ADD COLUMN notified_at INTEGER`);
  }
  // Mission tasks: durability split (locked 2026-05-04).
  //   - notified_at = claim timestamp (set BEFORE spawn so concurrent fires bail)
  //   - delivered_at = confirmed delivery (set ONLY after notify.sh exits 0
  //     AND Telegram returns ok:true). The recovery sweep filters on
  //     delivered_at IS NULL so a crash between claim and delivery is
  //     recoverable. notify_attempt_count caps retries so a permanently
  //     broken row doesn't loop forever.
  if (missionColNames.length > 0 && !missionColNames.includes('delivered_at')) {
    database.exec(`ALTER TABLE mission_tasks ADD COLUMN delivered_at INTEGER`);
  }
  if (missionColNames.length > 0 && !missionColNames.includes('notify_attempt_count')) {
    database.exec(`ALTER TABLE mission_tasks ADD COLUMN notify_attempt_count INTEGER NOT NULL DEFAULT 0`);
  }

  database.exec(`
    CREATE TABLE IF NOT EXISTS mission_reviews (
      task_id          TEXT PRIMARY KEY,
      review_status    TEXT NOT NULL,
      resolution       TEXT,
      followup_task_id TEXT,
      instruction      TEXT,
      snoozed_until    INTEGER,
      reviewed_at      INTEGER,
      created_at       INTEGER NOT NULL,
      updated_at       INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_mission_reviews_status
      ON mission_reviews(review_status, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_mission_reviews_followup
      ON mission_reviews(followup_task_id);
  `);

  database.exec(`
    CREATE TABLE IF NOT EXISTS attention_items (
      id                TEXT PRIMARY KEY,
      source_kind       TEXT NOT NULL,
      source_id         TEXT NOT NULL,
      source_key        TEXT NOT NULL UNIQUE,
      title             TEXT NOT NULL,
      detail            TEXT NOT NULL,
      severity          TEXT NOT NULL,
      status            TEXT NOT NULL DEFAULT 'open',
      linked_mission_id TEXT,
      assigned_agent    TEXT,
      href              TEXT,
      created_at        INTEGER NOT NULL,
      updated_at        INTEGER NOT NULL,
      resolved_at       INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_attention_status
      ON attention_items(status, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_attention_source
      ON attention_items(source_kind, source_id);
    CREATE INDEX IF NOT EXISTS idx_attention_mission
      ON attention_items(linked_mission_id);
  `);

  // ── Memory V2 migration ──────────────────────────────────────────────
  // Detect old schema (has 'sector' column but no 'importance') and migrate.
  const memCols = database.prepare(`PRAGMA table_info(memories)`).all() as Array<{ name: string }>;
  const memColNames = memCols.map((c) => c.name);
  const isOldSchema = memColNames.includes('sector') && !memColNames.includes('importance');

  if (isOldSchema) {
    database.exec(`
      -- Drop old FTS triggers first
      DROP TRIGGER IF EXISTS memories_fts_insert;
      DROP TRIGGER IF EXISTS memories_fts_delete;
      DROP TRIGGER IF EXISTS memories_fts_update;

      -- Drop old FTS table
      DROP TABLE IF EXISTS memories_fts;

      -- Drop old indexes (they'll conflict with new table's indexes)
      DROP INDEX IF EXISTS idx_memories_chat;
      DROP INDEX IF EXISTS idx_memories_sector;

      -- Backup old memories table
      ALTER TABLE memories RENAME TO memories_v1_backup;

      -- Create new memories table
      CREATE TABLE memories (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id       TEXT NOT NULL,
        source        TEXT NOT NULL DEFAULT 'conversation',
        raw_text      TEXT NOT NULL,
        summary       TEXT NOT NULL,
        entities      TEXT NOT NULL DEFAULT '[]',
        topics        TEXT NOT NULL DEFAULT '[]',
        connections   TEXT NOT NULL DEFAULT '[]',
        importance    REAL NOT NULL DEFAULT 0.5,
        salience      REAL NOT NULL DEFAULT 1.0,
        consolidated  INTEGER NOT NULL DEFAULT 0,
        embedding     TEXT,
        created_at    INTEGER NOT NULL,
        accessed_at   INTEGER NOT NULL
      );

      CREATE INDEX idx_memories_chat ON memories(chat_id, created_at DESC);
      CREATE INDEX idx_memories_importance ON memories(chat_id, importance DESC);
      CREATE INDEX idx_memories_unconsolidated ON memories(chat_id, consolidated);

      -- Create consolidations table
      CREATE TABLE IF NOT EXISTS consolidations (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id       TEXT NOT NULL,
        source_ids    TEXT NOT NULL,
        summary       TEXT NOT NULL,
        insight       TEXT NOT NULL,
        created_at    INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_consolidations_chat ON consolidations(chat_id, created_at DESC);

      -- Create new FTS table
      CREATE VIRTUAL TABLE memories_fts USING fts5(
        summary,
        raw_text,
        entities,
        topics,
        content=memories,
        content_rowid=id
      );

      -- Create new triggers
      CREATE TRIGGER memories_fts_insert AFTER INSERT ON memories BEGIN
        INSERT INTO memories_fts(rowid, summary, raw_text, entities, topics)
          VALUES (new.id, new.summary, new.raw_text, new.entities, new.topics);
      END;

      CREATE TRIGGER memories_fts_delete AFTER DELETE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, summary, raw_text, entities, topics)
          VALUES ('delete', old.id, old.summary, old.raw_text, old.entities, old.topics);
      END;

      CREATE TRIGGER memories_fts_update AFTER UPDATE OF summary, raw_text, entities, topics ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, summary, raw_text, entities, topics)
          VALUES ('delete', old.id, old.summary, old.raw_text, old.entities, old.topics);
        INSERT INTO memories_fts(rowid, summary, raw_text, entities, topics)
          VALUES (new.id, new.summary, new.raw_text, new.entities, new.topics);
      END;
    `);
    logger.info('Memory V2 migration: backed up old memories, created new schema');
  }

  // Ensure memory V2 indexes exist (covers both migrated and fresh installs)
  const memColsPost = database.prepare(`PRAGMA table_info(memories)`).all() as Array<{ name: string }>;
  if (memColsPost.some((c) => c.name === 'importance')) {
    database.exec(`
      CREATE INDEX IF NOT EXISTS idx_memories_importance ON memories(chat_id, importance DESC);
      CREATE INDEX IF NOT EXISTS idx_memories_unconsolidated ON memories(chat_id, consolidated);
    `);
  }

  // Add embedding column if missing (V2 tables created before embedding support)
  if (memColsPost.some((c) => c.name === 'importance') && !memColsPost.some((c) => c.name === 'embedding')) {
    database.exec(`ALTER TABLE memories ADD COLUMN embedding TEXT`);
    logger.info('Migration: added embedding column to memories table');
  }

  // Hive Mind V2: Add agent_id to memories for attribution
  if (!memColsPost.some((c: { name: string }) => c.name === 'agent_id')) {
    database.exec(`ALTER TABLE memories ADD COLUMN agent_id TEXT NOT NULL DEFAULT 'main'`);
    logger.info('Migration: added agent_id column to memories table');
  }

  // Hive Mind V2: Add embedding + model tracking to consolidations
  const consolCols = database.prepare('PRAGMA table_info(consolidations)').all() as Array<{ name: string }>;
  if (!consolCols.some((c) => c.name === 'embedding')) {
    database.exec(`ALTER TABLE consolidations ADD COLUMN embedding TEXT`);
    logger.info('Migration: added embedding column to consolidations table');
  }
  if (!consolCols.some((c) => c.name === 'embedding_model')) {
    database.exec(`ALTER TABLE consolidations ADD COLUMN embedding_model TEXT DEFAULT 'embedding-001'`);
  }

  // Add embedding_model to memories too (future-proofing)
  if (!memColsPost.some((c: { name: string }) => c.name === 'embedding_model')) {
    database.exec(`ALTER TABLE memories ADD COLUMN embedding_model TEXT DEFAULT 'embedding-001'`);
  }

  // Hive Mind V2: Fix FTS5 update trigger to only fire on content column changes.
  // The old trigger fires on every UPDATE (including salience/importance-only changes),
  // causing massive write amplification during decay sweeps.
  const triggerCheck = database.prepare(
    `SELECT sql FROM sqlite_master WHERE type='trigger' AND name='memories_fts_update'`,
  ).get() as { sql: string } | undefined;
  if (triggerCheck?.sql && !triggerCheck.sql.includes('UPDATE OF')) {
    database.exec(`
      DROP TRIGGER IF EXISTS memories_fts_update;
      CREATE TRIGGER memories_fts_update AFTER UPDATE OF summary, raw_text, entities, topics ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, summary, raw_text, entities, topics)
          VALUES ('delete', old.id, old.summary, old.raw_text, old.entities, old.topics);
        INSERT INTO memories_fts(rowid, summary, raw_text, entities, topics)
          VALUES (new.id, new.summary, new.raw_text, new.entities, new.topics);
      END;
    `);
    logger.info('Migration: restricted FTS5 update trigger to content columns only');
  }

  // Hive Mind V2: Add superseded_by for contradiction resolution
  if (!memColsPost.some((c: { name: string }) => c.name === 'superseded_by')) {
    database.exec(`ALTER TABLE memories ADD COLUMN superseded_by INTEGER REFERENCES memories(id)`);
    logger.info('Migration: added superseded_by column to memories table');
  }

  // Hive Mind V2: Add pinned flag for permanent memories that never decay.
  // Memories are only pinned explicitly by the user ("remember this permanently")
  // or via /pin command. No auto-pinning: the user controls what's permanent.
  if (!memColsPost.some((c: { name: string }) => c.name === 'pinned')) {
    database.exec(`ALTER TABLE memories ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0`);
    logger.info('Migration: added pinned column to memories table');
  }

  // Mission Control: migrate assigned_agent from NOT NULL to nullable (allow unassigned tasks).
  //
  // Ordering note: this rebuild runs AFTER additive migrations above (model,
  // notify_on_done, notified_at). The old version did `INSERT INTO ... SELECT *`
  // which broke once `mission_tasks` carried the additive columns but the
  // _new table didn't. Fix: include the additive columns in the rebuild
  // schema and use an explicit column list so the copy is order-independent
  // and survives any future additive migration that runs above this block.
  const missionCols = database.prepare(`PRAGMA table_info(mission_tasks)`).all() as Array<{ name: string; notnull: number }>;
  const assignedCol = missionCols.find((c) => c.name === 'assigned_agent');
  if (assignedCol && assignedCol.notnull === 1) {
    database.exec(`
      CREATE TABLE mission_tasks_new (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, prompt TEXT NOT NULL,
        assigned_agent TEXT, status TEXT NOT NULL DEFAULT 'queued',
        result TEXT, error TEXT, created_by TEXT NOT NULL DEFAULT 'dashboard',
        priority INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL,
        started_at INTEGER, completed_at INTEGER,
        manifest_json TEXT,
        model TEXT,
        notify_on_done INTEGER NOT NULL DEFAULT 0,
        notified_at INTEGER,
        delivered_at INTEGER,
        notify_attempt_count INTEGER NOT NULL DEFAULT 0
      );
      INSERT INTO mission_tasks_new
        (id, title, prompt, assigned_agent, status, result, error, created_by,
         priority, created_at, started_at, completed_at,
         manifest_json, model, notify_on_done, notified_at, delivered_at, notify_attempt_count)
      SELECT
        id, title, prompt, assigned_agent, status, result, error, created_by,
        priority, created_at, started_at, completed_at,
        manifest_json, model, notify_on_done, notified_at, delivered_at, notify_attempt_count
      FROM mission_tasks;
      DROP TABLE mission_tasks;
      ALTER TABLE mission_tasks_new RENAME TO mission_tasks;
      CREATE INDEX IF NOT EXISTS idx_mission_status
        ON mission_tasks(assigned_agent, status, priority DESC, created_at ASC);
    `);
    logger.info('Migration: made mission_tasks.assigned_agent nullable');
  }

  // Telegram outbox: add lease_expires_at for in-flight claim leases.
  // Workers atomically CAS pending → in_flight with a lease; a sweep
  // resets in_flight rows whose lease has expired (worker died mid-send).
  const outboxCols = database.prepare(`PRAGMA table_info(telegram_outbox)`).all() as Array<{ name: string }>;
  if (outboxCols.length > 0 && !outboxCols.some((c) => c.name === 'lease_expires_at')) {
    database.exec(`ALTER TABLE telegram_outbox ADD COLUMN lease_expires_at INTEGER`);
    logger.info('Migration: added lease_expires_at to telegram_outbox');
  }
  // Idempotent: covers fresh DBs (column created in schema) and migrated DBs (column just added above).
  if (outboxCols.length > 0) {
    database.exec(`CREATE INDEX IF NOT EXISTS idx_telegram_outbox_inflight ON telegram_outbox(status, lease_expires_at)`);
  }

  // Live Meetings: add provider column so we can track which platform
  // each session used (pika avatar vs recall voice-only). Default 'pika'
  // for existing rows so historical data keeps the right label.
  const meetCols = database.prepare(`PRAGMA table_info(meet_sessions)`).all() as Array<{ name: string }>;
  if (meetCols.length > 0 && !meetCols.some((c) => c.name === 'provider')) {
    database.exec(`ALTER TABLE meet_sessions ADD COLUMN provider TEXT NOT NULL DEFAULT 'pika'`);
    logger.info('Migration: added provider column to meet_sessions');
  }
}

/** @internal - exported for migration upgrade tests. */
export function _createSchema(database: Database.Database): void {
  return createSchema(database);
}

/** @internal - exported for migration upgrade tests. */
export function _runMigrationsForTest(database: Database.Database): void {
  return runMigrations(database);
}

/** @internal - for tests only. Creates a fresh in-memory database. */
export function _initTestDatabase(): void {
  // Use a test encryption key for field-level encryption
  encryptionKey = crypto.randomBytes(32);
  db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  createSchema(db);
  runMigrations(db);
}

/**
 * @internal — test-only handle to the active DB so atomicity tests can
 * inject controlled failure modes (e.g. drop a table mid-transaction to
 * verify rollback). Production code MUST NOT import this; it bypasses
 * every safety the regular API provides.
 *
 * Hard-guarded against accidental production import: throws unless we're
 * running under Vitest. Caught in Codex review of ee63a3b — left
 * unprotected, anyone could `import { _testDbHandle }` and bypass the
 * DDL-stable API surface.
 */
export function _testDbHandle(): Database.Database {
  // Vitest sets VITEST=true and process.env.VITEST_WORKER_ID in worker
  // processes. Either signal is sufficient.
  const inVitest = process.env.VITEST === 'true' || !!process.env.VITEST_WORKER_ID;
  if (!inVitest) {
    throw new Error(
      '_testDbHandle is test-only and refuses to run outside Vitest. ' +
      'Production code MUST NOT import this — it bypasses every safety ' +
      'the regular DB API provides.',
    );
  }
  return db;
}

export function getSession(chatId: string, agentId = 'main', provider = 'claude'): string | undefined {
  const row = db
    .prepare('SELECT session_id FROM sessions WHERE chat_id = ? AND agent_id = ? AND provider = ?')
    .get(chatId, agentId, provider) as { session_id: string } | undefined;
  return row?.session_id;
}

export function setSession(chatId: string, sessionId: string, agentId = 'main', provider = 'claude'): void {
  db.prepare(
    'INSERT OR REPLACE INTO sessions (chat_id, agent_id, provider, session_id, updated_at) VALUES (?, ?, ?, ?, ?)',
  ).run(chatId, agentId, provider, sessionId, new Date().toISOString());
}

export function clearSession(chatId: string, agentId = 'main', provider = 'claude'): void {
  db.prepare('DELETE FROM sessions WHERE chat_id = ? AND agent_id = ? AND provider = ?').run(chatId, agentId, provider);
}

export function clearAllSessions(chatId: string, agentId = 'main'): void {
  db.prepare('DELETE FROM sessions WHERE chat_id = ? AND agent_id = ?').run(chatId, agentId);
}

// ── Memory (V2: structured with LLM extraction) ────────────────────

export interface Memory {
  id: number;
  chat_id: string;
  source: string;
  agent_id: string;
  raw_text: string;
  summary: string;
  entities: string;    // JSON array
  topics: string;      // JSON array
  connections: string; // JSON array
  importance: number;
  salience: number;
  consolidated: number;
  pinned: number;      // 1 = permanent, never decays
  embedding: string | null; // JSON array of floats
  created_at: number;
  accessed_at: number;
}

export interface Consolidation {
  id: number;
  chat_id: string;
  source_ids: string;  // JSON array of memory IDs
  summary: string;
  insight: string;
  created_at: number;
  embedding?: string;
  embedding_model?: string;
}

export function saveStructuredMemory(
  chatId: string,
  rawText: string,
  summary: string,
  entities: string[],
  topics: string[],
  importance: number,
  source = 'conversation',
  agentId = 'main',
): number {
  const now = Math.floor(Date.now() / 1000);
  const result = db.prepare(
    `INSERT INTO memories (chat_id, source, raw_text, summary, entities, topics, importance, agent_id, created_at, accessed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    chatId,
    source,
    rawText,
    summary,
    JSON.stringify(entities),
    JSON.stringify(topics),
    importance,
    agentId,
    now,
    now,
  );
  return result.lastInsertRowid as number;
}

export function memoryExistsBySourceAndSummary(chatId: string, source: string, summary: string): boolean {
  const row = db.prepare(
    `SELECT 1 FROM memories WHERE chat_id = ? AND source = ? AND summary = ? LIMIT 1`,
  ).get(chatId, source, summary) as { 1: number } | undefined;
  return !!row;
}

const STOP_WORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'shall', 'can', 'need', 'dare', 'ought',
  'used', 'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by', 'from',
  'as', 'into', 'through', 'during', 'before', 'after', 'above', 'below',
  'between', 'out', 'off', 'over', 'under', 'again', 'further', 'then',
  'once', 'here', 'there', 'when', 'where', 'why', 'how', 'all', 'each',
  'every', 'both', 'few', 'more', 'most', 'other', 'some', 'such', 'no',
  'nor', 'not', 'only', 'own', 'same', 'so', 'than', 'too', 'very',
  'just', 'because', 'but', 'and', 'or', 'if', 'while', 'about',
  'what', 'which', 'who', 'whom', 'this', 'that', 'these', 'those',
  'am', 'it', 'its', 'my', 'me', 'we', 'our', 'you', 'your', 'he',
  'him', 'his', 'she', 'her', 'they', 'them', 'their', 'i', 'up',
  'down', 'get', 'got', 'like', 'make', 'know', 'think', 'take',
  'come', 'go', 'see', 'look', 'find', 'give', 'tell', 'say',
  'much', 'many', 'well', 'also', 'back', 'use', 'way',
  'feel', 'mark', 'marks', 'does', 'how',
]);

/**
 * Extract meaningful keywords from a query, stripping stop words and short tokens.
 */
function extractKeywords(query: string): string[] {
  return query
    .replace(/[""]/g, '"')
    .replace(/[^\w\s]/g, '')
    .toLowerCase()
    .trim()
    .split(/\s+/)
    .filter((w) => w.length >= 2 && !STOP_WORDS.has(w));
}

/**
 * Search memories using embedding similarity (primary) with FTS5/LIKE fallback.
 * The queryEmbedding parameter is optional; if provided, vector search is used first.
 * If not provided (or no embeddings in DB), falls back to keyword search.
 */
export function searchMemories(
  chatId: string,
  query: string,
  limit = 5,
  queryEmbedding?: number[],
): Memory[] {
  // Strategy 1: Vector similarity search (if embedding provided)
  if (queryEmbedding && queryEmbedding.length > 0) {
    const candidates = getMemoriesWithEmbeddings(chatId);
    if (candidates.length > 0) {
      const scored = candidates
        .map((c) => ({ id: c.id, score: cosineSimilarity(queryEmbedding, c.embedding) }))
        .filter((s) => s.score > 0.3) // minimum similarity threshold
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);

      if (scored.length > 0) {
        const ids = scored.map((s) => s.id);
        const placeholders = ids.map(() => '?').join(',');
        const rows = db
          .prepare(`SELECT * FROM memories WHERE id IN (${placeholders}) AND superseded_by IS NULL`)
          .all(...ids) as Memory[];
        // Preserve similarity-score ordering (SQL IN doesn't guarantee order)
        const rowMap = new Map(rows.map((r) => [r.id, r]));
        return ids.map((id) => rowMap.get(id)).filter(Boolean) as Memory[];
      }
    }
  }

  // Strategy 2: FTS5 keyword search with OR
  const keywords = extractKeywords(query);
  if (keywords.length === 0) return [];

  // Strip double-quotes from each keyword before wrapping it as an FTS5
  // phrase. Without this, a keyword like `"foo` would produce the
  // malformed fragment `""foo"*` and FTS5 would either error out or, in
  // the worst case, interpret attacker-controlled characters as query
  // operators. Belt-and-braces on top of extractKeywords' own filtering.
  const ftsQuery = keywords.map((w) => `"${w.replace(/"/g, '')}"*`).join(' OR ');
  let results = db
    .prepare(
      `SELECT memories.* FROM memories
       JOIN memories_fts ON memories.id = memories_fts.rowid
       WHERE memories_fts MATCH ? AND memories.chat_id = ? AND memories.superseded_by IS NULL
       ORDER BY rank
       LIMIT ?`,
    )
    .all(ftsQuery, chatId, limit) as Memory[];

  if (results.length > 0) return results;

  // Strategy 3: LIKE fallback on summary + entities + topics
  const likeConditions = keywords.map(() =>
    `(summary LIKE ? OR entities LIKE ? OR topics LIKE ? OR raw_text LIKE ?)`,
  ).join(' OR ');
  const likeParams: string[] = [];
  for (const kw of keywords) {
    const pattern = `%${kw}%`;
    likeParams.push(pattern, pattern, pattern, pattern);
  }

  results = db
    .prepare(
      `SELECT * FROM memories
       WHERE chat_id = ? AND superseded_by IS NULL AND (${likeConditions})
       ORDER BY importance DESC, accessed_at DESC
       LIMIT ?`,
    )
    .all(chatId, ...likeParams, limit) as Memory[];

  return results;
}

export function saveMemoryEmbedding(memoryId: number, embedding: number[]): void {
  db.prepare('UPDATE memories SET embedding = ?, embedding_model = ? WHERE id = ?')
    .run(JSON.stringify(embedding), getEmbeddingModelName(), memoryId);
}

/**
 * Atomically save a structured memory and its embedding in a single transaction.
 * If either step fails, both are rolled back.
 */
export function saveStructuredMemoryAtomic(
  chatId: string,
  rawText: string,
  summary: string,
  entities: string[],
  topics: string[],
  importance: number,
  embedding: number[],
  source = 'conversation',
  agentId = 'main',
): number {
  const txn = db.transaction(() => {
    const memoryId = saveStructuredMemory(chatId, rawText, summary, entities, topics, importance, source, agentId);
    if (embedding.length > 0) {
      saveMemoryEmbedding(memoryId, embedding);
    }
    return memoryId;
  });
  return txn();
}

export function getMemoriesWithEmbeddings(chatId: string): Array<{ id: number; embedding: number[]; summary: string; importance: number }> {
  const models = getCompatibleEmbeddingModelNames();
  const placeholders = models.map(() => '?').join(',');
  const rows = db
    .prepare(`SELECT id, embedding, summary, importance FROM memories WHERE chat_id = ? AND embedding IS NOT NULL AND superseded_by IS NULL AND embedding_model IN (${placeholders})`)
    .all(chatId, ...models) as Array<{ id: number; embedding: string; summary: string; importance: number }>;
  return rows.map((r) => ({
    id: r.id,
    embedding: JSON.parse(r.embedding) as number[],
    summary: r.summary,
    importance: r.importance,
  }));
}

export function getRecentHighImportanceMemories(chatId: string, limit = 5): Memory[] {
  return db
    .prepare(
      `SELECT * FROM memories WHERE chat_id = ? AND importance >= 0.5
       ORDER BY accessed_at DESC LIMIT ?`,
    )
    .all(chatId, limit) as Memory[];
}

export function getRecentMemories(chatId: string, limit = 5): Memory[] {
  return db
    .prepare(
      'SELECT * FROM memories WHERE chat_id = ? ORDER BY accessed_at DESC LIMIT ?',
    )
    .all(chatId, limit) as Memory[];
}

export function touchMemory(id: number): void {
  const now = Math.floor(Date.now() / 1000);
  db.prepare(
    'UPDATE memories SET accessed_at = ?, salience = MIN(salience + 0.1, 5.0) WHERE id = ?',
  ).run(now, id);
}

export function penalizeMemory(memoryId: number): void {
  db.prepare(
    `UPDATE memories SET salience = MAX(0.05, salience - 0.05) WHERE id = ?`,
  ).run(memoryId);
}

/**
 * Batch-update salience for multiple memories in a single transaction.
 * Reduces SQLite lock contention when multiple agents finish concurrently.
 */
export function batchUpdateMemoryRelevance(
  allIds: number[],
  usefulIds: Set<number>,
): void {
  const txn = db.transaction(() => {
    for (const id of allIds) {
      if (usefulIds.has(id)) {
        touchMemory(id);
      } else {
        penalizeMemory(id);
      }
    }
  });
  txn();
}

/**
 * Importance-weighted decay. High-importance memories decay slower.
 * Pinned memories are exempt from decay entirely.
 * - pinned:             no decay (permanent)
 * - importance >= 0.8:  1% per day (retains ~460 days)
 * - importance >= 0.5:  2% per day (retains ~230 days)
 * - importance < 0.5:   5% per day (retains ~90 days)
 */
export function decayMemories(): void {
  const oneDayAgo = Math.floor(Date.now() / 1000) - 86400;
  db.prepare(`
    UPDATE memories SET salience = salience * CASE
      WHEN importance >= 0.8 THEN 0.99
      WHEN importance >= 0.5 THEN 0.98
      ELSE 0.95
    END
    WHERE created_at < ? AND pinned = 0
  `).run(oneDayAgo);
  // Clear superseded_by references pointing to memories we're about to delete,
  // otherwise the FOREIGN KEY constraint on superseded_by -> memories(id) fails.
  db.prepare(`
    UPDATE memories SET superseded_by = NULL
    WHERE superseded_by IN (SELECT id FROM memories WHERE salience < 0.05 AND pinned = 0)
  `).run();
  db.prepare('DELETE FROM memories WHERE salience < 0.05 AND pinned = 0').run();
}

export function pinMemory(memoryId: number): void {
  db.prepare('UPDATE memories SET pinned = 1 WHERE id = ?').run(memoryId);
}

export function unpinMemory(memoryId: number): void {
  db.prepare('UPDATE memories SET pinned = 0 WHERE id = ?').run(memoryId);
}

// ── Consolidation CRUD ──────────────────────────────────────────────

export function getUnconsolidatedMemories(chatId: string, limit = 20): Memory[] {
  return db
    .prepare(
      `SELECT * FROM memories WHERE chat_id = ? AND consolidated = 0
       ORDER BY created_at DESC LIMIT ?`,
    )
    .all(chatId, limit) as Memory[];
}

export function saveConsolidation(
  chatId: string,
  sourceIds: number[],
  summary: string,
  insight: string,
): number {
  const now = Math.floor(Date.now() / 1000);
  const result = db.prepare(
    `INSERT INTO consolidations (chat_id, source_ids, summary, insight, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(chatId, JSON.stringify(sourceIds), summary, insight, now);
  return result.lastInsertRowid as number;
}

export function saveConsolidationEmbedding(consolidationId: number, embedding: number[]): void {
  db.prepare('UPDATE consolidations SET embedding = ?, embedding_model = ? WHERE id = ?')
    .run(JSON.stringify(embedding), getEmbeddingModelName(), consolidationId);
}

export function getConsolidationsWithEmbeddings(chatId: string): Array<{ id: number; embedding: number[]; summary: string; insight: string }> {
  const models = getCompatibleEmbeddingModelNames();
  const placeholders = models.map(() => '?').join(',');
  const rows = db
    .prepare(`SELECT id, embedding, summary, insight FROM consolidations WHERE chat_id = ? AND embedding IS NOT NULL AND embedding_model IN (${placeholders})`)
    .all(chatId, ...models) as Array<{ id: number; embedding: string; summary: string; insight: string }>;
  return rows.map((r) => ({ ...r, embedding: JSON.parse(r.embedding) as number[] }));
}

export function supersedeMemory(oldId: number, newId: number): void {
  db.prepare(
    `UPDATE memories SET superseded_by = ?, importance = importance * 0.3, salience = salience * 0.5 WHERE id = ?`,
  ).run(newId, oldId);
}

export function updateMemoryConnections(memoryId: number, connections: Array<{ linked_to: number; relationship: string }>): void {
  const row = db.prepare('SELECT connections FROM memories WHERE id = ?').get(memoryId) as { connections: string } | undefined;
  if (!row) return;
  const existing: Array<{ linked_to: number; relationship: string }> = JSON.parse(row.connections);
  const merged = [...existing, ...connections];
  // Deduplicate by linked_to to prevent unbounded growth on re-consolidation
  const seen = new Set<number>();
  const deduped = merged.filter((c) => {
    if (seen.has(c.linked_to)) return false;
    seen.add(c.linked_to);
    return true;
  });
  db.prepare('UPDATE memories SET connections = ? WHERE id = ?').run(JSON.stringify(deduped), memoryId);
}

export function markMemoriesConsolidated(ids: number[]): void {
  if (ids.length === 0) return;
  const placeholders = ids.map(() => '?').join(',');
  db.prepare(`UPDATE memories SET consolidated = 1 WHERE id IN (${placeholders})`).run(...ids);
}

/**
 * Atomically save a consolidation, wire connections, handle contradictions,
 * and mark source memories as consolidated. If any step fails, all roll back.
 */
export function saveConsolidationAtomic(
  chatId: string,
  sourceIds: number[],
  summary: string,
  insight: string,
  connections: Array<{ from_id: number; to_id: number; relationship: string }>,
  contradictions: Array<{ stale_id: number; superseded_by: number }>,
): number {
  const txn = db.transaction(() => {
    const consolidationId = saveConsolidation(chatId, sourceIds, summary, insight);

    for (const conn of connections) {
      updateMemoryConnections(conn.from_id, [
        { linked_to: conn.to_id, relationship: conn.relationship },
      ]);
      updateMemoryConnections(conn.to_id, [
        { linked_to: conn.from_id, relationship: conn.relationship },
      ]);
    }

    for (const contra of contradictions) {
      supersedeMemory(contra.stale_id, contra.superseded_by);
    }

    markMemoriesConsolidated(sourceIds);
    return consolidationId;
  });
  return txn();
}

export function getRecentConsolidations(chatId: string, limit = 5): Consolidation[] {
  return db
    .prepare(
      `SELECT * FROM consolidations WHERE chat_id = ?
       ORDER BY created_at DESC LIMIT ?`,
    )
    .all(chatId, limit) as Consolidation[];
}

export function searchConsolidations(chatId: string, query: string, limit = 3): Consolidation[] {
  // Simple LIKE search on consolidation summaries and insights
  const pattern = `%${query.replace(/[%_]/g, '')}%`;
  return db
    .prepare(
      `SELECT * FROM consolidations
       WHERE chat_id = ? AND (summary LIKE ? OR insight LIKE ?)
       ORDER BY created_at DESC LIMIT ?`,
    )
    .all(chatId, pattern, pattern, limit) as Consolidation[];
}

// ── Scheduled Tasks ──────────────────────────────────────────────────

export interface ScheduledTask {
  id: string;
  prompt: string;
  schedule: string;
  next_run: number;
  last_run: number | null;
  last_result: string | null;
  status: 'active' | 'paused' | 'running';
  created_at: number;
  agent_id: string;
  started_at: number | null;
  last_status: 'success' | 'failed' | 'timeout' | null;
  model: string | null;
  silent: number;
}

export function createScheduledTask(
  id: string,
  prompt: string,
  schedule: string,
  nextRun: number,
  agentId = 'main',
  model: string | null = null,
  silent = false,
): void {
  const now = Math.floor(Date.now() / 1000);
  db.prepare(
    `INSERT INTO scheduled_tasks (id, prompt, schedule, next_run, status, created_at, agent_id, model, silent)
     VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?)`,
  ).run(id, prompt, schedule, nextRun, now, agentId, model, silent ? 1 : 0);
}

export function setScheduledTaskSilent(id: string, silent: boolean): void {
  db.prepare(`UPDATE scheduled_tasks SET silent = ? WHERE id = ?`).run(silent ? 1 : 0, id);
}

export function updateScheduledTaskModel(id: string, model: string | null): void {
  db.prepare(`UPDATE scheduled_tasks SET model = ? WHERE id = ?`).run(model, id);
}

export function getDueTasks(agentId = 'main'): ScheduledTask[] {
  const now = Math.floor(Date.now() / 1000);
  return db
    .prepare(
      `SELECT * FROM scheduled_tasks WHERE status = 'active' AND next_run <= ? AND agent_id = ? ORDER BY next_run`,
    )
    .all(now, agentId) as ScheduledTask[];
}

export function getAllScheduledTasks(agentId?: string): ScheduledTask[] {
  if (agentId) {
    return db
      .prepare('SELECT * FROM scheduled_tasks WHERE agent_id = ? ORDER BY created_at DESC')
      .all(agentId) as ScheduledTask[];
  }
  return db
    .prepare('SELECT * FROM scheduled_tasks ORDER BY created_at DESC')
    .all() as ScheduledTask[];
}

/**
 * Mark a task as running and optionally advance its next_run to the next
 * scheduled occurrence. Advancing next_run immediately prevents the scheduler
 * from re-firing the same task on subsequent ticks while it is still executing
 * (double-fire bug), and survives process restarts since the value is persisted.
 */
export function markTaskRunning(id: string, tentativeNextRun?: number): void {
  const now = Math.floor(Date.now() / 1000);
  if (tentativeNextRun !== undefined) {
    db.prepare(
      `UPDATE scheduled_tasks SET status = 'running', started_at = ?, next_run = ? WHERE id = ?`,
    ).run(now, tentativeNextRun, id);
  } else {
    db.prepare(
      `UPDATE scheduled_tasks SET status = 'running', started_at = ? WHERE id = ?`,
    ).run(now, id);
  }
}

export function updateTaskAfterRun(
  id: string,
  nextRun: number,
  result: string,
  lastStatus: 'success' | 'failed' | 'timeout' = 'success',
): void {
  const now = Math.floor(Date.now() / 1000);
  db.prepare(
    `UPDATE scheduled_tasks SET status = 'active', last_run = ?, next_run = ?, last_result = ?, last_status = ?, started_at = NULL WHERE id = ?`,
  ).run(now, nextRun, result.slice(0, 4000), lastStatus, id);
}

export function clearScheduledTaskAttention(id: string, result = 'Cleared from Home Needs Attention.'): boolean {
  const now = Math.floor(Date.now() / 1000);
  const update = db.prepare(
    `UPDATE scheduled_tasks
     SET status = 'active',
         last_run = COALESCE(last_run, ?),
         last_result = ?,
         last_status = 'success',
         started_at = NULL
     WHERE id = ?`,
  ).run(now, result.slice(0, 4000), id);
  return update.changes > 0;
}

export function resetStuckTasks(agentId: string): number {
  const result = db.prepare(
    `UPDATE scheduled_tasks SET status = 'active', started_at = NULL WHERE status = 'running' AND agent_id = ?`,
  ).run(agentId);
  return result.changes;
}

export function deleteScheduledTask(id: string): void {
  db.prepare('DELETE FROM scheduled_tasks WHERE id = ?').run(id);
}

export function pauseScheduledTask(id: string): void {
  db.prepare(`UPDATE scheduled_tasks SET status = 'paused' WHERE id = ?`).run(id);
}

export function resumeScheduledTask(id: string): void {
  db.prepare(`UPDATE scheduled_tasks SET status = 'active' WHERE id = ?`).run(id);
}

// ── Durable Attention Items ──────────────────────────────────────────

export type AttentionItemStatus = 'open' | 'assigned' | 'resolved' | 'archived';

export interface AttentionItem {
  id: string;
  source_kind: 'brief' | 'mission' | 'schedule';
  source_id: string;
  source_key: string;
  title: string;
  detail: string;
  severity: 'high' | 'medium' | 'low';
  status: AttentionItemStatus;
  linked_mission_id: string | null;
  assigned_agent: string | null;
  href: string | null;
  created_at: number;
  updated_at: number;
  resolved_at: number | null;
}

function attentionIdForSource(sourceKey: string): string {
  return 'att_' + crypto.createHash('sha1').update(sourceKey).digest('hex').slice(0, 16);
}

export function getAttentionItem(id: string): AttentionItem | null {
  return (db.prepare('SELECT * FROM attention_items WHERE id = ?').get(id) as AttentionItem | undefined) ?? null;
}

export function getAttentionItemBySourceKey(sourceKey: string): AttentionItem | null {
  return (db.prepare('SELECT * FROM attention_items WHERE source_key = ?').get(sourceKey) as AttentionItem | undefined) ?? null;
}

export function listOpenAttentionItems(limit = 50): AttentionItem[] {
  return db.prepare(
    `SELECT * FROM attention_items
     WHERE status = 'open'
     ORDER BY
       CASE severity WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END,
       updated_at DESC
     LIMIT ?`,
  ).all(limit) as AttentionItem[];
}

export function upsertAttentionItem(input: {
  sourceKind: AttentionItem['source_kind'];
  sourceId: string;
  sourceKey: string;
  title: string;
  detail: string;
  severity: AttentionItem['severity'];
  href?: string | null;
}): AttentionItem {
  const now = Math.floor(Date.now() / 1000);
  const existing = db.prepare('SELECT * FROM attention_items WHERE source_key = ?').get(input.sourceKey) as AttentionItem | undefined;
  if (existing) {
    if (existing.status === 'resolved' || existing.status === 'archived' || existing.status === 'assigned') {
      return existing;
    }
    db.prepare(
      `UPDATE attention_items
       SET title = ?, detail = ?, severity = ?, href = ?, updated_at = ?
       WHERE id = ? AND status = 'open'`,
    ).run(input.title.slice(0, 220), input.detail.slice(0, 1000), input.severity, input.href ?? null, now, existing.id);
    return getAttentionItem(existing.id)!;
  }

  const id = attentionIdForSource(input.sourceKey);
  db.prepare(
    `INSERT INTO attention_items (
      id, source_kind, source_id, source_key, title, detail, severity,
      status, linked_mission_id, assigned_agent, href, created_at, updated_at, resolved_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'open', NULL, NULL, ?, ?, ?, NULL)`,
  ).run(
    id,
    input.sourceKind,
    input.sourceId,
    input.sourceKey,
    input.title.slice(0, 220),
    input.detail.slice(0, 1000),
    input.severity,
    input.href ?? null,
    now,
    now,
  );
  return getAttentionItem(id)!;
}

export function markAttentionAssigned(id: string, missionId: string, agentId: string | null): AttentionItem | null {
  const now = Math.floor(Date.now() / 1000);
  db.prepare(
    `UPDATE attention_items
     SET status = 'assigned', linked_mission_id = ?, assigned_agent = ?, updated_at = ?, resolved_at = NULL
     WHERE id = ?`,
  ).run(missionId, agentId, now, id);
  return getAttentionItem(id);
}

export function updateAttentionStatus(id: string, status: AttentionItemStatus): AttentionItem | null {
  const now = Math.floor(Date.now() / 1000);
  db.prepare(
    `UPDATE attention_items
     SET status = ?, updated_at = ?, resolved_at = CASE WHEN ? IN ('resolved', 'archived') THEN ? ELSE resolved_at END
     WHERE id = ?`,
  ).run(status, now, status, now, id);
  return getAttentionItem(id);
}

/**
 * Get recent scheduled task outputs for a given agent.
 * Used to inject context into the next user message so Claude knows
 * what was just shown to the user via a scheduled task.
 *
 * Returns tasks that ran in the last `withinMinutes` (default 30).
 */
export function getRecentTaskOutputs(
  agentId: string,
  withinMinutes = 30,
): Array<{ prompt: string; last_result: string; last_run: number }> {
  const cutoff = Math.floor(Date.now() / 1000) - withinMinutes * 60;
  return db
    .prepare(
      `SELECT prompt, last_result, last_run FROM scheduled_tasks
       WHERE agent_id = ? AND last_status = 'success' AND last_run > ?
       ORDER BY last_run DESC LIMIT 3`,
    )
    .all(agentId, cutoff) as Array<{ prompt: string; last_result: string; last_run: number }>;
}

// ── WhatsApp message map ──────────────────────────────────────────────

export function saveWaMessageMap(telegramMsgId: number, waChatId: string, contactName: string): void {
  const now = Math.floor(Date.now() / 1000);
  db.prepare(
    `INSERT OR REPLACE INTO wa_message_map (telegram_msg_id, wa_chat_id, contact_name, created_at)
     VALUES (?, ?, ?, ?)`,
  ).run(telegramMsgId, waChatId, contactName, now);
}

export function lookupWaChatId(telegramMsgId: number): { waChatId: string; contactName: string } | null {
  const row = db
    .prepare('SELECT wa_chat_id, contact_name FROM wa_message_map WHERE telegram_msg_id = ?')
    .get(telegramMsgId) as { wa_chat_id: string; contact_name: string } | undefined;
  if (!row) return null;
  return { waChatId: row.wa_chat_id, contactName: row.contact_name };
}

export function getRecentWaContacts(limit = 20): Array<{ waChatId: string; contactName: string; lastSeen: number }> {
  const rows = db.prepare(
    `SELECT wa_chat_id, contact_name, MAX(created_at) as lastSeen
     FROM wa_message_map
     GROUP BY wa_chat_id
     ORDER BY lastSeen DESC
     LIMIT ?`,
  ).all(limit) as Array<{ wa_chat_id: string; contact_name: string; lastSeen: number }>;
  return rows.map((r) => ({ waChatId: r.wa_chat_id, contactName: r.contact_name, lastSeen: r.lastSeen }));
}

// ── WhatsApp outbox ──────────────────────────────────────────────────

export interface WaOutboxItem {
  id: number;
  to_chat_id: string;
  body: string;
  created_at: number;
}

export function enqueueWaMessage(toChatId: string, body: string): number {
  const now = Math.floor(Date.now() / 1000);
  const result = db.prepare(
    `INSERT INTO wa_outbox (to_chat_id, body, created_at) VALUES (?, ?, ?)`,
  ).run(toChatId, encryptField(body), now);
  return result.lastInsertRowid as number;
}

export function getPendingWaMessages(): WaOutboxItem[] {
  const rows = db.prepare(
    `SELECT id, to_chat_id, body, created_at FROM wa_outbox WHERE sent_at IS NULL ORDER BY created_at`,
  ).all() as WaOutboxItem[];
  return rows.map((r) => ({ ...r, body: decryptField(r.body) }));
}

export function markWaMessageSent(id: number): void {
  const now = Math.floor(Date.now() / 1000);
  db.prepare(`UPDATE wa_outbox SET sent_at = ? WHERE id = ?`).run(now, id);
}

// ── WhatsApp messages ────────────────────────────────────────────────

/**
 * Prune WhatsApp messages older than the given number of days.
 * Covers wa_messages, wa_outbox (sent only), and wa_message_map.
 */
export function pruneWaMessages(retentionDays = 3): { messages: number; outbox: number; map: number } {
  const cutoff = Math.floor(Date.now() / 1000) - retentionDays * 86400;

  const msgResult = db.prepare(
    'DELETE FROM wa_messages WHERE created_at < ?',
  ).run(cutoff);

  const outboxResult = db.prepare(
    'DELETE FROM wa_outbox WHERE sent_at IS NOT NULL AND created_at < ?',
  ).run(cutoff);

  const mapResult = db.prepare(
    'DELETE FROM wa_message_map WHERE created_at < ?',
  ).run(cutoff);

  return {
    messages: msgResult.changes,
    outbox: outboxResult.changes,
    map: mapResult.changes,
  };
}

/**
 * Prune Slack messages older than the given number of days.
 */
export function pruneSlackMessages(retentionDays = 3): number {
  const cutoff = Math.floor(Date.now() / 1000) - retentionDays * 86400;
  const result = db.prepare(
    'DELETE FROM slack_messages WHERE created_at < ?',
  ).run(cutoff);
  return result.changes;
}

// ── Conversation Log ──────────────────────────────────────────────────

export interface ConversationTurn {
  id: number;
  chat_id: string;
  session_id: string | null;
  role: string;
  content: string;
  created_at: number;
}

export function logConversationTurn(
  chatId: string,
  role: 'user' | 'assistant',
  content: string,
  sessionId?: string,
  agentId = 'main',
): void {
  const now = Math.floor(Date.now() / 1000);
  db.prepare(
    `INSERT INTO conversation_log (chat_id, session_id, role, content, created_at, agent_id)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(chatId, sessionId ?? null, role, content, now, agentId);
}

export function getRecentConversation(
  chatId: string,
  limit = 20,
  agentId?: string,
): ConversationTurn[] {
  // IMPORTANT: filter by agent_id too. Without this, /respin in the main
  // agent bleeds in turns from research/comms/content/ops that share the
  // same chat_id, producing respins contaminated with other agents'
  // conversations. Reported by Benjamin Elkrieff in April 2026.
  if (agentId) {
    return db
      .prepare(
        `SELECT * FROM conversation_log
         WHERE chat_id = ? AND agent_id = ?
         ORDER BY created_at DESC LIMIT ?`,
      )
      .all(chatId, agentId, limit) as ConversationTurn[];
  }
  return db
    .prepare(
      `SELECT * FROM conversation_log WHERE chat_id = ?
       ORDER BY created_at DESC LIMIT ?`,
    )
    .all(chatId, limit) as ConversationTurn[];
}

/**
 * Search conversation_log by keywords. Used when the user asks about
 * past conversations ("remember when we...", "what did we talk about").
 * Returns recent turns that match any keyword, grouped chronologically.
 */
export function searchConversationHistory(
  chatId: string,
  query: string,
  agentId?: string,
  daysBack = 7,
  limit = 20,
): ConversationTurn[] {
  const cutoff = Math.floor(Date.now() / 1000) - (daysBack * 86400);
  const keywords = query
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length >= 3)
    .slice(0, 8);
  if (keywords.length === 0) return [];

  const conditions = keywords.map(() => 'content LIKE ?').join(' OR ');
  const params: (string | number)[] = [chatId, cutoff];
  for (const kw of keywords) {
    params.push(`%${kw}%`);
  }

  const agentFilter = agentId ? ' AND agent_id = ?' : '';
  if (agentId) params.push(agentId);

  return db
    .prepare(
      `SELECT * FROM conversation_log
       WHERE chat_id = ? AND created_at > ? AND (${conditions})${agentFilter}
       ORDER BY created_at DESC LIMIT ?`,
    )
    .all(...params, limit) as ConversationTurn[];
}

/**
 * Get a page of conversation turns for the dashboard chat overlay.
 * Returns turns in reverse chronological order (newest first).
 * Use `beforeId` for cursor-based pagination (load older messages).
 */
export function getConversationPage(
  chatId: string,
  limit = 40,
  beforeId?: number,
): ConversationTurn[] {
  if (beforeId) {
    return db
      .prepare(
        `SELECT * FROM conversation_log
         WHERE chat_id = ? AND id < ?
         ORDER BY id DESC LIMIT ?`,
      )
      .all(chatId, beforeId, limit) as ConversationTurn[];
  }
  return db
    .prepare(
      `SELECT * FROM conversation_log
       WHERE chat_id = ?
       ORDER BY id DESC LIMIT ?`,
    )
    .all(chatId, limit) as ConversationTurn[];
}

/**
 * Prune old conversation_log entries, keeping only the most recent N rows
 * per (chat_id, agent_id) pair. Scoping by agent matters because all five
 * agents share the same chat_id in a typical install, and a chatty agent
 * could otherwise evict a quieter agent's history under the shared cap.
 * Wrapped in a transaction so a mid-loop crash can't leave the table in a
 * half-pruned state.
 */
export function pruneConversationLog(keepPerChat = 500): void {
  const pairs = db
    .prepare('SELECT DISTINCT chat_id, agent_id FROM conversation_log')
    .all() as Array<{ chat_id: string; agent_id: string }>;

  const deleteStmt = db.prepare(`
    DELETE FROM conversation_log
    WHERE chat_id = ? AND agent_id = ? AND id NOT IN (
      SELECT id FROM conversation_log
      WHERE chat_id = ? AND agent_id = ?
      ORDER BY created_at DESC
      LIMIT ?
    )
  `);

  const runAll = db.transaction((rows: typeof pairs) => {
    for (const row of rows) {
      deleteStmt.run(row.chat_id, row.agent_id, row.chat_id, row.agent_id, keepPerChat);
    }
  });
  runAll(pairs);
}

// ── WhatsApp messages ────────────────────────────────────────────────

export function saveWaMessage(
  chatId: string,
  contactName: string,
  body: string,
  timestamp: number,
  isFromMe: boolean,
): void {
  const now = Math.floor(Date.now() / 1000);
  db.prepare(
    `INSERT INTO wa_messages (chat_id, contact_name, body, timestamp, is_from_me, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(chatId, contactName, encryptField(body), timestamp, isFromMe ? 1 : 0, now);
}

export interface WaMessageRow {
  id: number;
  chat_id: string;
  contact_name: string;
  body: string;
  timestamp: number;
  is_from_me: number;
  created_at: number;
}

export function getRecentWaMessages(chatId: string, limit = 20): WaMessageRow[] {
  const rows = db
    .prepare(
      `SELECT * FROM wa_messages WHERE chat_id = ?
       ORDER BY timestamp DESC LIMIT ?`,
    )
    .all(chatId, limit) as WaMessageRow[];
  return rows.map((r) => ({ ...r, body: decryptField(r.body) }));
}

// ── Slack messages ────────────────────────────────────────────────

export function saveSlackMessage(
  channelId: string,
  channelName: string,
  userName: string,
  body: string,
  timestamp: string,
  isFromMe: boolean,
): void {
  const now = Math.floor(Date.now() / 1000);
  db.prepare(
    `INSERT INTO slack_messages (channel_id, channel_name, user_name, body, timestamp, is_from_me, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(channelId, channelName, userName, encryptField(body), timestamp, isFromMe ? 1 : 0, now);
}

export interface SlackMessageRow {
  id: number;
  channel_id: string;
  channel_name: string;
  user_name: string;
  body: string;
  timestamp: string;
  is_from_me: number;
  created_at: number;
}

export function getRecentSlackMessages(channelId: string, limit = 20): SlackMessageRow[] {
  const rows = db
    .prepare(
      `SELECT * FROM slack_messages WHERE channel_id = ?
       ORDER BY created_at DESC LIMIT ?`,
    )
    .all(channelId, limit) as SlackMessageRow[];
  return rows.map((r) => ({ ...r, body: decryptField(r.body) }));
}

// ── Token Usage ──────────────────────────────────────────────────────

export function saveTokenUsage(
  chatId: string,
  sessionId: string | undefined,
  inputTokens: number,
  outputTokens: number,
  cacheRead: number,
  contextTokens: number,
  costUsd: number,
  didCompact: boolean,
  agentId = 'main',
): void {
  const now = Math.floor(Date.now() / 1000);
  db.prepare(
    `INSERT INTO token_usage (chat_id, session_id, input_tokens, output_tokens, cache_read, context_tokens, cost_usd, did_compact, created_at, agent_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(chatId, sessionId ?? null, inputTokens, outputTokens, cacheRead, contextTokens, costUsd, didCompact ? 1 : 0, now, agentId);
}

export interface SessionTokenSummary {
  turns: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  lastCacheRead: number;
  lastContextTokens: number;
  totalCostUsd: number;
  compactions: number;
  firstTurnAt: number;
  lastTurnAt: number;
}

// ── Dashboard Queries ──────────────────────────────────────────────────

export interface DashboardMemoryStats {
  total: number;
  pinned: number;
  consolidations: number;
  avgImportance: number;
  avgSalience: number;
  importanceDistribution: { bucket: string; count: number }[];
}

export function getDashboardMemoryStats(chatId: string): DashboardMemoryStats {
  const counts = db
    .prepare(
      `SELECT
         COUNT(*) as total,
         AVG(importance) as avgImportance,
         AVG(salience) as avgSalience
       FROM memories WHERE chat_id = ?`,
    )
    .get(chatId) as { total: number; avgImportance: number | null; avgSalience: number | null };

  const consolidationCount = db
    .prepare('SELECT COUNT(*) as cnt FROM consolidations WHERE chat_id = ?')
    .get(chatId) as { cnt: number };

  const pinnedCount = db
    .prepare('SELECT COUNT(*) as cnt FROM memories WHERE chat_id = ? AND pinned = 1')
    .get(chatId) as { cnt: number };

  const buckets = db
    .prepare(
      `SELECT
         CASE
           WHEN importance < 0.2 THEN '0-0.2'
           WHEN importance < 0.4 THEN '0.2-0.4'
           WHEN importance < 0.6 THEN '0.4-0.6'
           WHEN importance < 0.8 THEN '0.6-0.8'
           ELSE '0.8-1.0'
         END as bucket,
         COUNT(*) as count
       FROM memories WHERE chat_id = ?
       GROUP BY bucket
       ORDER BY bucket`,
    )
    .all(chatId) as { bucket: string; count: number }[];

  return {
    total: counts.total,
    pinned: pinnedCount.cnt,
    consolidations: consolidationCount.cnt,
    avgImportance: counts.avgImportance ?? 0,
    avgSalience: counts.avgSalience ?? 0,
    importanceDistribution: buckets,
  };
}

export function getDashboardPinnedMemories(chatId: string): Memory[] {
  return db
    .prepare('SELECT * FROM memories WHERE chat_id = ? AND pinned = 1 ORDER BY importance DESC')
    .all(chatId) as Memory[];
}

export function getDashboardLowSalienceMemories(chatId: string, limit = 10): Memory[] {
  return db
    .prepare(
      `SELECT * FROM memories WHERE chat_id = ? AND salience < 0.5
       ORDER BY salience ASC LIMIT ?`,
    )
    .all(chatId, limit) as Memory[];
}

export function getDashboardTopAccessedMemories(chatId: string, limit = 5): Memory[] {
  return db
    .prepare(
      `SELECT * FROM memories WHERE chat_id = ? AND importance >= 0.5
       ORDER BY accessed_at DESC LIMIT ?`,
    )
    .all(chatId, limit) as Memory[];
}

export function getDashboardMemoryTimeline(chatId: string, days = 30): { date: string; count: number }[] {
  return db
    .prepare(
      `SELECT
         date(created_at, 'unixepoch') as date,
         COUNT(*) as count
       FROM memories
       WHERE chat_id = ? AND created_at >= unixepoch('now', ?)
       GROUP BY date
       ORDER BY date`,
    )
    .all(chatId, `-${days} days`) as { date: string; count: number }[];
}

export function getDashboardConsolidations(chatId: string, limit = 5): Consolidation[] {
  return getRecentConsolidations(chatId, limit);
}

export interface DashboardTokenStats {
  todayInput: number;
  todayOutput: number;
  todayCost: number;
  todayTurns: number;
  allTimeCost: number;
  allTimeTurns: number;
}

export function getDashboardTokenStats(chatId: string): DashboardTokenStats {
  const today = db
    .prepare(
      `SELECT
         COALESCE(SUM(input_tokens), 0) as todayInput,
         COALESCE(SUM(output_tokens), 0) as todayOutput,
         COALESCE(SUM(cost_usd), 0) as todayCost,
         COUNT(*) as todayTurns
       FROM token_usage
       WHERE chat_id = ? AND created_at >= unixepoch('now', 'localtime', 'start of day', 'utc')`,
    )
    .get(chatId) as { todayInput: number; todayOutput: number; todayCost: number; todayTurns: number };

  const allTime = db
    .prepare(
      `SELECT
         COALESCE(SUM(input_tokens), 0) as allTimeInput,
         COALESCE(SUM(output_tokens), 0) as allTimeOutput,
         COALESCE(SUM(cost_usd), 0) as allTimeCost,
         COUNT(*) as allTimeTurns
       FROM token_usage WHERE chat_id = ?`,
    )
    .get(chatId) as { allTimeInput: number; allTimeOutput: number; allTimeCost: number; allTimeTurns: number };

  return { ...today, ...allTime };
}

export function getDashboardCostTimeline(chatId: string, days = 30): { date: string; cost: number; turns: number }[] {
  return db
    .prepare(
      `SELECT
         date(created_at, 'unixepoch') as date,
         SUM(cost_usd) as cost,
         COUNT(*) as turns
       FROM token_usage
       WHERE chat_id = ? AND created_at >= unixepoch('now', ?)
       GROUP BY date
       ORDER BY date`,
    )
    .all(chatId, `-${days} days`) as { date: string; cost: number; turns: number }[];
}

export interface RecentTokenUsageRow {
  id: number;
  chat_id: string;
  session_id: string | null;
  input_tokens: number;
  output_tokens: number;
  cache_read: number;
  context_tokens: number;
  cost_usd: number;
  did_compact: number;
  created_at: number;
}

export function getDashboardRecentTokenUsage(chatId: string, limit = 20): RecentTokenUsageRow[] {
  return db
    .prepare(
      `SELECT * FROM token_usage WHERE chat_id = ?
       ORDER BY created_at DESC LIMIT ?`,
    )
    .all(chatId, limit) as RecentTokenUsageRow[];
}

export function getDashboardMemoriesList(chatId: string, limit = 50, offset = 0, sortBy: 'importance' | 'salience' | 'recent' = 'importance'): { memories: Memory[]; total: number } {
  const total = db
    .prepare('SELECT COUNT(*) as cnt FROM memories WHERE chat_id = ?')
    .get(chatId) as { cnt: number };

  let orderClause: string;
  switch (sortBy) {
    case 'salience':
      orderClause = 'ORDER BY salience DESC, created_at DESC';
      break;
    case 'recent':
      orderClause = 'ORDER BY created_at DESC';
      break;
    default:
      orderClause = 'ORDER BY importance DESC, created_at DESC';
  }

  const memories = db
    .prepare(
      `SELECT * FROM memories WHERE chat_id = ? ${orderClause} LIMIT ? OFFSET ?`,
    )
    .all(chatId, limit, offset) as Memory[];
  return { memories, total: total.cnt };
}

// ── Hive Mind ──────────────────────────────────────────────────────

export interface HiveMindEntry {
  id: number;
  agent_id: string;
  chat_id: string;
  action: string;
  summary: string;
  artifacts: string | null;
  created_at: number;
}

export function logToHiveMind(
  agentId: string,
  chatId: string,
  action: string,
  summary: string,
  artifacts?: string,
): void {
  const now = Math.floor(Date.now() / 1000);
  db.prepare(
    `INSERT INTO hive_mind (agent_id, chat_id, action, summary, artifacts, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(agentId, chatId, action, summary, artifacts ?? null, now);
}

export function getHiveMindEntries(limit = 20, agentId?: string): HiveMindEntry[] {
  if (agentId) {
    return db
      .prepare('SELECT * FROM hive_mind WHERE agent_id = ? ORDER BY created_at DESC LIMIT ?')
      .all(agentId, limit) as HiveMindEntry[];
  }
  return db
    .prepare('SELECT * FROM hive_mind ORDER BY created_at DESC LIMIT ?')
    .all(limit) as HiveMindEntry[];
}

/**
 * Get recent hive_mind entries from agents OTHER than the given one.
 * Used to give each agent awareness of what teammates have been doing.
 */
export function getOtherAgentActivity(
  excludeAgentId: string,
  hoursBack = 24,
  limit = 10,
): HiveMindEntry[] {
  const cutoff = Math.floor(Date.now() / 1000) - (hoursBack * 3600);
  return db
    .prepare(
      `SELECT * FROM hive_mind
       WHERE agent_id != ? AND created_at > ?
       ORDER BY created_at DESC LIMIT ?`,
    )
    .all(excludeAgentId, cutoff, limit) as HiveMindEntry[];
}

/**
 * Get conversation turns for a specific session, ordered chronologically.
 * Used for hive-mind auto-commit on session end.
 */
export function getSessionConversation(sessionId: string, limit = 40): ConversationTurn[] {
  return db
    .prepare(
      `SELECT * FROM conversation_log WHERE session_id = ?
       ORDER BY created_at ASC LIMIT ?`,
    )
    .all(sessionId, limit) as ConversationTurn[];
}

export function getAgentTokenStats(agentId: string): { todayCost: number; todayTurns: number; allTimeCost: number } {
  const today = db
    .prepare(
      `SELECT COALESCE(SUM(cost_usd), 0) as todayCost, COUNT(*) as todayTurns
       FROM token_usage
       WHERE agent_id = ? AND created_at >= unixepoch('now', 'localtime', 'start of day', 'utc')`,
    )
    .get(agentId) as { todayCost: number; todayTurns: number };

  const allTime = db
    .prepare('SELECT COALESCE(SUM(cost_usd), 0) as allTimeCost FROM token_usage WHERE agent_id = ?')
    .get(agentId) as { allTimeCost: number };

  return { ...today, allTimeCost: allTime.allTimeCost };
}

export function getAgentRecentConversation(agentId: string, chatId: string, limit = 4): ConversationTurn[] {
  return db
    .prepare(
      `SELECT * FROM conversation_log WHERE agent_id = ? AND chat_id = ?
       ORDER BY created_at DESC LIMIT ?`,
    )
    .all(agentId, chatId, limit) as ConversationTurn[];
}

export function getSessionTokenUsage(sessionId: string): SessionTokenSummary | null {
  const row = db
    .prepare(
      `SELECT
         COUNT(*)           as turns,
         SUM(input_tokens)  as totalInputTokens,
         SUM(output_tokens) as totalOutputTokens,
         SUM(cost_usd)      as totalCostUsd,
         SUM(did_compact)   as compactions,
         MIN(created_at)    as firstTurnAt,
         MAX(created_at)    as lastTurnAt
       FROM token_usage WHERE session_id = ?`,
    )
    .get(sessionId) as {
      turns: number;
      totalInputTokens: number;
      totalOutputTokens: number;
      totalCostUsd: number;
      compactions: number;
      firstTurnAt: number;
      lastTurnAt: number;
    } | undefined;

  if (!row || row.turns === 0) return null;

  // Get the most recent turn's context_tokens (actual context window size from last API call)
  // Falls back to cache_read for backward compat with rows before the migration
  const lastRow = db
    .prepare(
      `SELECT cache_read, context_tokens FROM token_usage
       WHERE session_id = ?
       ORDER BY created_at DESC LIMIT 1`,
    )
    .get(sessionId) as { cache_read: number; context_tokens: number } | undefined;

  return {
    turns: row.turns,
    totalInputTokens: row.totalInputTokens,
    totalOutputTokens: row.totalOutputTokens,
    lastCacheRead: lastRow?.cache_read ?? 0,
    lastContextTokens: lastRow?.context_tokens ?? lastRow?.cache_read ?? 0,
    totalCostUsd: row.totalCostUsd,
    compactions: row.compactions,
    firstTurnAt: row.firstTurnAt,
    lastTurnAt: row.lastTurnAt,
  };
}

// ── Inter-Agent Tasks ──────────────────────────────────────────────────

export interface InterAgentTask {
  id: string;
  from_agent: string;
  to_agent: string;
  chat_id: string;
  prompt: string;
  status: string;
  result: string | null;
  created_at: string;
  completed_at: string | null;
}

export function createInterAgentTask(
  id: string,
  fromAgent: string,
  toAgent: string,
  chatId: string,
  prompt: string,
): void {
  db.prepare(
    `INSERT INTO inter_agent_tasks (id, from_agent, to_agent, chat_id, prompt, status, created_at)
     VALUES (?, ?, ?, ?, ?, 'pending', datetime('now'))`,
  ).run(id, fromAgent, toAgent, chatId, prompt);
}

export function completeInterAgentTask(
  id: string,
  status: 'completed' | 'failed',
  result: string | null,
): void {
  db.prepare(
    `UPDATE inter_agent_tasks SET status = ?, result = ?, completed_at = datetime('now') WHERE id = ?`,
  ).run(status, result?.slice(0, 2000) ?? null, id);
}

export function getInterAgentTasks(
  limit = 20,
  status?: string,
): InterAgentTask[] {
  if (status) {
    return db
      .prepare(
        'SELECT * FROM inter_agent_tasks WHERE status = ? ORDER BY created_at DESC LIMIT ?',
      )
      .all(status, limit) as InterAgentTask[];
  }
  return db
    .prepare(
      'SELECT * FROM inter_agent_tasks ORDER BY created_at DESC LIMIT ?',
    )
    .all(limit) as InterAgentTask[];
}

// ── Mission Tasks (one-shot async tasks for Mission Control) ─────────

/**
 * Valid values for `mission_tasks.status` (TEXT column, no CHECK constraint
 * — values documented here):
 *   - queued       Created, not yet claimed by an agent
 *   - running      Claimed and executing
 *   - completed    Terminal: agent finished cleanly with a result
 *   - failed       Terminal: agent errored / aborted with NO commits since
 *                  dispatch. True zero-progress failure
 *   - partial      Terminal (added 2026-05-04): agent hit max-turns/timeout
 *                  BUT made >=1 commit since dispatch. Distinguishes
 *                  "ran out of runway with real work landed" from "dead
 *                  on arrival." Read-side queries that filter for
 *                  `status = 'completed'` correctly EXCLUDE partial — a
 *                  partial requires human review and re-dispatch
 *   - cancelled    Terminal: user cancelled before completion
 *
 * Forward-compat: notify-state 'timed_out' is NOT persisted as a status
 * (timeouts collapse into 'failed' or 'partial' depending on commits)
 */
export interface MissionTask {
  id: string;
  title: string;
  prompt: string;
  assigned_agent: string | null;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'partial' | 'cancelled';
  result: string | null;
  error: string | null;
  created_by: string;
  priority: number;
  created_at: number;
  started_at: number | null;
  completed_at: number | null;
  manifest_json: string | null;
  model: string | null;
  notify_on_done: number;
  notified_at: number | null;
  delivered_at: number | null;
  notify_attempt_count: number;
}

export type MissionReviewStatus = 'needs_review' | 'needs_triage' | 'waiting_followup' | 'resolved' | 'archived' | 'snoozed';
export type MissionReviewResolution = 'approved' | 'retried' | 'delegated' | 'followup_completed' | 'superseded' | 'ignored' | null;

export interface MissionReview {
  task_id: string;
  review_status: MissionReviewStatus;
  resolution: MissionReviewResolution;
  followup_task_id: string | null;
  instruction: string | null;
  snoozed_until: number | null;
  reviewed_at: number | null;
  created_at: number;
  updated_at: number;
}

export function createMissionTask(
  id: string,
  title: string,
  prompt: string,
  assignedAgent: string | null = null,
  createdBy = 'dashboard',
  priority = 0,
  model: string | null = null,
  notifyOnDone = false,
): void {
  const now = Math.floor(Date.now() / 1000);
  db.prepare(
    `INSERT INTO mission_tasks (id, title, prompt, assigned_agent, status, created_by, priority, created_at, model, notify_on_done)
     VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?)`,
  ).run(id, title, prompt, assignedAgent, createdBy, priority, now, model, notifyOnDone ? 1 : 0);
}

/**
 * Claim a mission task for notification delivery. Returns true if the
 * row was updated (i.e. delivered_at IS NULL and notify_on_done = 1).
 *
 * Semantics changed 2026-05-04: the claim filter is `delivered_at IS NULL`,
 * not `notified_at IS NULL`. This is what makes crash-mid-spawn recoverable:
 * if a process dies between marking notified_at and spawning notify.sh,
 * delivered_at remains NULL and the recovery sweep can re-claim the row
 * by stamping a fresh notified_at. The same-process double-fire guard
 * is the in-memory `runningTaskIds` set + `task.delivered_at` early-return
 * inside notifyMissionDone. We also bump notify_attempt_count on each
 * claim so the sweep can stop retrying a permanently broken row.
 */
export function markMissionNotified(id: string): boolean {
  const now = Math.floor(Date.now() / 1000);
  const result = db.prepare(
    `UPDATE mission_tasks
       SET notified_at = ?,
           notify_attempt_count = notify_attempt_count + 1
     WHERE id = ? AND notify_on_done = 1 AND delivered_at IS NULL`,
  ).run(now, id);
  return result.changes > 0;
}

/**
 * Clear notified_at on a mission task. Used to release a claim when
 * delivery fails so the next recovery sweep can retry without waiting
 * for an in-flight TTL. Safe no-op once delivered_at is set (we never
 * clear notified_at on a delivered row).
 */
export function resetMissionNotified(id: string): void {
  db.prepare(
    `UPDATE mission_tasks SET notified_at = NULL
     WHERE id = ? AND delivered_at IS NULL`,
  ).run(id);
}

/**
 * Stamp delivered_at to mark the mission notification as durably handed
 * off. Since the outbox migration this means "row inserted into
 * telegram_outbox with status='pending'"; the outbox owns retries +
 * dead-letter from there. The recovery sweep filters on
 * `delivered_at IS NULL` so a crash before this stamp re-enqueues.
 *
 * Prefer enqueueTelegramAndMarkMissionDelivered() when paired with an
 * outbox enqueue — non-atomic enqueue + mark sequences leave a
 * duplicate-delivery window if the process crashes between them.
 */
export function markMissionDelivered(id: string): void {
  const now = Math.floor(Date.now() / 1000);
  db.prepare(
    `UPDATE mission_tasks SET delivered_at = ? WHERE id = ?`,
  ).run(now, id);
}

/**
 * Atomic mission-notify handoff: insert the outbox row AND stamp
 * delivered_at on the mission task, in a single transaction. Closes
 * the duplicate-delivery window where a crash between two non-atomic
 * writes leaves delivered_at NULL but the outbox row already exists,
 * so the next recovery sweep re-enqueues a duplicate.
 *
 * Codex review of ee63a3b flagged this gap. Use this in
 * notifyMissionDone instead of enqueueTelegramSend + markMissionDelivered.
 *
 * Returns the outbox row id on success. Throws on any DB failure (the
 * caller is expected to fall back to a non-durable path or retry).
 */
export function enqueueTelegramAndMarkMissionDelivered(
  missionId: string,
  agentId: string,
  chatId: string,
  payload: string,
): number {
  const now = Math.floor(Date.now() / 1000);
  let outboxId = 0;
  const txn = db.transaction(() => {
    const insertInfo = db.prepare(
      `INSERT INTO telegram_outbox (agent_id, chat_id, payload, status, created_at)
       VALUES (?, ?, ?, 'pending', ?)`,
    ).run(agentId, chatId, payload, now);
    outboxId = Number(insertInfo.lastInsertRowid);
    db.prepare(
      `UPDATE mission_tasks SET delivered_at = ? WHERE id = ?`,
    ).run(now, missionId);
  });
  txn();
  return outboxId;
}

/** @internal — test seam to age a row's completed_at for recovery sweep tests. */
export function _setMissionCompletedAtForTest(
  id: string,
  completedAt: number,
  status: 'completed' | 'failed' | 'partial' | 'timed_out' = 'completed',
): void {
  db.prepare(
    `UPDATE mission_tasks SET completed_at = ?, status = ? WHERE id = ?`,
  ).run(completedAt, status, id);
}

/** @internal — test seam to set notify_attempt_count for backoff tests. */
export function _setMissionNotifyAttemptCountForTest(id: string, count: number): void {
  db.prepare(
    `UPDATE mission_tasks SET notify_attempt_count = ? WHERE id = ?`,
  ).run(count, id);
}

/**
 * Find terminal mission tasks whose notify-on-done ping was never delivered.
 * Used by the scheduler startup sweep to recover from a crash that hit
 * between completeMissionTask() and notifyMissionDone().
 *
 * The graceSeconds window prevents racing with an in-flight notification
 * dispatched by the normal hot path of the scheduler.
 */
export function getMissionTasksNeedingNotificationRecovery(
  graceSeconds = 60,
  maxAttempts = 5,
): MissionTask[] {
  const cutoff = Math.floor(Date.now() / 1000) - graceSeconds;
  return db
    .prepare(
      `SELECT * FROM mission_tasks
       WHERE notify_on_done = 1
         AND delivered_at IS NULL
         AND notify_attempt_count < ?
         AND status IN ('completed', 'failed', 'partial', 'timed_out')
         AND completed_at IS NOT NULL
         AND completed_at < ?
       ORDER BY completed_at ASC`,
    )
    .all(maxAttempts, cutoff) as MissionTask[];
}

/**
 * Look up the most recent chat_id this agent has had a session for.
 * Used by the mission-task notify path to route pings to the right chat.
 * Returns null if the agent has no session row.
 */
export function getLatestChatIdForAgent(agentId: string): string | null {
  const row = db.prepare(
    `SELECT chat_id FROM sessions WHERE agent_id = ?
     ORDER BY updated_at DESC LIMIT 1`,
  ).get(agentId) as { chat_id: string } | undefined;
  return row?.chat_id ?? null;
}

export function getUnassignedMissionTasks(): MissionTask[] {
  return db
    .prepare(
      `SELECT * FROM mission_tasks WHERE assigned_agent IS NULL AND status = 'queued'
       ORDER BY priority DESC, created_at ASC`,
    )
    .all() as MissionTask[];
}

export function getMissionTasks(agentId?: string, status?: string): MissionTask[] {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (agentId) {
    conditions.push('assigned_agent = ?');
    params.push(agentId);
  }
  if (status) {
    conditions.push('status = ?');
    params.push(status);
  }

  const where = conditions.length > 0 ? ' WHERE ' + conditions.join(' AND ') : '';
  return db
    .prepare(
      `SELECT * FROM mission_tasks${where}
       ORDER BY
         CASE status WHEN 'running' THEN 0 WHEN 'queued' THEN 1 ELSE 2 END,
         priority DESC, created_at DESC`,
    )
    .all(...params) as MissionTask[];
}

export function getMissionTask(id: string): MissionTask | null {
  return (db.prepare('SELECT * FROM mission_tasks WHERE id = ?').get(id) as MissionTask) ?? null;
}

export function getMissionReview(taskId: string): MissionReview | null {
  return (db.prepare('SELECT * FROM mission_reviews WHERE task_id = ?').get(taskId) as MissionReview) ?? null;
}

export function upsertMissionReview(input: {
  taskId: string;
  reviewStatus: MissionReviewStatus;
  resolution?: MissionReviewResolution;
  followupTaskId?: string | null;
  instruction?: string | null;
  snoozedUntil?: number | null;
  reviewedAt?: number | null;
}): MissionReview {
  const now = Math.floor(Date.now() / 1000);
  db.prepare(`
    INSERT INTO mission_reviews (
      task_id, review_status, resolution, followup_task_id, instruction,
      snoozed_until, reviewed_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(task_id) DO UPDATE SET
      review_status = excluded.review_status,
      resolution = excluded.resolution,
      followup_task_id = excluded.followup_task_id,
      instruction = excluded.instruction,
      snoozed_until = excluded.snoozed_until,
      reviewed_at = excluded.reviewed_at,
      updated_at = excluded.updated_at
  `).run(
    input.taskId,
    input.reviewStatus,
    input.resolution ?? null,
    input.followupTaskId ?? null,
    input.instruction ?? null,
    input.snoozedUntil ?? null,
    input.reviewedAt ?? (input.reviewStatus === 'resolved' || input.reviewStatus === 'archived' ? now : null),
    now,
    now,
  );
  return getMissionReview(input.taskId)!;
}

export function updateMissionReviewState(taskId: string, reviewStatus: MissionReviewStatus, resolution?: MissionReviewResolution): MissionReview {
  const existing = getMissionReview(taskId);
  return upsertMissionReview({
    taskId,
    reviewStatus,
    resolution: resolution ?? existing?.resolution ?? null,
    followupTaskId: existing?.followup_task_id ?? null,
    instruction: existing?.instruction ?? null,
    snoozedUntil: reviewStatus === 'snoozed' ? existing?.snoozed_until ?? null : null,
  });
}

export function claimNextMissionTask(agentId: string): MissionTask | null {
  const txn = db.transaction(() => {
    const task = db
      .prepare(
        `SELECT * FROM mission_tasks
         WHERE assigned_agent = ? AND status = 'queued'
         ORDER BY priority DESC, created_at ASC
         LIMIT 1`,
      )
      .get(agentId) as MissionTask | undefined;
    if (!task) return null;
    db.prepare(
      `UPDATE mission_tasks SET status = 'running', started_at = ? WHERE id = ?`,
    ).run(Math.floor(Date.now() / 1000), task.id);
    return { ...task, status: 'running' as const, started_at: Math.floor(Date.now() / 1000) };
  });
  return txn();
}

export function completeMissionTask(
  id: string,
  result: string | null,
  status: 'completed' | 'failed' | 'partial',
  error?: string,
): void {
  const now = Math.floor(Date.now() / 1000);
  const task = getMissionTask(id);
  const manifest = task
    ? buildMissionManifest({ status, title: task.title, prompt: task.prompt, result, error })
    : null;
  db.prepare(
    `UPDATE mission_tasks SET status = ?, result = ?, error = ?, completed_at = ?, manifest_json = ? WHERE id = ?`,
  ).run(status, result, error ?? null, now, manifest ? JSON.stringify(manifest) : null, id);
}

export function getMissionManifest(task: MissionTask): MissionManifest {
  return parseMissionManifest(task.manifest_json) ?? buildMissionManifest({
    status: task.status,
    title: task.title,
    prompt: task.prompt,
    result: task.result,
    error: task.error,
  });
}

export function cancelMissionTask(id: string): boolean {
  const result = db.prepare(
    `UPDATE mission_tasks SET status = 'cancelled', completed_at = ? WHERE id = ? AND status IN ('queued', 'running')`,
  ).run(Math.floor(Date.now() / 1000), id);
  return result.changes > 0;
}

export function deleteMissionTask(id: string): boolean {
  const result = db.prepare(
    `DELETE FROM mission_tasks WHERE id = ? AND status IN ('completed', 'cancelled', 'failed', 'partial')`,
  ).run(id);
  return result.changes > 0;
}

export function cleanupOldMissionTasks(olderThanDays = 7): number {
  const cutoff = Math.floor(Date.now() / 1000) - olderThanDays * 86400;
  const result = db.prepare(
    `DELETE FROM mission_tasks WHERE status IN ('completed', 'cancelled', 'failed', 'partial') AND completed_at < ?`,
  ).run(cutoff);
  return result.changes;
}

export function reassignMissionTask(id: string, newAgent: string): boolean {
  const result = db.prepare(
    `UPDATE mission_tasks SET assigned_agent = ? WHERE id = ? AND status != 'running'`,
  ).run(newAgent, id);
  return result.changes > 0;
}

export function assignMissionTask(id: string, agent: string): boolean {
  const result = db.prepare(
    `UPDATE mission_tasks SET assigned_agent = ? WHERE id = ? AND assigned_agent IS NULL AND status = 'queued'`,
  ).run(agent, id);
  return result.changes > 0;
}

export function getMissionTaskHistory(limit = 30, offset = 0): { tasks: MissionTask[]; total: number } {
  const total = (db.prepare(
    `SELECT COUNT(*) as c FROM mission_tasks WHERE status IN ('completed', 'failed', 'cancelled', 'partial')`,
  ).get() as { c: number }).c;
  const tasks = db.prepare(
    `SELECT * FROM mission_tasks WHERE status IN ('completed', 'failed', 'cancelled', 'partial')
     ORDER BY completed_at DESC LIMIT ? OFFSET ?`,
  ).all(limit, offset) as MissionTask[];
  return { tasks, total };
}

export function listStaleMissionTasks(now = Math.floor(Date.now() / 1000)): MissionTask[] {
  return db.prepare(
    `SELECT * FROM mission_tasks
     WHERE (
       status = 'running' AND started_at IS NOT NULL AND started_at < ?
     ) OR (
       status = 'queued' AND assigned_agent IS NOT NULL AND created_at < ?
     ) OR (
       status IN ('completed', 'failed', 'partial') AND notify_on_done = 1 AND delivered_at IS NULL AND notify_attempt_count >= 5
     )
     ORDER BY COALESCE(started_at, completed_at, created_at) ASC
     LIMIT 50`,
  ).all(now - 45 * 60, now - 2 * 3600) as MissionTask[];
}

export function resetStuckMissionTasks(agentId: string): number {
  const result = db.prepare(
    `UPDATE mission_tasks SET status = 'queued', started_at = NULL WHERE status = 'running' AND assigned_agent = ?`,
  ).run(agentId);
  return result.changes;
}

// ── Meet Sessions (Pika video meeting skill) ────────────────────────

export type MeetProvider = 'pika' | 'recall' | 'daily';

export interface MeetSession {
  id: string;
  agent_id: string;
  meet_url: string;
  bot_name: string;
  platform: string;
  provider: MeetProvider;
  status: 'joining' | 'live' | 'left' | 'failed';
  voice_id: string | null;
  image_path: string | null;
  brief_path: string | null;
  created_at: number;
  joined_at: number | null;
  left_at: number | null;
  post_notes: string | null;
  error: string | null;
}

export function createMeetSession(session: {
  id: string;
  agentId: string;
  meetUrl: string;
  botName: string;
  platform?: string;
  provider?: MeetProvider;
  voiceId?: string | null;
  imagePath?: string | null;
  briefPath?: string | null;
}): void {
  const now = Math.floor(Date.now() / 1000);
  db.prepare(
    `INSERT INTO meet_sessions (id, agent_id, meet_url, bot_name, platform, provider, status, voice_id, image_path, brief_path, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'joining', ?, ?, ?, ?)`,
  ).run(
    session.id,
    session.agentId,
    session.meetUrl,
    session.botName,
    session.platform ?? 'google_meet',
    session.provider ?? 'pika',
    session.voiceId ?? null,
    session.imagePath ?? null,
    session.briefPath ?? null,
    now,
  );
}

export function markMeetSessionLive(id: string): void {
  const now = Math.floor(Date.now() / 1000);
  db.prepare(
    `UPDATE meet_sessions SET status = 'live', joined_at = ? WHERE id = ?`,
  ).run(now, id);
}

export function markMeetSessionLeft(id: string, postNotes?: string | null): void {
  const now = Math.floor(Date.now() / 1000);
  db.prepare(
    `UPDATE meet_sessions SET status = 'left', left_at = ?, post_notes = ? WHERE id = ?`,
  ).run(now, postNotes ?? null, id);
}

export function markMeetSessionFailed(id: string, error: string): void {
  const now = Math.floor(Date.now() / 1000);
  db.prepare(
    `UPDATE meet_sessions SET status = 'failed', left_at = ?, error = ? WHERE id = ?`,
  ).run(now, error.slice(0, 2000), id);
}

export function getMeetSession(id: string): MeetSession | null {
  return (db.prepare('SELECT * FROM meet_sessions WHERE id = ?').get(id) as MeetSession) ?? null;
}

export function listActiveMeetSessions(): MeetSession[] {
  return db.prepare(
    `SELECT * FROM meet_sessions WHERE status IN ('joining', 'live') ORDER BY created_at DESC`,
  ).all() as MeetSession[];
}

export function listRecentMeetSessions(limit = 20): MeetSession[] {
  return db.prepare(
    `SELECT * FROM meet_sessions ORDER BY created_at DESC LIMIT ?`,
  ).all(limit) as MeetSession[];
}

// ── Audit Log ────────────────────────────────────────────────────────

export function insertAuditLog(
  agentId: string,
  chatId: string,
  action: string,
  detail: string,
  blocked: boolean,
): void {
  db.prepare(
    `INSERT INTO audit_log (agent_id, chat_id, action, detail, blocked, created_at) VALUES (?, ?, ?, ?, ?, strftime('%s','now'))`,
  ).run(agentId, chatId, action, detail.slice(0, 2000), blocked ? 1 : 0);
}

export interface AuditLogEntry {
  id: number;
  agent_id: string;
  chat_id: string;
  action: string;
  detail: string;
  blocked: number;
  created_at: number;
}

export function getAuditLog(limit = 50, offset = 0, agentId?: string): AuditLogEntry[] {
  if (agentId) {
    return db.prepare(
      `SELECT * FROM audit_log WHERE agent_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    ).all(agentId, limit, offset) as AuditLogEntry[];
  }
  return db.prepare(
    `SELECT * FROM audit_log ORDER BY created_at DESC LIMIT ? OFFSET ?`,
  ).all(limit, offset) as AuditLogEntry[];
}

export function getAuditLogCount(agentId?: string): number {
  if (agentId) {
    return (db.prepare('SELECT COUNT(*) as c FROM audit_log WHERE agent_id = ?').get(agentId) as { c: number }).c;
  }
  return (db.prepare('SELECT COUNT(*) as c FROM audit_log').get() as { c: number }).c;
}

export function getRecentBlockedActions(limit = 10): AuditLogEntry[] {
  return db.prepare(
    `SELECT * FROM audit_log WHERE blocked = 1 ORDER BY created_at DESC LIMIT ?`,
  ).all(limit) as AuditLogEntry[];
}

// ── Phase 2: Compaction events ────────────────────────────────────────

export function saveCompactionEvent(
  sessionId: string,
  preTokens: number,
  postTokens: number,
  turnCount: number,
): void {
  const now = Math.floor(Date.now() / 1000);
  db.prepare(
    `INSERT INTO compaction_events (session_id, pre_tokens, post_tokens, turn_count, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(sessionId, preTokens, postTokens, turnCount, now);
}

export function getCompactionCount(sessionId: string): number {
  return (db.prepare(
    'SELECT COUNT(*) as c FROM compaction_events WHERE session_id = ?',
  ).get(sessionId) as { c: number }).c;
}

export function getCompactionHistory(sessionId: string): Array<{
  id: number; session_id: string; pre_tokens: number; post_tokens: number;
  turn_count: number; created_at: number;
}> {
  return db.prepare(
    'SELECT * FROM compaction_events WHERE session_id = ? ORDER BY created_at DESC',
  ).all(sessionId) as Array<{
    id: number; session_id: string; pre_tokens: number; post_tokens: number;
    turn_count: number; created_at: number;
  }>;
}

// ── Phase 2: Session stats for /convolife ──────────────────────────────

export function getSessionStats(sessionId: string): {
  turnCount: number;
  totalCost: number;
  compactionCount: number;
  maxContextTokens: number;
} {
  const stats = db.prepare(`
    SELECT
      COUNT(*) as turnCount,
      COALESCE(SUM(cost_usd), 0) as totalCost,
      COALESCE(SUM(did_compact), 0) as compactionCount,
      COALESCE(MAX(context_tokens), 0) as maxContextTokens
    FROM token_usage WHERE session_id = ?
  `).get(sessionId) as {
    turnCount: number; totalCost: number;
    compactionCount: number; maxContextTokens: number;
  } | undefined;

  return stats ?? { turnCount: 0, totalCost: 0, compactionCount: 0, maxContextTokens: 0 };
}

// ── Phase 2: Memory nudge support ──────────────────────────────────────

export function getLastMemorySaveTime(chatId: string, agentId = 'main'): number | null {
  const row = db.prepare(
    'SELECT created_at FROM memories WHERE chat_id = ? AND agent_id = ? ORDER BY created_at DESC LIMIT 1',
  ).get(chatId, agentId) as { created_at: number } | undefined;
  return row?.created_at ?? null;
}

export function getTurnCountSinceTimestamp(chatId: string, sinceTimestamp: number, agentId = 'main'): number {
  const row = db.prepare(
    'SELECT COUNT(*) as c FROM conversation_log WHERE chat_id = ? AND agent_id = ? AND role = ? AND created_at > ?',
  ).get(chatId, agentId, 'user', sinceTimestamp) as { c: number };
  return row.c;
}

// ── Phase 4: Skill health & usage ────────────────────────────────────

export function upsertSkillHealth(
  skillId: string,
  status: string,
  errorMsg = '',
): void {
  const now = Math.floor(Date.now() / 1000);
  db.prepare(`
    INSERT INTO skill_health (skill_id, status, error_msg, last_check, created_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(skill_id) DO UPDATE SET status = ?, error_msg = ?, last_check = ?
  `).run(skillId, status, errorMsg, now, now, status, errorMsg, now);
}

export function getSkillHealth(skillId: string): { status: string; error_msg: string; last_check: number } | undefined {
  return db.prepare('SELECT status, error_msg, last_check FROM skill_health WHERE skill_id = ?')
    .get(skillId) as { status: string; error_msg: string; last_check: number } | undefined;
}

export function getAllSkillHealth(): Array<{ skill_id: string; status: string; error_msg: string; last_check: number }> {
  return db.prepare('SELECT * FROM skill_health ORDER BY skill_id').all() as Array<{
    skill_id: string; status: string; error_msg: string; last_check: number;
  }>;
}

export function logSkillUsage(
  skillId: string,
  chatId: string,
  agentId: string,
  tokensUsed: number,
  succeeded: boolean,
): void {
  const now = Math.floor(Date.now() / 1000);
  db.prepare(
    `INSERT INTO skill_usage (skill_id, chat_id, agent_id, triggered_at, tokens_used, succeeded)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(skillId, chatId, agentId, now, tokensUsed, succeeded ? 1 : 0);
}

export function getSkillUsageStats(): Array<{
  skill_id: string; count: number; last_used: number; total_tokens: number;
}> {
  return db.prepare(`
    SELECT skill_id,
           COUNT(*) as count,
           MAX(triggered_at) as last_used,
           SUM(tokens_used) as total_tokens
    FROM skill_usage
    GROUP BY skill_id
    ORDER BY count DESC
  `).all() as Array<{
    skill_id: string; count: number; last_used: number; total_tokens: number;
  }>;
}

// ── Phase 6: Session summaries ────────────────────────────────────────

export function saveSessionSummary(
  sessionId: string,
  summary: string,
  keyDecisions: string[],
  turnCount: number,
  totalCost: number,
): void {
  const now = Math.floor(Date.now() / 1000);
  db.prepare(`
    INSERT INTO session_summaries (session_id, summary, key_decisions, turn_count, total_cost, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(session_id) DO UPDATE SET summary = ?, key_decisions = ?, turn_count = ?, total_cost = ?, created_at = ?
  `).run(sessionId, summary, JSON.stringify(keyDecisions), turnCount, totalCost, now,
    summary, JSON.stringify(keyDecisions), turnCount, totalCost, now);
}

export function getSessionSummary(sessionId: string): {
  summary: string; key_decisions: string; turn_count: number; total_cost: number;
} | undefined {
  return db.prepare('SELECT summary, key_decisions, turn_count, total_cost FROM session_summaries WHERE session_id = ?')
    .get(sessionId) as { summary: string; key_decisions: string; turn_count: number; total_cost: number } | undefined;
}

// ── War Room meeting history ─────────────────────────────────────────────

export function createWarRoomMeeting(id: string, mode: string, pinnedAgent: string): void {
  db.prepare(
    'INSERT OR IGNORE INTO warroom_meetings (id, started_at, mode, pinned_agent) VALUES (?, ?, ?, ?)',
  ).run(id, Math.floor(Date.now() / 1000), mode, pinnedAgent);
}

export function endWarRoomMeeting(id: string, entryCount: number): void {
  const now = Math.floor(Date.now() / 1000);
  db.prepare(
    'UPDATE warroom_meetings SET ended_at = ?, duration_s = ended_at - started_at, entry_count = ? WHERE id = ?',
  ).run(now, entryCount, id);
  // Actually compute duration correctly
  db.prepare(
    'UPDATE warroom_meetings SET duration_s = ? - started_at WHERE id = ?',
  ).run(now, id);
}

export function addWarRoomTranscript(meetingId: string, speaker: string, text: string): void {
  db.prepare(
    'INSERT INTO warroom_transcript (meeting_id, speaker, text, created_at) VALUES (?, ?, ?, ?)',
  ).run(meetingId, speaker, text, Math.floor(Date.now() / 1000));
}

export function getWarRoomMeetings(limit = 20): Array<{
  id: string; started_at: number; ended_at: number | null; duration_s: number | null;
  mode: string; pinned_agent: string; entry_count: number;
}> {
  return db.prepare(
    'SELECT * FROM warroom_meetings ORDER BY started_at DESC LIMIT ?',
  ).all(limit) as any[];
}

export function getWarRoomTranscript(meetingId: string): Array<{
  speaker: string; text: string; created_at: number;
}> {
  return db.prepare(
    'SELECT speaker, text, created_at FROM warroom_transcript WHERE meeting_id = ? ORDER BY created_at',
  ).all(meetingId) as any[];
}

// ── Telegram durable outbox ───────────────────────────────────────────
//
// Every Telegram send is INSERTed here with status='pending'. A worker
// (src/telegram-outbox.ts, ticked from the scheduler) drains pending rows,
// makes the actual API call, and on failure schedules a retry via
// exponential backoff or a 429-honouring delay. After MAX_ATTEMPTS the row
// is moved to 'dead-lettered' and a meta-alert is enqueued so the failure
// is visible.

export type TelegramOutboxStatus = 'pending' | 'in_flight' | 'sent' | 'failed' | 'dead-lettered';

export interface TelegramOutboxRow {
  id: number;
  agent_id: string;
  chat_id: string;
  payload: string;
  status: TelegramOutboxStatus;
  attempt_count: number;
  last_error: string | null;
  last_attempt_at: number | null;
  next_retry_at: number | null;
  lease_expires_at: number | null;
  telegram_message_id: number | null;
  created_at: number;
  sent_at: number | null;
}

/** Lease duration for an in_flight claim. The worker must complete the
 * send (and call markTelegramOutboxSent / scheduleTelegramOutboxRetry /
 * markTelegramOutboxDeadLettered, all of which clear the lease) before
 * lease_expires_at. If a worker crashes mid-send, the recovery sweep
 * resets the row to pending after this many seconds. */
/**
 * Lease length is bumped well above any plausible Telegram API call so the
 * recovery sweep only fires for true crashes (process death). The
 * within-process double-send window is closed by an in-memory single-flight
 * Set in telegram-outbox.ts; the lease guards crashes only.
 */
export const TELEGRAM_OUTBOX_LEASE_SECONDS = 5 * 60;

/** Insert a pending outbox row. Returns the new row id. */
export function insertTelegramOutbox(
  agentId: string,
  chatId: string,
  payload: string,
): number {
  const now = Math.floor(Date.now() / 1000);
  const info = db.prepare(
    `INSERT INTO telegram_outbox (agent_id, chat_id, payload, status, created_at)
     VALUES (?, ?, ?, 'pending', ?)`,
  ).run(agentId, chatId, payload, now);
  return Number(info.lastInsertRowid);
}

/**
 * Atomically claim up to `limit` due rows: pending → in_flight via
 * UPDATE-RETURNING. Two concurrent workers cannot claim the same row;
 * whichever runs the UPDATE first wins, the loser sees zero affected
 * rows. The lease (`lease_expires_at`) covers worker crashes — see
 * sweepStalledTelegramOutboxLeases.
 *
 * Implementation note: sqlite RETURNING (>=3.35) gives us the row in
 * one shot. Since better-sqlite3 doesn't iterate per-row UPDATE...
 * RETURNING with LIMIT in a single statement portably across versions,
 * we select candidate ids first then CAS each. The SELECT is advisory;
 * the UPDATE is the real lock.
 */
export function claimDueTelegramOutbox(limit = 20, agentId?: string): TelegramOutboxRow[] {
  const now = Math.floor(Date.now() / 1000);
  const leaseUntil = now + TELEGRAM_OUTBOX_LEASE_SECONDS;
  // Scope the claim to the calling agent. Each agent runs its own outbox
  // tick on its own process and delivers via its own bot token. Without
  // an agent_id filter, agents race each other for any pending row and
  // send via the WRONG bot — caught 2026-05-05 when Mason's tick beat
  // main's tick to the morning brief and delivered it via @SonkeMason_bot
  // instead of main's bot. agentId is optional only so the legacy unit
  // tests that don't run a real bot keep working; production callers
  // (tickTelegramOutbox) always pass it.
  const agentFilter = agentId ? 'AND agent_id = ?' : '';
  const candidateParams: (number | string)[] = agentId ? [now, agentId, limit] : [now, limit];
  const candidates = db.prepare(
    `SELECT id FROM telegram_outbox
     WHERE status = 'pending'
       AND (next_retry_at IS NULL OR next_retry_at <= ?)
       ${agentFilter}
     ORDER BY id ASC
     LIMIT ?`,
  ).all(...candidateParams) as Array<{ id: number }>;

  const claimStmt = db.prepare(
    `UPDATE telegram_outbox
     SET status = 'in_flight',
         lease_expires_at = ?,
         last_attempt_at = ?
     WHERE id = ?
       AND status = 'pending'
       AND (next_retry_at IS NULL OR next_retry_at <= ?)
       ${agentId ? 'AND agent_id = ?' : ''}
     RETURNING *`,
  );

  const claimed: TelegramOutboxRow[] = [];
  for (const c of candidates) {
    const row = (agentId
      ? claimStmt.get(leaseUntil, now, c.id, now, agentId)
      : claimStmt.get(leaseUntil, now, c.id, now)) as TelegramOutboxRow | undefined;
    if (row) claimed.push(row);
    // If undefined, another worker beat us to this row — skip silently.
  }
  return claimed;
}

/**
 * Reset rows whose in_flight lease has expired (worker crashed mid-send).
 * Returns the number of rows recovered. Counts as an attempt so a
 * row that consistently kills its worker eventually dead-letters.
 */
export function sweepStalledTelegramOutboxLeases(): number {
  const now = Math.floor(Date.now() / 1000);
  const info = db.prepare(
    `UPDATE telegram_outbox
     SET status = 'pending',
         lease_expires_at = NULL,
         attempt_count = attempt_count + 1,
         last_error = COALESCE(last_error, '') || ' [lease expired]'
     WHERE status = 'in_flight'
       AND lease_expires_at IS NOT NULL
       AND lease_expires_at <= ?`,
  ).run(now);
  return info.changes;
}

export function markTelegramOutboxSent(id: number, telegramMessageId: number | null): void {
  const now = Math.floor(Date.now() / 1000);
  db.prepare(
    `UPDATE telegram_outbox
     SET status = 'sent',
         telegram_message_id = ?,
         sent_at = ?,
         last_attempt_at = ?,
         attempt_count = attempt_count + 1,
         lease_expires_at = NULL,
         last_error = NULL
     WHERE id = ? AND status = 'in_flight'`,
  ).run(telegramMessageId, now, now, id);
}

export function scheduleTelegramOutboxRetry(
  id: number,
  nextRetryAt: number,
  lastError: string,
): void {
  const now = Math.floor(Date.now() / 1000);
  // Allow this to recover both the legacy 'pending' path (used by tests
  // that fast-forward next_retry_at on a row that never got claimed)
  // AND the new 'in_flight' path post-CAS.
  db.prepare(
    `UPDATE telegram_outbox
     SET status = 'pending',
         attempt_count = attempt_count + 1,
         last_attempt_at = ?,
         next_retry_at = ?,
         lease_expires_at = NULL,
         last_error = ?
     WHERE id = ? AND status IN ('pending', 'in_flight')`,
  ).run(now, nextRetryAt, lastError.slice(0, 500), id);
}

export function markTelegramOutboxDeadLettered(id: number, lastError: string): void {
  const now = Math.floor(Date.now() / 1000);
  db.prepare(
    `UPDATE telegram_outbox
     SET status = 'dead-lettered',
         attempt_count = attempt_count + 1,
         last_attempt_at = ?,
         lease_expires_at = NULL,
         last_error = ?
     WHERE id = ? AND status IN ('pending', 'in_flight')`,
  ).run(now, lastError.slice(0, 500), id);
}

export function getTelegramOutboxRow(id: number): TelegramOutboxRow | null {
  const row = db.prepare(`SELECT * FROM telegram_outbox WHERE id = ?`).get(id) as TelegramOutboxRow | undefined;
  return row ?? null;
}

export function countTelegramOutboxByStatus(): Record<TelegramOutboxStatus, number> {
  const rows = db.prepare(
    `SELECT status, COUNT(*) AS n FROM telegram_outbox GROUP BY status`,
  ).all() as Array<{ status: TelegramOutboxStatus; n: number }>;
  const out: Record<TelegramOutboxStatus, number> = { 'pending': 0, 'in_flight': 0, 'sent': 0, 'failed': 0, 'dead-lettered': 0 };
  for (const r of rows) out[r.status] = r.n;
  return out;
}

export interface TelegramOutboxStats {
  pending: number;
  in_flight: number;
  sent: number;
  failed: number;
  deadLettered: number;
  oldestUnsentAgeSeconds: number | null;
}

/** Aggregate stats for /status: counts + oldest unsent age. */
export function getOutboxStats(): TelegramOutboxStats {
  const counts = countTelegramOutboxByStatus();
  const oldest = db.prepare(
    `SELECT MIN(created_at) AS m FROM telegram_outbox
     WHERE status IN ('pending', 'in_flight')`,
  ).get() as { m: number | null };
  const now = Math.floor(Date.now() / 1000);
  return {
    pending: counts.pending,
    in_flight: counts.in_flight,
    sent: counts.sent,
    failed: counts.failed,
    deadLettered: counts['dead-lettered'],
    oldestUnsentAgeSeconds: oldest.m == null ? null : Math.max(0, now - oldest.m),
  };
}

/**
 * Prune sent and dead-lettered outbox rows older than `olderThanDays`.
 * Without this the outbox grows unbounded — every Telegram message ever
 * sent stays in the table forever, eventually choking sqlite. Called from
 * the same daily cleanup path as `cleanupOldMissionTasks`.
 *
 * Pending and in_flight rows are NEVER pruned regardless of age — those
 * still represent undelivered work or an in-progress send.
 */
export function pruneSentTelegramOutbox(olderThanDays = 7): number {
  const cutoff = Math.floor(Date.now() / 1000) - olderThanDays * 86400;
  // sent rows use sent_at; dead-lettered rows have last_attempt_at as the
  // most-recent terminal timestamp. Fall back to created_at so a row
  // missing both columns (shouldn't happen, but defensively) still ages out.
  const result = db.prepare(
    `DELETE FROM telegram_outbox
     WHERE status IN ('sent', 'dead-lettered')
       AND COALESCE(sent_at, last_attempt_at, created_at) < ?`,
  ).run(cutoff);
  return result.changes;
}

// ── Operation Notifications ─────────────────────────────────────────
//
// Durable, scheduler-driven notifications. Replaces ScheduleWakeup, which
// is cancelled the moment the user replies and therefore can't survive the
// agent's session ending. Rows fire from the main process tick.
//
// Status lifecycle: pending → fired | cancelled | expired.

export interface OperationNotificationRow {
  id: number;
  agent_id: string;
  chat_id: string;
  operation_id: string;
  fire_at: number;
  status: 'pending' | 'fired' | 'cancelled' | 'expired';
  payload: string;
  fired_at: number | null;
  cancelled_at: number | null;
  created_at: number;
}

export function insertOperationNotification(opts: {
  agentId: string;
  chatId: string;
  operationId: string;
  fireAt: number;
  payload: string;
}): number {
  const now = Math.floor(Date.now() / 1000);
  const info = db.prepare(
    `INSERT INTO operation_notifications
       (agent_id, chat_id, operation_id, fire_at, status, payload, created_at)
     VALUES (?, ?, ?, ?, 'pending', ?, ?)`,
  ).run(opts.agentId, opts.chatId, opts.operationId, opts.fireAt, opts.payload, now);
  return Number(info.lastInsertRowid);
}

export function getDueOperationNotifications(now?: number): OperationNotificationRow[] {
  const cutoff = now ?? Math.floor(Date.now() / 1000);
  return db.prepare(
    `SELECT * FROM operation_notifications
       WHERE status = 'pending' AND fire_at <= ?
       ORDER BY fire_at ASC`,
  ).all(cutoff) as OperationNotificationRow[];
}

export function getOperationNotification(id: number): OperationNotificationRow | undefined {
  return db.prepare('SELECT * FROM operation_notifications WHERE id = ?')
    .get(id) as OperationNotificationRow | undefined;
}

export function getOperationNotificationsByOpId(operationId: string): OperationNotificationRow[] {
  return db.prepare(
    'SELECT * FROM operation_notifications WHERE operation_id = ? ORDER BY id ASC',
  ).all(operationId) as OperationNotificationRow[];
}

/**
 * Atomically claim a pending row by id. Returns true iff this caller won
 * the claim race. Stamps status='fired' + fired_at; safe against double-fire
 * across overlapping ticks.
 */
export function claimOperationNotification(id: number): boolean {
  const now = Math.floor(Date.now() / 1000);
  const info = db.prepare(
    `UPDATE operation_notifications
       SET status = 'fired', fired_at = ?
       WHERE id = ? AND status = 'pending'`,
  ).run(now, id);
  return info.changes > 0;
}

/**
 * Atomic claim + outbox enqueue for operation_notifications.
 *
 * Solves the crash-mid-handoff bug: if the claim and the enqueue are
 * in separate transactions, a process crash between them marks the
 * row 'fired' but never enqueues the message — silent loss.
 *
 * This wraps both writes in a single sqlite transaction. Either both
 * commit or neither does. Returns the outbox row id on success, or
 * null if the row was already claimed (lost the race).
 */
export function claimAndEnqueueOperationNotification(
  rowId: number,
  enqueue: { agentId: string; chatId: string; payload: string },
): number | null {
  const now = Math.floor(Date.now() / 1000);
  let outboxId: number | null = null;
  const txn = db.transaction(() => {
    const claimInfo = db.prepare(
      `UPDATE operation_notifications
         SET status = 'fired', fired_at = ?
         WHERE id = ? AND status = 'pending'`,
    ).run(now, rowId);
    if (claimInfo.changes === 0) return;
    const insertInfo = db.prepare(
      `INSERT INTO telegram_outbox (agent_id, chat_id, payload, status, created_at)
       VALUES (?, ?, ?, 'pending', ?)`,
    ).run(enqueue.agentId, enqueue.chatId, enqueue.payload, now);
    outboxId = Number(insertInfo.lastInsertRowid);
  });
  txn();
  return outboxId;
}

/**
 * Cancel all pending rows for an operation_id. Already-fired rows are
 * untouched. Returns the number of rows actually cancelled.
 */
export function cancelOperationNotificationsByOpId(operationId: string): number {
  const now = Math.floor(Date.now() / 1000);
  const info = db.prepare(
    `UPDATE operation_notifications
       SET status = 'cancelled', cancelled_at = ?
       WHERE operation_id = ? AND status = 'pending'`,
  ).run(now, operationId);
  return info.changes;
}

/** @internal — test seam, lets a test claim back a row to retry. */
export function _resetOperationNotificationForTest(id: number): void {
  db.prepare(
    `UPDATE operation_notifications SET status = 'pending', fired_at = NULL WHERE id = ?`,
  ).run(id);
}
