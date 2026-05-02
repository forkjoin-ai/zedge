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
const DEFAULT_MOONSHINE_MODEL = 'gnosis-local';
const QWEN_MOONSHINE_MODEL = 'qwen2.5-0.5b-instruct';
const FAT_STATION_URL =
  process.env.ZEDGE_FAT_STATION_URL ?? 'http://127.0.0.1:8000';
const FAT_STATION_BIN =
  process.env.ZEDGE_FAT_STATION_BIN ??
  [
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
const GNOSIS_NUM_THREADS =
  process.env.ZEDGE_GNOSIS_NUM_THREADS ??
  process.env.GNOSIS_NUM_THREADS ??
  '4';
const HEALTH_POLL_MS = 2_000;
const HEALTH_TIMEOUT_MS = 90_000;
const DEFAULT_KNOT_LAYER_COUNT = 22;

type KnotMetadata = Record<string, unknown>;

interface MoonshineStartupConfig {
  knotPath: string;
  knotMetadata: KnotMetadata | null;
  modelName: string;
  layerRange: string;
  tokenizerGgufPath?: string;
}

interface LocalMoonshineModelSpec {
  modelName: string;
  knotPath: string;
  tokenizerGgufPath?: string;
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
};

interface MoonshineProbeResult {
  healthy: boolean;
  matches: boolean;
  models: string[];
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

function resolveMoonshineLayerRange(metadata: KnotMetadata | null): string {
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

  return `0..${metadataLayerCount ?? DEFAULT_KNOT_LAYER_COUNT}`;
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

function resolveStartupConfig(): MoonshineStartupConfig {
  const configuredKnotPath = process.env.ZEDGE_MOONSHINE_KNOT?.trim();
  const spec = configuredKnotPath ? undefined : resolveZedLocalModelSpec() ?? undefined;
  const knotPath = configuredKnotPath || spec?.knotPath || DEFAULT_KNOT_PATH;
  const knotMetadata = readKnotMetadata(knotPath);
  const modelName = resolveMoonshineModelName(knotMetadata, knotPath, spec);
  const layerRange = resolveMoonshineLayerRange(knotMetadata);
  const tokenizerGgufPath = resolveTokenizerGgufPath(knotPath, spec);
  return {
    knotPath,
    knotMetadata,
    modelName,
    layerRange,
    ...(tokenizerGgufPath ? { tokenizerGgufPath } : {}),
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

async function probeExpectedModel(modelName: string): Promise<MoonshineProbeResult> {
  try {
    const resp = await fetch(`${MOONSHINE_URL}/v1/models`, {
      signal: AbortSignal.timeout(2_000),
    });
    if (!resp.ok) {
      return { healthy: false, matches: false, models: [] };
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

    return {
      healthy: true,
      matches: models.includes(modelName),
      models,
    };
  } catch {
    return { healthy: false, matches: false, models: [] };
  }
}

async function waitReadyForModel(
  modelName: string,
  timeoutMs = HEALTH_TIMEOUT_MS
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await probeExpectedModel(modelName);
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

async function probeFatStationLayerRange(layerRange: string): Promise<boolean> {
  try {
    const resp = await fetch(`${FAT_STATION_URL}/health`, {
      signal: AbortSignal.timeout(2_000),
    });
    if (!resp.ok) return false;

    const body = (await resp.json()) as unknown;
    return isRecord(body) && body['layers'] === layerRange;
  } catch {
    return false;
  }
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
    console.warn(`[moonshine] knot file not found: ${config.knotPath}`);
    return false;
  }

  const { knotPath, modelName, layerRange, tokenizerGgufPath } = config;

  const fatStationHealthy = await probeUrl(FAT_STATION_URL);
  if (fatStationHealthy && !(await probeFatStationLayerRange(layerRange))) {
    console.warn(
      `[moonshine] existing fat-station does not match requested layer range ` +
        `${layerRange}; restarting local listener`
    );
    if (stopLocalListener(FAT_STATION_URL, 'fat-station')) {
      await allowStoppedPortsToClose();
    }
  }

  if (!(await probeUrl(FAT_STATION_URL))) {
    console.log(
      `[moonshine] Starting local fat-station: ${FAT_STATION_BIN} ` +
        `(model=${modelName}, layers=${layerRange}, threads=${GNOSIS_NUM_THREADS})`
    );
    spawnDetached(FAT_STATION_BIN, [
      '--knot',
      knotPath,
      '--port',
      '8000',
      '--role',
      'both',
      '--layers',
      layerRange,
    ], {
      env: {
        GNOSIS_NUM_THREADS,
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
      ...(process.env.ZEDGE_MOONSHINE_AUX_KNOT
        ? { AUX_KNOT_PATH: process.env.ZEDGE_MOONSHINE_AUX_KNOT }
        : {}),
      ...(tokenizerGgufPath ? { TOKENIZER_GGUF_PATH: tokenizerGgufPath } : {}),
    },
    stdoutPath: '/tmp/moonshine-openai-compat-launchd.out.log',
    stderrPath: '/tmp/moonshine-openai-compat-launchd.err.log',
  });

  return await waitReadyForModel(modelName);
}

async function startDockerMoonshine(modelName: string): Promise<boolean> {
  if (!existsSync(COMPOSE_FILE)) {
    console.warn(`[moonshine] compose file not found: ${COMPOSE_FILE} — set ZEDGE_MOONSHINE_COMPOSE_FILE to override`);
    return false;
  }

  console.log('[moonshine] Starting fat-station + openai-compat via docker compose...');
  try {
    await new Promise<void>((resolve, reject) => {
      const proc = spawn(
        'docker',
        ['compose', '-f', COMPOSE_FILE, 'up', '-d', 'fat-station', 'openai-compat'],
        { stdio: 'inherit' }
      );
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
  return await waitReadyForModel(modelName);
}

export async function ensureMoonshineRunning(): Promise<void> {
  const startupConfig = resolveStartupConfig();
  const probeResult = await probeExpectedModel(startupConfig.modelName);
  const fatStationMatches = await probeFatStationLayerRange(
    startupConfig.layerRange
  );
  if (probeResult.healthy && probeResult.matches && fatStationMatches) {
    console.log('[moonshine] OpenAI-compatible endpoint already running');
    return;
  }

  if (probeResult.healthy) {
    const reason = probeResult.matches
      ? `fat-station is not ready for ${startupConfig.layerRange}`
      : `expected ${startupConfig.modelName}`;
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
    (await startDockerMoonshine(startupConfig.modelName));
  if (ready) {
    console.log('[moonshine] Ready');
  } else {
    console.warn('[moonshine] Did not become healthy within timeout — inference will fail until container is up');
  }
}
