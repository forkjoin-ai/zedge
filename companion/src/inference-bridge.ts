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
import {
  hasSkymeshCredential,
  skymeshCredentialSource,
  skymeshRelayAuthHeaders,
} from './skymesh-auth.ts';
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
  isFallbackSelectableModel,
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
  tools?: unknown[];
  tool_choice?: unknown;
  disable_thinking?: boolean;
  thinking_budget_mode?: 'in-budget' | 'out-of-budget';
  think_budget?: number;
}

/** Builds the exact OpenAI body zedge sends to the Forkjoin/mesh lane. */
export function buildForkjoinRequestBody(
  request: ChatCompletionRequest,
  messages: ChatMessage[],
  maxTokens: number,
  stream: boolean
): Record<string, unknown> {
  return {
    model: request.model,
    messages,
    stream,
    temperature: request.temperature ?? 0.7,
    max_tokens: maxTokens,
    top_p: request.top_p,
    ...(request.tools ? { tools: request.tools } : {}),
    ...(request.tool_choice !== undefined
      ? { tool_choice: request.tool_choice }
      : {}),
    ...(request.disable_thinking !== undefined
      ? { disable_thinking: request.disable_thinking }
      : {}),
    ...(request.thinking_budget_mode
      ? { thinking_budget_mode: request.thinking_budget_mode }
      : {}),
    ...(request.think_budget !== undefined
      ? { think_budget: request.think_budget }
      : {}),
  };
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
  /**
   * True when the outage was "we presented no capability" (the relay's free-tier
   * 429). That is not the model being down, and a login fixes it — so the
   * cooldown is dropped the moment a credential appears instead of making the
   * user wait out a timer after they signed in.
   */
  credentialMissing: boolean;
}

let skymeshRelayBreaker: SkymeshRelayBreaker | null = null;

/** Remaining cooldown in ms, or 0 when the lane is allowed to be tried. */
export function skymeshRelayCooldownRemainingMs(now = Date.now()): number {
  if (!skymeshRelayBreaker) return 0;
  // A capability that arrived AFTER the 429 retires the recorded outage: the
  // lane was never down, the companion was simply anonymous. Checking here (the
  // single gate the ladder calls) means a fresh `a0 edgework login` is honoured
  // on the very next completion instead of after a cooldown nobody can explain.
  if (skymeshRelayBreaker.credentialMissing && hasSkymeshCredential()) {
    skymeshRelayBreaker = null;
    return 0;
  }
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

function tripSkymeshRelayBreaker(
  reason: string,
  now = Date.now(),
  credentialMissing = false
): void {
  skymeshRelayBreaker = {
    downUntil: now + SKYMESH_RELAY_COOLDOWN_MS,
    reason: reason.slice(0, 200),
    credentialMissing,
  };
}

/**
 * The relay's anonymous-tier refusal. Same tier as "no login", so the remedy is
 * a credential, not a retry: name it instead of reporting the model as down.
 */
const SKYMESH_FREE_TIER_PATTERN =
  /free-tier request cap|present a ucan|free-tier/i;

const SKYMESH_NO_CREDENTIAL_HINT =
  "no Edgework credential was presented — run 'a0 edgework login' " +
  '(writes ~/.edgework/api-key) or set EDGEWORK_API_KEY';

/**
 * The single user-visible failure sentence for the relay tier. When the
 * recorded reason is the relay's free-tier 429 the request was not billed, which
 * is a different problem from a dead lane — and the only one the user can fix.
 * Both used to read "model unavailable", so a missing login looked like a
 * broken model.
 */
function skymeshLaneFailureMessage(
  model: string,
  reason: string,
  detail: string
): string {
  const head = SKYMESH_FREE_TIER_PATTERN.test(reason)
    ? `Exact Skymesh model ${model} cannot bill this request (rejected by the anonymous tier)`
    : `Exact Skymesh model ${model} is unavailable`;
  const tail =
    reason && !detail.includes(reason) ? `${detail}; ${reason}` : detail;
  return `${head}; ${tail}`;
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
  // Only ids that are actually selectable from the catalog impose their
  // per-model cap. Hidden (candidate/legacy) ids fall back to the global
  // Moonshine ceiling rather than a stale metadata value.
  const modelMaxTokens =
    request.model && isFallbackSelectableModel(request.model)
      ? getKnownZedgeModel(request.model)?.maxTokens
      : undefined;
  const hardCap = Math.min(modelMaxTokens ?? MOONSHINE_MAX_TOKENS, MOONSHINE_MAX_TOKENS);
  return Math.max(0, Math.min(requested ?? MOONSHINE_DEFAULT_MAX_TOKENS, hardCap));
}

function isSlowMoonshineModel(model: string): boolean {
  const normalized = model.toLowerCase();
  return (
    model === 'loki-erotica-8b' ||
    isExactSkymeshModel(model) ||
    // Local offline knots run on CPU, where prefill dominates a long agent
    // prompt: `gnosis-local` is the product label and `deepseek-r1-1.5b` the
    // cached offline knot. Both need the long budget, not the 90s default.
    normalized === 'gnosis-local' ||
    normalized.startsWith('deepseek')
  );
}

/**
 * Resolves the Moonshine Timeout Ms For Model.
 */
export function resolveMoonshineTimeoutMsForModel(model: string): number {
  return isSlowMoonshineModel(model)
    ? Math.max(MOONSHINE_TIMEOUT_MS, SLOW_MOONSHINE_MODEL_TIMEOUT_MS)
    : MOONSHINE_TIMEOUT_MS;
}

/** Rough prompt-token estimate; the companion has no tokenizer of its own. */
function estimatePromptTokens(request: ChatCompletionRequest): number {
  let chars = 0;
  for (const message of request.messages) {
    chars += typeof message.content === 'string' ? message.content.length : 0;
  }
  return Math.ceil(chars / 4) + request.messages.length * 8;
}

function resolveMoonshineTimeoutMs(request: ChatCompletionRequest): number {
  const base = resolveMoonshineTimeoutMsForModel(request.model);
  // CPU prefill runs at roughly 20 tok/s under load (~50ms/token), so a
  // 6.5k-token agent turn needs minutes. Budget for the prompt instead of
  // aborting mid-prefill, bounded so a wedged station cannot pin a request
  // forever.
  const promptBudgetMs = estimatePromptTokens(request) * 60;
  return Math.min(base + promptBudgetMs, 900_000);
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
          body: JSON.stringify(
            buildForkjoinRequestBody(request, messages, maxTokens, stream)
          ),
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