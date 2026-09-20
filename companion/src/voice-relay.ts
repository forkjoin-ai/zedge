import { spawn } from 'child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { basename, delimiter, join } from 'path';
import {
  handleTtsSpeakRequest,
  type TtsSpeakResult,
} from './tts-relay.ts';

export type VoiceTier =
  | 'device-local-wasm'
  | 'fleet-http'
  | 'device-system'
  | 'unavailable';

export interface VoiceEndpointCapability {
  supported: boolean;
  tier: VoiceTier;
  modelId: string | null;
  streaming: boolean;
  offline: boolean;
  partial: boolean;
}

export interface VoiceCapabilityState {
  input: VoiceEndpointCapability;
  output: VoiceEndpointCapability;
  offlineReady: boolean;
}

export interface VoiceCommandResult {
  ok: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
}

export type VoiceRunCommand = (
  command: string,
  args: string[],
) => Promise<VoiceCommandResult>;

export type RecorderKind = 'ffmpeg' | 'sox' | 'arecord' | 'custom';

export interface ResolvedRecorder {
  command: string;
  name: string;
  kind: RecorderKind;
}

export interface VoiceOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform | string;
  fetchImpl?: typeof fetch;
  runCommand?: VoiceRunCommand;
  resolveCommand?: (name: string) => string | null;
  pathExists?: (path: string) => boolean;
  readFile?: (path: string) => Uint8Array;
  outputDir?: string;
  now?: () => number;
}

interface ResolvedSttBinary {
  command: string;
  modelId: string;
  modelPath: string | null;
}

interface ResolvedTtsBinary {
  command: string;
  modelId: string;
}

interface ResolvedSystemSpeaker {
  command: string;
  modelId: string;
}

export interface VoiceListenResult {
  ok: boolean;
  text?: string;
  tier: VoiceTier;
  modelId: string | null;
  error?: string;
  remediation?: string;
  filePath?: string;
  seconds?: number;
}

export interface VoiceSayResult {
  ok: boolean;
  tier: VoiceTier;
  modelId: string | null;
  playback: string;
  byteLength: number;
  mode?: TtsSpeakResult['mode'];
  fallbackFrom?: VoiceTier;
  filePath?: string;
  error?: string;
}

export interface VoiceRecording {
  ok: boolean;
  filePath?: string;
  command?: string;
  args?: string[];
  seconds?: number;
  error?: string;
}

const DISABLED_VOICE_VALUES = new Set(['0', 'false', 'off', 'no', 'disabled']);
const ENABLED_VOICE_VALUES = new Set(['1', 'true', 'on', 'yes', 'enabled']);

const STT_LOCAL_NAMES = ['whisper-cli', 'whisper'];
const TTS_LOCAL_NAMES = ['squeezebox', 'sqzbx'];
const RECORDER_NAMES = ['ffmpeg', 'sox', 'arecord'] as const;

const MAX_SPEECH_LENGTH = 600;
const MAX_CAPTURE_SECONDS = 30;
const MIN_CAPTURE_SECONDS = 1;

function envFirst(
  env: NodeJS.ProcessEnv,
  names: string[],
): string | undefined {
  for (const name of names) {
    const value = env[name];
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

function unavailableEndpoint(): VoiceEndpointCapability {
  return {
    supported: false,
    tier: 'unavailable',
    modelId: null,
    streaming: false,
    offline: false,
    partial: false,
  };
}

function findOnPath(name: string, pathValue: string): string | null {
  if (!pathValue) return null;
  const extensions =
    process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const dir of pathValue.split(delimiter)) {
    if (!dir) continue;
    for (const extension of extensions) {
      const candidate = join(dir, name + extension);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

function makeCommandResolver(
  options: VoiceOptions,
): (name: string) => string | null {
  if (options.resolveCommand) return options.resolveCommand;
  const env = options.env ?? process.env;
  return (name) => findOnPath(name, env.PATH ?? '');
}

function resolveVoiceName(env: NodeJS.ProcessEnv): string {
  return (
    envFirst(env, ['ZEDGE_VOICE_VOICE', 'MOONSHINE_VOICE_VOICE']) ?? 'local'
  );
}

function resolveFleetBase(
  env: NodeJS.ProcessEnv,
  route: 'stt' | 'tts',
): string | null {
  const names =
    route === 'stt'
      ? ['ZEDGE_STT_URL', 'MOONSHINE_STT_URL', 'ZEDGE_MOONSHINE_URL', 'MOONSHINE_URL']
      : ['ZEDGE_TTS_URL', 'MOONSHINE_TTS_URL', 'ZEDGE_MOONSHINE_URL', 'MOONSHINE_URL'];
  const base = envFirst(env, names);
  return base ? base.replace(/\/+$/, '') : null;
}

/**
 * Returns whether voice mode is opt-in enabled (ZEDGE_VOICE_ENABLED, then
 * MOONSHINE_VOICE). Voice mode defaults to off.
 */
export function isVoiceEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const value = envFirst(env, [
    'ZEDGE_VOICE_ENABLED',
    'MOONSHINE_VOICE',
  ])?.toLowerCase();
  if (!value) return false;
  if (DISABLED_VOICE_VALUES.has(value)) return false;
  return ENABLED_VOICE_VALUES.has(value);
}

function resolveSttBinary(
  env: NodeJS.ProcessEnv,
  lookup: (name: string) => string | null,
): ResolvedSttBinary | null {
  const explicit = envFirst(env, ['ZEDGE_STT_BIN', 'MOONSHINE_STT_BIN']);
  let command = explicit ?? null;
  if (!command) {
    for (const name of STT_LOCAL_NAMES) {
      const found = lookup(name);
      if (found) {
        command = found;
        break;
      }
    }
  }
  if (!command) return null;
  const modelPath =
    envFirst(env, ['ZEDGE_WHISPER_MODEL', 'MOONSHINE_WHISPER_MODEL']) ?? null;
  return {
    command,
    modelId: modelPath ?? basename(command) ?? 'whisper',
    modelPath,
  };
}

function resolveTtsBinary(
  env: NodeJS.ProcessEnv,
  lookup: (name: string) => string | null,
): ResolvedTtsBinary | null {
  const explicit = envFirst(env, ['ZEDGE_TTS_BIN', 'MOONSHINE_TTS_BIN']);
  let command = explicit ?? null;
  if (!command) {
    for (const name of TTS_LOCAL_NAMES) {
      const found = lookup(name);
      if (found) {
        command = found;
        break;
      }
    }
  }
  if (!command) return null;
  return { command, modelId: basename(command) || 'squeezebox' };
}

function resolveSystemSpeaker(
  platform: string,
  lookup: (name: string) => string | null,
): ResolvedSystemSpeaker | null {
  if (platform === 'darwin') {
    return { command: lookup('say') ?? 'say', modelId: 'say' };
  }
  if (platform === 'linux') {
    const espeak = lookup('espeak-ng');
    if (espeak) return { command: espeak, modelId: 'espeak-ng' };
    const spd = lookup('spd-say');
    if (spd) return { command: spd, modelId: 'spd-say' };
  }
  return null;
}

function resolveSttCapability(
  env: NodeJS.ProcessEnv,
  lookup: (name: string) => string | null,
): VoiceEndpointCapability {
  const local = resolveSttBinary(env, lookup);
  if (local) {
    return {
      supported: true,
      tier: 'device-local-wasm',
      modelId: local.modelId,
      streaming: false,
      offline: true,
      partial: false,
    };
  }
  const base = resolveFleetBase(env, 'stt');
  if (base) {
    return {
      supported: true,
      tier: 'fleet-http',
      modelId:
        envFirst(env, ['ZEDGE_STT_MODEL', 'MOONSHINE_STT_MODEL']) ??
        'whisper-1',
      streaming: false,
      offline: false,
      partial: false,
    };
  }
  // Node has no device-system speech recognition route.
  return unavailableEndpoint();
}

function resolveTtsCapability(
  env: NodeJS.ProcessEnv,
  platform: string,
  lookup: (name: string) => string | null,
): VoiceEndpointCapability {
  const local = resolveTtsBinary(env, lookup);
  if (local) {
    return {
      supported: true,
      tier: 'device-local-wasm',
      modelId: local.modelId,
      streaming: false,
      offline: true,
      partial: false,
    };
  }
  const base = resolveFleetBase(env, 'tts');
  if (base) {
    return {
      supported: true,
      tier: 'fleet-http',
      modelId: resolveVoiceName(env),
      streaming: false,
      offline: false,
      partial: false,
    };
  }
  const system = resolveSystemSpeaker(platform, lookup);
  if (system) {
    return {
      supported: true,
      tier: 'device-system',
      modelId: system.modelId,
      streaming: false,
      offline: true,
      partial: false,
    };
  }
  return unavailableEndpoint();
}

/**
 * Resolves the best available STT/TTS routes for voice mode. Resolution is a
 * static capability read; it never contacts the network.
 */
export function resolveVoiceCapability(
  options: VoiceOptions = {},
): VoiceCapabilityState {
  const env = options.env ?? process.env;
  const platform = String(options.platform ?? process.platform);
  const lookup = makeCommandResolver(options);
  const input = resolveSttCapability(env, lookup);
  const output = resolveTtsCapability(env, platform, lookup);
  return {
    input,
    output,
    offlineReady:
      input.tier === 'device-local-wasm' &&
      output.tier === 'device-local-wasm',
  };
}

function recorderKind(name: string): RecorderKind | null {
  if (name.includes('ffmpeg')) return 'ffmpeg';
  if (name.includes('sox')) return 'sox';
  if (name.includes('arecord')) return 'arecord';
  return null;
}

/**
 * Resolves the microphone capture binary: explicit recorder override, then
 * ffmpeg, sox, and arecord on PATH.
 */
export function resolveRecorder(
  options: VoiceOptions = {},
): ResolvedRecorder | null {
  const env = options.env ?? process.env;
  const explicit = envFirst(env, [
    'ZEDGE_RECORDER_BIN',
    'MOONSHINE_RECORDER_BIN',
  ]);
  if (explicit) {
    const name = basename(explicit);
    return { command: explicit, name, kind: recorderKind(name) ?? 'custom' };
  }
  const lookup = makeCommandResolver(options);
  for (const name of RECORDER_NAMES) {
    const found = lookup(name);
    if (found) return { command: found, name, kind: name };
  }
  return null;
}

function clampCaptureSeconds(value: unknown): number {
  const parsed =
    typeof value === 'number' ? value : Number.parseFloat(String(value ?? ''));
  if (!Number.isFinite(parsed)) return MIN_CAPTURE_SECONDS;
  return Math.min(
    MAX_CAPTURE_SECONDS,
    Math.max(MIN_CAPTURE_SECONDS, Math.floor(parsed)),
  );
}

function recorderArgs(
  recorder: ResolvedRecorder,
  seconds: number,
  filePath: string,
  platform: string,
): string[] {
  switch (recorder.kind) {
    case 'sox':
      return [
        '-d',
        '-c',
        '1',
        '-r',
        '16000',
        filePath,
        'trim',
        '0',
        String(seconds),
      ];
    case 'arecord':
      return [
        '-q',
        '-f',
        'S16_LE',
        '-r',
        '16000',
        '-c',
        '1',
        '-d',
        String(seconds),
        filePath,
      ];
    case 'ffmpeg':
    case 'custom':
    default:
      return platform === 'darwin'
        ? [
            '-y',
            '-f',
            'avfoundation',
            '-i',
            ':0',
            '-t',
            String(seconds),
            '-ac',
            '1',
            '-ar',
            '16000',
            filePath,
          ]
        : [
            '-y',
            '-f',
            'alsa',
            '-i',
            'default',
            '-t',
            String(seconds),
            '-ac',
            '1',
            '-ar',
            '16000',
            filePath,
          ];
  }
}

function defaultRunCommand(
  command: string,
  args: string[],
): Promise<VoiceCommandResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), 60_000);
    child.stdout?.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, code, stdout, stderr });
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({
        ok: false,
        code: null,
        stdout,
        stderr:
          stderr || (error instanceof Error ? error.message : String(error)),
      });
    });
  });
}

/**
 * Records a bounded microphone clip to a temp wav file. Never records
 * unbounded audio: seconds is clamped to [1, 30].
 */
export async function recordClip(
  request: { seconds?: unknown } = {},
  options: VoiceOptions = {},
): Promise<VoiceRecording> {
  const recorder = resolveRecorder(options);
  if (!recorder) {
    return {
      ok: false,
      error:
        'no audio recorder found; set ZEDGE_RECORDER_BIN or install ffmpeg, sox, or arecord',
    };
  }

  const seconds = clampCaptureSeconds(request.seconds);
  const platform = String(options.platform ?? process.platform);
  const now = options.now ?? Date.now;
  const dir = options.outputDir ?? join(tmpdir(), 'zedge-voice');
  mkdirSync(dir, { recursive: true });
  const filePath = join(
    dir,
    'clip-' + now() + '-' + Math.random().toString(36).slice(2) + '.wav',
  );

  const args = recorderArgs(recorder, seconds, filePath, platform);
  const result = await (options.runCommand ?? defaultRunCommand)(
    recorder.command,
    args,
  );
  if (!result.ok) {
    return {
      ok: false,
      command: recorder.command,
      args,
      seconds,
      error:
        result.stderr.trim() ||
        'recorder ' +
          recorder.name +
          ' exited with code ' +
          String(result.code ?? 'unknown'),
    };
  }

  const pathExists = options.pathExists ?? existsSync;
  if (!pathExists(filePath)) {
    return {
      ok: false,
      command: recorder.command,
      args,
      seconds,
      error: 'recorder did not produce ' + filePath,
    };
  }

  return {
    ok: true,
    filePath,
    command: recorder.command,
    args,
    seconds,
  };
}

function readAudioBytes(filePath: string, options: VoiceOptions): Uint8Array {
  if (options.readFile) return options.readFile(filePath);
  return new Uint8Array(readFileSync(filePath));
}

function cleanupRecording(
  filePath: string | undefined,
  _options: VoiceOptions,
): void {
  if (!filePath) return;
  try {
    rmSync(filePath, { force: true });
  } catch {
    // Best-effort cleanup: raw audio must not outlive the turn.
  }
}

function sttArgs(binary: ResolvedSttBinary, audioPath: string): string[] {
  const args = ['-f', audioPath];
  if (binary.modelPath) args.unshift('-m', binary.modelPath);
  return args;
}

function listenError(
  status: number,
  error: string,
  capability: VoiceEndpointCapability,
  extra: Partial<VoiceListenResult> = {},
): { status: number; result: VoiceListenResult } {
  return {
    status,
    result: {
      ok: false,
      tier: capability.tier,
      modelId: capability.modelId,
      error,
      ...extra,
    },
  };
}

/**
 * Handles a voice capture turn: record a bounded clip, transcribe it through
 * the best available STT route, and return the transcript with the tier used.
 */
export async function handleVoiceListenRequest(
  body: unknown,
  options: VoiceOptions = {},
): Promise<{ status: number; result: VoiceListenResult }> {
  const env = options.env ?? process.env;
  const capability = resolveVoiceCapability(options);

  if (!isVoiceEnabled(env)) {
    return listenError(409, 'voice mode is disabled', capability);
  }
  if (!capability.input.supported) {
    return listenError(
      503,
      'no speech-to-text route is available',
      capability,
      {
        remediation:
          'Set ZEDGE_STT_BIN to a local whisper binary, or point ZEDGE_STT_URL or ZEDGE_MOONSHINE_URL at a Moonshine station.',
      },
    );
  }

  const request =
    body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  const recording = await recordClip({ seconds: request.seconds }, options);
  if (!recording.ok || !recording.filePath) {
    return listenError(
      502,
      recording.error ?? 'failed to record audio',
      capability,
      { seconds: recording.seconds },
    );
  }

  try {
    const audio = readAudioBytes(recording.filePath, options);

    if (capability.input.tier === 'device-local-wasm') {
      const binary = resolveSttBinary(env, makeCommandResolver(options));
      if (!binary) {
        return listenError(
          503,
          'device-local STT binary resolved but is no longer available',
          capability,
        );
      }
      const result = await (options.runCommand ?? defaultRunCommand)(
        binary.command,
        sttArgs(binary, recording.filePath),
      );
      if (!result.ok) {
        return listenError(
          502,
          result.stderr.trim() || 'local speech-to-text command failed',
          capability,
        );
      }
      const text = result.stdout.trim();
      if (!text) {
        return listenError(
          502,
          'local speech-to-text command returned no transcript',
          capability,
        );
      }
      return {
        status: 200,
        result: {
          ok: true,
          text,
          tier: 'device-local-wasm',
          modelId: capability.input.modelId,
          filePath: recording.filePath,
          seconds: recording.seconds,
        },
      };
    }

    const base = resolveFleetBase(env, 'stt');
    if (!base) {
      return listenError(
        503,
        'fleet STT route is no longer configured',
        capability,
      );
    }
    const modelId = capability.input.modelId ?? 'whisper-1';
    const form = new FormData();
    form.append('file', new Blob([audio], { type: 'audio/wav' }), 'clip.wav');
    form.append('model', modelId);

    const fetchImpl = options.fetchImpl ?? fetch;
    let response: Response;
    try {
      response = await fetchImpl(base + '/v1/audio/transcriptions', {
        method: 'POST',
        body: form,
      });
    } catch (error) {
      return listenError(
        502,
        error instanceof Error ? error.message : String(error),
        capability,
        { remediation: 'Could not reach the STT station at ' + base + '.' },
      );
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      return listenError(
        502,
        detail || 'STT station returned HTTP ' + String(response.status),
        capability,
        { remediation: 'Check the STT station at ' + base + '.' },
      );
    }

    const payload = (await response.json().catch(() => ({}))) as {
      text?: unknown;
    };
    const text = typeof payload.text === 'string' ? payload.text.trim() : '';
    if (!text) {
      return listenError(502, 'STT station returned no transcript', capability);
    }
    return {
      status: 200,
      result: {
        ok: true,
        text,
        tier: 'fleet-http',
        modelId,
        filePath: recording.filePath,
        seconds: recording.seconds,
      },
    };
  } finally {
    cleanupRecording(recording.filePath, options);
  }
}

function sayError(
  status: number,
  error: string,
  capability: VoiceEndpointCapability,
  extra: Partial<VoiceSayResult> = {},
): { status: number; result: VoiceSayResult } {
  return {
    status,
    result: {
      ok: false,
      tier: capability.tier,
      modelId: capability.modelId,
      playback: 'none',
      byteLength: 0,
      error,
      ...extra,
    },
  };
}

/**
 * Handles a voice speak turn: sanitize assistant text, then speak it through
 * the best available TTS route. The fleet tier delegates to the shared
 * companion TTS relay (host playback included).
 */
export async function handleVoiceSayRequest(
  body: unknown,
  options: VoiceOptions = {},
): Promise<{ status: number; result: VoiceSayResult }> {
  const env = options.env ?? process.env;
  const platform = String(options.platform ?? process.platform);
  const capability = resolveVoiceCapability(options);

  if (!isVoiceEnabled(env)) {
    return sayError(409, 'voice mode is disabled', capability);
  }

  const request =
    body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  if (typeof request.input !== 'string' || request.input.trim().length === 0) {
    return sayError(400, 'input must be a non-empty string', capability);
  }
  if (request.voice !== undefined && typeof request.voice !== 'string') {
    return sayError(400, 'voice must be a string when provided', capability);
  }

  const text = sanitizeForSpeech(request.input);
  if (!text) {
    return sayError(400, 'input is empty after speech sanitization', capability);
  }
  const voice =
    (typeof request.voice === 'string' && request.voice.trim()) ||
    resolveVoiceName(env);

  if (!capability.output.supported) {
    return sayError(503, 'no text-to-speech route is available', capability, {
      remediation:
        'Set ZEDGE_TTS_BIN to a local squeezebox binary, point ZEDGE_TTS_URL or ZEDGE_MOONSHINE_URL at a Moonshine station, or install a system voice (macOS say, Linux espeak-ng).',
    });
  }

  if (capability.output.tier === 'device-local-wasm') {
    const binary = resolveTtsBinary(env, makeCommandResolver(options));
    if (binary) {
      const result = await (options.runCommand ?? defaultRunCommand)(
        binary.command,
        [text],
      );
      if (result.ok) {
        return {
          status: 200,
          result: {
            ok: true,
            tier: 'device-local-wasm',
            modelId: binary.modelId,
            playback: binary.command,
            byteLength: text.length,
          },
        };
      }
    }
  }

  const fleetBase = resolveFleetBase(env, 'tts');
  let fleetError: string | undefined;
  if (fleetBase) {
    const relay = await handleTtsSpeakRequest(
      { input: text, voice },
      {
        env: { ...env, ZEDGE_MOONSHINE_URL: fleetBase },
        platform: options.platform,
        fetchImpl: options.fetchImpl,
        outputDir: options.outputDir,
        runCommand: async (command, args) =>
          (await (options.runCommand ?? defaultRunCommand)(command, args)).ok,
      },
    );
    if (relay.result.ok) {
      return {
        status: 200,
        result: {
          ok: true,
          tier: 'fleet-http',
          modelId: voice,
          mode: relay.result.mode,
          playback: relay.result.playback,
          byteLength: relay.result.byteLength,
          filePath: relay.result.filePath,
        },
      };
    }
    fleetError = relay.result.error ?? 'fleet TTS relay failed';
  }

  const system = resolveSystemSpeaker(platform, makeCommandResolver(options));
  if (system) {
    const result = await (options.runCommand ?? defaultRunCommand)(
      system.command,
      [text],
    );
    if (result.ok) {
      return {
        status: 200,
        result: {
          ok: true,
          tier: 'device-system',
          modelId: system.modelId,
          playback: system.command,
          byteLength: text.length,
          ...(fleetError ? { fallbackFrom: 'fleet-http' as VoiceTier } : {}),
        },
      };
    }
    if (!fleetError) {
      return sayError(
        502,
        result.stderr.trim() || 'system speech command failed',
        capability,
      );
    }
  }

  if (fleetError) {
    return sayError(502, fleetError, capability, { fallbackFrom: 'fleet-http' });
  }
  return sayError(503, 'no text-to-speech route is available', capability);
}

/**
 * Handles the voice status request: opt-in state plus resolved routes.
 */
export function handleVoiceStatusRequest(
  options: VoiceOptions = {},
): Record<string, unknown> {
  const env = options.env ?? process.env;
  const capability = resolveVoiceCapability(options);
  const recorder = resolveRecorder(options);
  return {
    enabled: isVoiceEnabled(env),
    ...capability,
    platform: String(options.platform ?? process.platform),
    captureMode: resolveCaptureMode(env),
    activity: {
      state: 'idle',
      audioLevel: 0,
      connectionState: 'disconnected',
    },
    recorder: recorder
      ? {
          command: recorder.command,
          name: recorder.name,
          kind: recorder.kind,
        }
      : null,
  };
}

/**
 * Handles the voice capabilities request (contract VoiceCapabilityState).
 */
export function handleVoiceCapabilitiesRequest(
  options: VoiceOptions = {},
): VoiceCapabilityState {
  return resolveVoiceCapability(options);
}

/**
 * Handles the voice config request: enable/disable, STT/TTS bases, and voice.
 */
export function handleVoiceConfigRequest(
  body: unknown,
  options: VoiceOptions = {},
): { status: number; result: Record<string, unknown> } {
  const env = options.env ?? process.env;
  const request =
    body && typeof body === 'object' ? (body as Record<string, unknown>) : {};

  if ('enabled' in request) {
    if (typeof request.enabled !== 'boolean') {
      return {
        status: 400,
        result: {
          ok: false,
          ...handleVoiceStatusRequest(options),
          error: 'enabled must be a boolean',
        },
      };
    }
    env['ZEDGE_VOICE_ENABLED'] = request.enabled ? '1' : '0';
  }

  const stringFields = [
    ['sttUrl', 'ZEDGE_STT_URL'],
    ['ttsUrl', 'ZEDGE_TTS_URL'],
    ['voice', 'ZEDGE_VOICE_VOICE'],
  ] as const;
  for (const [field, key] of stringFields) {
    if (field in request) {
      if (typeof request[field] !== 'string') {
        return {
          status: 400,
          result: {
            ok: false,
            ...handleVoiceStatusRequest(options),
            error: field + ' must be a string',
          },
        };
      }
      env[key] = request[field].trim();
    }
  }

  if ('captureMode' in request) {
    const captureMode = request.captureMode;
    if (
      typeof captureMode !== 'string' ||
      !['push-to-talk', 'continuous'].includes(captureMode)
    ) {
      return {
        status: 400,
        result: {
          ok: false,
          ...handleVoiceStatusRequest(options),
          error: 'captureMode must be push-to-talk or continuous',
        },
      };
    }
    env['ZEDGE_VOICE_CAPTURE_MODE'] = captureMode.trim();
  }

  return {
    status: 200,
    result: {
      ok: true,
      ...handleVoiceStatusRequest(options),
    },
  };
}

/**
 * Strips fenced code blocks, tool/thinking markup, and excess whitespace from
 * assistant text before it is spoken. Clamps to a bounded spoken length.
 */
export function sanitizeForSpeech(
  text: string,
  maxLength: number = MAX_SPEECH_LENGTH,
): string {
  if (typeof text !== 'string') return '';
  let value = text;

  // Fenced code blocks must never be read aloud.
  value = value.replace(/\x60\x60\x60[\s\S]*?\x60\x60\x60/g, ' ');
  value = value.replace(/~~~[\s\S]*?~~~/g, ' ');

  // Paired thinking / tool blocks.
  value = value.replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, ' ');
  value = value.replace(
    /<(tool_call|tool_result|function_call)>[\s\S]*?<\/\1>/gi,
    ' ',
  );
  value = value.replace(/<(analysis|reasoning)>[\s\S]*?<\/\1>/gi, ' ');

  // Tool markup and reasoning rows are transcript-only UI, not speech.
  value = value
    .split('\n')
    .filter(
      (line) =>
        !/^\s*(?:thinking|thought|reasoning|tool_call|tool_use|tool|function_call|observation)\s*[:=]/i.test(
          line,
        ),
    )
    .filter((line) => !/^\s*<[^>]+>\s*$/.test(line))
    .join('\n');

  value = value.replace(/\[\[[^\]]*\]\]/g, ' ');
  value = value.replace(/\s+/g, ' ').trim();

  if (value.length > maxLength) {
    const clipped = value.slice(0, maxLength);
    const lastSpace = clipped.lastIndexOf(' ');
    value =
      (lastSpace > maxLength * 0.6 ? clipped.slice(0, lastSpace) : clipped).trim() +
      '…';
  }

  return value;
}

/* ------------------------------------------------------------------ *
 * Capture modes (Ambush-derived continuous listening)
 *
 * Modeled on shared-ui/src/hooks/useAmbientTranscription.ts: a long-lived
 * microphone with a simple energy VAD finalizes an utterance after a silence
 * gap. The same observable activity state is surfaced for push-to-talk and
 * continuous capture so the front end can render honestly.
 * ------------------------------------------------------------------ */

export type VoiceCaptureMode = 'push-to-talk' | 'continuous';
export type VoiceActivityState =
  | 'idle'
  | 'listening'
  | 'processing'
  | 'speaking';
export type VoiceConnectionState =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'error';

export interface VoiceActivity {
  state: VoiceActivityState;
  audioLevel: number;
  connectionState: VoiceConnectionState;
}

export const DEFAULT_SILENCE_GAP_MS = 1400;
export const DEFAULT_ENERGY_THRESHOLD = 0.05;

export interface FinalizeDecisionInput {
  level: number;
  nowMs: number;
  lastVoiceAtMs: number | null;
  threshold?: number;
  silenceGapMs?: number;
}

/**
 * Pure energy-VAD decision: true when the level is below threshold and the
 * voice has been silent for at least the silence gap. Kept pure so the
 * finalize logic is unit-testable without a microphone.
 */
export function shouldFinalizeUtterance(
  input: FinalizeDecisionInput,
): boolean {
  const threshold = input.threshold ?? DEFAULT_ENERGY_THRESHOLD;
  const gap = input.silenceGapMs ?? DEFAULT_SILENCE_GAP_MS;
  if (input.level > threshold) return false;
  if (input.lastVoiceAtMs === null) return false;
  return input.nowMs - input.lastVoiceAtMs >= gap;
}

export interface VoiceCaptureDeps {
  mode?: VoiceCaptureMode;
  threshold?: number;
  silenceGapMs?: number;
  now?: () => number;
  setTimeoutFn?: (fn: () => void, ms: number) => unknown;
  clearTimeoutFn?: (handle: unknown) => void;
  connect?: () => Promise<void> | void;
  teardown?: () => Promise<void> | void;
  transcribe?: () => Promise<string | null>;
  onUtterance?: (text: string) => void;
  onBargeIn?: () => Promise<void> | void;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/**
 * Observable capture controller for both capture modes. Continuous mode owns
 * the long-lived mic loop and finalizes on the silence gap; push-to-talk
 * finalizes on release(). pause() is the explicit privacy stop and tears down
 * the injected media resources; destroy() also drops listeners on unmount.
 */
export class VoiceCaptureController {
  private readonly mode: VoiceCaptureMode;
  private readonly threshold: number;
  private readonly silenceGapMs: number;
  private readonly now: () => number;
  private readonly setTimeoutFn: (fn: () => void, ms: number) => unknown;
  private readonly clearTimeoutFn: (handle: unknown) => void;
  private readonly deps: VoiceCaptureDeps;

  private activity: VoiceActivity = {
    state: 'idle',
    audioLevel: 0,
    connectionState: 'disconnected',
  };
  private listeners = new Set<(activity: VoiceActivity) => void>();
  private isSpeaking = false;
  private lastVoiceAtMs: number | null = null;
  private silenceTimer: unknown = null;
  private paused = true;
  private destroyed = false;

  constructor(deps: VoiceCaptureDeps = {}) {
    this.deps = deps;
    this.mode = deps.mode ?? 'push-to-talk';
    this.threshold = deps.threshold ?? DEFAULT_ENERGY_THRESHOLD;
    this.silenceGapMs = deps.silenceGapMs ?? DEFAULT_SILENCE_GAP_MS;
    this.now = deps.now ?? Date.now;
    this.setTimeoutFn =
      deps.setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimeoutFn =
      deps.clearTimeoutFn ??
      ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  }

  getMode(): VoiceCaptureMode {
    return this.mode;
  }

  getActivity(): VoiceActivity {
    return { ...this.activity };
  }

  subscribe(listener: (activity: VoiceActivity) => void): () => void {
    this.listeners.add(listener);
    listener(this.getActivity());
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(patch: Partial<VoiceActivity>): void {
    this.activity = { ...this.activity, ...patch };
    const snapshot = this.getActivity();
    for (const listener of this.listeners) listener(snapshot);
  }

  private clearSilenceTimer(): void {
    if (this.silenceTimer !== null) {
      this.clearTimeoutFn(this.silenceTimer);
      this.silenceTimer = null;
    }
  }

  async start(): Promise<void> {
    if (this.destroyed) {
      throw new Error('voice capture controller has been destroyed');
    }
    this.paused = false;
    this.isSpeaking = false;
    this.lastVoiceAtMs = null;
    this.clearSilenceTimer();
    this.emit({ state: 'idle', connectionState: 'connecting' });
    try {
      await this.deps.connect?.();
    } catch {
      this.emit({ state: 'idle', connectionState: 'error' });
      return;
    }
    if (this.paused || this.destroyed) return;
    this.emit({ state: 'listening', connectionState: 'connected' });
  }

  /**
   * Feeds a normalized (0..1) audio level from an AnalyserNode or recorder
   * meter. Continuous mode uses this for the energy VAD.
   */
  pushAudioLevel(level: number): void {
    if (this.paused || this.destroyed) return;
    if (this.activity.state !== 'listening') return;

    const normalized = clamp01(level);
    const nowMs = this.now();
    if (normalized > this.threshold) {
      this.isSpeaking = true;
      this.lastVoiceAtMs = nowMs;
      this.clearSilenceTimer();
      this.emit({ audioLevel: normalized });
      return;
    }

    this.emit({ audioLevel: normalized });
    if (!this.isSpeaking || this.lastVoiceAtMs === null) return;
    if (this.silenceTimer !== null) return;
    this.silenceTimer = this.setTimeoutFn(() => {
      this.silenceTimer = null;
      this.onSilenceElapsed();
    }, this.silenceGapMs);
  }

  private onSilenceElapsed(): void {
    if (this.paused || this.destroyed) return;
    if (!this.isSpeaking) return;
    this.isSpeaking = false;
    this.lastVoiceAtMs = null;
    void this.finalizeUtterance();
  }

  private async finalizeUtterance(): Promise<void> {
    this.emit({ state: 'processing' });
    let text: string | null = null;
    try {
      if (this.deps.transcribe) text = await this.deps.transcribe();
    } catch {
      text = null;
    }
    if (text && this.deps.onUtterance) this.deps.onUtterance(text);
    if (this.paused || this.destroyed) {
      this.emit({ state: 'idle' });
      return;
    }
    this.emit({ state: 'listening' });
  }

  /** Push-to-talk release: finalize the bounded utterance immediately. */
  release(): void {
    if (this.mode !== 'push-to-talk') return;
    if (this.paused || this.destroyed) return;
    this.isSpeaking = false;
    this.lastVoiceAtMs = null;
    this.clearSilenceTimer();
    void this.finalizeUtterance();
  }

  /** Marks the surface as speaking (TTS playback began). */
  beginSpeaking(): void {
    this.emit({ state: 'speaking' });
  }

  /** Marks playback finished or stopped. */
  endSpeaking(): void {
    if (this.activity.state !== 'speaking') return;
    this.emit({ state: this.paused ? 'idle' : 'listening' });
  }

  /** Barge-in: a new capture or turn cancel stops playback. */
  async bargeIn(): Promise<void> {
    if (this.activity.state === 'speaking') {
      this.emit({ state: this.paused ? 'idle' : 'listening' });
    }
    await this.deps.onBargeIn?.();
  }

  /**
   * Explicit privacy pause: stops listening, clears the VAD timer, and tears
   * down the injected stream/recorder/AudioContext. start() resumes.
   */
  pause(): void {
    this.paused = true;
    this.isSpeaking = false;
    this.lastVoiceAtMs = null;
    this.clearSilenceTimer();
    this.emit({
      state: 'idle',
      audioLevel: 0,
      connectionState: 'disconnected',
    });
    void this.deps.teardown?.();
  }

  /** Stop (alias of pause) for explicit user stops. */
  stop(): void {
    this.pause();
  }

  /** Unmount teardown: pause and drop all listeners. */
  destroy(): void {
    this.destroyed = true;
    this.pause();
    this.listeners.clear();
  }
}

/**
 * Resolves the default capture mode. Push-to-talk is the CLI/Zed default;
 * continuous is opt-in via ZEDGE_VOICE_CAPTURE_MODE=continuous.
 */
export function resolveCaptureMode(
  env: NodeJS.ProcessEnv = process.env,
): VoiceCaptureMode {
  const value = envFirst(env, [
    'ZEDGE_VOICE_CAPTURE_MODE',
    'MOONSHINE_VOICE_CAPTURE_MODE',
  ])?.toLowerCase();
  return value === 'continuous' ? 'continuous' : 'push-to-talk';
}

