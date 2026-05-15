/**
 * Moonshine container lifecycle for the Zedge companion sidecar.
 *
 * Starts the fat-station + openai-compat services at sidecar startup, then
 * waits for the /health endpoint to become ready.
 *
 * The preferred local path uses the repo-built fat-station binary and the
 * TypeScript OpenAI-compatible shim. Docker compose remains a fallback for
 * containerized environments.
 */

import { execFileSync, spawn } from 'child_process';
import { closeSync, existsSync, openSync, readSync } from 'fs';
import { basename, join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { readZedModelSelection } from './zed-settings.ts';

const __here = dirname(fileURLToPath(import.meta.url));
// companion/src → companion → zedge → open-source → repo root
const REPO_ROOT = join(__here, '..', '..', '..', '..');
const COMPOSE_FILE =
  process.env.ZEDGE_MOONSHINE_COMPOSE_FILE ??
  join(REPO_ROOT, 'docker-compose.moonshine.yml');
const RKNOT_COMPOSE_FILE =
  process.env.ZEDGE_MOONSHINE_RKNOT_COMPOSE_FILE ??
  join(REPO_ROOT, 'docker-compose.moonshine-rknot.yml');
const DEFAULT_KNOT_PATH = join(
  REPO_ROOT,
  'open-source/bitwise/datasets/llama1b_fixed.knot'
);
const QWEN_KNOT_PATH = join(
  REPO_ROOT,
  'open-source/bitwise/datasets/qwen2.5-0.5b-instruct-q4_k_m.knot'
);
const QWEN_TOKENIZER_GGUF_PATH = join(
  REPO_ROOT,
  'open-source/bitwise/datasets/gguf/qwen2.5-0.5b-instruct-q4_k_m.gguf'
);
const GEMMA4_DENSE_KNOT_PATH = join(
  REPO_ROOT,
  'open-source/bitwise/datasets/gemma4-31b-it.knot'
);
const GEMMA4_RKNOT_PATH = join(
  REPO_ROOT,
  'open-source/bitwise/datasets/gemma4-31b-it.k10-b8.rknot'
);
const GEMMA4_TOKENIZER_JSON_PATH = join(
  REPO_ROOT,
  'open-source/bitwise/datasets/gemma4-tokenizer.json'
);
const DEFAULT_MOONSHINE_MODEL = 'gnosis-local';
const QWEN_MOONSHINE_MODEL = 'qwen2.5-0.5b-instruct';
const GEMMA4_MOONSHINE_MODEL = 'gemma4-31b-it';
const FAT_STATION_URL =
  process.env.ZEDGE_FAT_STATION_URL ?? 'http://127.0.0.1:8000';
const FAT_STATION_BIN =
  process.env.ZEDGE_FAT_STATION_BIN ??
  [
    join(
      REPO_ROOT,
      'open-source/gnosis/distributed-inference/target/release/fat-station-memo'
    ),
    join(
      REPO_ROOT,
      'open-source/gnosis/distributed-inference/target/debug/fat-station-memo'
    ),
    join(
      REPO_ROOT,
      'open-source/gnosis/distributed-inference/target/release/fat-station'
    ),
    join(
      REPO_ROOT,
      'open-source/gnosis/distributed-inference/target/debug/fat-station'
    ),
  ].find((candidate) => existsSync(candidate));
const OPENAI_COMPAT_ENTRY = join(
  REPO_ROOT,
  'open-source/gnosis/distributed-inference-host/src/bin/openai-server.ts'
);
const OPENAI_COMPAT_CWD = join(
  REPO_ROOT,
  'open-source/gnosis/distributed-inference-host'
);
const TSX_CLI =
  process.env.ZEDGE_TSX_CLI ??
  [
    join(REPO_ROOT, 'node_modules/.pnpm/tsx@4.21.0/node_modules/tsx/dist/cli.mjs'),
    join(REPO_ROOT, 'node_modules/tsx/dist/cli.mjs'),
  ].find((candidate) => existsSync(candidate));

const MOONSHINE_URL = process.env.ZEDGE_MOONSHINE_URL ?? 'http://127.0.0.1:8080';
const DOCKER_COMPOSE_BUILD_ENABLED =
  process.env.ZEDGE_MOONSHINE_DOCKER_BUILD === '1' ||
  process.env.ZEDGE_MOONSHINE_DOCKER_BUILD === 'true';
const GNOSIS_NUM_THREADS =
  process.env.ZEDGE_GNOSIS_NUM_THREADS ??
  process.env.GNOSIS_NUM_THREADS ??
  '4';
const GNOSIS_FFN_LEAKAGE_MODE =
  process.env.ZEDGE_GNOSIS_FFN_LEAKAGE_MODE ??
  process.env.GNOSIS_FFN_LEAKAGE_MODE;
const GNOSIS_FFN_GUARD_RMS_DELTA3_THRESHOLD =
  process.env.ZEDGE_GNOSIS_FFN_GUARD_RMS_DELTA3_THRESHOLD ??
  process.env.GNOSIS_FFN_GUARD_RMS_DELTA3_THRESHOLD;
const GNOSIS_FFN_GUARD_MIN_LOGIT_MARGIN =
  process.env.ZEDGE_GNOSIS_FFN_GUARD_MIN_LOGIT_MARGIN ??
  process.env.GNOSIS_FFN_GUARD_MIN_LOGIT_MARGIN;
const GNOSIS_FFN_GUARD_HIGH_CONFIDENCE_LOGIT_MARGIN =
  process.env.ZEDGE_GNOSIS_FFN_GUARD_HIGH_CONFIDENCE_LOGIT_MARGIN ??
  process.env.GNOSIS_FFN_GUARD_HIGH_CONFIDENCE_LOGIT_MARGIN;
const GNOSIS_FFN_GUARD_ADMIT_WEATHER_CELLS =
  process.env.ZEDGE_GNOSIS_FFN_GUARD_ADMIT_WEATHER_CELLS ??
  process.env.GNOSIS_FFN_GUARD_ADMIT_WEATHER_CELLS;
const HEALTH_POLL_MS = 2_000;
const HEALTH_TIMEOUT_MS = 90_000;
const WATCHDOG_INTERVAL_MS = Number(
  process.env.ZEDGE_MOONSHINE_WATCHDOG_INTERVAL_MS ?? 15_000
);
const DEFAULT_KNOT_LAYER_COUNT = 22;

type KnotMetadata = Record<string, unknown>;

let watchdogInterval: ReturnType<typeof setInterval> | null = null;
let watchdogRepair: Promise<void> | null = null;
let watchdogConsecutiveFailures = 0;

interface MoonshineStartupConfig {
  knotPath: string;
  rknotPath?: string;
  knotMetadata: KnotMetadata | null;
  modelName: string;
  layerRange: string;
  tokenizerGgufPath?: string;
  tokenizerJsonPath?: string;
}

interface LocalMoonshineModelSpec {
  modelName: string;
  knotPath: string;
  rknotPath?: string;
  rknotCandidates?: string[];
  tokenizerGgufPath?: string;
  tokenizerJsonPath?: string;
  defaultLayers?: string;
}

const LOCAL_MOONSHINE_MODELS: Record<string, LocalMoonshineModelSpec> = {
  [DEFAULT_MOONSHINE_MODEL]: {
    modelName: DEFAULT_MOONSHINE_MODEL,
    knotPath: DEFAULT_KNOT_PATH,
  },
  [QWEN_MOONSHINE_MODEL]: {
    modelName: QWEN_MOONSHINE_MODEL,
    knotPath: QWEN_KNOT_PATH,
    tokenizerGgufPath: QWEN_TOKENIZER_GGUF_PATH,
  },
  [GEMMA4_MOONSHINE_MODEL]: {
    modelName: GEMMA4_MOONSHINE_MODEL,
    knotPath: GEMMA4_DENSE_KNOT_PATH,
    rknotPath: GEMMA4_RKNOT_PATH,
    tokenizerJsonPath: GEMMA4_TOKENIZER_JSON_PATH,
    defaultLayers: '0..60',
  },
};

interface MoonshineProbeResult {
  healthy: boolean;
  matches: boolean;
  modelMatches: boolean;
  runtimeMatches: boolean;
  models: string[];
  health?: RuntimeFingerprint;
  mismatchReason?: string;
}

interface RuntimeFingerprint {
  hiddenDim?: number;
  vocabSize?: number;
  layers?: string;
}

interface FatStationProbeResult extends RuntimeFingerprint {
  healthy: boolean;
  matches: boolean;
  status?: string;
  error?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readKnotMetadata(knotPath: string): KnotMetadata | null {
  let fd: number | undefined;
  try {
    fd = openSync(knotPath, 'r');
    const header = Buffer.alloc(10);
    const headerBytes = readSync(fd, header, 0, header.length, 0);
    if (headerBytes < header.length) return null;
    if (header.subarray(0, 4).toString('utf8') !== 'KNOT') return null;

    const metadataLength = header.readUInt32LE(6);
    if (metadataLength <= 0 || metadataLength > 4 * 1024 * 1024) {
      return null;
    }

    const metadataBuffer = Buffer.alloc(metadataLength);
    const metadataBytes = readSync(
      fd,
      metadataBuffer,
      0,
      metadataLength,
      10
    );
    if (metadataBytes < metadataLength) return null;

    const parsed = JSON.parse(metadataBuffer.toString('utf8')) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch (error) {
    console.warn(
      `[moonshine] could not read knot metadata: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return null;
  } finally {
    if (fd !== undefined) {
      closeSync(fd);
    }
  }
}

function positiveInteger(value: unknown): number | null {
  const numberValue =
    typeof value === 'number' ? value : Number.parseInt(String(value), 10);
  if (!Number.isInteger(numberValue) || numberValue <= 0) return null;
  return numberValue;
}

function resolveZedLocalModelSpec(): LocalMoonshineModelSpec | null {
  const selection = readZedModelSelection();
  if (!selection) return null;

  const candidates = [
    selection.defaultModel,
    ...selection.availableModels,
  ].filter((modelId): modelId is string => typeof modelId === 'string');

  for (const rawModelId of candidates) {
    const modelId = rawModelId.trim();
    const spec = LOCAL_MOONSHINE_MODELS[modelId];
    if (spec && existsSync(spec.knotPath)) {
      return spec;
    }
  }

  return null;
}

function resolveMoonshineModelName(
  metadata: KnotMetadata | null,
  knotPath: string,
  spec?: LocalMoonshineModelSpec
): string {
  const configuredModel = process.env.ZEDGE_MOONSHINE_MODEL?.trim();
  if (configuredModel) return configuredModel;
  if (spec) return spec.modelName;

  const metadataName = metadata?.['name'];
  if (
    typeof metadataName === 'string' &&
    metadataName.toLowerCase().includes('qwen')
  ) {
    return metadataName;
  }

  if (knotPath.toLowerCase().includes('qwen')) {
    return QWEN_MOONSHINE_MODEL;
  }

  return DEFAULT_MOONSHINE_MODEL;
}

function resolveMoonshineLayerRange(
  metadata: KnotMetadata | null,
  defaultRange?: string
): string {
  const configuredRange = process.env.ZEDGE_MOONSHINE_LAYER_RANGE?.trim();
  if (configuredRange) return configuredRange;

  const configuredLayers = process.env.ZEDGE_MOONSHINE_LAYERS?.trim();
  if (configuredLayers) {
    if (/^\d+(?:\.\.|:)\d+$/.test(configuredLayers)) {
      return configuredLayers;
    }

    const layerCount = positiveInteger(configuredLayers);
    if (layerCount) return `0..${layerCount}`;
  }

  const config = metadata?.['config'];
  const metadataLayerCount = isRecord(config)
    ? positiveInteger(config['num_layers'])
    : null;

  return defaultRange ?? `0..${metadataLayerCount ?? DEFAULT_KNOT_LAYER_COUNT}`;
}

function resolveMoonshineRknotPath(spec?: LocalMoonshineModelSpec): string | undefined {
  const configuredPath = process.env.ZEDGE_MOONSHINE_RKNOT?.trim();
  if (configuredPath) return configuredPath;
  if (spec?.rknotPath && existsSync(spec.rknotPath)) {
    return spec.rknotPath;
  }
  for (const candidate of spec?.rknotCandidates ?? []) {
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

function resolveTokenizerGgufPath(
  knotPath: string,
  spec?: LocalMoonshineModelSpec
): string | undefined {
  const configuredPath = process.env.ZEDGE_MOONSHINE_TOKENIZER_GGUF?.trim();
  if (configuredPath) return configuredPath;
  if (spec?.tokenizerGgufPath && existsSync(spec.tokenizerGgufPath)) {
    return spec.tokenizerGgufPath;
  }

  const knotBaseName = basename(knotPath, '.knot');
  const adjacentGgufPath = join(dirname(knotPath), 'gguf', `${knotBaseName}.gguf`);
  return existsSync(adjacentGgufPath) ? adjacentGgufPath : undefined;
}

function resolveTokenizerJsonPath(
  modelName: string,
  spec?: LocalMoonshineModelSpec
): string | undefined {
  const configuredPath = process.env.ZEDGE_MOONSHINE_TOKENIZER_JSON?.trim();
  if (configuredPath) return configuredPath;
  if (spec?.tokenizerJsonPath && existsSync(spec.tokenizerJsonPath)) {
    return spec.tokenizerJsonPath;
  }
  if (
    modelName === GEMMA4_MOONSHINE_MODEL &&
    existsSync(GEMMA4_TOKENIZER_JSON_PATH)
  ) {
    return GEMMA4_TOKENIZER_JSON_PATH;
  }
  return undefined;
}

function resolveStartupConfig(): MoonshineStartupConfig {
  const configuredKnotPath = process.env.ZEDGE_MOONSHINE_KNOT?.trim();
  const spec = configuredKnotPath ? undefined : resolveZedLocalModelSpec() ?? undefined;
  const knotPath = configuredKnotPath || spec?.knotPath || DEFAULT_KNOT_PATH;
  const rknotPath = resolveMoonshineRknotPath(spec);
  const knotMetadata = readKnotMetadata(knotPath);
  const modelName = resolveMoonshineModelName(knotMetadata, knotPath, spec);
  const layerRange = resolveMoonshineLayerRange(
    knotMetadata,
    spec?.defaultLayers
  );
  const tokenizerGgufPath = resolveTokenizerGgufPath(knotPath, spec);
  const tokenizerJsonPath = resolveTokenizerJsonPath(modelName, spec);
  return {
    knotPath,
    ...(rknotPath ? { rknotPath } : {}),
    knotMetadata,
    modelName,
    layerRange,
    ...(tokenizerGgufPath ? { tokenizerGgufPath } : {}),
    ...(tokenizerJsonPath ? { tokenizerJsonPath } : {}),
  };
}

async function probe(): Promise<boolean> {
  try {
    const resp = await fetch(`${MOONSHINE_URL}/health`, {
      signal: AbortSignal.timeout(2_000),
    });
    return resp.ok;
  } catch {
    return false;
  }
}

function numericField(body: Record<string, unknown>, key: string): number | undefined {
  const value = body[key];
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function runtimeMismatchReason(
  actual: RuntimeFingerprint | undefined,
  expected: RuntimeFingerprint
): string | undefined {
  if (!actual) return 'OpenAI shim health did not return a runtime fingerprint';
  if (actual.hiddenDim !== expected.hiddenDim) {
    return `hidden_dim ${actual.hiddenDim ?? 'missing'} != ${expected.hiddenDim}`;
  }
  if (actual.vocabSize !== expected.vocabSize) {
    return `vocab_size ${actual.vocabSize ?? 'missing'} != ${expected.vocabSize}`;
  }
  if (
    normalizeLayerRange(String(actual.layers ?? '')) !==
    normalizeLayerRange(String(expected.layers ?? ''))
  ) {
    return `layers ${actual.layers ?? 'missing'} != ${expected.layers}`;
  }
  return undefined;
}

async function probeOpenAiHealth(): Promise<RuntimeFingerprint | undefined> {
  try {
    const resp = await fetch(`${MOONSHINE_URL}/health`, {
      signal: AbortSignal.timeout(2_000),
    });
    if (!resp.ok) return undefined;

    const body = (await resp.json()) as unknown;
    if (!isRecord(body)) return undefined;
    return {
      hiddenDim: numericField(body, 'hidden_dim'),
      vocabSize: numericField(body, 'vocab_size'),
      layers:
        typeof body['layers'] === 'string'
          ? normalizeLayerRange(body['layers'])
          : undefined,
    };
  } catch {
    return undefined;
  }
}

async function probeExpectedModel(
  modelName: string,
  expectedRuntime?: RuntimeFingerprint
): Promise<MoonshineProbeResult> {
  try {
    const [resp, health] = await Promise.all([
      fetch(`${MOONSHINE_URL}/v1/models`, {
        signal: AbortSignal.timeout(2_000),
      }),
      probeOpenAiHealth(),
    ]);
    if (!resp.ok) {
      return {
        healthy: false,
        matches: false,
        modelMatches: false,
        runtimeMatches: false,
        models: [],
        health,
      };
    }

    const body = (await resp.json()) as unknown;
    const models = isRecord(body) && Array.isArray(body['data'])
      ? body['data']
          .map((entry) =>
            isRecord(entry) && typeof entry['id'] === 'string'
              ? entry['id']
              : null
          )
          .filter((entry): entry is string => entry !== null)
      : [];
    const modelMatches = models.includes(modelName);
    const mismatchReason = expectedRuntime
      ? runtimeMismatchReason(health, expectedRuntime)
      : undefined;
    const runtimeMatches = !mismatchReason;

    return {
      healthy: true,
      matches: modelMatches && runtimeMatches,
      modelMatches,
      runtimeMatches,
      models,
      health,
      ...(mismatchReason ? { mismatchReason } : {}),
    };
  } catch {
    return {
      healthy: false,
      matches: false,
      modelMatches: false,
      runtimeMatches: false,
      models: [],
    };
  }
}

async function waitReadyForModel(
  modelName: string,
  expectedRuntime?: RuntimeFingerprint,
  timeoutMs = HEALTH_TIMEOUT_MS
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await probeExpectedModel(modelName, expectedRuntime);
    if (result.healthy && result.matches) return true;
    await new Promise((r) => setTimeout(r, HEALTH_POLL_MS));
  }
  return false;
}

async function probeUrl(url: string): Promise<boolean> {
  try {
    const resp = await fetch(`${url}/health`, {
      signal: AbortSignal.timeout(2_000),
    });
    return resp.ok;
  } catch {
    return false;
  }
}

async function probeFatStationRuntime(
  layerRange: string
): Promise<FatStationProbeResult> {
  try {
    const resp = await fetch(`${FAT_STATION_URL}/health`, {
      signal: AbortSignal.timeout(2_000),
    });
    if (!resp.ok) {
      return {
        healthy: false,
        matches: false,
        error: `fat-station HTTP ${resp.status}`,
      };
    }

    const body = (await resp.json()) as unknown;
    if (!isRecord(body)) {
      return {
        healthy: false,
        matches: false,
        error: 'fat-station health returned a non-object payload',
      };
    }

    const layers =
      typeof body['layers'] === 'string'
        ? normalizeLayerRange(body['layers'])
        : undefined;
    return {
      healthy: body['status'] === 'ok',
      matches: normalizeLayerRange(String(layers ?? '')) === normalizeLayerRange(layerRange),
      status: typeof body['status'] === 'string' ? body['status'] : undefined,
      layers,
      hiddenDim: numericField(body, 'hidden_dim'),
      vocabSize: numericField(body, 'vocab_size'),
    };
  } catch (error) {
    return {
      healthy: false,
      matches: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function normalizeLayerRange(layerRange: string): string {
  return layerRange.trim().replace('..', '-');
}

async function waitUrlReady(
  url: string,
  timeoutMs = HEALTH_TIMEOUT_MS
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probeUrl(url)) return true;
    await new Promise((r) => setTimeout(r, HEALTH_POLL_MS));
  }
  return false;
}

function spawnDetached(
  command: string,
  args: string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    stdoutPath?: string;
    stderrPath?: string;
  } = {}
): void {
  const stdoutFd = options.stdoutPath
    ? openSync(options.stdoutPath, 'a')
    : 'ignore';
  const stderrFd = options.stderrPath
    ? openSync(options.stderrPath, 'a')
    : 'ignore';
  const proc = spawn(command, args, {
    cwd: options.cwd,
    detached: true,
    env: {
      ...process.env,
      PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin',
      ...options.env,
    },
    stdio: ['ignore', stdoutFd, stderrFd],
  });
  proc.unref();
}

function buildFatStationSourceArgs(config: MoonshineStartupConfig): string[] {
  return config.rknotPath
    ? ['--rknot', config.rknotPath, '--dense', config.knotPath]
    : ['--knot', config.knotPath];
}

function moonshineSourceLabel(config: MoonshineStartupConfig): string {
  return config.rknotPath
    ? `rknot=${config.rknotPath}, dense=${config.knotPath}`
    : `knot=${config.knotPath}`;
}

function isLoopbackUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(parsed.hostname);
  } catch {
    return false;
  }
}

function stopLocalListener(url: string, label: string): boolean {
  if (!isLoopbackUrl(url)) return false;

  let port: string;
  try {
    port = new URL(url).port;
  } catch {
    return false;
  }
  if (!port) return false;

  let output = '';
  try {
    output = execFileSync('lsof', [`-tiTCP:${port}`, '-sTCP:LISTEN'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return false;
  }

  const pids = output
    .split(/\s+/)
    .map((pid) => Number.parseInt(pid, 10))
    .filter((pid) => Number.isInteger(pid) && pid > 0 && pid !== process.pid);
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGTERM');
      console.log(`[moonshine] stopped stale ${label} listener pid=${pid}`);
    } catch (error) {
      console.warn(
        `[moonshine] could not stop stale ${label} listener pid=${pid}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  return pids.length > 0;
}

async function allowStoppedPortsToClose(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 1_500));
}

async function startLocalMoonshine(
  config = resolveStartupConfig()
): Promise<boolean> {
  if (!FAT_STATION_BIN || !existsSync(FAT_STATION_BIN)) {
    console.warn('[moonshine] local fat-station binary not found');
    return false;
  }
  if (!TSX_CLI || !existsSync(TSX_CLI)) {
    console.warn('[moonshine] local tsx CLI not found');
    return false;
  }
  if (!existsSync(config.knotPath)) {
    console.warn(`[moonshine] dense knot file not found: ${config.knotPath}`);
    return false;
  }
  if (config.rknotPath && !existsSync(config.rknotPath)) {
    console.warn(`[moonshine] rknot file not found: ${config.rknotPath}`);
    return false;
  }

  const { modelName, layerRange, tokenizerGgufPath, tokenizerJsonPath } = config;

  let fatStationRuntime = await probeFatStationRuntime(layerRange);
  if (!fatStationRuntime.healthy || !fatStationRuntime.matches) {
    console.warn(
      `[moonshine] existing fat-station is not ready for ${layerRange}: ` +
        `${fatStationRuntime.error ?? fatStationRuntime.layers ?? 'unknown'}; ` +
        `restarting local listener`
    );
    if (stopLocalListener(FAT_STATION_URL, 'fat-station')) {
      await allowStoppedPortsToClose();
    }
  }

  if (!(await probeUrl(FAT_STATION_URL))) {
    console.log(
      `[moonshine] Starting local fat-station: ${FAT_STATION_BIN} ` +
        `(model=${modelName}, ${moonshineSourceLabel(config)}, ` +
        `layers=${layerRange}, threads=${GNOSIS_NUM_THREADS})`
    );
    spawnDetached(FAT_STATION_BIN, [
      ...buildFatStationSourceArgs(config),
      '--port',
      '8000',
      '--role',
      'both',
      '--layers',
      layerRange,
    ], {
      env: {
        GNOSIS_NUM_THREADS,
        ...(GNOSIS_FFN_LEAKAGE_MODE ? { GNOSIS_FFN_LEAKAGE_MODE } : {}),
        ...(GNOSIS_FFN_GUARD_RMS_DELTA3_THRESHOLD
          ? { GNOSIS_FFN_GUARD_RMS_DELTA3_THRESHOLD }
          : {}),
        ...(GNOSIS_FFN_GUARD_MIN_LOGIT_MARGIN
          ? { GNOSIS_FFN_GUARD_MIN_LOGIT_MARGIN }
          : {}),
        ...(GNOSIS_FFN_GUARD_HIGH_CONFIDENCE_LOGIT_MARGIN
          ? { GNOSIS_FFN_GUARD_HIGH_CONFIDENCE_LOGIT_MARGIN }
          : {}),
        ...(GNOSIS_FFN_GUARD_ADMIT_WEATHER_CELLS
          ? { GNOSIS_FFN_GUARD_ADMIT_WEATHER_CELLS }
          : {}),
        RUST_BACKTRACE: '1',
      },
      stdoutPath: '/tmp/moonshine-fat-station-launchd.out.log',
      stderrPath: '/tmp/moonshine-fat-station-launchd.err.log',
    });
    if (!(await waitUrlReady(FAT_STATION_URL))) {
      console.warn('[moonshine] local fat-station did not become healthy');
      return false;
    }
  }

  fatStationRuntime = await probeFatStationRuntime(layerRange);
  if (!fatStationRuntime.healthy || !fatStationRuntime.matches) {
    console.warn(
      `[moonshine] local fat-station is not ready for ${layerRange}: ` +
        `${fatStationRuntime.error ?? fatStationRuntime.layers ?? 'unknown'}`
    );
    return false;
  }

  const existingOpenAiShim = await probeExpectedModel(
    modelName,
    fatStationRuntime
  );
  if (existingOpenAiShim.healthy && existingOpenAiShim.matches) {
    return true;
  }

  if (existingOpenAiShim.healthy && existingOpenAiShim.mismatchReason) {
    console.warn(
      `[moonshine] existing OpenAI-compatible shim runtime mismatch: ` +
        `${existingOpenAiShim.mismatchReason}; restarting local listener`
    );
  }

  if (stopLocalListener(MOONSHINE_URL, 'OpenAI-compatible')) {
    await allowStoppedPortsToClose();
  }

  if (!(await probeUrl(FAT_STATION_URL))) {
    console.log(
      `[moonshine] Starting local fat-station: ${FAT_STATION_BIN} ` +
        `(model=${modelName}, ${moonshineSourceLabel(config)}, ` +
        `layers=${layerRange}, threads=${GNOSIS_NUM_THREADS})`
    );
    spawnDetached(FAT_STATION_BIN, [
      ...buildFatStationSourceArgs(config),
      '--port',
      '8000',
      '--role',
      'both',
      '--layers',
      layerRange,
    ], {
      env: {
        GNOSIS_NUM_THREADS,
        ...(GNOSIS_FFN_LEAKAGE_MODE ? { GNOSIS_FFN_LEAKAGE_MODE } : {}),
        ...(GNOSIS_FFN_GUARD_RMS_DELTA3_THRESHOLD
          ? { GNOSIS_FFN_GUARD_RMS_DELTA3_THRESHOLD }
          : {}),
        ...(GNOSIS_FFN_GUARD_MIN_LOGIT_MARGIN
          ? { GNOSIS_FFN_GUARD_MIN_LOGIT_MARGIN }
          : {}),
        ...(GNOSIS_FFN_GUARD_HIGH_CONFIDENCE_LOGIT_MARGIN
          ? { GNOSIS_FFN_GUARD_HIGH_CONFIDENCE_LOGIT_MARGIN }
          : {}),
        ...(GNOSIS_FFN_GUARD_ADMIT_WEATHER_CELLS
          ? { GNOSIS_FFN_GUARD_ADMIT_WEATHER_CELLS }
          : {}),
        RUST_BACKTRACE: '1',
      },
      stdoutPath: '/tmp/moonshine-fat-station-launchd.out.log',
      stderrPath: '/tmp/moonshine-fat-station-launchd.err.log',
    });
    if (!(await waitUrlReady(FAT_STATION_URL))) {
      console.warn('[moonshine] local fat-station did not become healthy');
      return false;
    }
  }

  console.log('[moonshine] Starting local OpenAI-compatible shim');
  spawnDetached(process.execPath, [TSX_CLI, OPENAI_COMPAT_ENTRY], {
    cwd: OPENAI_COMPAT_CWD,
    env: {
      FAT_STATION_URL,
      PORT: '8080',
      MODEL_NAME: modelName,
      AGENTIC: '0',
      MOONSHINE_MEMO_ENABLED:
        process.env.ZEDGE_MOONSHINE_MEMO_ENABLED ?? '1',
      MOONSHINE_MEMO_TAU_SQUARED:
        process.env.ZEDGE_MOONSHINE_MEMO_TAU_SQUARED ?? '0',
      MOONSHINE_MEMO_MAX_ENTRIES:
        process.env.ZEDGE_MOONSHINE_MEMO_MAX_ENTRIES ?? '8192',
      ...(GNOSIS_FFN_LEAKAGE_MODE ? { GNOSIS_FFN_LEAKAGE_MODE } : {}),
      ...(GNOSIS_FFN_GUARD_RMS_DELTA3_THRESHOLD
        ? { GNOSIS_FFN_GUARD_RMS_DELTA3_THRESHOLD }
        : {}),
      ...(process.env.ZEDGE_MOONSHINE_AUX_KNOT
        ? { AUX_KNOT_PATH: process.env.ZEDGE_MOONSHINE_AUX_KNOT }
        : {}),
      ...(tokenizerGgufPath ? { TOKENIZER_GGUF_PATH: tokenizerGgufPath } : {}),
      ...(tokenizerJsonPath ? { GEMMA4_TOKENIZER_JSON: tokenizerJsonPath } : {}),
    },
    stdoutPath: '/tmp/moonshine-openai-compat-launchd.out.log',
    stderrPath: '/tmp/moonshine-openai-compat-launchd.err.log',
  });

  return await waitReadyForModel(modelName, fatStationRuntime);
}

async function startDockerMoonshine(
  config = resolveStartupConfig()
): Promise<boolean> {
  if (!existsSync(COMPOSE_FILE)) {
    console.warn(`[moonshine] compose file not found: ${COMPOSE_FILE} — set ZEDGE_MOONSHINE_COMPOSE_FILE to override`);
    return false;
  }
  if (config.rknotPath && !existsSync(RKNOT_COMPOSE_FILE)) {
    console.warn(
      `[moonshine] RKNOT compose file not found: ${RKNOT_COMPOSE_FILE} — ` +
        `set ZEDGE_MOONSHINE_RKNOT_COMPOSE_FILE to override`
    );
    return false;
  }

  const composeArgs = ['compose', '-f', COMPOSE_FILE];
  const composeEnv: NodeJS.ProcessEnv = { ...process.env };
  if (config.rknotPath) {
    composeArgs.push('-f', RKNOT_COMPOSE_FILE);
    composeEnv.MOONSHINE_MESH_RKNOT_HOST_PATH = config.rknotPath;
    composeEnv.MOONSHINE_MESH_DENSE_HOST_PATH = config.knotPath;
    composeEnv.MOONSHINE_MESH_LAYERS = config.layerRange;
    composeEnv.MODEL_NAME = config.modelName;
  }
  composeArgs.push('up', '-d');
  if (!DOCKER_COMPOSE_BUILD_ENABLED) {
    composeArgs.push('--no-build');
  }
  composeArgs.push('fat-station', 'openai-compat');

  console.log(
    '[moonshine] Starting fat-station + openai-compat via docker compose ' +
      `(${config.modelName}, ${moonshineSourceLabel(config)}, ` +
      `build=${DOCKER_COMPOSE_BUILD_ENABLED ? 'enabled' : 'disabled'})...`
  );
  try {
    await new Promise<void>((resolve, reject) => {
      const proc = spawn('docker', composeArgs, {
        stdio: 'inherit',
        env: composeEnv,
      });
      proc.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`docker compose up exited with code ${code}`));
      });
      proc.on('error', reject);
    });
  } catch (error) {
    console.warn(`[moonshine] docker startup failed: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }

  console.log('[moonshine] Waiting for /health...');
  return await waitReadyForModel(config.modelName);
}

export async function ensureMoonshineRunning(): Promise<void> {
  const startupConfig = resolveStartupConfig();
  const fatStationRuntime = await probeFatStationRuntime(
    startupConfig.layerRange
  );
  const probeResult = await probeExpectedModel(
    startupConfig.modelName,
    fatStationRuntime.healthy && fatStationRuntime.matches
      ? fatStationRuntime
      : undefined
  );
  if (
    probeResult.healthy &&
    probeResult.matches &&
    fatStationRuntime.healthy &&
    fatStationRuntime.matches
  ) {
    console.log('[moonshine] OpenAI-compatible endpoint already running');
    return;
  }

  if (probeResult.healthy) {
    const reason = !probeResult.modelMatches
      ? `expected ${startupConfig.modelName}`
      : probeResult.mismatchReason
        ? `runtime mismatch (${probeResult.mismatchReason})`
        : `fat-station is not ready for ${startupConfig.layerRange}`;
    console.warn(
      `[moonshine] existing OpenAI-compatible endpoint exposes ` +
        `${probeResult.models.join(', ') || 'no models'}, ${reason}; ` +
        `restarting local listener`
    );
    if (stopLocalListener(MOONSHINE_URL, 'OpenAI-compatible')) {
      await allowStoppedPortsToClose();
    }
  }

  const ready =
    (await startLocalMoonshine(startupConfig)) ||
    (await startDockerMoonshine(startupConfig));
  if (ready) {
    console.log('[moonshine] Ready');
  } else {
    console.warn('[moonshine] Did not become healthy within timeout — inference will fail until container is up');
  }
}

async function isMoonshineRuntimeReady(
  startupConfig = resolveStartupConfig()
): Promise<boolean> {
  const fatStationRuntime = await probeFatStationRuntime(
    startupConfig.layerRange
  );
  if (!fatStationRuntime.healthy || !fatStationRuntime.matches) return false;

  const probeResult = await probeExpectedModel(
    startupConfig.modelName,
    fatStationRuntime
  );
  return probeResult.healthy && probeResult.matches;
}

export function startMoonshineRuntimeWatchdog(): void {
  if (process.env.ZEDGE_MOONSHINE_WATCHDOG === '0') return;
  if (watchdogInterval !== null) return;
  if (!Number.isFinite(WATCHDOG_INTERVAL_MS) || WATCHDOG_INTERVAL_MS <= 0) {
    return;
  }

  watchdogInterval = setInterval(() => {
    if (watchdogRepair !== null) return;
    watchdogRepair = (async () => {
      try {
        if (await isMoonshineRuntimeReady()) {
          watchdogConsecutiveFailures = 0;
          return;
        }
        watchdogConsecutiveFailures += 1;
        if (watchdogConsecutiveFailures < 2) return;
        watchdogConsecutiveFailures = 0;
        console.warn('[moonshine] runtime degraded; repairing local listeners');
        await ensureMoonshineRunning();
      } catch (error) {
        console.warn(
          `[moonshine] runtime watchdog failed: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      } finally {
        watchdogRepair = null;
      }
    })();
  }, WATCHDOG_INTERVAL_MS);
  watchdogInterval.unref?.();
}
