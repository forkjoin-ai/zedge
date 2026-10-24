import { spawn } from 'child_process';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

export type TtsAudioMode = 'auto' | 'host' | 'pulse' | 'alsa' | 'file';
export type ResolvedTtsAudioMode = Exclude<TtsAudioMode, 'auto'>;

export interface TtsSpeakResult {
  ok: boolean;
  mode: ResolvedTtsAudioMode;
  playback: string;
  byteLength: number;
  contentType: string;
  filePath?: string;
  moonshineStatus?: number;
  error?: string;
}

export interface TtsRelayStatus {
  enabled: boolean;
  requestedMode: TtsAudioMode;
  mode: ResolvedTtsAudioMode;
  moonshineUrl: string;
  platform: string;
}

export interface TtsVoice {
  id: string;
  name: string;
  model: string;
  local: boolean;
}

interface ResolveModeOptions {
  platform?: NodeJS.Platform | string;
  hasAlsaDevice?: () => boolean;
}

interface TtsSpeakOptions extends ResolveModeOptions {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  runCommand?: (command: string, args: string[]) => Promise<boolean>;
  outputDir?: string;
  playback?: boolean;
}

const TTS_MODES = new Set<TtsAudioMode>([
  'auto',
  'host',
  'pulse',
  'alsa',
  'file',
]);

const DISABLED_TTS_VALUES = new Set(['0', 'false', 'off', 'no', 'disabled']);
const TTS_VOICES: TtsVoice[] = [
  { id: 'local', name: 'Moonshine Local', model: 'moonshine-tts', local: true },
  { id: 'moonshine', name: 'Moonshine', model: 'moonshine-tts', local: true },
  { id: 'narrator', name: 'Narrator', model: 'moonshine-tts', local: true },
];

function moonshineBaseUrl(env: NodeJS.ProcessEnv): string {
  return (env['ZEDGE_MOONSHINE_URL'] ?? 'http://127.0.0.1:8080').replace(
    /\/+$/,
    '',
  );
}

function configuredAudioMode(env: NodeJS.ProcessEnv): string | undefined {
  return env['ZEDGE_TTS_AUDIO_MODE'] ?? env['MOONSHINE_TTS_AUDIO_MODE'];
}

/**
 * Parses the Tts Audio Mode.
 */
export function parseTtsAudioMode(value: string | undefined): TtsAudioMode {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return 'auto';
  return TTS_MODES.has(normalized as TtsAudioMode)
    ? (normalized as TtsAudioMode)
    : 'auto';
}

/**
 * Resolves the Tts Audio Mode.
 */
export function resolveTtsAudioMode(
  value: string | undefined,
  options: ResolveModeOptions = {},
): ResolvedTtsAudioMode {
  const requested = parseTtsAudioMode(value);
  if (requested !== 'auto') return requested;

  const platform = options.platform ?? process.platform;
  if (platform === 'darwin') return 'host';
  if (
    platform === 'linux' &&
    (options.hasAlsaDevice ?? (() => existsSync('/dev/snd')))()
  ) {
    return 'alsa';
  }
  return 'file';
}

/**
 * Returns whether is Tts Relay Enabled is true.
 */
export function isTtsRelayEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = (env['ZEDGE_TTS_ENABLED'] ?? env['MOONSHINE_TTS_ENABLED'])
    ?.trim()
    .toLowerCase();
  return !value || !DISABLED_TTS_VALUES.has(value);
}

/**
 * Handles the zedge get Tts Relay Status workflow.
 */
export function getTtsRelayStatus(
  options: TtsSpeakOptions = {},
): TtsRelayStatus {
  const env = options.env ?? process.env;
  const requestedMode = parseTtsAudioMode(configuredAudioMode(env));
  const platform = String(options.platform ?? process.platform);
  return {
    enabled: isTtsRelayEnabled(env),
    requestedMode,
    mode: resolveTtsAudioMode(configuredAudioMode(env), options),
    moonshineUrl: moonshineBaseUrl(env),
    platform,
  };
}

/**
 * Handles the zedge list Tts Voices workflow.
 */
export function listTtsVoices(): { defaultVoice: string; voices: TtsVoice[] } {
  return {
    defaultVoice: 'local',
    voices: TTS_VOICES,
  };
}

/**
 * Handles the zedge configure Tts Relay workflow.
 */
export function configureTtsRelay(
  body: unknown,
  options: TtsSpeakOptions = {},
): { status: number; result: TtsRelayStatus & { ok: boolean; error?: string } } {
  const env = options.env ?? process.env;
  const request =
    body && typeof body === 'object' ? (body as Record<string, unknown>) : {};

  if ('enabled' in request) {
    if (typeof request.enabled !== 'boolean') {
      return {
        status: 400,
        result: {
          ok: false,
          ...getTtsRelayStatus(options),
          error: 'enabled must be a boolean',
        },
      };
    }
    env['ZEDGE_TTS_ENABLED'] = request.enabled ? '1' : '0';
  }

  if ('mode' in request) {
    if (typeof request.mode !== 'string') {
      return {
        status: 400,
        result: {
          ok: false,
          ...getTtsRelayStatus(options),
          error: 'mode must be a string',
        },
      };
    }

    const mode = request.mode.trim().toLowerCase();
    if (DISABLED_TTS_VALUES.has(mode)) {
      env['ZEDGE_TTS_ENABLED'] = '0';
    } else if (!TTS_MODES.has(mode as TtsAudioMode)) {
      return {
        status: 400,
        result: {
          ok: false,
          ...getTtsRelayStatus(options),
          error: `unsupported TTS audio mode: ${request.mode}`,
        },
      };
    } else {
      env['ZEDGE_TTS_AUDIO_MODE'] = mode;
      if (!('enabled' in request)) {
        env['ZEDGE_TTS_ENABLED'] = '1';
      }
    }
  }

  return {
    status: 200,
    result: {
      ok: true,
      ...getTtsRelayStatus(options),
    },
  };
}

function writeAudioFile(bytes: Uint8Array, outputDir?: string): string {
  const dir = outputDir ?? join(tmpdir(), 'zedge-tts');
  mkdirSync(dir, { recursive: true });
  const path = join(
    dir,
    `speech-${Date.now()}-${Math.random().toString(36).slice(2)}.wav`,
  );
  writeFileSync(path, bytes);
  return path;
}

function defaultRunCommand(command: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: 'ignore' });
    const timer = setTimeout(() => child.kill('SIGTERM'), 15_000);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve(code === 0);
    });
    child.on('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

function playbackCommand(
  mode: ResolvedTtsAudioMode,
  platform: string,
): string | null {
  if (mode === 'file') return null;
  if (mode === 'pulse') return 'paplay';
  if (mode === 'alsa') return 'aplay';
  if (platform === 'darwin') return 'afplay';
  if (platform === 'linux') return 'aplay';
  return null;
}

function errorResult(
  status: number,
  message: string,
  mode: ResolvedTtsAudioMode,
): { status: number; result: TtsSpeakResult } {
  return {
    status,
    result: {
      ok: false,
      mode,
      playback: 'none',
      byteLength: 0,
      contentType: 'application/json',
      error: message,
    },
  };
}

/**
 * Handles the Tts Speak Request request flow.
 */
export async function handleTtsSpeakRequest(
  body: unknown,
  options: TtsSpeakOptions = {},
): Promise<{ status: number; result: TtsSpeakResult }> {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const mode = resolveTtsAudioMode(
    configuredAudioMode(env),
    options,
  );

  if (!isTtsRelayEnabled(env)) {
    return errorResult(409, 'TTS relay is disabled', mode);
  }

  const request = body as {
    input?: unknown;
    voice?: unknown;
    format?: unknown;
  };
  if (typeof request.input !== 'string' || request.input.trim().length === 0) {
    return errorResult(400, 'input must be a non-empty string', mode);
  }
  if (request.voice !== undefined && typeof request.voice !== 'string') {
    return errorResult(400, 'voice must be a string when provided', mode);
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(`${moonshineBaseUrl(env)}/v1/audio/speech`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        input: request.input,
        ...(request.voice ? { voice: request.voice } : {}),
        format: 'wav',
      }),
    });
  } catch (error) {
    return errorResult(
      502,
      error instanceof Error ? error.message : String(error),
      mode,
    );
  }

  const contentType =
    response.headers.get('content-type') ?? 'application/octet-stream';
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    return {
      status: 502,
      result: {
        ok: false,
        mode,
        playback: 'none',
        byteLength: 0,
        contentType,
        moonshineStatus: response.status,
        error: detail || `Moonshine TTS returned HTTP ${response.status}`,
      },
    };
  }

  const audio = new Uint8Array(await response.arrayBuffer());
  if (audio.byteLength === 0) {
    return errorResult(502, 'Moonshine TTS returned empty audio', mode);
  }

  const command = playbackCommand(mode, String(platform));
  const filePath = writeAudioFile(audio, options.outputDir);
  if (options.playback === false) {
    return {
      status: 200,
      result: {
        ok: true,
        mode,
        playback: 'preview',
        byteLength: audio.byteLength,
        contentType,
        filePath,
        moonshineStatus: response.status,
      },
    };
  }

  if (!command) {
    return {
      status: 200,
      result: {
        ok: true,
        mode,
        playback: 'file',
        byteLength: audio.byteLength,
        contentType,
        filePath,
        moonshineStatus: response.status,
      },
    };
  }

  const played = await (options.runCommand ?? defaultRunCommand)(command, [
    filePath,
  ]);
  return {
    status: 200,
    result: {
      ok: true,
      mode,
      playback: played ? command : `${command}-failed`,
      byteLength: audio.byteLength,
      contentType,
      filePath,
      moonshineStatus: response.status,
    },
  };
}

/**
 * Handles the Tts Preview Request request flow.
 */
export function handleTtsPreviewRequest(
  body: unknown,
  options: TtsSpeakOptions = {},
): Promise<{ status: number; result: TtsSpeakResult }> {
  return handleTtsSpeakRequest(body, { ...options, playback: false });
}
