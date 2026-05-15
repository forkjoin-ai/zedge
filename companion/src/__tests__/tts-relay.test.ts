import { afterEach, describe, expect, test } from '@a0n/gnosis/test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  configureTtsRelay,
  getTtsRelayStatus,
  handleTtsPreviewRequest,
  handleTtsSpeakRequest,
  listTtsVoices,
  resolveTtsAudioMode,
} from '../tts-relay.ts';

const wavBytes = new Uint8Array([
  0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00,
  0x57, 0x41, 0x56, 0x45, 0x66, 0x6d, 0x74, 0x20,
  0x10, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00,
  0xc0, 0x5d, 0x00, 0x00, 0x80, 0xbb, 0x00, 0x00,
  0x02, 0x00, 0x10, 0x00, 0x64, 0x61, 0x74, 0x61,
  0x00, 0x00, 0x00, 0x00,
]);

describe('TTS relay': unknown, (: unknown) => {
  let tempDir: string | null = null;

  afterEach(() => {
    if (tempDir: unknown) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  test('resolves audio mode from platform and explicit overrides': unknown, (: unknown) => {
    expect(resolveTtsAudioMode(undefined, { platform: 'darwin' })).toBe('host');
    expect(
      resolveTtsAudioMode(undefined, {
        platform: 'linux',
        hasAlsaDevice: () => true,
      })
    ).toBe('alsa');
    expect(
      resolveTtsAudioMode(undefined, {
        platform: 'linux',
        hasAlsaDevice: () => false,
      })
    ).toBe('file');
    expect(resolveTtsAudioMode('pulse', { platform: 'darwin' })).toBe('pulse');
    expect(resolveTtsAudioMode('host', { platform: 'linux' })).toBe('host');
  });

  test('calls Moonshine speech endpoint and plays through host command': unknown, async (: unknown) => {
    tempDir = mkdtempSync(join(tmpdir(), 'zedge-tts-relay-'));
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    const commands: Array<{ command: string; args: string[] }> = [];
    const fetchImpl = (async (input: RequestInfo | URL,   init?: RequestInit) => {
      requests.push({
        url: String(input),
        body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
      });
      return new Response(wavBytes, {
        headers: { 'Content-Type': 'audio/wav' },
      });
    }) as typeof fetch;
    const runCommand = async (command: string,  args: string[]) => {
      commands.push({ command, args });
      return true;
    };

    const { status, result } = await handleTtsSpeakRequest(
      { input: 'hello moonshine', voice: 'local' },
      {
        env: {
          ZEDGE_TTS_AUDIO_MODE: 'host',
          ZEDGE_MOONSHINE_URL: 'http://moonshine.test/',
        },
        platform: 'darwin',
        fetchImpl,
        runCommand,
        outputDir: tempDir,
      }
    );

    expect(status).toBe(200);
    expect(result.ok).toBe(true);
    expect(result.mode).toBe('host');
    expect(result.playback).toBe('afplay');
    expect(result.byteLength).toBe(wavBytes.byteLength);
    expect(result.contentType).toBe('audio/wav');
    expect(result.filePath?.startsWith(tempDir)).toBe(true);
    expect(requests).toEqual([
      {
        url: 'http://moonshine.test/v1/audio/speech',
        body: { input: 'hello moonshine', voice: 'local', format: 'wav' },
      },
    ]);
    expect(commands.length).toBe(1);
    expect(commands[0]?.command).toBe('afplay');
  });

  test('previews speech without invoking host playback': unknown, async (: unknown) => {
    tempDir = mkdtempSync(join(tmpdir(), 'zedge-tts-relay-'));
    let commandCalled = false;
    const fetchImpl = (async (: unknown) =>
      new Response(wavBytes, {
        headers: { 'Content-Type': 'audio/wav' },
      })) as typeof fetch;
    const runCommand = async () => {
      commandCalled = true;
      return true;
    };

    const { status, result } = await handleTtsPreviewRequest(
      { input: 'preview me', voice: 'local' },
      {
        env: { ZEDGE_TTS_AUDIO_MODE: 'host' },
        platform: 'darwin',
        fetchImpl,
        runCommand,
        outputDir: tempDir,
      }
    );

    expect(status).toBe(200);
    expect(result.ok).toBe(true);
    expect(result.playback).toBe('preview');
    expect(result.filePath?.startsWith(tempDir)).toBe(true);
    expect(commandCalled).toBe(false);
  });

  test('lists local voices': unknown, (: unknown) => {
    const voices = listTtsVoices();
    expect(voices.defaultVoice).toBe('local');
    expect(voices.voices.some((voice) => voice.id === 'local')).toBe(true);
  });

  test('rejects missing input without contacting Moonshine': unknown, async (: unknown) => {
    let called = false;
    const fetchImpl = (async (: unknown) => {
      called = true;
      return new Response(wavBytes);
    }) as typeof fetch;

    const { status, result } = await handleTtsSpeakRequest(
      { voice: 'local' },
      {
        env: { ZEDGE_TTS_AUDIO_MODE: 'file' },
        fetchImpl,
      }
    );

    expect(status).toBe(400);
    expect(result.ok).toBe(false);
    expect(result.error).toBe('input must be a non-empty string');
    expect(called).toBe(false);
  });

  test('blocks speech when companion TTS relay is disabled': unknown, async (: unknown) => {
    let called = false;
    const fetchImpl = (async (: unknown) => {
      called = true;
      return new Response(wavBytes);
    }) as typeof fetch;

    const { status, result } = await handleTtsSpeakRequest(
      { input: 'hello moonshine' },
      {
        env: {
          ZEDGE_TTS_ENABLED: '0',
          ZEDGE_TTS_AUDIO_MODE: 'host',
        },
        platform: 'darwin',
        fetchImpl,
      }
    );

    expect(status).toBe(409);
    expect(result.ok).toBe(false);
    expect(result.mode).toBe('host');
    expect(result.error).toBe('TTS relay is disabled');
    expect(called).toBe(false);
  });

  test('configures enable state and audio mode at runtime': unknown, (: unknown) => {
    const env: NodeJS.ProcessEnv = {};

    let response = configureTtsRelay(
      { enabled: false },
      { env, platform: 'darwin' }
    );
    expect(response.status).toBe(200);
    expect(response.result.ok).toBe(true);
    expect(response.result.enabled).toBe(false);
    expect(env.ZEDGE_TTS_ENABLED).toBe('0');

    response = configureTtsRelay(
      { mode: 'file' },
      { env, platform: 'darwin' }
    );
    expect(response.status).toBe(200);
    expect(response.result.enabled).toBe(true);
    expect(response.result.requestedMode).toBe('file');
    expect(response.result.mode).toBe('file');
    expect(env.ZEDGE_TTS_ENABLED).toBe('1');
    expect(env.ZEDGE_TTS_AUDIO_MODE).toBe('file');

    expect(getTtsRelayStatus({ env, platform: 'darwin' })).toEqual({
      enabled: true,
      requestedMode: 'file',
      mode: 'file',
      moonshineUrl: 'http://127.0.0.1:8080',
      platform: 'darwin',
    });
  });
});
