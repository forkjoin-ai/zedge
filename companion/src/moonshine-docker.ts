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
import { homedir } from 'os';
import { basename, join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { readZedModelSelection } from './zed-settings.ts';
import {
  guardedSubagentCreate,
  guardedSubagentReap,
  isGuardedSubagentEnabled,
  guardedSubagentDisabledReason,
  resolveGuardedSubagentEnv,
  type GuardedSubagentEnv,
} from './monster-resident-client.ts';

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
// The previously-referenced qwen2.5-0.5b-instruct-q4_k_m.knot exists neither
// locally nor in R2. The only runnable dense Qwen knot is the cached 4.7GB
// coder model the producer's Paris quality gate already verifies. Point the
// Qwen spec at it. Override with ZEDGE_QWEN_CODER_KNOT or ZEDGE_MOONSHINE_KNOT.
// NOTE: this is a CODER model — route to completions/FIM, not chat (chat deflects).
const QWEN_CODER_KNOT_PATH =
  process.env.ZEDGE_QWEN_CODER_KNOT?.trim() ||
  join(homedir(), '.edgework', 'models', 'qwen-coder-7b.knot');
// Layer depth the Paris gate uses for the 7B coder knot (0..28). Setting this
// explicitly avoids the runtime-fingerprint mismatch restart loop.
const QWEN_CODER_DEFAULT_LAYERS = '0..28';
const GEMMA4_DENSE_KNOT_PATH = join(
  REPO_ROOT,
  'open-source/bitwise/datasets/gemma4-31b-it.knot'
);
const GEMMA4_DENSE_KNOT_URL =
  process.env.ZEDGE_GEMMA4_DENSE_KNOT_URL ??
  'https://edgework.ai/api/v1/r2/distributed-inference/models/gemma4-31b-it.knot';
const GEMMA4_RKNOT_PATH = join(
  REPO_ROOT,
  'open-source/bitwise/datasets/gemma4-31b-it.k10-b8.rknot'
);
const GEMMA4_TOKENIZER_JSON_PATH = join(
  REPO_ROOT,
  'open-source/bitwise/datasets/gemma4-tokenizer.json'
);
const DEFAULT_MOONSHINE_MODEL = 'gnosis-local';
const QWEN_CODER_MOONSHINE_MODEL = 'qwen-coder-7b';
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
const GNOSIS_RKNOT_DECODE_CACHE_BYTES =
  process.env.ZEDGE_GNOSIS_RKNOT_DECODE_CACHE_BYTES ??
  process.env.GNOSIS_RKNOT_DECODE_CACHE_BYTES ??
  '0';
const HEALTH_POLL_MS = 2_000;
const HEALTH_TIMEOUT_MS = Number(
  process.env.ZEDGE_MOONSHINE_HEALTH_TIMEOUT_MS ?? 300_000
);
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
  denseFallbackUrl?: string;
  rknotPath?: string;
  rknotCandidates?: string[];
  tokenizerGgufPath?: string;
  tokenizerJsonPath?: string;
  defaultLayers?: string;
}

// Base for dense .knot files on R2 (served by fat-station / the worker via HTTP
// Range). New mesh knots follow the regular key models/<id>.knot, so a single
// helper wires them: local cache path if present, else stream the R2 fallback.
// Layers are intentionally NOT pinned -- resolveMoonshineLayerRange reads the
// count from the knot metadata (0..<metadataLayerCount>), so each arch self-sizes.
const R2_DENSE_KNOT_BASE =
  process.env.ZEDGE_R2_KNOT_BASE?.trim() ??
  'https://edgework.ai/api/v1/r2/distributed-inference/models';
function meshKnotSpec(id: string): LocalMoonshineModelSpec {
  return {
    modelName: id,
    knotPath: join(homedir(), '.edgework', 'models', `${id}.knot`),
    denseFallbackUrl: `${R2_DENSE_KNOT_BASE}/${id}.knot`,
  };
}

const LOCAL_MOONSHINE_MODELS: Record<string, LocalMoonshineModelSpec> = {
  [DEFAULT_MOONSHINE_MODEL]: {
    modelName: DEFAULT_MOONSHINE_MODEL,
    knotPath: DEFAULT_KNOT_PATH,
  },
  [QWEN_CODER_MOONSHINE_MODEL]: {
    modelName: QWEN_CODER_MOONSHINE_MODEL,
    knotPath: QWEN_CODER_KNOT_PATH,
    // Coder knot is 0..28 deep; pin it so the runtime fingerprint matches.
    defaultLayers: QWEN_CODER_DEFAULT_LAYERS,
  },
  [GEMMA4_MOONSHINE_MODEL]: {
    modelName: GEMMA4_MOONSHINE_MODEL,
    knotPath: GEMMA4_DENSE_KNOT_PATH,
    denseFallbackUrl: GEMMA4_DENSE_KNOT_URL,
    rknotPath: GEMMA4_RKNOT_PATH,
    tokenizerJsonPath: GEMMA4_TOKENIZER_JSON_PATH,
    // Interactive sidecar default: full 0..60 currently exceeds the runtime
    // fetch ceiling on local RKNOT probes. Opt into full depth with
    // ZEDGE_MOONSHINE_LAYER_RANGE=0..60 for profiling and quality runs.
    defaultLayers: '0..1',
  },
  // New mesh knots (dense, on R2; layers auto-detected from knot metadata).
  'smollm2-360m': meshKnotSpec('smollm2-360m'),
  // UN-WIRED 2026-05-24: the R2 gemma3-1b-it.knot is BROKEN — gate gives
  // 262144/262144 NaN logits (config 26L/1152h; all-NaN = pre-Q8-fix 36-byte
  // encode). NOT a pipeline bug (gemma3-4b passes the same Gemma4Pipeline).
  // Re-encode with the fixed encoder (cloudbuild has an encode-gemma3-1b step),
  // re-gate (gemma tokens 2,818,5279,529,7001,563 -> 9079), then re-wire.
  // 'gemma3-1b-it': meshKnotSpec('gemma3-1b-it'),
  // ADMITTED (monster-guard PASS, Paris 12095 rank0) after re-knot fixed
  // rope_theta 1e6→10000. qwen2->NativeLlama.
  'deepseek-r1-1.5b': meshKnotSpec('deepseek-r1-1.5b'),
  'phi-3.5-mini': meshKnotSpec('phi-3.5-mini'),
  // ADMITTED (Paris 7785 rank0) after the SSM fix chain (Q8 loader, a_log F32,
  // A-disc, conv1d reorder, tied-lm_head fallback). mamba -> MambaPipeline.
  'mamba-2.8b': meshKnotSpec('mamba-2.8b'),
  // Landed + config-QA'd (4.4 GB, qwen2/NativeLlama, 28 layers / 3584 hidden).
  'qwen2.5-7b': meshKnotSpec('qwen2.5-7b'),
  // ADMITTED (monster-guard PASS, Paris 6233 rank0) after bowl_q_filter fix.
  // 34-byte Q8_0, mistral = qwen2 arch / NativeLlama (32 layers / 4096 hidden).
  'mistral-7b': meshKnotSpec('mistral-7b'),
  // ADMITTED (monster-guard PASS, Paris 12366 rank0) after rope_theta re-encode
  // (500000) + bowl_q_filter fix. arch=llama / NativeLlama (28L / 3072h).
  'llama-3.2-3b': meshKnotSpec('llama-3.2-3b'),
  // ADMITTED (monster-guard PASS, Paris 12095 rank0) after the amplituhedron
  // hotpath fix. qwen3 dense / NativeLlama + per-head q/k-norm (36L / 2560h).
  'qwen3-4b': meshKnotSpec('qwen3-4b'),
  // ADMITTED (monster-guard PASS, Paris 12095 rank0) after amplituhedron fix.
  'qwen3-8b': meshKnotSpec('qwen3-8b'),
  // ADMITTED (Paris 6671 rank0) after d_inner-from-weights + weightless B/C/dt
  // RMSNorms (FalconMamba is Mamba-1 + those norms). falcon-mamba->MambaPipeline.
  'falcon-mamba-7b': meshKnotSpec('falcon-mamba-7b'),
  // ADMITTED 2026-05-24 (Paris 9079 rank0, logit 21.25 == HF; monster-guard PASS
  // w/ reject 506). Root cause was SWAPPED gemma3 sandwich norms: the knot's
  // ffn_norm IS HF post_attention_layernorm and post_attention_norm IS HF
  // pre_feedforward_layernorm (llama.cpp gemma GGUF naming) — model_gemma4.rs
  // fetched them backwards. gemma3 -> Gemma4Pipeline.
  'gemma3-4b-it': meshKnotSpec('gemma3-4b-it'),
  // ── Exotic (non-transformer) knots — runtime arches are wired (rwkv7 ->
  //    model_rwkv7.rs, jamba -> model_hybrid.rs) and the encode-ssm-models.py
  //    converter round-trip is audited GREEN (tensor names + arch + config all
  //    match). Pending cloud build + R2 upload (currently 404); uncomment each
  //    the moment its <id>.knot returns 200 on R2. Build cmds:
  //      encode-ssm-models.py --model RWKV/RWKV7-Goose-World3-2.9B-HF \
  //        --output rknots/rwkv7-2.9b.knot
  //      encode-ssm-models.py --model ai21labs/AI21-Jamba-1.5-Mini \
  //        --output rknots/jamba-1.5-mini.knot
  //    falcon-h1r-7b is blocked: upstream ships fused QKV; the converter now
  //    refuses it (needs a fused->split q/k/v step) rather than shipping zeroed
  //    attention.
  // ADMITTED 2026-05-24 (Paris 37138 rank0, nan=0; R2 200). rwkv7->RWKV7Pipeline.
  'rwkv7-2.9b': meshKnotSpec('rwkv7-2.9b'),
  // ADMITTED 2026-05-24 (vision-language). Re-encode (9da8efe5, 4.32GB) carries the
  // Qwen2.5-VL vision tower; ViT (model_qwen2vl_vit.rs) -> visual tokens -> NativeLlama.
  // Real face-image caption passed the looser coherence gate. Image input via the
  // fat-station /vision-embed + /vision-chat routes.
  'qwen2.5-vl-3b': meshKnotSpec('qwen2.5-vl-3b'),
  // 'jamba-1.5-mini': meshKnotSpec('jamba-1.5-mini'),  // MESH-GATE PENDING (54GB)
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

function isHttpUrl(value: string): boolean {
  return value.startsWith('http://') || value.startsWith('https://');
}

function sourceExists(value: string): boolean {
  return isHttpUrl(value) || existsSync(value);
}

function isExplicitGemma4Selection(): boolean {
  return (
    process.env.ZEDGE_MOONSHINE_MODEL?.trim() === GEMMA4_MOONSHINE_MODEL ||
    !!process.env.ZEDGE_MOONSHINE_RKNOT?.trim()
  );
}

function canUseModelSpec(spec: LocalMoonshineModelSpec): boolean {
  if (spec.modelName === GEMMA4_MOONSHINE_MODEL) {
    return (
      isExplicitGemma4Selection() ||
      resolveMoonshineRknotPath(spec) !== undefined
    );
  }
  return sourceExists(resolveDenseSource(spec));
}

function readKnotMetadata(knotPath: string): KnotMetadata | null {
  if (isHttpUrl(knotPath)) return null;

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
  } catch (error: unknown) {
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
  if (!selection) {
    const defaultSpec = LOCAL_MOONSHINE_MODELS[GEMMA4_MOONSHINE_MODEL];
    return defaultSpec && canUseModelSpec(defaultSpec) ? defaultSpec : null;
  }

  const candidates = [
    selection.defaultModel,
    ...selection.availableModels,
  ].filter((modelId): modelId is string => typeof modelId === 'string');

  for (const rawModelId of candidates) {
    const modelId = rawModelId.trim();
    const spec = LOCAL_MOONSHINE_MODELS[modelId];
    if (spec && canUseModelSpec(spec)) {
      return spec;
    }
  }

  return null;
}

function resolveDenseSource(spec?: LocalMoonshineModelSpec): string {
  const configuredPath = process.env.ZEDGE_MOONSHINE_KNOT?.trim();
  if (configuredPath) return configuredPath;
  if (spec?.knotPath && existsSync(spec.knotPath)) return spec.knotPath;
  if (spec?.denseFallbackUrl) return spec.denseFallbackUrl;
  return spec?.knotPath || DEFAULT_KNOT_PATH;
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
    return QWEN_CODER_MOONSHINE_MODEL;
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
  const spec = process.env.ZEDGE_MOONSHINE_KNOT?.trim()
    ? undefined
    : resolveZedLocalModelSpec() ?? undefined;
  const knotPath = resolveDenseSource(spec);
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
  } catch (error: unknown) {
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

// ---------- Guarded subagent inference hotpath ----------

// Stable id for the editor's leased inference subagent so reap/list can target
// it. Caste "breeder": this node is the persistent host for the editor's model.
const GUARDED_SUBAGENT_ID =
  process.env.ZEDGE_GUARDED_SUBAGENT_ID?.trim() || 'zedge-inference';
// Node binary name the allowlist resolves. Defaults to the basename of the
// preferred binary (fat-station-memo / fat-station). Override with
// ZEDGE_FAT_STATION_NODE if the allowlist exposes a different name.
const GUARDED_SUBAGENT_NODE =
  process.env.ZEDGE_FAT_STATION_NODE?.trim() ||
  (FAT_STATION_BIN ? basename(FAT_STATION_BIN) : 'fat-station');
const GUARDED_SUBAGENT_LEASE_SECS = Number(
  process.env.ZEDGE_GUARDED_SUBAGENT_LEASE_SECS ?? 60
);
const GUARDED_SUBAGENT_GRANT_TTL_SECS = Number(
  process.env.ZEDGE_GUARDED_SUBAGENT_GRANT_TTL_SECS ?? 86_400
);

// Resolved once per process. null = not yet resolved.
let guardedEnvCache: { env?: GuardedSubagentEnv; missing: string[] } | null =
  null;

function getGuardedEnv(): { env?: GuardedSubagentEnv; missing: string[] } {
  if (guardedEnvCache === null) {
    guardedEnvCache = resolveGuardedSubagentEnv(REPO_ROOT);
  }
  return guardedEnvCache;
}

/** Builds the env passed to the fat-station node (guarded or legacy). */
function buildFatStationNodeEnv(
  config: MoonshineStartupConfig
): NodeJS.ProcessEnv {
  return {
    GNOSIS_NUM_THREADS,
    ...(config.rknotPath ? { GNOSIS_RKNOT_DECODE_CACHE_BYTES } : {}),
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
  };
}

/** The fat-station argv after the source flags (port/role/layers). */
function buildFatStationServeArgs(layerRange: string): string[] {
  return ['--port', '8000', '--role', 'both', '--layers', layerRange];
}

/** Legacy bare detached spawn of the fat-station (the pre-guard hotpath). */
function legacySpawnFatStation(
  config: MoonshineStartupConfig,
  layerRange: string
): void {
  spawnDetached(
    FAT_STATION_BIN as string,
    [
      ...buildFatStationSourceArgs(config),
      ...buildFatStationServeArgs(layerRange),
    ],
    {
      env: buildFatStationNodeEnv(config),
      stdoutPath: '/tmp/moonshine-fat-station-launchd.out.log',
      stderrPath: '/tmp/moonshine-fat-station-launchd.err.log',
    }
  );
}

/**
 * Launches the fat-station. DEFAULT path is the guarded subagent: the node is
 * born UCAN-leased + sandboxed via monster-swarm / monster-resident. Falls back
 * to the legacy bare spawn when opted out (ZEDGE_GUARDED_SUBAGENT=0) or when a
 * required guarded piece is missing (logs a clear warning, never hard-fails the
 * editor). Returns true if a launch was issued.
 */
async function launchFatStation(
  config: MoonshineStartupConfig,
  layerRange: string
): Promise<boolean> {
  if (!isGuardedSubagentEnabled()) {
    console.log(
      `[moonshine] guarded subagent disabled (${guardedSubagentDisabledReason()}); ` +
        `using legacy bare spawn`
    );
    legacySpawnFatStation(config, layerRange);
    return true;
  }

  const guarded = getGuardedEnv();
  if (!guarded.env) {
    console.warn(
      `[moonshine] guarded subagent path unavailable, falling back to legacy ` +
        `bare spawn. Missing: ${guarded.missing.join('; ')}. ` +
        `Set ZEDGE_GUARDED_SUBAGENT=0 to silence and always use legacy.`
    );
    legacySpawnFatStation(config, layerRange);
    return true;
  }

  const nodeArgs = [
    ...buildFatStationSourceArgs(config),
    ...buildFatStationServeArgs(layerRange),
  ];
  console.log(
    `[moonshine] Birthing guarded fat-station subagent ` +
      `(id=${GUARDED_SUBAGENT_ID}, node=${GUARDED_SUBAGENT_NODE}, ` +
      `caste=scout, caps=net, lease=${GUARDED_SUBAGENT_LEASE_SECS}s, ` +
      `${moonshineSourceLabel(config)}, layers=${layerRange})`
  );
  // caste=scout (not breeder): this is a single editor-owned model host the
  // companion births and reaps on its own lifecycle. A breeder is protected by
  // the AntColony two-queen floor (the last breeder cannot be reaped), which
  // would make shutdown/model-switch reap fail and leak the lease-renewed node.
  // A scout reaps cleanly; "persistent during the session" is the editor keeping
  // it alive, not the swarm-survival invariant.
  const result = await guardedSubagentCreate(guarded.env, {
    node: GUARDED_SUBAGENT_NODE,
    id: GUARDED_SUBAGENT_ID,
    caste: 'scout',
    caps: ['net'],
    leaseSecs: GUARDED_SUBAGENT_LEASE_SECS,
    grantTtlSecs: GUARDED_SUBAGENT_GRANT_TTL_SECS,
    nodeArgs,
    extraEnv: buildFatStationNodeEnv(config),
  });
  if (result.ok) {
    console.log(
      `[moonshine] guarded fat-station spawned: ${result.output ?? 'ok'}`
    );
    return true;
  }

  console.warn(
    `[moonshine] guarded fat-station spawn failed (${result.error}); ` +
      `falling back to legacy bare spawn`
  );
  legacySpawnFatStation(config, layerRange);
  return true;
}

/**
 * Reaps the editor's leased inference subagent (revoke). Best-effort: no-op when
 * the guarded path is disabled or unavailable. The node dies at the next lease
 * tick. Exposed for shutdown / model-switch teardown.
 */
export async function reapGuardedInferenceSubagent(): Promise<void> {
  if (!isGuardedSubagentEnabled()) return;
  const guarded = getGuardedEnv();
  if (!guarded.env) return;
  const result = await guardedSubagentReap(guarded.env, GUARDED_SUBAGENT_ID);
  if (result.ok) {
    console.log(
      `[moonshine] reaped guarded fat-station subagent ${GUARDED_SUBAGENT_ID}`
    );
  } else {
    console.warn(
      `[moonshine] could not reap guarded subagent ${GUARDED_SUBAGENT_ID}: ` +
        `${result.error}`
    );
  }
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
    } catch (error: unknown) {
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
  if (!sourceExists(config.knotPath)) {
    console.warn(`[moonshine] dense knot source not found: ${config.knotPath}`);
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
    await launchFatStation(config, layerRange);
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
    await launchFatStation(config, layerRange);
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
    composeEnv.MOONSHINE_MESH_DENSE_SOURCE = config.knotPath;
    composeEnv.MOONSHINE_MESH_LAYERS = config.layerRange;
    composeEnv.MODEL_NAME = config.modelName;
    if (config.tokenizerJsonPath) {
      composeEnv.GEMMA4_TOKENIZER_JSON = config.tokenizerJsonPath;
    }
    composeEnv.GNOSIS_RKNOT_DECODE_CACHE_BYTES =
      GNOSIS_RKNOT_DECODE_CACHE_BYTES;
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
  } catch (error: unknown) {
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
  if (probeResult.healthy &&
    probeResult.matches &&
    fatStationRuntime.healthy &&
    fatStationRuntime.matches) {
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
      } catch (error: unknown) {
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
