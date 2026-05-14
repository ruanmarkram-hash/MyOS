// Runs before any test module imports. Sets the env vars that config.ts
// reads at import time so contract tests can build a working dashboard
// app without polluting the developer's real .env or DB.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DASHBOARD_TOKEN = process.env.DASHBOARD_TOKEN || 'test-contract-token';
process.env.DASHBOARD_MUTATIONS_ENABLED = process.env.DASHBOARD_MUTATIONS_ENABLED || 'true';
process.env.WARROOM_ENABLED = process.env.WARROOM_ENABLED || 'false';
process.env.ALLOWED_CHAT_ID = process.env.ALLOWED_CHAT_ID || 'test-chat';
process.env.DB_ENCRYPTION_KEY = process.env.DB_ENCRYPTION_KEY || '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

const testConfigDir = path.join(os.tmpdir(), 'myos-test-config');
const testAgentsDir = path.join(testConfigDir, 'agents');
fs.mkdirSync(testAgentsDir, { recursive: true });

for (const id of ['charter', 'ember', 'marlow', 'mason', 'warden', 'comms', 'content', 'ops', 'research']) {
  const dir = path.join(testAgentsDir, id);
  fs.mkdirSync(dir, { recursive: true });
  const displayName = id.charAt(0).toUpperCase() + id.slice(1);
  fs.writeFileSync(
    path.join(dir, 'agent.yaml'),
    [
      `name: ${displayName}`,
      `description: Test ${displayName} agent`,
      `telegram_bot_token_env: ${id.toUpperCase()}_BOT_TOKEN`,
      'model: gpt-5.4',
      '',
    ].join('\n'),
    'utf-8',
  );
  fs.writeFileSync(path.join(dir, 'CLAUDE.md'), `# ${displayName}\n\nTest agent.\n`, 'utf-8');
}

process.env.MYOS_CONFIG = process.env.MYOS_CONFIG || testConfigDir;
