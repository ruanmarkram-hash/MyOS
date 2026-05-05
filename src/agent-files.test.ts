// Phase C1.a tests: atomic write helper, history append, allowlist refusal.
//
// The dashboard contract test for the API surface lives in
// agent-files.contract.test.ts so the unit tests here stay free of the
// Hono/transport layer.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { _initTestDatabase, listAgentFileHistory } from './db.js';
import {
  atomicWrite,
  sha256,
  saveEditableFile,
  readEditableFile,
  listEditableFiles,
  isEditableFileId,
  EditorError,
} from './agent-files.js';
import * as configMod from './config.js';
import { PROJECT_ROOT, setAgentSystemPrompt } from './config.js';

describe('atomicWrite', () => {
  it('writes content to the target path', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cclaw-atomic-'));
    const target = path.join(dir, 'sample.md');
    atomicWrite(target, 'hello');
    expect(fs.readFileSync(target, 'utf-8')).toBe('hello');
  });

  it('overwrites existing files atomically', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cclaw-atomic-'));
    const target = path.join(dir, 'sample.md');
    fs.writeFileSync(target, 'original');
    atomicWrite(target, 'replaced');
    expect(fs.readFileSync(target, 'utf-8')).toBe('replaced');
  });

  it('leaves no temp files behind on success', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cclaw-atomic-'));
    const target = path.join(dir, 'sample.md');
    atomicWrite(target, 'hello');
    const leftovers = fs.readdirSync(dir).filter((n) => n.startsWith('.sample.md.tmp'));
    expect(leftovers).toEqual([]);
  });

  it('writes the right bytes for unicode content', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cclaw-atomic-'));
    const target = path.join(dir, 'unicode.md');
    const text = '🌱 Sage and a long dash';
    atomicWrite(target, text);
    expect(fs.readFileSync(target, 'utf-8')).toBe(text);
  });
});

describe('sha256', () => {
  it('matches the standard sha-256 hex digest', () => {
    expect(sha256('hello')).toBe(
      '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
    );
  });
});

describe('allowlist', () => {
  it('exposes exactly one editable file today (main)', () => {
    const files = listEditableFiles();
    expect(files.map((f) => f.id)).toEqual(['main']);
    expect(files[0].path).toBe(path.join(PROJECT_ROOT, 'CLAUDE.md'));
  });

  it('isEditableFileId only accepts known ids', () => {
    expect(isEditableFileId('main')).toBe(true);
    expect(isEditableFileId('charter')).toBe(false);
    expect(isEditableFileId('../etc/passwd')).toBe(false);
    expect(isEditableFileId('')).toBe(false);
  });

  it('readEditableFile refuses unknown ids with a 400-coded EditorError', () => {
    expect(() => readEditableFile('charter')).toThrowError(EditorError);
    try {
      readEditableFile('charter');
    } catch (err) {
      expect((err as EditorError).status).toBe(400);
    }
  });

  it('saveEditableFile refuses unknown ids before touching disk', () => {
    expect(() =>
      saveEditableFile('not-a-real-id', 'pwned', { editedByChatId: 'tester' }),
    ).toThrowError(EditorError);
  });
});

describe('saveEditableFile (history append + hot-reload)', () => {
  const claudeMdPath = path.join(PROJECT_ROOT, 'CLAUDE.md');
  let snapshot: string | null = null;
  let snapshotPrompt: string | undefined;

  beforeEach(() => {
    _initTestDatabase();
    snapshot = fs.existsSync(claudeMdPath) ? fs.readFileSync(claudeMdPath, 'utf-8') : null;
    snapshotPrompt = configMod.agentSystemPrompt;
  });

  afterEach(() => {
    if (snapshot !== null) fs.writeFileSync(claudeMdPath, snapshot);
    setAgentSystemPrompt(snapshotPrompt);
  });

  it('appends a history row whose sha matches the persisted bytes', () => {
    const newContent = '# Test rules\nSage stays chill.\n';
    const result = saveEditableFile('main', newContent, { editedByChatId: 'tester' });
    expect(result.contentSha).toBe(sha256(newContent));
    expect(fs.readFileSync(claudeMdPath, 'utf-8')).toBe(newContent);

    const history = listAgentFileHistory(claudeMdPath);
    expect(history.length).toBe(1);
    expect(history[0].content).toBe(newContent);
    expect(history[0].content_sha).toBe(result.contentSha);
    expect(history[0].edited_by_chat_id).toBe('tester');
  });

  it('updates the in-memory agentSystemPrompt for hot-reload', () => {
    const newContent = '## Hot reload sentinel ' + Date.now();
    const result = saveEditableFile('main', newContent, { editedByChatId: 'tester' });
    expect(result.hotReloaded).toBe(true);
    expect(configMod.agentSystemPrompt).toBe(newContent);
  });

  it('refuses stale writes when expectedSha mismatches on-disk content', () => {
    fs.writeFileSync(claudeMdPath, 'on-disk version A');
    expect(() =>
      saveEditableFile('main', 'attempted overwrite', {
        editedByChatId: 'tester',
        expectedSha: sha256('stale value the client thought was current'),
      }),
    ).toThrowError(/changed on disk/i);
    expect(fs.readFileSync(claudeMdPath, 'utf-8')).toBe('on-disk version A');
  });
});
