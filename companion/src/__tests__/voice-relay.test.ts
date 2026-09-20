import { afterEach, describe, expect, test } from '@a0n/gnosis/test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  DEFAULT_SILENCE_GAP_MS,
  VoiceCaptureController,
  handleVoiceConfigRequest,
  handleVoiceListenRequest,
  handleVoiceSayRequest,
  handleVoiceStatusRequest,
  isVoiceEnabled,
  recordClip,
  resolveRecorder,
  resolveVoiceCapability,
  sanitizeForSpeech,
  shouldFinalizeUtterance,
} from '../voice-relay.ts';

const wavBytes = new Uint8Array([
  0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45,
  0x66, 0x6d, 0x74, 0x20, 0x10, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00,
  0xc0, 0x5d, 0x00, 0x00, 0x80, 0xbb, 0x00, 0x00, 0x02, 0x00, 0x10, 0x00,
  0x64, 0x61, 0x74, 0x61, 0x00, 0x00, 0x00, 0x00,
]);

function lookupFrom(map: Record<string, string>) {
  return (name: string): string | null => map[name] ?? null;
}

function makeContinuousHarness(mode: 'push-to-talk' | 'continuous' = 'continuous') {
  let nowMs = 0;
  let timer: (() => void) | null = null;
  const teardownCalls: number[] = [];
  const utterances: string[] = [];
  const controller = new VoiceCaptureController({
    mode,
    silenceGapMs: DEFAULT_SILENCE_GAP_MS,
    now: () => nowMs,
    setTimeoutFn: (fn) => {
      timer = fn;
      return 1;
    },
    clearTimeoutFn: () => {
      timer = null;
    },
    transcribe: async () => 'hello world',
    teardown: () => {
      teardownCalls.push(1);
    },
    onUtterance: (text) => {
      utterances.push(text);
    },
  });
  return {
    controller,
    utterances,
    teardownCalls,
    advance: (ms: number) => {
      nowMs += ms;
    },
    fireSilenceTimer: () => {
      const fn = timer;
      timer = null;
      fn?.();
    },
    hasTimer: () => timer !== null,
  };
}

describe('voice capability resolution', () => {
  test('reports unavailable routes when nothing is configured', () => {
    const state = resolveVoiceCapability({
      env: {},
      platform: 'linux',
      resolveCommand: () => null,
    });
    expect(state.input.tier).toBe('unavailable');
    expect(state.input.supported).toBe(false);
    expect(state.output.tier).toBe('unavailable');
    expect(state.offlineReady).toBe(false);
  });

  test('prefers a local whisper binary and reads the whisper model', () => {
    const state = resolveVoiceCapability({
      env: { ZEDGE_WHISPER_MODEL: '/models/ggml-base.bin' },
      platform: 'linux',
      resolveCommand: lookupFrom({ 'whisper-cli': '/opt/whisper-cli' }),
    });
    expect(state.input.tier).toBe('device-local-wasm');
    expect(state.input.modelId).toBe('/models/ggml-base.bin');
    expect(state.input.offline).toBe(true);
  });

  test('uses fleet-http when a station URL is configured', () => {
    const state = resolveVoiceCapability({
      env: { ZEDGE_MOONSHINE_URL: 'http://station.test/' },
      platform: 'linux',
      resolveCommand: () => null,
    });
    expect(state.input.tier).toBe('fleet-http');
    expect(state.output.tier).toBe('fleet-http');
    expect(state.offlineReady).toBe(false);
  });

  test('prefers ZEDGE_ spellings and falls back to MOONSHINE_', () => {
    const state = resolveVoiceCapability({
      env: {
        ZEDGE_STT_URL: 'http://zedge.test',
        MOONSHINE_STT_URL: 'http://moonshine.test',
      },
      platform: 'linux',
      resolveCommand: () => null,
    });
    expect(state.input.tier).toBe('fleet-http');
    expect(state.input.modelId).toBe('whisper-1');
  });

  test('falls back to a device-system voice', () => {
    const darwin = resolveVoiceCapability({
      env: {},
      platform: 'darwin',
      resolveCommand: () => null,
    });
    expect(darwin.output.tier).toBe('device-system');
    expect(darwin.output.modelId).toBe('say');

    const linux = resolveVoiceCapability({
      env: {},
      platform: 'linux',
      resolveCommand: lookupFrom({ 'espeak-ng': '/usr/bin/espeak-ng' }),
    });
    expect(linux.output.tier).toBe('device-system');
    expect(linux.output.modelId).toBe('espeak-ng');
  });

  test('marks offlineReady only when both endpoints are device-local', () => {
    const state = resolveVoiceCapability({
      env: { ZEDGE_TTS_BIN: '/opt/squeezebox' },
      platform: 'linux',
      resolveCommand: lookupFrom({ 'whisper-cli': '/usr/bin/whisper-cli' }),
    });
    expect(state.input.tier).toBe('device-local-wasm');
    expect(state.output.tier).toBe('device-local-wasm');
    expect(state.offlineReady).toBe(true);
  });

  test('voice mode is opt-in and honors the MOONSHINE fallback', () => {
    expect(isVoiceEnabled({})).toBe(false);
    expect(isVoiceEnabled({ MOONSHINE_VOICE: '1' })).toBe(true);
    expect(isVoiceEnabled({ ZEDGE_VOICE_ENABLED: 'on' })).toBe(true);
    expect(
      isVoiceEnabled({ ZEDGE_VOICE_ENABLED: '0', MOONSHINE_VOICE: '1' }),
    ).toBe(false);
  });
});

describe('voice capture ladder', () => {
  let tempDir: string | null = null;

  afterEach(() => {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  test('records then transcribes through the local whisper binary', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'zedge-voice-'));
    const calls: Array<{ command: string; args: string[] }> = [];
    const runCommand = async (command: string, args: string[]) => {
      calls.push({ command, args });
      return { ok: true, code: 0, stdout: 'hello local voice', stderr: '' };
    };

    const { status, result } = await handleVoiceListenRequest(
      { seconds: 3 },
      {
        env: {
          ZEDGE_VOICE_ENABLED: '1',
          ZEDGE_RECORDER_BIN: '/usr/bin/ffmpeg',
          ZEDGE_STT_BIN: '/opt/whisper-cli',
          ZEDGE_WHISPER_MODEL: '/models/base.bin',
        },
        platform: 'linux',
        runCommand,
        pathExists: () => true,
        readFile: () => wavBytes,
        outputDir: tempDir,
        now: () => 111,
      },
    );

    expect(status).toBe(200);
    expect(result.ok).toBe(true);
    expect(result.text).toBe('hello local voice');
    expect(result.tier).toBe('device-local-wasm');
    expect(result.modelId).toBe('/models/base.bin');
    expect(calls[0]?.command).toBe('/usr/bin/ffmpeg');
    expect(calls[1]?.command).toBe('/opt/whisper-cli');
    expect(calls[1]?.args).toContain('-m');
    expect(calls[1]?.args).toContain('/models/base.bin');
    expect(calls[1]?.args).toContain('-f');
  });

  test('posts multipart/form-data with a file part and model to the station', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'zedge-voice-'));
    const requests: Array<{ url: string; body: unknown }> = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(input), body: init?.body });
      return new Response(JSON.stringify({ text: 'fleet transcript' }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;

    const { status, result } = await handleVoiceListenRequest(
      { seconds: 2 },
      {
        env: {
          ZEDGE_VOICE_ENABLED: '1',
          ZEDGE_RECORDER_BIN: '/usr/bin/ffmpeg',
          ZEDGE_STT_URL: 'http://stt.test/',
        },
        platform: 'linux',
        runCommand: async () => ({ ok: true, code: 0, stdout: '', stderr: '' }),
        pathExists: () => true,
        readFile: () => wavBytes,
        fetchImpl,
        outputDir: tempDir,
        now: () => 1,
      },
    );

    expect(status).toBe(200);
    expect(result.text).toBe('fleet transcript');
    expect(result.tier).toBe('fleet-http');
    expect(requests[0]?.url).toBe('http://stt.test/v1/audio/transcriptions');
    const form = requests[0]?.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    expect(form.get('model')).toBe('whisper-1');
    const file = form.get('file') as File;
    expect(file).toBeInstanceOf(Blob);
    expect(file.name).toBe('clip.wav');
    expect(file.type).toBe('audio/wav');
  });

  test('resolves the recorder preference and clamps capture seconds', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'zedge-voice-'));
    expect(resolveRecorder({ env: { ZEDGE_RECORDER_BIN: '/opt/sox' } })?.kind).toBe(
      'sox',
    );
    expect(
      resolveRecorder({
        env: {},
        resolveCommand: lookupFrom({ arecord: '/usr/bin/arecord' }),
      })?.kind,
    ).toBe('arecord');

    const calls: Array<{ command: string; args: string[] }> = [];
    const runCommand = async (command: string, args: string[]) => {
      calls.push({ command, args });
      return { ok: true, code: 0, stdout: '', stderr: '' };
    };
    const longClip = await recordClip(
      { seconds: 999 },
      {
        env: { ZEDGE_RECORDER_BIN: '/opt/sox' },
        platform: 'linux',
        runCommand,
        pathExists: () => true,
        outputDir: tempDir,
        now: () => 5,
      },
    );
    expect(longClip.ok).toBe(true);
    expect(longClip.seconds).toBe(30);
    expect(calls[0]?.args).toContain('30');

    const shortClip = await recordClip(
      { seconds: 0 },
      {
        env: { ZEDGE_RECORDER_BIN: '/opt/sox' },
        platform: 'linux',
        runCommand,
        pathExists: () => true,
        outputDir: tempDir,
        now: () => 6,
      },
    );
    expect(shortClip.seconds).toBe(1);
  });

  test('fails loudly when no recorder is available', async () => {
    const recording = await recordClip(
      { seconds: 2 },
      {
        env: {},
        platform: 'linux',
        resolveCommand: () => null,
        outputDir: tmpdir(),
      },
    );
    expect(recording.ok).toBe(false);
    expect(recording.error).toContain('no audio recorder found');
  });
});

describe('voice say route', () => {
  let tempDir: string | null = null;

  afterEach(() => {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  test('delegates to the TTS relay for the fleet tier and reports the tier', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'zedge-voice-'));
    const requests: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL) => {
      requests.push(String(input));
      return new Response(wavBytes, {
        headers: { 'Content-Type': 'audio/wav' },
      });
    }) as typeof fetch;

    const { status, result } = await handleVoiceSayRequest(
      { input: 'hello fleet' },
      {
        env: {
          ZEDGE_VOICE_ENABLED: '1',
          ZEDGE_TTS_URL: 'http://tts.test/',
        },
        platform: 'darwin',
        fetchImpl,
        runCommand: async () => ({ ok: true, code: 0, stdout: '', stderr: '' }),
        outputDir: tempDir,
      },
    );

    expect(status).toBe(200);
    expect(result.ok).toBe(true);
    expect(result.tier).toBe('fleet-http');
    expect(result.playback).toBe('afplay');
    expect(requests[0]).toBe('http://tts.test/v1/audio/speech');
  });

  test('uses the device-system voice when no fleet route is configured', async () => {
    const commands: string[] = [];
    const { status, result } = await handleVoiceSayRequest(
      { input: 'hello system' },
      {
        env: { ZEDGE_VOICE_ENABLED: '1' },
        platform: 'darwin',
        runCommand: async (command: string) => {
          commands.push(command);
          return { ok: true, code: 0, stdout: '', stderr: '' };
        },
      },
    );
    expect(status).toBe(200);
    expect(result.tier).toBe('device-system');
    expect(result.modelId).toBe('say');
    expect(commands).toEqual(['say']);
  });
});

describe('sanitizeForSpeech', () => {
  test('strips fenced code, tool markup, and thinking rows', () => {
    const input = [
      'Here is the answer.',
      '\u0060\u0060\u0060ts',
      'const secret = 1;',
      '\u0060\u0060\u0060',
      'thinking: should not be spoken',
      '<tool_call>{"name":"x"}</tool_call>',
      'Final line.',
    ].join('\n');
    expect(sanitizeForSpeech(input)).toBe('Here is the answer. Final line.');
  });

  test('collapses whitespace and clamps long text', () => {
    expect(sanitizeForSpeech('  spaced   out  ')).toBe('spaced out');
    const out = sanitizeForSpeech('a'.repeat(40), 10);
    expect(out.length).toBe(11);
    expect(out.endsWith('\u2026')).toBe(true);
  });
});

describe('voice disabled behavior', () => {
  test('refuses listen and say without contacting any route', async () => {
    let called = false;
    const runCommand = async () => {
      called = true;
      return { ok: true, code: 0, stdout: 'x', stderr: '' };
    };
    const fetchImpl = (async () => {
      called = true;
      return new Response('{}');
    }) as typeof fetch;
    const env = {
      ZEDGE_VOICE_ENABLED: '0',
      ZEDGE_STT_BIN: '/opt/whisper-cli',
      ZEDGE_RECORDER_BIN: '/usr/bin/ffmpeg',
    };

    const listen = await handleVoiceListenRequest(
      { seconds: 1 },
      { env, platform: 'linux', runCommand, fetchImpl, pathExists: () => true },
    );
    expect(listen.status).toBe(409);
    expect(listen.result.ok).toBe(false);
    expect(listen.result.error).toBe('voice mode is disabled');

    const say = await handleVoiceSayRequest(
      { input: 'hello' },
      { env, platform: 'linux', runCommand, fetchImpl },
    );
    expect(say.status).toBe(409);
    expect(say.result.ok).toBe(false);
    expect(called).toBe(false);
  });
});

describe('voice config and status', () => {
  test('configures enable state and capture mode at runtime', () => {
    const env: NodeJS.ProcessEnv = {};

    let response = handleVoiceConfigRequest(
      { enabled: true, captureMode: 'continuous' },
      { env, platform: 'linux', resolveCommand: () => null },
    );
    expect(response.status).toBe(200);
    expect(env.ZEDGE_VOICE_ENABLED).toBe('1');
    expect(env.ZEDGE_VOICE_CAPTURE_MODE).toBe('continuous');
    expect(response.result.enabled).toBe(true);
    expect(response.result.captureMode).toBe('continuous');

    response = handleVoiceConfigRequest(
      { captureMode: 'bogus' },
      { env, platform: 'linux' },
    );
    expect(response.status).toBe(400);

    response = handleVoiceConfigRequest({ enabled: 'yes' }, { env });
    expect(response.status).toBe(400);
  });

  test('status reports the resolved routes, capture mode, and recorder', () => {
    const status = handleVoiceStatusRequest({
      env: { ZEDGE_VOICE_ENABLED: '1', ZEDGE_TTS_BIN: '/opt/squeezebox' },
      platform: 'linux',
      resolveCommand: lookupFrom({ ffmpeg: '/usr/bin/ffmpeg' }),
    });
    expect(status.enabled).toBe(true);
    expect(status.captureMode).toBe('push-to-talk');
    expect((status.output as Record<string, unknown>).tier).toBe(
      'device-local-wasm',
    );
    expect((status.recorder as Record<string, unknown>).name).toBe('ffmpeg');
  });
});

describe('continuous capture (Ambush-derived)', () => {
  test('shouldFinalizeUtterance respects threshold and silence gap', () => {
    expect(
      shouldFinalizeUtterance({ level: 0, nowMs: 1500, lastVoiceAtMs: 0 }),
    ).toBe(true);
    expect(
      shouldFinalizeUtterance({ level: 0, nowMs: 1000, lastVoiceAtMs: 0 }),
    ).toBe(false);
    expect(
      shouldFinalizeUtterance({ level: 0.2, nowMs: 9000, lastVoiceAtMs: 0 }),
    ).toBe(false);
    expect(
      shouldFinalizeUtterance({ level: 0, nowMs: 9000, lastVoiceAtMs: null }),
    ).toBe(false);
  });

  test('walks idle -> listening -> processing -> listening on the silence gap', async () => {
    const harness = makeContinuousHarness();
    const states: string[] = [];
    harness.controller.subscribe((activity) => states.push(activity.state));

    expect(harness.controller.getActivity().state).toBe('idle');
    await harness.controller.start();
    expect(harness.controller.getActivity().state).toBe('listening');
    expect(harness.controller.getActivity().connectionState).toBe('connected');

    harness.controller.pushAudioLevel(0.4);
    expect(harness.controller.getActivity().audioLevel).toBe(0.4);
    harness.advance(200);
    harness.controller.pushAudioLevel(0);
    expect(harness.hasTimer()).toBe(true);

    harness.advance(DEFAULT_SILENCE_GAP_MS);
    harness.fireSilenceTimer();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(harness.utterances).toEqual(['hello world']);
    expect(states).toContain('processing');
    expect(harness.controller.getActivity().state).toBe('listening');
  });

  test('pause is an explicit privacy stop that tears down and is observable', async () => {
    const harness = makeContinuousHarness();
    await harness.controller.start();

    harness.controller.pushAudioLevel(0.5);
    harness.controller.pause();

    expect(harness.controller.getActivity().state).toBe('idle');
    expect(harness.controller.getActivity().connectionState).toBe('disconnected');
    expect(harness.controller.getActivity().audioLevel).toBe(0);
    expect(harness.teardownCalls.length).toBe(1);
    expect(harness.hasTimer()).toBe(false);
  });

  test('push-to-talk release finalizes without the VAD timer', async () => {
    const harness = makeContinuousHarness('push-to-talk');
    await harness.controller.start();
    harness.controller.release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(harness.utterances).toEqual(['hello world']);
    expect(harness.hasTimer()).toBe(false);
  });

  test('barge-in stops playback and returns to listening', async () => {
    const harness = makeContinuousHarness();
    await harness.controller.start();
    harness.controller.beginSpeaking();
    expect(harness.controller.getActivity().state).toBe('speaking');

    await harness.controller.bargeIn();
    expect(harness.controller.getActivity().state).toBe('listening');
  });

  test('destroy pauses and drops listeners on unmount', async () => {
    const harness = makeContinuousHarness();
    await harness.controller.start();
    const snapshots: string[] = [];
    harness.controller.subscribe((activity) => snapshots.push(activity.state));
    harness.controller.destroy();
    expect(harness.teardownCalls.length).toBeGreaterThanOrEqual(1);
    const before = snapshots.length;
    harness.controller.pushAudioLevel(0.9);
    expect(snapshots.length).toBe(before);
  });
});
