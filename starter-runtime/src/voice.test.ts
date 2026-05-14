import { describe, it, expect, vi, beforeEach } from 'vitest';
import { execFileSync } from 'child_process';
import path from 'path';
import fs from 'fs';

vi.mock('./env.js', () => ({
  readEnvFile: vi.fn(),
}));

vi.mock('./logger.js', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('./safe-spawn.js', () => ({
  safeExecFileAsync: vi.fn(),
}));

import { voiceCapabilities, synthesizeSpeechLocal, transcribeAudio, UPLOADS_DIR } from './voice.js';
import { readEnvFile } from './env.js';
import { safeExecFileAsync } from './safe-spawn.js';

const mockReadEnvFile = vi.mocked(readEnvFile);
const mockSafeExecFileAsync = vi.mocked(safeExecFileAsync);
const isMac = process.platform === 'darwin';

function hasFfmpeg(): boolean {
  try {
    execFileSync('which', ['ffmpeg'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

describe('voiceCapabilities', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns tts based on platform when no env vars set', () => {
    mockReadEnvFile.mockReturnValue({});
    const result = voiceCapabilities();
    expect(result).toEqual({ stt: false, tts: isMac });
  });

  it('returns stt=true when GROQ_API_KEY is set', () => {
    mockReadEnvFile.mockReturnValue({ GROQ_API_KEY: 'gsk_test123' });
    const result = voiceCapabilities();
    expect(result).toEqual({ stt: true, tts: isMac });
  });

  it('returns tts based on platform when only ELEVENLABS_API_KEY set (missing voice ID)', () => {
    mockReadEnvFile.mockReturnValue({ ELEVENLABS_API_KEY: 'el_test123' });
    const result = voiceCapabilities();
    expect(result).toEqual({ stt: false, tts: isMac });
  });

  it('returns tts=true when both ELEVENLABS keys set', () => {
    mockReadEnvFile.mockReturnValue({
      ELEVENLABS_API_KEY: 'el_test123',
      ELEVENLABS_VOICE_ID: 'voice_abc',
    });
    const result = voiceCapabilities();
    expect(result).toEqual({ stt: false, tts: true });
  });

  it('returns tts based on platform when only GRADIUM_API_KEY set (missing voice ID)', () => {
    mockReadEnvFile.mockReturnValue({ GRADIUM_API_KEY: 'gd_test123' });
    const result = voiceCapabilities();
    expect(result).toEqual({ stt: false, tts: isMac });
  });

  it('returns tts=true when both GRADIUM keys set', () => {
    mockReadEnvFile.mockReturnValue({
      GRADIUM_API_KEY: 'gd_test123',
      GRADIUM_VOICE_ID: 'voice_abc',
    });
    const result = voiceCapabilities();
    expect(result).toEqual({ stt: false, tts: true });
  });

  it('returns all true when all providers set', () => {
    mockReadEnvFile.mockReturnValue({
      GROQ_API_KEY: 'gsk_test123',
      ELEVENLABS_API_KEY: 'el_test123',
      ELEVENLABS_VOICE_ID: 'voice_abc',
      GRADIUM_API_KEY: 'gd_test123',
      GRADIUM_VOICE_ID: 'voice_def',
    });
    const result = voiceCapabilities();
    expect(result).toEqual({ stt: true, tts: true });
  });
});

describe('synthesizeSpeechLocal', () => {
  it('produces a non-empty OGG buffer on macOS', async () => {
    if (!isMac) return;
    if (!hasFfmpeg()) return;
    // Restore real safeExecFileAsync for this end-to-end check.
    const real = await vi.importActual<typeof import('./safe-spawn.js')>('./safe-spawn.js');
    mockSafeExecFileAsync.mockImplementation(real.safeExecFileAsync);
    mockReadEnvFile.mockReturnValue({});
    const buffer = await synthesizeSpeechLocal('Hello, this is a test.');
    expect(buffer).toBeInstanceOf(Buffer);
    expect(buffer.length).toBeGreaterThan(0);
  }, 15000);
});

// ── safe-spawn migration coverage ─────────────────────────────────────────────
//
// These tests assert the recently-migrated voice spawn sites route through
// safeExecFileAsync with envClass: 'system-tool', not raw execFile.
// They mock safe-spawn entirely so no real subprocess is spawned.

describe('voice.ts safe-spawn migration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockReadEnvFile.mockReturnValue({});
  });

  describe('hasFfmpeg / synthesizeSpeechLocal', () => {
    it('uses safeExecFileAsync with envClass system-tool for ffmpeg version probe', async () => {
      if (!isMac) return;
      // Stub safeExecFileAsync to succeed and bypass real subprocesses.
      mockSafeExecFileAsync.mockResolvedValue({ stdout: '', stderr: '' });
      // Stub fs.readFileSync so we don't actually need the produced file.
      const readSpy = vi.spyOn(fs, 'readFileSync').mockReturnValue(Buffer.from('fake-ogg'));
      const unlinkSpy = vi.spyOn(fs, 'unlinkSync').mockImplementation(() => undefined);
      try {
        await synthesizeSpeechLocal('hello');
      } finally {
        readSpy.mockRestore();
        unlinkSpy.mockRestore();
      }
      // ffmpeg version probe (hasFfmpeg) is the first call.
      const ffmpegProbe = mockSafeExecFileAsync.mock.calls.find(
        (c) => c[0] === 'ffmpeg' && Array.isArray(c[1]) && c[1][0] === '-version',
      );
      expect(ffmpegProbe).toBeDefined();
      expect(ffmpegProbe?.[2]).toMatchObject({ envClass: 'system-tool' });
    });

    it('uses safeExecFileAsync with envClass system-tool for /usr/bin/say and ffmpeg encode', async () => {
      if (!isMac) return;
      mockSafeExecFileAsync.mockResolvedValue({ stdout: '', stderr: '' });
      const readSpy = vi.spyOn(fs, 'readFileSync').mockReturnValue(Buffer.from('fake-ogg'));
      const unlinkSpy = vi.spyOn(fs, 'unlinkSync').mockImplementation(() => undefined);
      try {
        await synthesizeSpeechLocal('hello');
      } finally {
        readSpy.mockRestore();
        unlinkSpy.mockRestore();
      }
      const sayCall = mockSafeExecFileAsync.mock.calls.find((c) => c[0] === '/usr/bin/say');
      expect(sayCall).toBeDefined();
      expect(sayCall?.[2]).toMatchObject({ envClass: 'system-tool' });

      const encodeCall = mockSafeExecFileAsync.mock.calls.find(
        (c) => c[0] === 'ffmpeg' && Array.isArray(c[1]) && c[1].includes('-c:a'),
      );
      expect(encodeCall).toBeDefined();
      expect(encodeCall?.[2]).toMatchObject({ envClass: 'system-tool' });
    });
  });

  describe('transcribeAudio (whisper-cpp local fallback)', () => {
    it('uses safeExecFileAsync system-tool for ffmpeg WAV conversion and whisper-cpp', async () => {
      // No GROQ_API_KEY → fall straight to local whisper-cpp path.
      mockReadEnvFile.mockReturnValue({
        WHISPER_CPP_PATH: '/usr/local/bin/whisper-cpp',
        WHISPER_MODEL_PATH: '/tmp/fake-model.bin',
      });
      // Two calls: ffmpeg conversion (no stdout needed) then whisper-cpp (stdout JSON).
      mockSafeExecFileAsync
        .mockResolvedValueOnce({ stdout: '', stderr: '' })
        .mockResolvedValueOnce({ stdout: JSON.stringify({ transcription: [{ text: 'hi' }] }), stderr: '' });
      const unlinkSpy = vi.spyOn(fs, 'unlinkSync').mockImplementation(() => undefined);
      try {
        const text = await transcribeAudio('/tmp/fake-input.ogg');
        expect(text).toBe('hi');
      } finally {
        unlinkSpy.mockRestore();
      }

      // ffmpeg WAV conversion call
      const ffmpegCall = mockSafeExecFileAsync.mock.calls.find(
        (c) => c[0] === 'ffmpeg' && Array.isArray(c[1]) && c[1].includes('-ar'),
      );
      expect(ffmpegCall).toBeDefined();
      expect(ffmpegCall?.[2]).toMatchObject({ envClass: 'system-tool' });

      // whisper-cpp call
      const whisperCall = mockSafeExecFileAsync.mock.calls.find(
        (c) => c[0] === '/usr/local/bin/whisper-cpp',
      );
      expect(whisperCall).toBeDefined();
      expect(whisperCall?.[2]).toMatchObject({ envClass: 'system-tool' });
    });
  });
});

describe('UPLOADS_DIR', () => {
  it('is an absolute path', () => {
    expect(path.isAbsolute(UPLOADS_DIR)).toBe(true);
  });

  it('ends with workspace/uploads', () => {
    expect(UPLOADS_DIR).toMatch(/workspace[/\\]uploads$/);
  });
});
