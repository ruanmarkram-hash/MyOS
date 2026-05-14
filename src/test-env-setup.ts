import fs from 'fs';
import os from 'os';
import path from 'path';

// Runs before any test module imports. Sets the env vars that config.ts
// reads at import time so contract tests can build a working dashboard
// app without polluting the developer's real .env or DB.
process.env.DASHBOARD_TOKEN = process.env.DASHBOARD_TOKEN || 'test-contract-token';
process.env.DASHBOARD_MUTATIONS_ENABLED = process.env.DASHBOARD_MUTATIONS_ENABLED || 'true';
process.env.WARROOM_ENABLED = process.env.WARROOM_ENABLED || 'false';
process.env.ALLOWED_CHAT_ID = process.env.ALLOWED_CHAT_ID || 'test-chat-id';
process.env.DB_ENCRYPTION_KEY = process.env.DB_ENCRYPTION_KEY || '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

const testConfigDir = path.join(os.tmpdir(), 'myos-test-config');
process.env.MYOS_CONFIG = process.env.MYOS_CONFIG || testConfigDir;

const testAgents = [
  'charter',
  'comms',
  'content',
  'ember',
  'marlow',
  'mason',
  'ops',
  'research',
  'warden',
];

for (const id of testAgents) {
  const agentDir = path.join(testConfigDir, 'agents', id);
  fs.mkdirSync(agentDir, { recursive: true });
  const tokenEnv = `${id.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_BOT_TOKEN`;
  process.env[tokenEnv] = process.env[tokenEnv] || `test-${id}-token`;
  const yamlPath = path.join(agentDir, 'agent.yaml');
  if (!fs.existsSync(yamlPath)) {
    fs.writeFileSync(
      yamlPath,
      [
        `name: ${id[0].toUpperCase()}${id.slice(1)}`,
        `description: Test ${id} agent`,
        `telegram_bot_token_env: ${tokenEnv}`,
        'model: claude-sonnet-4-6',
        '',
      ].join('\n'),
      'utf-8',
    );
  }
}
