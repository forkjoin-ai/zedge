/**
 * Zedge Inference Bridge
 *
 * Chat backend: Moonshine container (localhost:8080, docker-compose.moonshine.yml openai-compat service)
 * Fallback: echo (guaranteed response when container is not running)
 *
 * Remote edge/cloudrun/mesh/wasm tiers deprecated.
 */

import { getApiBaseUrl, getAuthHeaders, getZedgeConfig } from './config.ts';
import {
  getCloudRunPeerUrls,
  hasCloudRunCoordinatorForModel,
  resolveCloudRunUpstreamModel,
} from './coordinator-urls.ts';
import { isSkymeshTeleportEnabled, trySkymeshCacheTeleport, SKYMESH_DEFAULT_CACHE_URL, warmSkymeshCache, prewarmSkymeshTeleport, streamCachedAnswer } from './skymesh-cache.ts';
import { appendFileSync, mkdirSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { getCloudRunAuthHeaders } from './cloudrun-auth.ts';
import { aetherLocalRuntime } from './aether-local-runtime.ts';
import { runWithCompanionActivity } from './companion-activity.ts';
import {
  getKnownZedgeModel,
  getKnownZedgeModels,
  isForkjoinTierModel,
  isExactSkymeshModel,
  isLiveModelVisible,
} from './model-catalog.ts';
import {
  applyConversationPromptBudget,
  applySystemPromptBudget,
  shouldSkipHeavySystemContext,
} from './prompt-budget.ts';
import {
  moonshinePrefillHeaders,
  zedgePrefillTelemetryHeaders,
} from './prefill-window.ts';

// --- Inference log file + in-memory ring buffer ---
const __inference_dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_LOG_DIR = join(__inference_dirname, '..', '..', '.edgework');

function resolveInferenceLogFile(): string | null {
  const explicitLogFile = process.env.ZEDGE_INFERENCE_LOG_FILE;
  if (explicitLogFile === 'off') {
    return null;
  }

  // Keep unit-test fixture traffic out of the shared runtime log by default.
  if (!explicitLogFile && process.argv.includes('test')) {
    return null;
  }

  const logFile = explicitLogFile ?? join(DEFAULT_LOG_DIR, 'inference.log');
  try {
    mkdirSync(dirname(logFile), { recursive: true });
  } catch {
    /* Directory may already exist or be unwritable -- best-effort */
  }
  return logFile;
}

const LOG_RING_MAX = 200;
const logRing: string[] = [];

function logInference(line: string): void {
  const ts = new Date().toISOString();
  const entry = `[${ts}] ${line}`;
  logRing.push(entry);
  if (logRing.length > LOG_RING_MAX) logRing.shift();
  const logFile = resolveInferenceLogFile();
  if (!logFile) {
    return;
  }
  try {
    appendFileSync(logFile, entry + '\n');
  } catch {
    /* Log file may be unwritable -- best-effort logging */
  }
}

/** Append a sidecar diagnostic line to the same log surface as inference. */
export function appendInferenceDiagnostic(line: string): void {
  logInference(line);
}

/** Get recent inference logs (most recent last) */
export function getRecentLogs(count?: number): string[] {
  const n = count ?? LOG_RING_MAX;
  return logRing.slice(-n);
}

/** Clear the in-memory log ring */
export function clearLogs(): void {
  logRing.length = 0;
  const logFile = resolveInferenceLogFile();
  if (!logFile) {
    return;
  }
  try {
    writeFileSync(logFile, '');
  } catch {
    /* Log file may be unwritable -- best-effort cleanup */
  }
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  prefillWindowId?: string;
}

export interface CompletionChoice {
  index: number;
  message: ChatMessage;
  finish_reason: string;
}

export interface ChatCompletionResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: CompletionChoice[];
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export interface ModelInfo {
  id: string;
  object: string;
  owned_by: string;
}

// Cloud Run coordinator URLs imported from coordinator-urls.ts (single source of truth)

const REMOTE_EMBEDDING_MODELS = new Set(['text-embedding-3-small']);

export type InferenceTier =
  | 'skymesh'
  /** The SSM relay at skymesh.forkjoin.ai. Distinct from `skymesh`, which is the cache teleport. */
  | 'skymesh-relay'
  | 'forkjoin'
  | 'mesh'
  | 'edge'
  | 'cloudrun'
  | 'wasm'
  | 'echo'
  | 'moonshine';

function isExplicitLocalOnlyModel(model: string): boolean {
  const normalized = model.toLowerCase();
  return (
    normalized.startsWith('wasm-local') ||
    normalized.startsWith('echo-local') ||
    normalized.startsWith('local-only') ||
    normalized === 'gnosis-local' ||
    normalized === 'tinyllama-1.1b' ||
    (normalized.includes('tinyllama') && normalized.includes('local'))
  );
}

function shouldUseLocalEmbeddingFallback(model: string): boolean {
  return isExplicitLocalOnlyModel(model) || !REMOTE_EMBEDDING_MODELS.has(model);
}

function compactWasmFallbackRequest(
  request: ChatCompletionRequest
): ChatCompletionRequest {
  if (isExplicitLocalOnlyModel(request.model)) {
    return request;
  }

  const lastUserContent =
    [...request.messages]
      .reverse()
      .find((message) => message.role === 'user')
      ?.content?.slice(0, 1200) ??
    request.messages[request.messages.length - 1]?.content?.slice(0, 1200) ??
    '';

  const compactMessages: ChatMessage[] = [
    {
      role: 'user',
      content: lastUserContent,
    },
  ];

  return {
    ...request,
    messages: compactMessages,
    max_tokens: Math.min(request.max_tokens ?? 128, 64),
    temperature: Math.min(request.temperature ?? 0.7, 0.35),
  };
}

function getEdgeRequestTimeoutMs(
  request: ChatCompletionRequest
): number | null {
  if (isExplicitLocalOnlyModel(request.model)) {
    return 1_500;
  }

  if (request.stream === true) {
    return EDGE_STREAMING_TOTAL_TIMEOUT_MS;
  }

  return EDGE_NON_STREAMING_TOTAL_TIMEOUT_MS;
}

export interface TierAttempt {
  tier: InferenceTier;
  status: 'ok' | 'timeout' | 'error' | 'skipped' | 'http_error';
  ms: number;
  detail?: string;
}

function formatAttemptDuration(ms: number): string {
  if (ms < 1) return `${Math.max(0, Math.round(ms * 1_000_000))}ns`;
  return `${Math.round(ms)}ms`;
}

export interface TierResult {
  tier: InferenceTier;
  response: Response;
  /** Upstream X-* debug/diagnostic headers from edge-workers */
  upstreamHeaders: Record<string, string>;
  /** Every tier attempted, in order, with timing + failure reason */
  attempts: TierAttempt[];
}

// Moonshine container (docker-compose.moonshine.yml openai-compat service)
export const MOONSHINE_BASE_URL =
  process.env.ZEDGE_MOONSHINE_URL ?? 'http://127.0.0.1:8080';
export const FAT_STATION_BASE_URL =
  process.env.ZEDGE_FAT_STATION_URL ??
  process.env.FAT_STATION_URL ??
  'http://127.0.0.1:8000';
/**
 * The SSM relay. `rwkv7-mini` and the other exact-Skymesh models live at
 * `apps/skymesh` (which fronts sovereign-infer), NOT in the local Moonshine
 * container — MOONSHINE_BASE_URL is loopback, so without this the only tier
 * that could serve them dialled 127.0.0.1 and the request died in 2ms.
 */
export const SKYMESH_RELAY_BASE_URL = (
  process.env.ZEDGE_SKYMESH_PUBLIC_BASE ?? 'https://skymesh.forkjoin.ai'
).replace(/\/+$/, '');
/**
 * Two deadlines, not one. `fetch` resolves when the RESPONSE HEADERS arrive, so
 * a lane that is simply down is detectable long before a slow lane that is
 * genuinely working: the first token must show up promptly, after which a real
 * SSM answer is allowed to take its time.
 *
 * Before this tier existed the same request failed in 2ms against loopback —
 * fast and useless. A single 180s ceiling would trade that for a three-minute
 * hang, which is worse: the editor sits there with nothing to show.
 */
const SKYMESH_RELAY_HEADERS_TIMEOUT_MS = Number(
  // 15s: long enough to collect the lane's own error (the OOM upstream answers
  // in ~10.5s, and that message is the whole diagnosis), short enough that a
  // fully dead lane does not hold the editor. Paid at most once per cooldown.
  process.env.ZEDGE_SKYMESH_HEADERS_TIMEOUT_MS ?? 15_000
);
/** After headers, the mesh is slow by design; a real answer can outlast Moonshine. */
const SKYMESH_RELAY_TIMEOUT_MS = Number(
  process.env.ZEDGE_SKYMESH_TIMEOUT_MS ?? 180_000
);
/**
 * How long a failed lane stays known-down. While it holds, the tier is skipped
 * in ~0ms with the reason it failed, instead of every request paying the full
 * discovery cost again (the sovereign-infer OOM answers in ~10s — a 10s wait
 * per keystroke-driven completion is indistinguishable from a hang).
 */
const SKYMESH_RELAY_COOLDOWN_MS = Number(
  process.env.ZEDGE_SKYMESH_COOLDOWN_MS ?? 60_000
);

interface SkymeshRelayBreaker {
  downUntil: number;
  reason: string;
}

let skymeshRelayBreaker: SkymeshRelayBreaker | null = null;

/** Remaining cooldown in ms, or 0 when the lane is allowed to be tried. */
export function skymeshRelayCooldownRemainingMs(now = Date.now()): number {
  if (!skymeshRelayBreaker) return 0;
  const remaining = skymeshRelayBreaker.downUntil - now;
  if (remaining <= 0) {
    skymeshRelayBreaker = null;
    return 0;
  }
  return remaining;
}

/** Why the lane is being skipped, for the attempt chain. */
export function skymeshRelayCooldownReason(): string {
  return skymeshRelayBreaker?.reason ?? '';
}

function tripSkymeshRelayBreaker(reason: string, now = Date.now()): void {
  skymeshRelayBreaker = {
    downUntil: now + SKYMESH_RELAY_COOLDOWN_MS,
    reason: reason.slice(0, 200),
  };
}

/** A working answer clears the breaker immediately — no half-open dance needed. */
function clearSkymeshRelayBreaker(): void {
  skymeshRelayBreaker = null;
}

/** Test seam: forget any recorded outage. */
export function resetSkymeshRelayBreakerForTests(): void {
  skymeshRelayBreaker = null;
}
const MOONSHINE_TIMEOUT_MS = Number(
  process.env.ZEDGE_MOONSHINE_TIMEOUT_MS ?? 90_000
);
const SLOW_MOONSHINE_MODEL_TIMEOUT_MS = Number(
  process.env.ZEDGE_SLOW_MOONSHINE_TIMEOUT_MS ?? 300_000
);
const MOONSHINE_BUSY_BUFFER_MS = 30_000;
const MOONSHINE_REPAIR_RETRY_MS = Number(
  process.env.ZEDGE_MOONSHINE_REPAIR_RETRY_MS ?? 60_000
);

function moonshineFailureWorthRepair(
  detail: string,
  httpStatus?: number
): boolean {
  const lower = detail.toLowerCase();
  // A hung /generate looks like AbortError/timeout while /health stays 200.
  // Repairing then kills the healthy OpenAI shim, respawns it in front of the
  // same busy station, and Zed sees a 60s 0-byte stall ("temporarily
  // unavailable"). Only dead listeners are worth a restart.
  if (
    lower.includes('fetch failed') ||
    lower.includes('econnrefused') ||
    lower.includes('enotfound') ||
    lower.includes('socket hang up') ||
    lower.includes('network')
  ) {
    return true;
  }
  return httpStatus !== undefined && (httpStatus === 500 || httpStatus === 502);
}

function moonshineStationBusyResponse(inflight: number): Response {
  return new Response(
    JSON.stringify({
      error: {
        message: `Moonshine fat-station is busy (inflight=${inflight}). Retry shortly.`,
        type: 'overloaded',
        code: 'station_busy',
      },
    }),
    {
      status: 503,
      headers: {
        'Content-Type': 'application/json',
        'Retry-After': '2',
        'X-Zedge-Moonshine': 'busy',
      },
    }
  );
}

async function probeFatStationInflight(
  timeoutMs = 2_000
): Promise<number | null> {
  try {
    const resp = await fetch(`${FAT_STATION_BASE_URL}/status`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!resp.ok) return null;
    const body = (await resp.json()) as { inflight?: unknown };
    return typeof body.inflight === 'number' && Number.isFinite(body.inflight)
      ? body.inflight
      : null;
  } catch {
    return null;
  }
}

async function repairMoonshineListeners(reason: string): Promise<void> {
  logInference(`[moonshine] repairing listeners (${reason})`);
  const { ensureMoonshineRunning } = await import('./moonshine-docker.ts');
  await Promise.race([
    ensureMoonshineRunning(),
    new Promise<void>((_, reject) => {
      setTimeout(
        () => reject(new Error('moonshine repair timed out')),
        MOONSHINE_REPAIR_RETRY_MS
      );
    }),
  ]);
}

async function runMoonshineTier(
  request: ChatCompletionRequest,
  attempts: TierAttempt[]
): Promise<TierResult | null> {
  const t0 = performance.now();
  const controller = new AbortController();
  let failureDetail = '';
  let failureStatus: number | undefined;

  // Fat-station /generate holds stateful_request_gate for the whole forward
  // and only then writes headers. Concurrent chats block with 0 bytes, while
  // /health try_locks the inner pipeline (released between tokens) and stays
  // 200. /status.inflight is the honest busy bit — fail closed before we
  // join the mutex queue that Zed then times out on.
  const inflight = await probeFatStationInflight();
  if (inflight !== null && inflight > 0) {
    attempts.push({
      tier: 'moonshine',
      status: 'http_error',
      ms: performance.now() - t0,
      detail: `station inflight=${inflight}`,
    });
    logInference(
      `[moonshine] station busy inflight=${inflight} model=${request.model}`
    );
    return {
      tier: 'moonshine',
      response: moonshineStationBusyResponse(inflight),
      upstreamHeaders: { 'X-Zedge-Moonshine': 'busy' },
      attempts,
    };
  }

  try {
    const resp = await tryMoonshineInference(request, controller.signal);
    if (resp.ok) {
      attempts.push({ tier: 'moonshine', status: 'ok', ms: performance.now() - t0 });
      logInference(
        `model=${request.model} tier=moonshine status=ok ms=${
          performance.now() - t0
        }`
      );
      return {
        tier: 'moonshine',
        response: resp,
        upstreamHeaders: extractUpstreamDebugHeaders(resp),
        attempts,
      };
    }
    failureStatus = resp.status;
    failureDetail = `${resp.status} ${resp.statusText}`;
    attempts.push({
      tier: 'moonshine',
      status: 'http_error',
      ms: performance.now() - t0,
      detail: failureDetail,
    });
    logInference(
      `[moonshine] http_error ${resp.status} model=${request.model}`
    );
  } catch (err) {
    const isTimeout =
      err instanceof DOMException && err.name === 'AbortError';
    failureDetail = String(err);
    attempts.push({
      tier: 'moonshine',
      status: isTimeout ? 'timeout' : 'error',
      ms: performance.now() - t0,
      detail: failureDetail,
    });
    logInference(`[moonshine] error: ${failureDetail}`);
  }

  if (!moonshineFailureWorthRepair(failureDetail, failureStatus)) {
    return null;
  }

  try {
    await repairMoonshineListeners(failureDetail);
  } catch (repairErr) {
    logInference(`[moonshine] repair failed: ${String(repairErr)}`);
    return null;
  }

  const retryT0 = Date.now();
  const retryController = new AbortController();
  try {
    const resp = await tryMoonshineInference(request, retryController.signal);
    if (resp.ok) {
      attempts.push({
        tier: 'moonshine',
        status: 'ok',
        ms: Date.now() - retryT0,
        detail: 'after-repair',
      });
      logInference(
        `model=${request.model} tier=moonshine status=ok (after repair) ms=${
          Date.now() - retryT0
        }`
      );
      return {
        tier: 'moonshine',
        response: resp,
        upstreamHeaders: extractUpstreamDebugHeaders(resp),
        attempts,
      };
    }
    attempts.push({
      tier: 'moonshine',
      status: 'http_error',
      ms: Date.now() - retryT0,
      detail: `${resp.status} ${resp.statusText} (after repair)`,
    });
    logInference(
      `[moonshine] http_error ${resp.status} model=${request.model} (after repair)`
    );
  } catch (err) {
    attempts.push({
      tier: 'moonshine',
      status: 'error',
      ms: Date.now() - retryT0,
      detail: `${String(err)} (after repair)`,
    });
    logInference(`[moonshine] error after repair: ${String(err)}`);
  }

  return null;
}

// --- Forkjoin distributed-inference tier (OWN-runtime mesh passthrough) ---
//
// First-class default tier. Passes the OpenAI-shaped chat-completion request
// THROUGH to the Forkjoin mesh's own-runtime OpenAI-compatible endpoint
// (the @a0n/distributed-inference-host shim that drives fat-station / knots /
// the WASM worker: tokenize -> embed -> forward -> lm-head -> detokenize).
//
// Consumption path: HTTP passthrough. The host package exposes its
// OpenAI-compatible /v1/chat/completions surface only as a running server
// (src/bin/openai-server.ts), not as a clean in-process chat function -- the
// only in-process chat export, runAgenticChatCompletion, requires an
// AgenticChatRuntime + MCP client and runs the heavy agentic loop, which is the
// wrong shape for a plain passthrough. So we POST to the shim base, exactly
// like tryMoonshineInference. NO third-party/paid inference -- own mesh only.
//
// The base URL is configurable so the guarded production path (UCAN via
// monster-resident / monster-guard) can slot in later by pointing
// ZEDGE_FORKJOIN_URL at the guarded endpoint; the loopback default has no auth.
// Read lazily (per call) so env overrides apply at runtime, matching the
// getZedgeConfig() / resolveInferenceLogFile() idiom in this module.
const FORKJOIN_BUSY_BUFFER_MS = 30_000;

function getForkjoinBaseUrl(): string {
  return (
    process.env.ZEDGE_FORKJOIN_URL ??
    process.env.FORKJOIN_OPENAI_URL ??
    'http://127.0.0.1:8080'
  );
}

/** An explicit own-mesh endpoint is an operator routing decision. */
function hasExplicitForkjoinEndpoint(): boolean {
  return Boolean(
    process.env.ZEDGE_FORKJOIN_URL?.trim() ||
      process.env.FORKJOIN_OPENAI_URL?.trim()
  );
}

function getForkjoinTimeoutMs(): number {
  return Number(process.env.ZEDGE_FORKJOIN_TIMEOUT_MS ?? 90_000);
}

function getSkymeshCacheUrl(): string {
  return (
    process.env.ZEDGE_SKYMESH_CACHE_URL ??
    getZedgeConfig().skyMeshCacheUrl ??
    SKYMESH_DEFAULT_CACHE_URL
  );
}

/**
 * Whether the Forkjoin distributed-inference tier is enabled. ON by default;
 * set ZEDGE_FORKJOIN_ENABLED to '0' or 'false' to skip the tier entirely.
 * Because the tier falls through gracefully on any failure, ON-by-default is
 * safe.
 */
function isForkjoinTierEnabled(): boolean {
  const raw = process.env.ZEDGE_FORKJOIN_ENABLED;
  if (raw === undefined) {
    return true;
  }
  const normalized = raw.trim().toLowerCase();
  return normalized !== '0' && normalized !== 'false' && normalized !== 'off';
}

/** Local Zedge: forkjoin default URL is the Moonshine shim — skip duplicate hop. */
function forkjoinCollidesWithMoonshine(): boolean {
  try {
    const forkjoin = new URL(getForkjoinBaseUrl());
    const moonshine = new URL(MOONSHINE_BASE_URL);
    return (
      forkjoin.hostname === moonshine.hostname &&
      (forkjoin.port || '80') === (moonshine.port || '80')
    );
  } catch {
    return getForkjoinBaseUrl() === MOONSHINE_BASE_URL;
  }
}
const MOONSHINE_DEFAULT_MAX_TOKENS = parsePositiveInteger(
  process.env.ZEDGE_MOONSHINE_DEFAULT_MAX_TOKENS,
  512
);
const MOONSHINE_MAX_TOKENS = parsePositiveInteger(
  process.env.ZEDGE_MOONSHINE_MAX_TOKENS,
  4096
);

type MoonshineCacheKind = 'amplituhedron' | 'memo';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function fetchJsonWithin(
  url: string,
  timeoutMs: number
): Promise<{ ok: boolean; status?: number; body?: unknown; error?: string }> {
  try {
    const resp = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    let body: unknown;
    try {
      body = await resp.json();
    } catch {
      body = undefined;
    }
    return { ok: resp.ok, status: resp.status, body };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function postJsonWithin(
  url: string,
  timeoutMs: number
): Promise<{ ok: boolean; status?: number; error?: string }> {
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    return { ok: resp.ok, status: resp.status };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Handles the zedge get Moonshine Cache Status workflow.
 */
export async function getMoonshineCacheStatus(timeoutMs = 5_000): Promise<{
  moonshine: {
    baseUrl: string;
    ready: boolean;
    model?: string;
    status?: string;
    error?: string;
  };
  fatStation: {
    baseUrl: string;
    ready: boolean;
    status?: string;
    amplituhedron?: Record<string, unknown>;
    memo?: Record<string, unknown>;
    error?: string;
  };
}> {
  const [moonshine, fatStationHealth, memoStats] = await Promise.all([
    fetchJsonWithin(`${MOONSHINE_BASE_URL}/health`, timeoutMs),
    fetchJsonWithin(`${FAT_STATION_BASE_URL}/health`, timeoutMs),
    fetchJsonWithin(`${FAT_STATION_BASE_URL}/memo/stats`, timeoutMs),
  ]);
  const moonshineBody = isRecord(moonshine.body) ? moonshine.body : {};
  const stationBody = isRecord(fatStationHealth.body)
    ? fatStationHealth.body
    : {};
  return {
    moonshine: {
      baseUrl: MOONSHINE_BASE_URL,
      ready: moonshine.ok && moonshineBody['status'] === 'ok',
      status:
        typeof moonshineBody['status'] === 'string'
          ? moonshineBody['status']
          : undefined,
      model:
        typeof moonshineBody['model'] === 'string'
          ? moonshineBody['model']
          : undefined,
      error: moonshine.error,
    },
    fatStation: {
      baseUrl: FAT_STATION_BASE_URL,
      ready: fatStationHealth.ok && stationBody['status'] === 'ok',
      status:
        typeof stationBody['status'] === 'string'
          ? stationBody['status']
          : undefined,
      amplituhedron: isRecord(stationBody['amplituhedron'])
        ? stationBody['amplituhedron']
        : undefined,
      memo: memoStats.ok && isRecord(memoStats.body) ? memoStats.body : undefined,
      error: fatStationHealth.error ?? memoStats.error,
    },
  };
}

/**
 * Handles the zedge clear Moonshine Caches workflow.
 */
export async function clearMoonshineCaches(args: {
  kinds: readonly MoonshineCacheKind[];
  timeoutMs?: number;
}): Promise<{
  cleared: MoonshineCacheKind[];
  skipped: MoonshineCacheKind[];
  results: Record<string, { ok: boolean; status?: number; error?: string }>;
}> {
  const timeoutMs = args.timeoutMs ?? 5_000;
  const selected = new Set(args.kinds);
  const routeByKind: Record<MoonshineCacheKind, string> = {
    amplituhedron: '/amplituhedron/clear',
    memo: '/memo/clear',
  };
  const entries = await Promise.all(
    (Object.keys(routeByKind) as MoonshineCacheKind[]).map(async (kind) => {
      if (!selected.has(kind)) {
        return [kind, { skipped: true, result: { ok: true } }] as const;
      }
      const result = await postJsonWithin(
        `${FAT_STATION_BASE_URL}${routeByKind[kind]}`,
        timeoutMs
      );
      return [kind, { skipped: false, result }] as const;
    })
  );
  const cleared: MoonshineCacheKind[] = [];
  const skipped: MoonshineCacheKind[] = [];
  const results: Record<string, { ok: boolean; status?: number; error?: string }> = {};
  for (const [kind, entry] of entries) {
    if (entry.skipped) {
      skipped.push(kind);
    } else if (entry.result.ok) {
      cleared.push(kind);
    }
    results[kind] = entry.result;
  }
  return { cleared, skipped, results };
}
const ZEDGE_FALLBACK_ASSISTANT_PATTERNS = [
  'Moonshine did not return a usable completion before Zedge',
  'Zedge could not start a usable inference tier',
  '[zedge notice]',
];
const CHAT_TEMPLATE_PREFIXES = [
  '<s>[INST]',
  '[INST]',
  '<s>',
  '</s>',
  '[/INST]',
  '[SING]',
  '<<SYS>>',
  '<</SYS>>',
];

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = value === undefined ? fallback : Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function resolveMoonshineMaxTokens(request: ChatCompletionRequest): number {
  const requested = Number.isInteger(request.max_tokens)
    ? request.max_tokens
    : MOONSHINE_DEFAULT_MAX_TOKENS;
  const modelMaxTokens = request.model
    ? getKnownZedgeModel(request.model)?.maxTokens
    : undefined;
  const hardCap = Math.min(modelMaxTokens ?? MOONSHINE_MAX_TOKENS, MOONSHINE_MAX_TOKENS);
  return Math.max(0, Math.min(requested ?? MOONSHINE_DEFAULT_MAX_TOKENS, hardCap));
}

function isSlowMoonshineModel(model: string): boolean {
  return model === 'loki-erotica-8b' || isExactSkymeshModel(model);
}

/**
 * Resolves the Moonshine Timeout Ms For Model.
 */
export function resolveMoonshineTimeoutMsForModel(model: string): number {
  return isSlowMoonshineModel(model)
    ? Math.max(MOONSHINE_TIMEOUT_MS, SLOW_MOONSHINE_MODEL_TIMEOUT_MS)
    : MOONSHINE_TIMEOUT_MS;
}

function resolveMoonshineTimeoutMs(request: ChatCompletionRequest): number {
  return resolveMoonshineTimeoutMsForModel(request.model);
}

const LOCAL_WASM_TOTAL_TIMEOUT_MS = 45_000;
const LOCAL_WASM_BUSY_BUFFER_MS = 15_000;
const LOCAL_WASM_PREWARM_BUSY_MS = 5 * 60_000;
const EDGE_STREAMING_TOTAL_TIMEOUT_MS = 60_000;
const EDGE_NON_STREAMING_TOTAL_TIMEOUT_MS = 45_000;
const EDGE_NON_STREAMING_COMPLETION_TIMEOUT_MS = 90_000;
const EDGE_STREAM_FIRST_TOKEN_TIMEOUT_MS = 20_000;
const EDGE_STREAM_TOTAL_BUDGET_MS = 75_000;
const EDGE_NON_STREAM_TOTAL_BUDGET_MS = 60_000;
const EDGE_CIRCUIT_FAILURE_WINDOW_MS = 2 * 60_000;
const EDGE_CIRCUIT_OPEN_MS = 5 * 60_000;
const EDGE_CIRCUIT_FAILURE_THRESHOLD = 3;
const REMOTE_MODEL_CACHE_TTL_MS = 60_000;

let cachedRemoteModels: ModelInfo[] = [];
let remoteModelCatalogFetchedAt = 0;
let remoteModelCatalogRefreshPromise: Promise<void> | null = null;

interface EdgeCircuitState {
  failureTimestamps: number[];
  openUntil: number;
  lastFailureReason?: string;
}

const edgeCircuitByModel = new Map<string, EdgeCircuitState>();

/** True when an assistant turn was generated by Zedge's own fallback path. */
function isZedgeFallbackAssistantMessage(message: ChatMessage): boolean {
  if (message.role !== 'assistant') {
    return false;
  }
  for (const pattern of ZEDGE_FALLBACK_ASSISTANT_PATTERNS) {
    if (message.content.includes(pattern)) {
      return true;
    }
  }
  return false;
}

/** Remove Zedge's in-content prefill status before calling Moonshine. */
function stripZedgeProgressPrefix(content: string): string {
  let remaining = content;
  // Current Zed-compatible progress is ordinary content because Zed does not
  // render reasoning_content. Remove every completed progress paragraph from
  // assistant history before another model sees it. The dots may wrap.
  const currentProgress =
    /^\s*\*?\d+t\/s\s*\|[\s\S]*?prefill\s+\d+(?:ns|ms|s)\s*\*\s*/u;
  while (currentProgress.test(remaining)) {
    remaining = remaining.replace(currentProgress, '');
  }
  return remaining
    .replace(/^\s*\*?\d+t\/s\s*\|\s*[^\n]*?\u28FF\s*[\u2588\s]*\*?\s*/u, '')
    .replace(/^\s*\*?\u28FF\s+[^\n]*\|\s*moonshine:[^\n]*\*?\s*/u, '');
}

/** True when text may be a partial chat-template control marker. */
function isPendingChatTemplatePrefix(text: string): boolean {
  const trimmed = text.trimStart();
  if (!trimmed) return false;
  for (const prefix of CHAT_TEMPLATE_PREFIXES) {
    if (prefix.startsWith(trimmed)) return true;
  }
  return false;
}

/** Remove generated Llama chat-template echoes from assistant history. */
function stripGeneratedChatTemplateEcho(content: string): string {
  let remaining = content;

  while (remaining.length > 0) {
    remaining = remaining.trimStart();

    if (remaining.startsWith('<s>[INST]')) {
      const closeIndex = remaining.indexOf('[/INST]');
      if (closeIndex < 0) return '';
      remaining = remaining.slice(closeIndex + '[/INST]'.length);
      continue;
    }

    if (remaining.startsWith('[INST]')) {
      const closeIndex = remaining.indexOf('[/INST]');
      if (closeIndex < 0) return '';
      remaining = remaining.slice(closeIndex + '[/INST]'.length);
      continue;
    }

    let removedMarker = false;
    for (const marker of [
      '<s>',
      '</s>',
      '[/INST]',
      '[SING]',
      '<<SYS>>',
      '<</SYS>>',
    ]) {
      if (remaining.startsWith(marker)) {
        remaining = remaining.slice(marker.length);
        removedMarker = true;
        break;
      }
    }
    if (removedMarker) continue;

    if (isPendingChatTemplatePrefix(remaining)) return '';
    return remaining;
  }

  return '';
}

/** Clean one chat message before forwarding it to Moonshine. */
function sanitizeMoonshineMessage(message: ChatMessage): ChatMessage | null {
  if (isZedgeFallbackAssistantMessage(message)) {
    return null;
  }
  if (message.role !== 'assistant') {
    return message;
  }

  const content = stripGeneratedChatTemplateEcho(
    stripZedgeProgressPrefix(message.content)
  );
  if (content.trim().length === 0 && content !== message.content) {
    return null;
  }
  return content === message.content ? message : { ...message, content };
}

/** Remove previous local fallback and prompt-artifact turns before Moonshine. */
export function sanitizeMoonshineMessages(messages: ChatMessage[]): ChatMessage[] {
  const filteredMessages: ChatMessage[] = [];
  for (const message of messages) {
    const sanitized = sanitizeMoonshineMessage(message);
    if (sanitized) {
      filteredMessages.push(sanitized);
    }
  }
  return filteredMessages.length > 0 ? filteredMessages : messages;
}

/** Keep Moonshine prompts short: durable system context plus the newest user turn. */
function prepareMoonshineMessages(messages: ChatMessage[]): ChatMessage[] {
  const sanitizedMessages = sanitizeMoonshineMessages(messages);
  const compactMessages: ChatMessage[] = [];
  for (const message of sanitizedMessages) {
    if (message.role === 'system' && message.content.trim().length > 0) {
      compactMessages.push(message);
    }
  }

  for (let i = sanitizedMessages.length - 1; i >= 0; i -= 1) {
    const message = sanitizedMessages[i]!;
    if (message.role === 'user' && message.content.trim().length > 0) {
      compactMessages.push(message);
      return compactMessages;
    }
  }

  return sanitizedMessages;
}

function getEdgeCircuitState(model: string): EdgeCircuitState {
  const key = model.toLowerCase();
  let state = edgeCircuitByModel.get(key);
  if (!state) {
    state = { failureTimestamps: [], openUntil: 0 };
    edgeCircuitByModel.set(key, state);
  }
  return state;
}

function pruneEdgeCircuitFailures(state: EdgeCircuitState, now: number): void {
  const cutoff = now - EDGE_CIRCUIT_FAILURE_WINDOW_MS;
  state.failureTimestamps = state.failureTimestamps.filter(
    (ts) => ts >= cutoff
  );
}

function getEdgeCircuitSnapshot(
  model: string,
  now = Date.now()
): {
  isOpen: boolean;
  remainingMs: number;
  failuresInWindow: number;
  lastFailureReason?: string;
} {
  const state = getEdgeCircuitState(model);
  pruneEdgeCircuitFailures(state, now);
  const remainingMs = Math.max(0, state.openUntil - now);
  return {
    isOpen: remainingMs > 0,
    remainingMs,
    failuresInWindow: state.failureTimestamps.length,
    lastFailureReason: state.lastFailureReason,
  };
}

function recordEdgeCircuitFailure(model: string, reason: string): void {
  const now = Date.now();
  const state = getEdgeCircuitState(model);
  pruneEdgeCircuitFailures(state, now);
  state.failureTimestamps.push(now);
  state.lastFailureReason = reason.slice(0, 240);

  if (state.failureTimestamps.length >= EDGE_CIRCUIT_FAILURE_THRESHOLD) {
    const nextOpenUntil = now + EDGE_CIRCUIT_OPEN_MS;
    if (nextOpenUntil > state.openUntil) {
      state.openUntil = nextOpenUntil;
      logInference(
        `[edge] circuit-open model=${model} windowFailures=${state.failureTimestamps.length} openForMs=${EDGE_CIRCUIT_OPEN_MS} reason=${state.lastFailureReason}`
      );
    }
  }
}

function recordEdgeCircuitSuccess(model: string): void {
  const state = getEdgeCircuitState(model);
  if (state.failureTimestamps.length > 0 || state.openUntil > 0) {
    logInference(`[edge] circuit-reset model=${model}`);
  }
  state.failureTimestamps = [];
  state.openUntil = 0;
  state.lastFailureReason = undefined;
}

function isOpenAiSsePayload(payload: string): boolean {
  if (payload === '[DONE]') {
    return true;
  }

  try {
    const parsed = JSON.parse(payload) as { choices?: unknown };
    return Array.isArray(parsed.choices);
  } catch {
    return false;
  }
}

function hasUsableFallbackText(text: string): boolean {
  const normalized = text.trim();
  if (!normalized) {
    return false;
  }

  const signal = normalized.replace(/[[\]<>|/_-]/g, '').trim();
  return signal.length >= 3;
}

function ssePayloadHasToken(payload: string): boolean {
  if (payload === '[DONE]') {
    return false;
  }

  try {
    const parsed = JSON.parse(payload) as {
      choices?: Array<{
        delta?: { content?: string; reasoning_content?: string };
        message?: { content?: string };
      }>;
      token?: unknown;
      content?: unknown;
      text?: unknown;
    };

    const choice = parsed.choices?.[0];
    const openAiContent =
      choice?.delta?.content ??
      choice?.delta?.reasoning_content ??
      choice?.message?.content;
    if (typeof openAiContent === 'string' && openAiContent.length > 0) {
      return true;
    }

    const legacyToken =
      typeof parsed.token === 'string'
        ? parsed.token
        : typeof parsed.content === 'string'
        ? parsed.content
        : typeof parsed.text === 'string'
        ? parsed.text
        : null;
    return legacyToken !== null && legacyToken.length > 0;
  } catch {
    return false;
  }
}

async function settleWithTimeout(
  promise: Promise<unknown>,
  timeoutMs: number
): Promise<void> {
  await Promise.race([
    promise.then(() => undefined).catch(() => undefined),
    new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
}

async function ensureEdgeStreamingHasToken(
  response: Response,
  model: string,
  firstTokenTimeoutMs = EDGE_STREAM_FIRST_TOKEN_TIMEOUT_MS
): Promise<Response> {
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('text/event-stream') || !response.body) {
    return response;
  }

  const [probeBody, passthroughBody] = response.body.tee();
  const reader = probeBody.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });

  let buffer = '';
  let pendingDataLines: string[] = [];
  let sawToken = false;
  let sawDone = false;
  const deadline = Date.now() + Math.max(1_000, firstTokenTimeoutMs);

  const processPendingEvent = () => {
    if (pendingDataLines.length === 0) {
      return;
    }

    const payload = pendingDataLines.join('\n').trim();
    pendingDataLines = [];

    if (!payload) {
      return;
    }

    if (payload === '[DONE]') {
      sawDone = true;
      return;
    }

    if (ssePayloadHasToken(payload)) {
      sawToken = true;
    }
  };

  try {
    while (!sawToken && !sawDone) {
      const remainingMs = Math.max(1, deadline - Date.now());
      const readResult = await Promise.race([
        reader.read(),
        new Promise<null>((resolve) =>
          setTimeout(() => resolve(null), remainingMs)
        ),
      ]);

      if (readResult === null) {
        throw new Error(
          `Edge stream produced no tokens within ${firstTokenTimeoutMs}ms`
        );
      }

      const { done, value } = readResult;
      if (done) {
        buffer += decoder.decode();
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      let newlineIndex = buffer.indexOf('\n');
      while (newlineIndex !== -1) {
        const rawLine = buffer.slice(0, newlineIndex).replace(/\r$/, '');
        buffer = buffer.slice(newlineIndex + 1);

        if (rawLine.length === 0) {
          processPendingEvent();
          if (sawToken || sawDone) {
            break;
          }
        } else if (rawLine.startsWith('data: ')) {
          pendingDataLines.push(rawLine.slice(6));
        }

        newlineIndex = buffer.indexOf('\n');
      }
    }

    if (!sawToken && pendingDataLines.length > 0) {
      processPendingEvent();
    }
  } finally {
    try {
      await settleWithTimeout(reader.cancel(), 1_000);
    } catch {
      // Best-effort cleanup only.
    }
    reader.releaseLock();
  }

  if (sawToken) {
    return new Response(passthroughBody, {
      status: response.status,
      headers: new Headers(response.headers),
    });
  }

  try {
    await passthroughBody.cancel();
  } catch {
    // Best-effort cleanup only.
  }

  const reason = sawDone
    ? 'Edge stream ended without tokens'
    : 'Edge stream never produced tokens';
  throw new Error(`${reason} for model ${model}`);
}

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

/**
 * Extract all X-* headers from an upstream response.
 * These are debug/diagnostic headers emitted by edge-workers
 * (model selection, timing, fallback, billing, routing, etc.)
 */
export function extractUpstreamDebugHeaders(
  response: Response
): Record<string, string> {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    if (key.toLowerCase().startsWith('x-')) {
      headers[key] = value;
    }
  });
  Object.assign(headers, zedgePrefillTelemetryHeaders(response.headers));
  return headers;
}

function createJsonChatCompletionResponse(
  model: string,
  content: string,
  options: {
    id?: string;
    created?: number;
    completionTokens?: number;
    headers?: Record<string, string>;
    status?: number;
  } = {}
): Response {
  const completionTokens =
    options.completionTokens ?? Math.ceil(content.length / 4);
  const response: ChatCompletionResponse = {
    id: options.id ?? `chatcmpl-edge-${Date.now()}`,
    object: 'chat.completion',
    created: options.created ?? Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content },
        finish_reason: 'stop',
      },
    ],
    usage: {
      prompt_tokens: 0,
      completion_tokens: completionTokens,
      total_tokens: completionTokens,
    },
  };

  return new Response(JSON.stringify(response), {
    status: options.status ?? 200,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers ?? {}),
    },
  });
}

async function collapseEdgeStreamingResponse(
  response: Response,
  fallbackModel: string,
  options: {
    timeoutMs?: number;
    requireNonEmptyText?: boolean;
  } = {}
): Promise<Response> {
  const upstreamHeaders = extractUpstreamDebugHeaders(response);
  const contentType = response.headers.get('content-type') ?? '';

  if (
    contentType.includes('text/event-stream') ||
    contentType.includes('text/plain')
  ) {
    if (!response.body) {
      return createJsonChatCompletionResponse(fallbackModel, '', {
        headers: upstreamHeaders,
        status: response.status,
      });
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let buffer = '';
    let content = '';
    let model = fallbackModel;
    let id = `chatcmpl-edge-${Date.now()}`;
    let created = Math.floor(Date.now() / 1000);
    const deadline =
      typeof options.timeoutMs === 'number'
        ? Date.now() + options.timeoutMs
        : null;
    let sawCompletion = false;
    let pendingDataLines: string[] = [];

    const processEvent = (): boolean => {
      if (pendingDataLines.length === 0) {
        return false;
      }

      const payload = pendingDataLines.join('\n').trim();
      pendingDataLines = [];
      if (!payload) {
        return false;
      }
      if (payload === '[DONE]') {
        sawCompletion = true;
        return true;
      }

      try {
        const chunk = JSON.parse(payload) as {
          id?: string;
          created?: number;
          model?: string;
          choices?: Array<{
            delta?: { content?: string };
            message?: { content?: string };
            finish_reason?: string | null;
          }>;
        };
        const choice = chunk.choices?.[0];
        content += choice?.delta?.content ?? choice?.message?.content ?? '';
        if (typeof chunk.model === 'string') {
          model = chunk.model;
        }
        if (typeof chunk.id === 'string') {
          id = chunk.id;
        }
        if (typeof chunk.created === 'number') {
          created = chunk.created;
        }
        if (choice?.finish_reason != null) {
          sawCompletion = true;
          return true;
        }
      } catch {
        // Ignore non-JSON SSE lines.
      }

      return false;
    };

    try {
      while (!sawCompletion) {
        const readResult =
          deadline === null
            ? await reader.read()
            : await Promise.race([
                reader.read(),
                new Promise<null>((resolve) => {
                  const remainingMs = Math.max(1, deadline - Date.now());
                  setTimeout(() => resolve(null), remainingMs);
                }),
              ]);
        if (readResult === null) {
          throw new Error(
            `Edge completion timed out after ${options.timeoutMs}ms`
          );
        }

        const { done, value } = readResult;
        if (done) {
          buffer += decoder.decode();
          break;
        }

        buffer += decoder.decode(value, { stream: true });

        let newlineIndex = buffer.indexOf('\n');
        while (newlineIndex !== -1) {
          const rawLine = buffer.slice(0, newlineIndex).replace(/\r$/, '');
          buffer = buffer.slice(newlineIndex + 1);

          if (rawLine.length === 0) {
            if (processEvent()) {
              break;
            }
          } else if (rawLine.startsWith('data: ')) {
            pendingDataLines.push(rawLine.slice(6));
          }

          newlineIndex = buffer.indexOf('\n');
        }
      }
    } finally {
      try {
        await reader.cancel();
      } catch {
        // Best-effort cleanup only.
      }
      reader.releaseLock();
    }

    if (!sawCompletion && pendingDataLines.length > 0) {
      processEvent();
    }

    if (options.requireNonEmptyText && content.trim().length === 0) {
      throw new Error('Edge returned empty completion');
    }

    return createJsonChatCompletionResponse(model, content, {
      id,
      created,
      headers: upstreamHeaders,
      status: response.status,
    });
  }

  const data = (await response.json()) as Record<string, unknown> & {
    response?: string;
    token_count?: number;
    choices?: ChatCompletionResponse['choices'];
    usage?: ChatCompletionResponse['usage'];
    created?: number;
    id?: string;
    model?: string;
  };

  if (Array.isArray(data.choices)) {
    return new Response(JSON.stringify(data), {
      status: response.status,
      headers: {
        'Content-Type': 'application/json',
        ...upstreamHeaders,
      },
    });
  }

  return createJsonChatCompletionResponse(fallbackModel, data.response ?? '', {
    id: typeof data.id === 'string' ? data.id : undefined,
    created: typeof data.created === 'number' ? data.created : undefined,
    completionTokens:
      typeof data.token_count === 'number' ? data.token_count : undefined,
    headers: upstreamHeaders,
    status: response.status,
  });
}

/**
 * Attempt inference via Moonshine container (localhost:8080)
 * Primary chat backend — deprecates remote edge/cloudrun/mesh/wasm tiers.
 */
/**
 * Attempt inference via the Forkjoin own-runtime distributed-inference mesh.
 *
 * Passes the OpenAI-shaped ChatCompletionRequest THROUGH to the mesh's
 * OpenAI-compatible /v1/chat/completions endpoint (the
 * @a0n/distributed-inference-host shim driving fat-station / knots / the WASM
 * worker). Supports streaming (SSE) and non-streaming: returns the raw upstream
 * Response so createSSEProxyStream / response wrapping can consume it.
 *
 * Returns null on ANY failure (disabled, mesh down, timeout, http error) so
 * infer() falls through to Moonshine then echo. Modeled on
 * tryMoonshineInference: same timeout / AbortController / activity / logging.
 */
async function tryForkjoinDistributedInference(
  request: ChatCompletionRequest,
  signal?: AbortSignal
): Promise<Response | null> {
  if (!isForkjoinTierEnabled()) {
    logInference('[forkjoin] skipped: ZEDGE_FORKJOIN_ENABLED disabled');
    return null;
  }

  const timeoutMs = getForkjoinTimeoutMs();
  return await runWithCompanionActivity(
    'forkjoin-chat',
    timeoutMs + FORKJOIN_BUSY_BUFFER_MS,
    async () => {
      const url = `${getForkjoinBaseUrl()}/v1/chat/completions`;
      const maxTokens = resolveMoonshineMaxTokens(request);
      const stream = request.stream ?? false;
      const messages = prepareMoonshineMessages(request.messages);
      if (messages.length !== request.messages.length) {
        logInference(
          `[forkjoin] compacted history ${request.messages.length}->${messages.length} message(s)`
        );
      }
      logInference(
        `[forkjoin] -> ${url} model=${request.model} stream=${stream} max_tokens=${maxTokens}`
      );

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const abortFromUpstream = () => controller.abort();
      signal?.addEventListener('abort', abortFromUpstream, { once: true });

      try {
        const resp = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Zedge-Agentic': 'off',
            ...moonshinePrefillHeaders(request.prefillWindowId),
          },
          body: JSON.stringify({
            model: request.model,
            messages,
            stream,
            temperature: request.temperature ?? 0.7,
            max_tokens: maxTokens,
            top_p: request.top_p,
          }),
          signal: controller.signal,
        });
        logInference(`[forkjoin] <- ${resp.status} ${resp.statusText}`);
        return resp;
      } catch (err) {
        // Mesh down / timeout / network error -- fall through gracefully.
        logInference(`[forkjoin] error: ${String(err)}`);
        return null;
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abortFromUpstream);
      }
    },
    `${request.model} chat`
  );
}

/**
 * Tier 0c: the SSM relay at skymesh.forkjoin.ai.
 *
 * `apps/skymesh` speaks the OpenAI chat contract and forwards to
 * sovereign-infer's `/generate-<lane>`; it implements REAL SSE for the SSM
 * lanes, so `stream` is passed straight through and prefill headers ride along
 * exactly as they do for Moonshine. Returns null on any failure so the ladder
 * continues — except that `infer()` refuses the echo fallback for these
 * models, because an exact-Skymesh model answered by echo is a lie.
 */
async function trySkymeshRelayInference(
  request: ChatCompletionRequest,
  signal?: AbortSignal
): Promise<Response | null> {
  return await runWithCompanionActivity(
    'skymesh-relay-chat',
    SKYMESH_RELAY_TIMEOUT_MS + MOONSHINE_BUSY_BUFFER_MS,
    async () => {
      const url = `${SKYMESH_RELAY_BASE_URL}/v1/chat/completions`;
      const maxTokens = resolveMoonshineMaxTokens(request);
      const stream = request.stream ?? false;
      const relayMessages = applyConversationPromptBudget(
        request.model,
        sanitizeMoonshineMessages(request.messages)
      );
      logInference(
        `[skymesh-relay] -> ${url} model=${request.model} stream=${stream} max_tokens=${maxTokens}`
      );

      const controller = new AbortController();
      // Headers first, body second: a lane that never answers is cut loose in
      // seconds, while a lane that HAS answered keeps the long window it needs
      // to finish generating.
      // Non-streaming agentic rounds do not receive response headers until
      // generation is complete, so the short dead-lane probe would abort a
      // healthy SSM request before it can return its JSON body.
      const initialTimeoutMs = stream
        ? SKYMESH_RELAY_HEADERS_TIMEOUT_MS
        : SKYMESH_RELAY_TIMEOUT_MS;
      let timer = setTimeout(() => controller.abort(), initialTimeoutMs);
      const abortFromUpstream = () => controller.abort();
      signal?.addEventListener('abort', abortFromUpstream, { once: true });

      try {
        const resp = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...moonshinePrefillHeaders(request.prefillWindowId),
          },
          body: JSON.stringify({
            model: request.model,
            messages: relayMessages,
            stream,
            temperature: request.temperature ?? 0.7,
            max_tokens: maxTokens,
            top_p: request.top_p,
          }),
          signal: controller.signal,
        });
        // Headers are in: extend to the generation deadline.
        clearTimeout(timer);
        timer = setTimeout(() => controller.abort(), SKYMESH_RELAY_TIMEOUT_MS);
        logInference(
          `[skymesh-relay] <- ${resp.status} ${resp.statusText}`
        );
        if (!resp.ok) {
          // Surface WHY, not just that it failed: the lane returns a JSON
          // OpenAI error body (e.g. an upstream OOM), and swallowing it is how
          // "the SSM lane does not stream" gets misdiagnosed for a week.
          const detail = await resp
            .clone()
            .text()
            .then((text) => text.slice(0, 300))
            .catch(() => '');
          logInference(
            `[skymesh-relay] upstream error ${resp.status}: ${detail}`
          );
          tripSkymeshRelayBreaker(`HTTP ${resp.status}: ${detail}`);
          return null;
        }
        clearSkymeshRelayBreaker();
        return resp;
      } catch (err) {
        logInference(`[skymesh-relay] error: ${String(err)}`);
        tripSkymeshRelayBreaker(String(err));
        return null;
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abortFromUpstream);
      }
    },
    `${request.model} chat`
  );
}

async function tryMoonshineInference(
  request: ChatCompletionRequest,
  signal?: AbortSignal
): Promise<Response> {
  const timeoutMs = resolveMoonshineTimeoutMs(request);
  return await runWithCompanionActivity(
    'moonshine-chat',
    timeoutMs + MOONSHINE_BUSY_BUFFER_MS,
    async () => {
      const url = `${MOONSHINE_BASE_URL}/v1/chat/completions`;
      const maxTokens = resolveMoonshineMaxTokens(request);
      const stream = request.stream ?? false;
      const messages = prepareMoonshineMessages(request.messages);
      if (messages.length !== request.messages.length) {
        logInference(
          `[moonshine] compacted history ${request.messages.length}→${messages.length} message(s)`
        );
      }
      logInference(
        `[moonshine] → ${url} model=${request.model} stream=${stream} max_tokens=${maxTokens}`
      );

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const abortFromUpstream = () => controller.abort();
      signal?.addEventListener('abort', abortFromUpstream, { once: true });

      try {
        const resp = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Zedge-Agentic': 'off',
            ...moonshinePrefillHeaders(request.prefillWindowId),
          },
          body: JSON.stringify({
            model: request.model,
            messages,
            stream,
            temperature: request.temperature ?? 0.7,
            max_tokens: maxTokens,
            top_p: request.top_p,
          }),
          signal: controller.signal,
        });
        logInference(`[moonshine] ← ${resp.status} ${resp.statusText}`);
        return resp;
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abortFromUpstream);
      }
    },
    `${request.model} chat`
  );
}

/**
 * Handles the zedge prewarm Moonshine Prompt workflow.
 */
export async function prewarmMoonshinePrompt(
  request: ChatCompletionRequest,
  signal?: AbortSignal
): Promise<Response> {
  const warmRequest: ChatCompletionRequest = {
    ...request,
    stream: false,
    max_tokens: 0,
  };
  return await tryMoonshineInference(warmRequest, signal);
}

/**
 * Handles the zedge prewarm Skymesh Global Cache workflow.
 */
export async function prewarmSkymeshGlobalCache(
  prompt: string,
  model: string,
  signal?: AbortSignal
): Promise<void> {
  try {
    await prewarmSkymeshTeleport(prompt, model, FAT_STATION_BASE_URL, getSkymeshCacheUrl());
  } catch {
    // Silently fail — prewarming is best-effort
  }
}

/**
 * Attempt inference via LAN mesh peers
 */
async function tryMeshInference(
  request: ChatCompletionRequest
): Promise<Response | null> {
  // Lazy import to avoid circular deps at module load time
  const { meshInfer, getMeshStatus } = await import('./p2p-mesh.ts');
  const status = getMeshStatus();
  if (!status.running || status.peers.length === 0) return null;

  const result = await meshInfer(request);
  if (!result) return null;

  const response: ChatCompletionResponse = {
    id: `chatcmpl-mesh-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: request.model,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: result.content },
        finish_reason: 'stop',
      },
    ],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };

  return new Response(JSON.stringify(response), {
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Attempt inference via Edge Coordinator (CF Workers)
 */
async function tryEdgeCoordinator(
  request: ChatCompletionRequest,
  signal?: AbortSignal
): Promise<Response> {
  const circuit = getEdgeCircuitSnapshot(request.model);
  if (circuit.isOpen) {
    const remainingSeconds = Math.max(1, Math.ceil(circuit.remainingMs / 1000));
    const reasonSuffix = circuit.lastFailureReason
      ? ` (${circuit.lastFailureReason})`
      : '';
    const message = `circuit-open: Edge temporarily disabled for model ${request.model}; retry in ${remainingSeconds}s${reasonSuffix}`;
    logInference(`[edge] ${message}`);
    throw new Error(message);
  }

  const baseUrl = getApiBaseUrl();
  const authHeaders = getAuthHeaders();
  const headers = {
    'Content-Type': 'application/json',
    'User-Agent':
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    Accept: 'text/event-stream, application/json',
    Origin: 'https://edge.affectively.ai',
    'X-Requested-Model': request.model,
    ...authHeaders,
  };

  // Try both edge domains: affectively.ai is primary, edgework.ai is fallback.
  // Use /ai/communicate because direct /v1 endpoints can be intermittently
  // blocked by Cloudflare worker runtime errors in this environment.
  const EDGE_URLS = [
    'https://edge.affectively.ai',
    baseUrl, // api.edgework.ai
  ];

  const maxRetries = request.stream === true ? 1 : 2;
  const edgeDeadline =
    Date.now() +
    (request.stream === true
      ? EDGE_STREAM_TOTAL_BUDGET_MS
      : EDGE_NON_STREAM_TOTAL_BUDGET_MS);

  for (const edgeBase of EDGE_URLS) {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const remainingEdgeBudgetMs = edgeDeadline - Date.now();
      if (remainingEdgeBudgetMs <= 0) {
        logInference(
          `[edge] budget exhausted before ${edgeBase} attempt=${attempt}`
        );
        break;
      }

      const url = `${edgeBase}/ai/communicate`;
      const lastUserMsg =
        [...request.messages]
          .reverse()
          .find((message) => message.role === 'user')?.content ?? '';
      const lastMsg =
        request.messages[request.messages.length - 1]?.content ?? '';
      const edgeBody = {
        prompt: lastUserMsg || lastMsg,
        messages: request.messages,
        model: request.model,
        max_tokens: request.max_tokens ?? 128,
        temperature: request.temperature ?? 0.7,
        top_p: request.top_p,
        stream: true,
      };
      logInference(
        `[edge] → ${url} model=${request.model} stream=${edgeBody.stream} attempt=${attempt}`
      );

      const edgeSignalController = new AbortController();
      const abortFromUpstream = () => edgeSignalController.abort();
      signal?.addEventListener('abort', abortFromUpstream, { once: true });
      const edgeTimeoutMs = Math.min(
        getEdgeRequestTimeoutMs(request) ?? remainingEdgeBudgetMs,
        remainingEdgeBudgetMs
      );
      const requestTimeout =
        edgeTimeoutMs <= 0
          ? null
          : setTimeout(() => edgeSignalController.abort(), edgeTimeoutMs);

      let resp: Response;
      try {
        resp = await fetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify(edgeBody),
          signal: edgeSignalController.signal,
        });
      } finally {
        if (requestTimeout !== null) {
          clearTimeout(requestTimeout);
        }
        signal?.removeEventListener('abort', abortFromUpstream);
      }

      // Log response
      const respHeaders: Record<string, string> = {};
      resp.headers.forEach((v, k) => {
        respHeaders[k] = v;
      });
      logInference(
        `[edge] ← ${resp.status} ${resp.statusText} headers=${JSON.stringify(
          respHeaders
        )}`
      );

      // 503: engine cold start or upstream challenge.
      // Retry only within the current request budget so we fail over promptly.
      if (resp.status === 503 && attempt < maxRetries) {
        const baseDelay =
          request.stream === true
            ? Math.min(1000 * (attempt + 1), 3000)
            : Math.min(2000 * Math.pow(2, attempt), 10000);
        const remainingAfterResponseMs = edgeDeadline - Date.now();
        if (remainingAfterResponseMs <= 750) {
          logInference(
            `[edge] 503 and budget nearly exhausted (${remainingAfterResponseMs}ms); skipping retries`
          );
          break;
        }
        const delayMs = Math.min(
          baseDelay,
          Math.max(250, remainingAfterResponseMs - 500)
        );
        logInference(
          `[edge] 503 engine cold start, retrying in ${delayMs}ms (attempt ${
            attempt + 1
          }/${maxRetries})...`
        );
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        continue;
      }

      if (!resp.ok) break; // Try next EDGE_URL

      if (request.stream) {
        try {
          const remainingBeforeProbeMs = edgeDeadline - Date.now();
          if (remainingBeforeProbeMs <= 1_000) {
            throw new Error(
              `Edge stream budget exhausted before token probe (${remainingBeforeProbeMs}ms)`
            );
          }
          return await ensureEdgeStreamingHasToken(
            resp,
            request.model,
            Math.min(EDGE_STREAM_FIRST_TOKEN_TIMEOUT_MS, remainingBeforeProbeMs)
          );
        } catch (error) {
          await cancelResponseBody(resp);
          throw error;
        }
      }

      // Batch mode: normalize either JSON or unexpected SSE to OpenAI JSON.
      try {
        return await collapseEdgeStreamingResponse(resp, request.model, {
          timeoutMs: Math.min(
            EDGE_NON_STREAMING_COMPLETION_TIMEOUT_MS,
            Math.max(5_000, edgeDeadline - Date.now())
          ),
          requireNonEmptyText: true,
        });
      } catch (error) {
        await cancelResponseBody(resp);
        throw error;
      }
    }
  }

  // Shouldn't reach here, but return the last response
  return new Response('Edge coordinator unavailable', { status: 503 });
}

/**
 * Whether Cloud Run monofat (CPU middle) tier is enabled. ON by default when
 * coordinators are configured. Set ZEDGE_CLOUDRUN_ENABLED=0 to skip.
 */
function isCloudRunTierEnabled(): boolean {
  const raw = process.env.ZEDGE_CLOUDRUN_ENABLED;
  if (raw === undefined) return true;
  const normalized = raw.trim().toLowerCase();
  return normalized !== '0' && normalized !== 'false' && normalized !== 'off';
}

function getCloudRunTimeoutMs(): number {
  // Cold minScale=0 monofat can need long heat (codestral ~3–5 min first hit).
  // Warm is hundreds of ms. Env override for interactive tighter budgets.
  return Number(process.env.ZEDGE_CLOUDRUN_TIMEOUT_MS ?? 180_000);
}

/**
 * POST one monofat peer. Retries 503 cold-start with short backoff.
 */
async function postCloudRunPeer(
  coordinatorUrl: string,
  request: ChatCompletionRequest,
  signal?: AbortSignal
): Promise<Response> {
  const MAX_RETRIES = 2;
  const INITIAL_BACKOFF_MS = 1_500;
  const MAX_BACKOFF_MS = 6_000;
  const upstreamModel = resolveCloudRunUpstreamModel(request.model);
  const body = JSON.stringify({ ...request, model: upstreamModel });

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (signal?.aborted) {
      throw new DOMException('The operation was aborted.', 'AbortError');
    }

    const authHeaders = await getCloudRunAuthHeaders(coordinatorUrl);
    if (attempt === 0) {
      logInference(
        `[cloudrun] → ${coordinatorUrl}/v1/chat/completions model=${request.model}→${upstreamModel}`
      );
    } else {
      logInference(
        `[cloudrun] → retry ${attempt}/${MAX_RETRIES} peer=${coordinatorUrl} model=${request.model}`
      );
    }

    const timeoutMs = getCloudRunTimeoutMs();
    const timeoutController = new AbortController();
    const onAbort = () => timeoutController.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => timeoutController.abort(), timeoutMs);

    let resp: Response;
    try {
      resp = await fetch(`${coordinatorUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept:
            request.stream === true ? 'text/event-stream' : 'application/json',
          ...authHeaders,
        },
        body,
        signal: timeoutController.signal,
      });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }

    logInference(
      `[cloudrun] ← ${resp.status} ${resp.statusText} peer=${coordinatorUrl}`
    );

    const contentLength = resp.headers.get('content-length');
    if (resp.ok && contentLength && parseInt(contentLength, 10) < 80) {
      logInference(
        `[cloudrun] Rejecting small 200 response (${contentLength}B) -- likely error`
      );
      if (attempt < MAX_RETRIES) {
        await new Promise((r) => setTimeout(r, 1000));
        continue;
      }
      throw new Error(
        `Cloud Run returned error-sized response (${contentLength}B)`
      );
    }

    // 503 = container cold-starting / model warming
    if (
      (resp.status === 503 || resp.status === 500) &&
      attempt < MAX_RETRIES
    ) {
      const backoff = Math.min(
        INITIAL_BACKOFF_MS * Math.pow(1.5, attempt),
        MAX_BACKOFF_MS
      );
      logInference(
        `[cloudrun] ${resp.status} warming, retrying in ${Math.round(backoff)}ms`
      );
      await new Promise((resolve) => {
        const t = setTimeout(resolve, backoff);
        signal?.addEventListener(
          'abort',
          () => {
            clearTimeout(t);
            resolve(undefined);
          },
          { once: true }
        );
      });
      continue;
    }

    return resp;
  }

  throw new Error(`Cloud Run: exhausted ${MAX_RETRIES} retries`);
}

/**
 * Attempt inference via Cloud Run monofat peers (CPU middle).
 * Codestral races peer-a ‖ peer-b; first OK wins. Others hit primary only.
 */
async function tryCloudRunCoordinator(
  request: ChatCompletionRequest,
  signal?: AbortSignal
): Promise<Response> {
  const peers = getCloudRunPeerUrls(request.model);
  if (peers.length === 0) {
    throw new Error(`No Cloud Run coordinator for model: ${request.model}`);
  }

  if (peers.length === 1) {
    return postCloudRunPeer(peers[0]!, request, signal);
  }

  // Peer race: first ok response wins; abort losers.
  logInference(
    `[cloudrun] peer-race model=${request.model} peers=${peers.length}`
  );
  const controllers = peers.map(() => new AbortController());
  const onParentAbort = () => {
    for (const c of controllers) c.abort();
  };
  signal?.addEventListener('abort', onParentAbort, { once: true });

  try {
    const raced = await Promise.any(
      peers.map(async (url, i) => {
        const linked = AbortSignal.any
          ? AbortSignal.any([
              controllers[i]!.signal,
              ...(signal ? [signal] : []),
            ])
          : controllers[i]!.signal;
        const resp = await postCloudRunPeer(url, request, linked);
        if (!resp.ok) {
          throw new Error(`peer ${url} status ${resp.status}`);
        }
        // Cancel siblings
        for (let j = 0; j < controllers.length; j++) {
          if (j !== i) controllers[j]!.abort();
        }
        logInference(`[cloudrun] peer-race winner=${url}`);
        return resp;
      })
    );
    return raced;
  } catch (err) {
    // Promise.any AggregateError when all peers fail
    throw new Error(
      `Cloud Run peer race failed for ${request.model}: ${String(err)}`
    );
  } finally {
    signal?.removeEventListener('abort', onParentAbort);
  }
}

async function cancelResponseBody(response: Response): Promise<void> {
  const body = response.body;
  if (!body) return;

  try {
    await settleWithTimeout(body.cancel(), 1_000);
  } catch {
    // Best-effort cleanup only. The winner has already been returned.
  }
}

export interface RacedCoordinatorResponse {
  tier: InferenceTier;
  response: Response;
}

export interface RacedCoordinatorOutcome {
  winner: RacedCoordinatorResponse | null;
  backgroundCleanup: Promise<void>;
}

/**
 * Handles the zedge race Coordinator Responses workflow.
 */
export async function raceCoordinatorResponses({
  requestModel,
  startMs,
  edgePromise,
  cloudRunPromise,
  abortEdge,
  abortCloudRun,
}: {
  requestModel: string;
  startMs: number;
  edgePromise: Promise<RacedCoordinatorResponse | null>;
  cloudRunPromise: Promise<RacedCoordinatorResponse | null>;
  abortEdge?: () => void;
  abortCloudRun?: () => void;
}): Promise<RacedCoordinatorOutcome> {
  const winner = await raceForFirst([edgePromise, cloudRunPromise]);
  if (!winner) {
    return {
      winner: null,
      backgroundCleanup: Promise.resolve(),
    };
  }

  const loserTier = winner.tier === 'edge' ? 'cloudrun' : 'edge';
  const loserPromise = winner.tier === 'edge' ? cloudRunPromise : edgePromise;
  const abortLoser = winner.tier === 'edge' ? abortCloudRun : abortEdge;
  abortLoser?.();

  const backgroundCleanup = loserPromise
    .then(async (result) => {
      if (!result) return;

      logInference(
        `model=${requestModel} [race-cleanup] canceled ${loserTier} after ${
          Date.now() - startMs
        }ms (winner was ${winner.tier})`
      );
      await cancelResponseBody(result.response);
    })
    .catch(() => {});

  return {
    winner,
    backgroundCleanup,
  };
}

/**
 * Race multiple promises, return the first non-null result.
 * If all resolve to null, returns null.
 */
async function raceForFirst<T>(
  promises: Promise<T | null>[]
): Promise<T | null> {
  // Wrap each promise so null results don't "win" the race
  return new Promise<T | null>((resolve) => {
    let remaining = promises.length;
    for (const p of promises) {
      p.then((result) => {
        if (result !== null) {
          resolve(result);
        } else {
          remaining--;
          if (remaining === 0) resolve(null);
        }
      }).catch(() => {
        remaining--;
        if (remaining === 0) resolve(null);
      });
    }
  });
}

/**
 * Local WASM inference — generates a response using the Aether-backed local runtime
 */
async function tryWasmFallback(
  request: ChatCompletionRequest
): Promise<Response> {
  return await runWithCompanionActivity(
    'wasm-chat',
    LOCAL_WASM_TOTAL_TIMEOUT_MS + LOCAL_WASM_BUSY_BUFFER_MS,
    async () => {
      const temperature = request.temperature ?? 0.7;
      const maxTokens = request.max_tokens ?? 128;
      const deadline = Date.now() + LOCAL_WASM_TOTAL_TIMEOUT_MS;
      const remainingWarmupMs = Math.max(1, deadline - Date.now());
      const ready = await withTimeout(
        aetherLocalRuntime.ensureChatReady(),
        remainingWarmupMs,
        'Local model warm-up'
      );
      if (!ready) {
        throw new Error('Local model failed to load');
      }

      const t0 = performance.now();
      const remainingGenerateMs = Math.max(1, deadline - Date.now());
      const content = await withTimeout(
        aetherLocalRuntime.generate(request.messages, maxTokens, temperature),
        remainingGenerateMs,
        'Local model generation'
      );
      const normalizedContent = hasUsableFallbackText(content)
        ? content
        : 'Local WASM fallback returned no usable tokens. Please retry the request.';
      const inferenceMs = performance.now() - t0;

      const promptTokens = request.messages.reduce(
        (acc, m) => acc + Math.ceil(m.content.length / 4),
        0
      );
      const completionTokens = Math.ceil(normalizedContent.length / 4);

      logInference(
        `[wasm] generated ${completionTokens} tokens in ${inferenceMs}ms (${aetherLocalRuntime.modelId})`
      );

      const response: ChatCompletionResponse = {
        id: `chatcmpl-wasm-${Date.now()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: aetherLocalRuntime.modelId,
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: normalizedContent },
            finish_reason: 'stop',
          },
        ],
        usage: {
          prompt_tokens: promptTokens,
          completion_tokens: completionTokens,
          total_tokens: promptTokens + completionTokens,
        },
      };

      return new Response(JSON.stringify(response), {
        headers: { 'Content-Type': 'application/json' },
      });
    },
    request.model
  );
}

let localWasmWarmupPromise: Promise<boolean> | null = null;

/**
 * Handles the zedge start Local Wasm Warmup workflow.
 */
export function startLocalWasmWarmup(): Promise<boolean> {
  if (localWasmWarmupPromise) {
    return localWasmWarmupPromise;
  }

  localWasmWarmupPromise = runWithCompanionActivity(
    'wasm-prewarm',
    LOCAL_WASM_PREWARM_BUSY_MS,
    async () => {
      const t0 = performance.now();
      try {
        const ready = await aetherLocalRuntime.ensureChatReady();
        const elapsed = performance.now() - t0;
        if (ready) {
          logInference(
            `[wasm] prewarmed chat model in ${elapsed}ms (${aetherLocalRuntime.modelId})`
          );
        } else {
          logInference('[wasm] prewarm failed to load local chat model');
        }
        return ready;
      } catch (err) {
        logInference(`[wasm] prewarm error: ${String(err)}`);
        return false;
      }
    },
    'startup'
  ).finally(() => {
    localWasmWarmupPromise = null;
  });

  return localWasmWarmupPromise;
}

/**
 * Echo fallback — guaranteed response acknowledging the message
 * Used when even WASM inference fails (should never happen, but belt + suspenders)
 */
function echoFallback(request: ChatCompletionRequest): Response {
  const lastMessage = request.messages[request.messages.length - 1];
  const content = `I received your message, but Moonshine did not return a usable completion before Zedge's local echo fallback. Your message was: "${
    lastMessage?.content?.slice(0, 200) ?? ''
  }"`;

  const response: ChatCompletionResponse = {
    id: `chatcmpl-echo-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: request.model,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content },
        finish_reason: 'stop',
      },
    ],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };

  return new Response(JSON.stringify(response), {
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Create an SSE proxy stream with heartbeat and reconnection
 *
 * Wraps an upstream SSE response with:
 * - Heartbeat comments every 15s to keep the connection alive
 * - Proper stream termination with [DONE] sentinel
 * - Error recovery that sends an error event instead of dropping
 */
export function createSSEProxyStream(
  upstreamBody: ReadableStream<Uint8Array> | null,
  tier: InferenceTier,
  upstreamHeaders: Record<string, string> = {},
  attempts?: TierAttempt[],
  modelName?: string,
  options: {
    forwardNamedEvents?: boolean;
    suppressPrefillProgress?: boolean;
  } = {}
): ReadableStream<Uint8Array> {
  const forwardNamedEvents = options.forwardNamedEvents === true;
  const suppressPrefillProgress = options.suppressPrefillProgress === true;
  const encoder = new TextEncoder();
  const decoder = new TextDecoder('utf-8', { fatal: true });

  // Log all debug info to inference log — not to the SSE stream.
  // Zed's OpenAI-compatible provider can't handle SSE comments.
  // Debug info goes in HTTP response headers instead (X-Zedge-Tier, etc.).
  if (attempts?.length) {
    const chainStr = attempts
      .map(
        (a) =>
          `${a.tier}:${a.status}(${formatAttemptDuration(a.ms)})${
            a.detail ? '[' + a.detail.slice(0, 40) + ']' : ''
          }`
      )
      .join(' → ');
    logInference(`[sse-proxy] tier=${tier} chain: ${chainStr}`);
  }
  for (const [key, value] of Object.entries(upstreamHeaders)) {
    logInference(`[sse-proxy] tier=${tier} header: ${key}=${value}`);
  }

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      if (!upstreamBody) {
        logInference(`[sse-proxy] tier=${tier} no upstream body`);
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({ error: 'No response body' })}\n\n`
          )
        );
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
        return;
      }

      // Guard against writing to a closed controller. All enqueue/close
      // calls go through these helpers to prevent "Controller is already closed".
      let closed = false;
      const enqueue = (chunk: Uint8Array) => {
        if (closed) return;
        try {
          controller.enqueue(chunk);
        } catch {
          closed = true;
        }
      };
      const closeController = () => {
        if (closed) return;
        closed = true;
        try {
          controller.close();
        } catch {
          // Already closed
        }
      };

      // Heartbeat to keep TCP connection alive during long waits
      // (cold starts, prefill, weight loading). Zed's parser ignores
      // non-`data:` lines but the bytes prevent idle connection timeouts.
      enqueue(encoder.encode(': zedge-ready\n\n'));
      const heartbeat = setInterval(() => {
        if (closed) {
          clearInterval(heartbeat);
          return;
        }
        enqueue(encoder.encode(': heartbeat\n\n'));
      }, 5_000);

      // SSE stream content logging
      let totalBytes = 0;
      let dataEventCount = 0;
      let firstDataLogged = false;
      let sawDone = false;
      const streamStart = Date.now();
      let lineBuf = '';
      // Debug/progress info can go via reasoning_content (Zed thinking UI)
      // or as content (italic markdown). reasoning_content is better UX but
      // currently broken in Zed's openai_compatible provider (#46794).
      const useReasoning = getZedgeConfig().reasoningContent === true;
      let emittedProgress = false;
      let emittedProgressBlocks = 0;
      let observedPrefill = false;
      let prefillStartMs = 0;
      let lastPrefillMs = 0;
      let lastPrefillPos = 0;
      let currentEventName: string | null = null;
      const progressTickCount = 20;
      const progressId = `chatcmpl-progress-${Date.now()}`;
      const progressCreated = Math.floor(Date.now() / 1000);
      const progressChainInfo = attempts?.length
        ? attempts
            .map((a) => `${a.tier}:${a.status}(${formatAttemptDuration(a.ms)})`)
            .join(' > ')
        : tier;

      const handleLine = (
        rawLine: string,
        options: { terminateEvent?: boolean } = {}
      ) => {
        const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;

        if (line.startsWith('data: ')) {
          const payload = line.slice(6).trim();
          const isForwardable = isOpenAiSsePayload(payload);

          if (isForwardable) {
            dataEventCount++;
            if (payload === '[DONE]') {
              sawDone = true;
            } else if (!firstDataLogged && hasMeaningfulSseDelta(payload)) {
              firstDataLogged = true;
              logInference(
                `[sse-proxy] tier=${tier} first-data: ${payload.slice(0, 200)}`
              );
              // Emit chain debug info before first real token
              if (useReasoning) {
                // reasoning_content goes into Zed's thinking UI (when supported)
                const debugChunk = {
                  id: progressId,
                  object: 'chat.completion.chunk',
                  created: progressCreated,
                  model: modelName ?? tier,
                  choices: [
                    {
                      index: 0,
                      delta: { reasoning_content: `[${progressChainInfo}]\n` },
                      finish_reason: null,
                    },
                  ],
                };
                enqueue(
                  encoder.encode(`data: ${JSON.stringify(debugChunk)}\n\n`)
                );
              } else if (emittedProgress) {
                // Close the markdown progress line before forwarding text.
                const prefillDuration = observedPrefill
                  ? formatAttemptDuration(Date.now() - prefillStartMs)
                  : null;
                const closingText = prefillDuration
                  ? `* prefill ${prefillDuration} *\n\n`
                  : '*\n\n';
                if (useReasoning) {
                  const sep = {
                    id: progressId,
                    object: 'chat.completion.chunk',
                    created: progressCreated,
                    model: modelName ?? tier,
                    choices: [
                      {
                        index: 0,
                        delta: { reasoning_content: closingText },
                        finish_reason: null,
                      },
                    ],
                  };
                  enqueue(encoder.encode(`data: ${JSON.stringify(sep)}\n\n`));
                } else {
                  const sep = {
                    id: progressId,
                    object: 'chat.completion.chunk',
                    created: progressCreated,
                    model: modelName ?? tier,
                    choices: [
                      {
                        index: 0,
                        delta: { content: closingText },
                        finish_reason: null,
                      },
                    ],
                  };
                  enqueue(encoder.encode(`data: ${JSON.stringify(sep)}\n\n`));
                }
              }
            }

            enqueue(
              encoder.encode(
                line + (options.terminateEvent === true ? '\n\n' : '\n')
              )
            );
          } else if (currentEventName === 'prefill') {
            if (forwardNamedEvents) {
              logInference(
                `[sse-proxy] tier=${tier} forwarding event:${currentEventName} ${payload.slice(
                  0,
                  100
                )}`
              );
              enqueue(
                encoder.encode(
                  `event: ${currentEventName}\ndata: ${payload}\n\n`
                )
              );
            } else {
              logInference(
                `[sse-proxy] tier=${tier} observed event:${currentEventName} ${payload.slice(
                  0,
                  100
                )}`
              );
            }
            if (
              currentEventName === 'prefill' &&
              !firstDataLogged &&
              !suppressPrefillProgress
            ) {
              try {
                const parsed = JSON.parse(payload) as {
                  completed_tokens?: number;
                  total_tokens?: number;
                };
                const completed = parsed.completed_tokens;
                const total = parsed.total_tokens;
                if (
                  typeof completed === 'number' &&
                  typeof total === 'number'
                ) {
                  emitPrefillProgress(completed, total);
                }
              } catch {
                logInference(
                  `[sse-proxy] tier=${tier} invalid prefill event payload: ${payload.slice(
                    0,
                    100
                  )}`
                );
              }
            }
          } else if (currentEventName === 'heartbeat') {
            if (forwardNamedEvents) {
              logInference(
                `[sse-proxy] tier=${tier} forwarding event:${currentEventName} ${payload.slice(
                  0,
                  100
                )}`
              );
              enqueue(
                encoder.encode(
                  `event: ${currentEventName}\ndata: ${payload}\n\n`
                )
              );
            } else {
              logInference(
                `[sse-proxy] tier=${tier} observed event:${currentEventName} ${payload.slice(
                  0,
                  100
                )}`
              );
            }
          } else {
            // Edge stream compatibility:
            // Some upstream tiers emit token SSE payloads in a compact shape
            // like {"token":"...","index":0} instead of OpenAI chunks.
            // Convert those events into OpenAI-compatible delta chunks so Zed
            // can render tokens without timing out waiting for valid data.
            try {
              const parsed = JSON.parse(payload) as Record<string, unknown>;
              const legacyToken =
                typeof parsed.token === 'string'
                  ? parsed.token
                  : typeof parsed.content === 'string'
                  ? parsed.content
                  : typeof parsed.text === 'string'
                  ? parsed.text
                  : null;
              const legacyDone =
                parsed.done === true ||
                parsed.is_done === true ||
                parsed.eos === true ||
                parsed.event === 'done' ||
                parsed.finish_reason === 'stop';

              if (legacyToken !== null && legacyToken.length > 0) {
                dataEventCount++;
                if (!firstDataLogged) {
                  firstDataLogged = true;
                  logInference(
                    `[sse-proxy] tier=${tier} first-legacy-token: ${legacyToken.slice(
                      0,
                      80
                    )}`
                  );
                }

                const legacyChunk = {
                  id: progressId,
                  object: 'chat.completion.chunk',
                  created: progressCreated,
                  model: modelName ?? tier,
                  choices: [
                    {
                      index: 0,
                      delta:
                        dataEventCount === 1
                          ? { role: 'assistant', content: legacyToken }
                          : { content: legacyToken },
                      finish_reason: null,
                    },
                  ],
                };
                enqueue(
                  encoder.encode(`data: ${JSON.stringify(legacyChunk)}\n\n`)
                );
              }

              if (legacyDone && !sawDone) {
                sawDone = true;
                const finishChunk = {
                  id: progressId,
                  object: 'chat.completion.chunk',
                  created: progressCreated,
                  model: modelName ?? tier,
                  choices: [
                    {
                      index: 0,
                      delta: {},
                      finish_reason: 'stop',
                    },
                  ],
                };
                enqueue(
                  encoder.encode(`data: ${JSON.stringify(finishChunk)}\n\n`)
                );
                enqueue(encoder.encode('data: [DONE]\n\n'));
              }

              if (legacyToken === null && !legacyDone) {
                logInference(
                  `[sse-proxy] tier=${tier} filtered non-OpenAI data: ${payload.slice(
                    0,
                    100
                  )}`
                );
              }
            } catch {
              logInference(
                `[sse-proxy] tier=${tier} filtered non-OpenAI data: ${payload.slice(
                  0,
                  100
                )}`
              );
            }
          }
        } else if (line === '') {
          currentEventName = null;
          enqueue(encoder.encode('\n'));
        } else if (line.startsWith('event: ')) {
          currentEventName = line.slice('event: '.length).trim();
        } else if (line.startsWith(':')) {
          // Log upstream comments (heartbeat, prefill) but don't forward raw
          logInference(
            `[sse-proxy] tier=${tier} upstream: ${line.slice(0, 100)}`
          );

          // Convert prefill progress into an append-only filled bar. Zed
          // appends deltas, so this emits only newly crossed buckets.
          const prefillMatch = line.match(/^: prefill (\d+)\/(\d+)/);
          if (
            prefillMatch &&
            !firstDataLogged &&
            !suppressPrefillProgress
          ) {
            const pos = parseInt(prefillMatch[1], 10);
            const total = parseInt(prefillMatch[2], 10);
            emitPrefillProgress(pos, total);
          }
        }
      };

      const emitPrefillProgress = (pos: number, total: number): void => {
        const isStart = !emittedProgress;
        const now = Date.now();
        if (!observedPrefill) {
          observedPrefill = true;
          prefillStartMs = now;
          lastPrefillMs = now;
          lastPrefillPos = pos;
        }

        const targetTicks =
          total > 0 && pos > 0
            ? Math.max(
                1,
                Math.min(
                  progressTickCount,
                  Math.ceil((pos / total) * progressTickCount)
                )
              )
            : 0;
        const newTicks = Math.max(0, targetTicks - emittedProgressBlocks);
        emittedProgressBlocks = Math.max(emittedProgressBlocks, targetTicks);
        const elapsedPrefillMs = Math.max(1, now - prefillStartMs);
        const recentElapsedMs = Math.max(1, now - lastPrefillMs);
        const recentProgress = Math.max(0, pos - lastPrefillPos);
        const overallTokSec =
          pos > 0 ? Math.round((pos / elapsedPrefillMs) * 1000) : 0;
        const currentTokSec =
          recentProgress > 0
            ? Math.round((recentProgress / recentElapsedMs) * 1000)
            : overallTokSec;
        lastPrefillMs = now;
        lastPrefillPos = pos;
        const tickContent =
          (isStart
            ? `*${currentTokSec}t/s | ${progressChainInfo} prefill \u2591`
            : '') + '\u2588'.repeat(newTicks);
        if (!tickContent) {
          return;
        }

        emittedProgress = true;
        const tickDelta = isStart
          ? { role: 'assistant' as const, content: tickContent }
          : { content: tickContent };

        if (useReasoning) {
          const progressChunk = {
            id: progressId,
            object: 'chat.completion.chunk',
            created: progressCreated,
            model: modelName ?? tier,
            choices: [
              {
                index: 0,
                delta: { reasoning_content: tickContent },
                finish_reason: null,
              },
            ],
          };
          enqueue(encoder.encode(`data: ${JSON.stringify(progressChunk)}\n\n`));
        } else {
          const progressChunk = {
            id: progressId,
            object: 'chat.completion.chunk',
            created: progressCreated,
            model: modelName ?? tier,
            choices: [
              {
                index: 0,
                delta: tickDelta,
                finish_reason: null,
              },
            ],
          };
          enqueue(encoder.encode(`data: ${JSON.stringify(progressChunk)}\n\n`));
        }
      };

      const flushLineBuf = () => {
        if (lineBuf.trim().length === 0) {
          lineBuf = '';
          return;
        }
        handleLine(lineBuf, { terminateEvent: true });
        lineBuf = '';
      };

      try {
        const reader = upstreamBody.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          totalBytes += value.byteLength;
          const text = decoder.decode(value, { stream: true });

          // Filter: only forward `data:` lines and blank-line delimiters.
          // Strip all SSE comments (`: heartbeat`, `: prefill`, etc.)
          // so Zed's parser never sees them.
          lineBuf += text;
          const lines = lineBuf.split('\n');
          lineBuf = lines.pop() ?? '';

          for (const line of lines) {
            handleLine(line);
          }
        }

        flushLineBuf();
      } catch (err) {
        flushLineBuf();
        const errMsg = err instanceof Error ? err.message : 'Stream error';
        logInference(`[sse-proxy] tier=${tier} stream-error: ${errMsg}`);
        enqueue(
          encoder.encode(`data: ${JSON.stringify({ error: errMsg })}\n\n`)
        );
      } finally {
        clearInterval(heartbeat);
        const elapsed = Date.now() - streamStart;
        // Emit usage/debug summary (reasoning_content when enabled)
        if (dataEventCount > 0 && useReasoning) {
          const usageChunk = {
            id: progressId,
            object: 'chat.completion.chunk',
            created: progressCreated,
            model: modelName ?? tier,
            choices: [
              {
                index: 0,
                delta: {
                  reasoning_content: `\n---\ntier: ${tier} | ${dataEventCount} tokens | ${elapsed}ms | ${totalBytes}B\n`,
                },
                finish_reason: null,
              },
            ],
            usage: {
              prompt_tokens: 0,
              completion_tokens: dataEventCount,
              total_tokens: dataEventCount,
            },
          };
          enqueue(encoder.encode(`data: ${JSON.stringify(usageChunk)}\n\n`));
        }
        if (dataEventCount === 0) {
          const emptyNotice = {
            id: progressId,
            object: 'chat.completion.chunk',
            created: progressCreated,
            model: modelName ?? tier,
            choices: [
              {
                index: 0,
                delta: {
                  role: 'assistant',
                  content: `[zedge notice] ${tier} produced no tokens for "${
                    modelName ?? 'selected model'
                  }". Retry or switch to wasm-local.`,
                },
                finish_reason: null,
              },
            ],
          };
          enqueue(encoder.encode(`data: ${JSON.stringify(emptyNotice)}\n\n`));
        }
        if (!sawDone) {
          enqueue(encoder.encode('data: [DONE]\n\n'));
        }
        logInference(
          `[sse-proxy] tier=${tier} stream-end: ${totalBytes}B ${dataEventCount} data-events sawDone=${sawDone} ${elapsed}ms`
        );
        closeController();
      }
    },
  });
}

/**
 * Empty role/progress chunks are valid OpenAI SSE, but they are not the first
 * generated token. Skymesh emits those chunks while prefill is running; using
 * them as the first-data marker suppresses the visible prefill progress bar.
 */
function hasMeaningfulSseDelta(payload: string): boolean {
  try {
    const parsed = JSON.parse(payload) as {
      choices?: Array<{
        delta?: {
          content?: unknown;
          reasoning_content?: unknown;
          tool_calls?: unknown;
          function_call?: unknown;
        };
        message?: { content?: unknown };
      }>;
    };
    const choice = parsed.choices?.[0];
    if (!choice) return false;
    const delta = choice.delta;
    if (delta) {
      if (typeof delta.content === 'string' && delta.content.length > 0)
        return true;
      if (
        typeof delta.reasoning_content === 'string' &&
        delta.reasoning_content.length > 0
      )
        return true;
      if (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0)
        return true;
      if (delta.function_call !== undefined && delta.function_call !== null)
        return true;
    }
    return (
      typeof choice.message?.content === 'string' &&
      choice.message.content.length > 0
    );
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// FIM (Fill-in-Middle) Fast Path
// ---------------------------------------------------------------------------

/** Known FIM token formats per model family */
const FIM_TOKENS: Record<
  string,
  { prefix: string; suffix: string; middle: string }
> = {
  qwen: {
    prefix: '<|fim_prefix|>',
    suffix: '<|fim_suffix|>',
    middle: '<|fim_middle|>',
  },
  starcoder: {
    prefix: '<fim_prefix>',
    suffix: '<fim_suffix>',
    middle: '<fim_middle>',
  },
  codellama: { prefix: '<PRE>', suffix: '<SUF>', middle: '<MID>' },
  deepseek: {
    prefix: '<｜fim▁begin｜>',
    suffix: '<｜fim▁hole｜>',
    middle: '<｜fim▁end｜>',
  },
};

function getFimTokens(model: string): {
  prefix: string;
  suffix: string;
  middle: string;
} {
  // Check more specific patterns first to avoid false matches on 'coder'
  if (model.includes('starcoder')) return FIM_TOKENS.starcoder;
  if (model.includes('codellama')) return FIM_TOKENS.codellama;
  if (model.includes('deepseek')) return FIM_TOKENS.deepseek;
  if (model.includes('qwen') || model.includes('coder')) return FIM_TOKENS.qwen;
  return FIM_TOKENS.qwen; // Default to Qwen FIM format
}

/** Build a native FIM prompt from prefix/suffix context */
export function buildFimPrompt(
  prefix: string,
  suffix: string,
  model: string
): string {
  const tokens = getFimTokens(model);
  return `${tokens.prefix}${prefix}${tokens.suffix}${suffix}${tokens.middle}`;
}

export interface FimResult {
  completion: string;
  tier: InferenceTier;
  model: string;
  attempts: TierAttempt[];
  durationMs: number;
}

/**
 * FIM inference -- optimized fast path for tab completions.
 *
 * Routes through the Moonshine container (localhost:8080).
 * Remote edge/cloudrun/mesh/wasm tiers deprecated.
 */
export async function inferFim(
  prefix: string,
  suffix: string,
  model: string,
  maxTokens = 128,
  temperature = 0.2
): Promise<FimResult> {
  const t0 = performance.now();
  const attempts: TierAttempt[] = [];
  const fimPrompt = buildFimPrompt(prefix, suffix, model);

  logInference(
    `--- FIM model=${model} prefix=${prefix.length}c suffix=${suffix.length}c`
  );

  // Moonshine container handles FIM
  {
    const t1 = performance.now();
    try {
      const resp = await tryMoonshineInference({
        model,
        messages: [
          {
            role: 'system',
            content: 'Complete the code. Output ONLY the completion.',
          },
          { role: 'user', content: fimPrompt },
        ],
        max_tokens: maxTokens,
        temperature,
      });

      if (resp.ok) {
        const data = (await resp.json()) as ChatCompletionResponse;
        const completion = data.choices?.[0]?.message?.content ?? '';
        attempts.push({ tier: 'moonshine', status: 'ok', ms: performance.now() - t1 });
        logInference(
          `[fim:moonshine] ${completion.length}c in ${performance.now() - t1}ms`
        );
        return {
          completion,
          tier: 'moonshine',
          model,
          attempts,
          durationMs: performance.now() - t0,
        };
      }
      attempts.push({
        tier: 'moonshine',
        status: 'http_error',
        ms: performance.now() - t1,
        detail: `${resp.status}`,
      });
    } catch (err) {
      attempts.push({
        tier: 'moonshine',
        status: 'error',
        ms: performance.now() - t1,
        detail: String(err),
      });
    }
  }

  // Echo fallback for FIM
  attempts.push({
    tier: 'echo',
    status: 'ok',
    ms: 0,
    detail: 'FIM moonshine failed',
  });
  return {
    completion: '',
    tier: 'echo',
    model,
    attempts,
    durationMs: performance.now() - t0,
  };
}

/**
 * Execute the inference chain
 *
 * Tier order:
 * 1. Moonshine container (localhost:8080, docker-compose.moonshine.yml openai-compat service)
 * 2. Echo fallback (guaranteed)
 *
 * Remote edge/cloudrun/mesh/wasm tiers deprecated — use Moonshine docker container.
 */
/**
 * SOUL-DOC ISOLATION (mirrors gnosis openai-server, commit 71b7203f).
 *
 * The Tier -1 Skymesh teleport keys the model-agnostic global cache on the LAST
 * USER MESSAGE TEXT ALONE — no system prompt, no history, no conversation id.
 * That key is only sound for a single, context-free user turn. If the request
 * carries a non-empty system prompt (persona / Halogram / judge CHARTER) or ANY
 * prior turn (an assistant reply, or more than one user message), the answer is
 * context-conditioned: serving a last-user-text hit would leak a foreign
 * completion across conversations (e.g. two unrelated chats whose newest user
 * turn is "yes" / "continue" / "why?" collide on the same fp48 key). Only a
 * lone, context-free user turn may teleport; everything else runs real inference.
 */
export function skymeshTeleportEligibility(messages: readonly ChatMessage[]): {
  eligible: boolean;
  hasSystemPrompt: boolean;
  hasPriorContext: boolean;
} {
  const hasSystemPrompt = messages.some(
    (m) => m.role === 'system' && m.content.trim().length > 0,
  );
  const hasPriorContext =
    messages.some((m) => m.role === 'assistant') ||
    messages.filter((m) => m.role === 'user').length > 1;
  const lastUserContent =
    [...messages].reverse().find((m) => m.role === 'user')?.content ?? '';
  const eligible =
    !hasSystemPrompt && !hasPriorContext && lastUserContent.trim().length > 0;
  return { eligible, hasSystemPrompt, hasPriorContext };
}

/**
 * Handles the zedge infer workflow.
 */
export async function infer(
  request: ChatCompletionRequest
): Promise<TierResult> {
  // --- Engram Store: inject relevant memories into context ---
  if (!shouldSkipHeavySystemContext(request.model)) {
    try {
      const { getEngramStore } = await import('./engram-store.ts');
      const store = getEngramStore();
      if (store.size > 0) {
        const lastUserMsg = [...request.messages]
          .reverse()
          .find((m) => m.role === 'user');
        if (lastUserMsg && lastUserMsg.content.length > 10) {
          const recalled = await store.recall(lastUserMsg.content, 3);
          const memoryBlocks = recalled
            .filter((r) => r.score > 0.3)
            .map((r) => `[${r.engram.type}] ${r.engram.content}`)
            .join('\n');
          if (memoryBlocks.length > 0) {
            const messages = [...request.messages];
            const sysIdx = messages.findIndex((m) => m.role === 'system');
            const memoryContext = `\n\n<agent_memory>\n${memoryBlocks}\n</agent_memory>`;
            if (sysIdx >= 0) {
              messages[sysIdx] = {
                ...messages[sysIdx],
                content: messages[sysIdx].content + memoryContext,
              };
            } else {
              messages.unshift({
                role: 'system',
                content: `You have persistent memory from previous sessions.${memoryContext}`,
              });
            }
            request = { ...request, messages };
          }
        }
      }
    } catch {
      // Engram store not initialized -- proceed without memory
    }
  }
  request = {
    ...request,
    messages: applySystemPromptBudget(
      request.model,
      request.messages
    ) as ChatCompletionRequest['messages'],
  };

  const attempts: TierAttempt[] = [];
  const lastMsg = request.messages[request.messages.length - 1];
  const msgPreview =
    typeof lastMsg?.content === 'string'
      ? lastMsg.content.slice(0, 80)
      : JSON.stringify(lastMsg?.content)?.slice(0, 80) ?? '';
  logInference(
    `--- REQUEST model=${request.model} stream=${
      request.stream ?? false
    } msgs=${request.messages.length} last="${msgPreview}"`
  );

  // Tier -1: Skymesh global cache-key teleportation (default-on).
  // On verified hit: returns cached answer with zero inference (geodesicLength=0).
  // On miss / fat-station down / error: falls through silently.
  if (isSkymeshTeleportEnabled()) {
    const t0 = performance.now();
    try {
      const lastUserContent =
        [...request.messages]
          .reverse()
          .find((m) => m.role === 'user')?.content ?? '';
      const { eligible: teleportEligible, hasSystemPrompt, hasPriorContext } =
        skymeshTeleportEligibility(request.messages);
      if (teleportEligible) {
        const answerText = await trySkymeshCacheTeleport(
          lastUserContent,
          request.model,
          FAT_STATION_BASE_URL,
          getSkymeshCacheUrl()
        );
        if (answerText !== null) {
          attempts.push({ tier: 'skymesh', status: 'ok', ms: performance.now() - t0 });
          logInference(
            `model=${request.model} tier=skymesh status=ok (teleport hit) ms=${performance.now() - t0}`
          );

          // Handle streaming vs non-streaming
          let response: Response;
          if (request.stream === true) {
            const stream = streamCachedAnswer(answerText, request.model, `chatcmpl-skymesh-${Date.now()}`);
            response = new Response(stream, {
              status: 200,
              headers: {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                'X-Zedge-Tier': 'skymesh',
                'X-Skymesh-Teleport': 'hit',
              },
            });
          } else {
            response = createJsonChatCompletionResponse(request.model, answerText, {
              id: `chatcmpl-skymesh-${Date.now()}`,
              headers: {
                'X-Zedge-Tier': 'skymesh',
                'X-Skymesh-Teleport': 'hit',
              },
            });
          }

          return {
            tier: 'skymesh',
            response,
            upstreamHeaders: {
              'X-Zedge-Tier': 'skymesh',
              'X-Skymesh-Teleport': 'hit',
            },
            attempts,
          };
        }
        attempts.push({
          tier: 'skymesh',
          status: 'skipped',
          ms: performance.now() - t0,
          detail: 'miss',
        });
      } else {
        attempts.push({
          tier: 'skymesh',
          status: 'skipped',
          ms: 0,
          detail: hasSystemPrompt
            ? 'system-prompted (soul-doc isolation)'
            : hasPriorContext
            ? 'multi-turn (context-conditioned)'
            : 'no user content',
        });
      }
    } catch (err) {
      attempts.push({
        tier: 'skymesh',
        status: 'error',
        ms: performance.now() - t0,
        detail: String(err),
      });
      logInference(`[skymesh] teleport error: ${String(err)}`);
    }
  }

  // Tier 0a: Cloud Run monofat (CPU middle) — measured daily drivers
  // (mistral ~189, gemma* ~145–185, codestral race ~139/68). Prefer over local
  // moonshine for catalog models that have a monofat box. minScale=0 cold ok.
  if (
    isCloudRunTierEnabled() &&
    !hasExplicitForkjoinEndpoint() &&
    hasCloudRunCoordinatorForModel(request.model)
  ) {
    const t0 = performance.now();
    const controller = new AbortController();
    try {
      const resp = await tryCloudRunCoordinator(request, controller.signal);
      if (resp.ok) {
          attempts.push({ tier: 'cloudrun', status: 'ok', ms: performance.now() - t0 });
        logInference(
          `model=${request.model} tier=cloudrun status=ok ms=${performance.now() - t0}`
        );
        return {
          tier: 'cloudrun',
          response: resp,
          upstreamHeaders: {
            ...extractUpstreamDebugHeaders(resp),
            'X-Zedge-Tier': 'cloudrun',
          },
          attempts,
        };
      }
      attempts.push({
        tier: 'cloudrun',
        status: 'http_error',
        ms: performance.now() - t0,
        detail: `${resp.status} ${resp.statusText}`,
      });
      logInference(
        `[cloudrun] http_error ${resp.status} model=${request.model}`
      );
    } catch (err) {
      const isTimeout =
        err instanceof DOMException && err.name === 'AbortError';
      attempts.push({
        tier: 'cloudrun',
        status: isTimeout ? 'timeout' : 'error',
        ms: performance.now() - t0,
        detail: String(err),
      });
      logInference(`[cloudrun] error: ${String(err)}`);
    }
  } else {
    attempts.push({
      tier: 'cloudrun',
      status: 'skipped',
      ms: 0,
      detail: !isCloudRunTierEnabled()
        ? 'disabled'
        : `no monofat coordinator for ${request.model}`,
    });
  }

  // Tier 0b: Forkjoin own-runtime distributed-inference mesh.
  // Passthrough to the mesh OpenAI-compatible endpoint. Falls through to
  // Moonshine then echo on any failure, so ON-by-default is safe.
  if (
    isForkjoinTierEnabled() &&
    !forkjoinCollidesWithMoonshine() &&
    isForkjoinTierModel(request.model)
  ) {
    const t0 = performance.now();
    const controller = new AbortController();
    try {
      const resp = await tryForkjoinDistributedInference(
        request,
        controller.signal
      );
      if (resp && resp.ok) {
        attempts.push({ tier: 'forkjoin', status: 'ok', ms: performance.now() - t0 });
        logInference(
          `model=${request.model} tier=forkjoin status=ok ms=${
            performance.now() - t0
          }`
        );
        return {
          tier: 'forkjoin',
          response: resp,
          upstreamHeaders: extractUpstreamDebugHeaders(resp),
          attempts,
        };
      }
      if (resp) {
        attempts.push({
          tier: 'forkjoin',
          status: 'http_error',
          ms: performance.now() - t0,
          detail: `${resp.status} ${resp.statusText}`,
        });
        logInference(
          `[forkjoin] http_error ${resp.status} model=${request.model}`
        );
      } else {
        // null => mesh unreachable/disabled/network failure (already logged).
        attempts.push({
          tier: 'forkjoin',
          status: 'error',
          ms: performance.now() - t0,
          detail: 'mesh unavailable',
        });
      }
    } catch (err) {
      const isTimeout =
        err instanceof DOMException && err.name === 'AbortError';
      attempts.push({
        tier: 'forkjoin',
        status: isTimeout ? 'timeout' : 'error',
        ms: performance.now() - t0,
        detail: String(err),
      });
      logInference(`[forkjoin] error: ${String(err)}`);
    }
  } else {
    attempts.push({
      tier: 'forkjoin',
      status: 'skipped',
      ms: 0,
      detail: forkjoinCollidesWithMoonshine()
        ? 'same endpoint as moonshine'
        : isForkjoinTierEnabled()
          ? `model ${request.model} not routed to forkjoin`
          : 'disabled',
    });
  }

  // Tier 0c: the SSM relay. Exact-Skymesh models are not local, so they take
  // this lane INSTEAD of Moonshine — dialling loopback for them is what made
  // the SSM daily driver look like it had stopped yielding tokens.
  if (isExactSkymeshModel(request.model)) {
    const t0 = performance.now();
    // A lane known to be down fails HERE, in about a microsecond, carrying the
    // reason it went down. Paying the full discovery cost on every request is
    // how a broken upstream turns into an editor that appears to hang.
    const cooldownMs = skymeshRelayCooldownRemainingMs();
    if (cooldownMs > 0) {
      const detail = `lane down for ${Math.ceil(cooldownMs / 1000)}s more: ${skymeshRelayCooldownReason()}`;
      attempts.push({
        tier: 'skymesh-relay',
        status: 'skipped',
        ms: performance.now() - t0,
        detail,
      });
      logInference(`model=${request.model} tier=skymesh-relay skipped (${detail})`);
      throw new Error(
        `Exact Skymesh model ${request.model} is unavailable; ${detail}`
      );
    }
    const relayResponse = await trySkymeshRelayInference(request);
    const ms = performance.now() - t0;
    if (relayResponse) {
      attempts.push({ tier: 'skymesh-relay', status: 'ok', ms });
      logInference(
        `model=${request.model} tier=skymesh-relay status=ok ms=${ms}`
      );
      return {
        tier: 'skymesh-relay',
        response: relayResponse,
        upstreamHeaders: { 'X-Zedge-Tier': 'skymesh-relay' },
        attempts,
      };
    }
    attempts.push({ tier: 'skymesh-relay', status: 'error', ms });
    // Moonshine cannot serve this model at all; say so rather than letting a
    // loopback connection refusal stand in as the reason.
    attempts.push({
      tier: 'moonshine',
      status: 'skipped',
      ms: 0,
      detail: 'exact-skymesh model is not served by the local container',
    });
  }

  // Tier 1: Moonshine container (repair + one retry when the shim is down)
  if (!isExactSkymeshModel(request.model)) {
    const moonshineResult = await runMoonshineTier(request, attempts);
    if (moonshineResult) {
      const resp = moonshineResult.response;

        // Background: warm global skymesh cache (fire-and-forget)
        queueMicrotask(async () => {
          try {
            const lastUserContent = [...request.messages]
              .reverse()
              .find((m) => m.role === 'user')?.content ?? '';
            // SEED-SIDE SOUL-DOC ISOLATION: this Moonshine answer was generated
            // from the FULL request (system prompt + history), but the global
            // cache is keyed on the last-user text ALONE. Seeding a context-
            // conditioned answer under a context-free key POISONS the cache —
            // any later single-turn request with the same last-user text would
            // read back this persona/multi-turn answer. So only seed when the
            // request itself is a lone, context-free user turn (same gate as the
            // teleport read above).
            if (skymeshTeleportEligibility(request.messages).eligible) {
              const tokens = await (async () => {
                try {
                  const tr = await fetch(`${FAT_STATION_BASE_URL}/tokenize`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ text: lastUserContent }),
                    signal: AbortSignal.timeout(500),
                  });
                  if (!tr.ok) return null;
                  const tb = (await tr.json()) as Record<string, unknown>;
                  return Array.isArray(tb.tokens) ? (tb.tokens as number[]) : null;
                } catch {
                  return null;
                }
              })();

              if (tokens && tokens.length > 0) {
                // Extract response text from the successful Moonshine response
                if (!resp.bodyUsed) {
                  const rb = (await resp.clone().json()) as Record<string, unknown>;
                  const choices = Array.isArray(rb.choices) ? rb.choices : [];
                  const choice = choices[0] as Record<string, unknown> | undefined;
                  const message = choice?.message as Record<string, unknown> | undefined;
                  const answerText = message?.content as string | undefined;

                  if (answerText) {
                    await warmSkymeshCache({
                      queryTokens: tokens,
                      answerText,
                      model: request.model,
                      cacheUrl: getSkymeshCacheUrl(),
                      fatStationBaseUrl: FAT_STATION_BASE_URL,
                      promptText: lastUserContent,
                    });
                  }
                }
              }
            }
          } catch {
            // Best-effort, silently fail
          }
        });

      return moonshineResult;
    }
  }

  // Tier 2: Echo fallback (guaranteed response)
  if (isExactSkymeshModel(request.model)) {
    const chain = attempts
      .map((a) => `${a.tier}:${a.status}(${a.ms}ms)`)
      .join(' → ');
    throw new Error(
      `Exact Skymesh model ${request.model} is unavailable; refusing echo fallback (chain: ${chain})`
    );
  }
  attempts.push({ tier: 'echo', status: 'ok', ms: 0 });
  const echoChain = attempts
    .map((a) => `${a.tier}:${a.status}(${a.ms}ms)`)
    .join(' → ');
  console.error(
    `[zedge] fell to ECHO for model=${request.model} | chain: ${echoChain}`
  );
  logInference(`model=${request.model} tier=echo FALLBACK chain: ${echoChain}`);
  return {
    tier: 'echo',
    response: echoFallback(request),
    upstreamHeaders: {},
    attempts,
  };
}

/**
 * Auto-learn from a completed inference interaction.
 * Extracts learnable information and stores as engrams.
 * Called by server.ts after successful chat completions.
 */
export function autoLearnFromInference(
  request: ChatCompletionRequest,
  responseContent: string,
  tier: string
): void {
  queueMicrotask(async () => {
    try {
      const { getEngramStore } = await import('./engram-store.ts');
      const store = getEngramStore();

      const lastUserMsg = [...request.messages]
        .reverse()
        .find((m) => m.role === 'user');
      if (!lastUserMsg || lastUserMsg.content.length < 20) return;

      // Extract file paths mentioned in the conversation
      const filePathMatch = lastUserMsg.content.match(
        /(?:[\w./\\-]+\.(?:ts|js|py|rs|go|tsx|jsx|css|html|gg))/
      );
      if (filePathMatch) {
        void store.remember({
          type: 'file-relationship',
          content: `User asked about ${
            filePathMatch[0]
          }: ${lastUserMsg.content.slice(0, 200)}`,
          filePath: filePathMatch[0],
        });
      }

      // If response contains code patterns, store as code-pattern
      if (
        responseContent.includes('function ') ||
        responseContent.includes('class ') ||
        responseContent.includes('export ')
      ) {
        void store.remember({
          type: 'code-pattern',
          content: `Pattern discussed (tier: ${tier}): ${responseContent.slice(
            0,
            300
          )}`,
        });
      }

      // If multi-turn, store conversation summary
      if (request.messages.length >= 6) {
        const summary = request.messages
          .filter((m) => m.role === 'user')
          .map((m) => m.content.slice(0, 100))
          .join(' | ');
        void store.remember({
          type: 'conversation-summary',
          content: `Multi-turn conversation (${
            request.messages.length
          } msgs): ${summary.slice(0, 400)}`,
        });
      }
    } catch {
      // Auto-learning is best-effort
    }
  });
}

/**
 * Get merged model list from moonshine container + local catalog
 */
/** Fetches the model list reported by the Moonshine OpenAI-compatible server. */
async function fetchRemoteModels(timeoutMs = 5_000): Promise<ModelInfo[]> {
  try {
    const resp = await fetch(`${MOONSHINE_BASE_URL}/v1/models`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!resp.ok) return [];
    const data = (await resp.json()) as { data?: ModelInfo[] };
    if (Array.isArray(data.data)) return data.data;
  } catch {
    // Moonshine container not running -- return empty
  }
  return [];
}

/**
 * Handles the zedge get Live Moonshine Models workflow.
 */
export async function getLiveMoonshineModels(
  timeoutMs = 5_000
): Promise<ModelInfo[]> {
  return await fetchRemoteModels(timeoutMs);
}

/**
 * Handles the zedge get Live Moonshine Runtime Health workflow.
 */
export async function getLiveMoonshineRuntimeHealth(
  timeoutMs = 5_000
): Promise<{
  models: ModelInfo[];
  openAi: {
    ready: boolean;
    status?: string;
    model?: string;
    hiddenDim?: number;
    vocabSize?: number;
    layers?: string;
    runtimeMatches?: boolean;
    error?: string;
  };
  fatStation: {
    ready: boolean;
    status?: string;
    layers?: string;
    hiddenDim?: number;
    vocabSize?: number;
    error?: string;
  };
}> {
  const numberField = (
    body: Record<string, unknown>,
    key: string
  ): number | undefined => {
    const value = body[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string') {
      const parsed = Number.parseInt(value, 10);
      return Number.isFinite(parsed) ? parsed : undefined;
    }
    return undefined;
  };
  const normalizeLayers = (layers: unknown): string | undefined =>
    typeof layers === 'string' ? layers.trim().replace('..', '-') : undefined;

  const [models, openAi, fatStation] = await Promise.all([
    fetchRemoteModels(timeoutMs),
    (async () => {
      try {
        const resp = await fetch(`${MOONSHINE_BASE_URL}/health`, {
          headers: { Accept: 'application/json' },
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!resp.ok) {
          return {
            ready: false,
            error: `Moonshine HTTP ${resp.status}`,
          };
        }
        const body = (await resp.json()) as Record<string, unknown>;
        return {
          ready: body['status'] === 'ok',
          status: typeof body['status'] === 'string' ? body['status'] : undefined,
          model: typeof body['model'] === 'string' ? body['model'] : undefined,
          hiddenDim: numberField(body, 'hidden_dim'),
          vocabSize: numberField(body, 'vocab_size'),
          layers: normalizeLayers(body['layers']),
        };
      } catch (error) {
        return {
          ready: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    })(),
    (async () => {
      try {
        const resp = await fetch(`${FAT_STATION_BASE_URL}/health`, {
          headers: { Accept: 'application/json' },
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!resp.ok) {
          return {
            ready: false,
            error: `fat-station HTTP ${resp.status}`,
          };
        }
        const body = (await resp.json()) as Record<string, unknown>;
        return {
          ready: body.status === 'ok',
          status: typeof body['status'] === 'string' ? body['status'] : undefined,
          layers: normalizeLayers(body['layers']),
          hiddenDim: numberField(body, 'hidden_dim'),
          vocabSize: numberField(body, 'vocab_size'),
        };
      } catch (error) {
        return {
          ready: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    })(),
  ]);

  const runtimeMatches =
    openAi.ready &&
    fatStation.ready &&
    openAi.hiddenDim !== undefined &&
    openAi.hiddenDim === fatStation.hiddenDim &&
    openAi.vocabSize !== undefined &&
    openAi.vocabSize === fatStation.vocabSize &&
    openAi.layers !== undefined &&
    openAi.layers === fatStation.layers;

  return { models, openAi: { ...openAi, runtimeMatches }, fatStation };
}

/** Refreshes the cached Moonshine model catalog immediately. */
async function refreshRemoteModelCatalog(timeoutMs = 5_000): Promise<void> {
  const models = await fetchRemoteModels(timeoutMs);
  cachedRemoteModels = models;
  remoteModelCatalogFetchedAt = Date.now();
}

/** Starts a non-blocking model catalog refresh when the cache is stale. */
function refreshRemoteModelCatalogInBackground(timeoutMs = 5_000): void {
  const now = Date.now();
  if (
    remoteModelCatalogRefreshPromise ||
    now - remoteModelCatalogFetchedAt < REMOTE_MODEL_CACHE_TTL_MS
  ) {
    return;
  }

  remoteModelCatalogRefreshPromise = refreshRemoteModelCatalog(timeoutMs)
    .catch(() => {
      remoteModelCatalogFetchedAt = Date.now();
    })
    .finally(() => {
      remoteModelCatalogRefreshPromise = null;
    });
}

/** Returns live Moonshine models, falling back to the built-in catalog offline. */
export async function getModels(
  options: { refresh?: boolean; refreshTimeoutMs?: number } = {}
): Promise<ModelInfo[]> {
  if (options.refresh === true) {
    await refreshRemoteModelCatalog(options.refreshTimeoutMs ?? 5_000);
  } else {
    refreshRemoteModelCatalogInBackground(options.refreshTimeoutMs ?? 1_000);
  }

  const models: ModelInfo[] = [];
  const seen = new Set<string>();
  const remoteModels = cachedRemoteModels.filter((model) =>
    isLiveModelVisible(model.id)
  );
  const sourceModels =
    remoteModels.length > 0
      ? remoteModels
      : getKnownZedgeModels().map((model): ModelInfo => ({
          id: model.id,
          object: 'model',
          owned_by: model.ownedBy,
        }));

  for (const model of sourceModels) {
    if (!seen.has(model.id)) {
      seen.add(model.id);
      models.push(model);
    }
  }

  return models;
}

/**
 * Generate embeddings via edge with local fallback
 *
 * If the edge endpoint is unavailable, generates embeddings locally using
 * an Aether-backed MiniLM runtime with a hash fallback.
 */
export async function embed(
  input: string | string[],
  model = 'text-embedding-3-small'
): Promise<Response> {
  if (!shouldUseLocalEmbeddingFallback(model)) {
    const baseUrl = getApiBaseUrl();

    // Try remote first for known edge-compatible embedding models.
    try {
      const resp = await fetch(`${baseUrl}/v1/embeddings`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...getAuthHeaders(),
        },
        body: JSON.stringify({ input, model }),
        signal: AbortSignal.timeout(10_000),
      });
      if (resp.ok) return resp;
    } catch {
      // Remote unavailable
    }
  }

  const inputs = Array.isArray(input) ? input : [input];
  const embeddings = await Promise.all(
    inputs.map((text) => aetherLocalRuntime.embed(text))
  );
  const data = embeddings.map((embedding, index) => ({
    object: 'embedding',
    embedding,
    index,
  }));

  return new Response(
    JSON.stringify({
      object: 'list',
      data,
      model: aetherLocalRuntime.localEmbeddingModelId,
      usage: {
        prompt_tokens: inputs.reduce((a, t) => a + Math.ceil(t.length / 4), 0),
        total_tokens: inputs.reduce((a, t) => a + Math.ceil(t.length / 4), 0),
      },
    }),
    { headers: { 'Content-Type': 'application/json' } }
  );
}
