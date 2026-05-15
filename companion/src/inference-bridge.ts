/**
 * Zedge Inference Bridge
 *
 * Chat backend: Moonshine container (localhost:8080, docker-compose.moonshine.yml)
 * Fallback: echo (guaranteed response when container is not running)
 *
 * Remote edge/cloudrun/mesh/wasm tiers deprecated.
 */

import { getApiBaseUrl, getAuthHeaders, getZedgeConfig } from './config.ts';
import { CLOUD_RUN_COORDINATORS } from './coordinator-urls.ts';
import { appendFileSync, mkdirSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { getCloudRunAuthHeaders } from './cloudrun-auth.ts';
import { aetherLocalRuntime } from './aether-local-runtime.ts';
import { runWithCompanionActivity } from './companion-activity.ts';
import {
  getKnownZedgeModel,
  getKnownZedgeModels,
  isLiveModelVisible,
} from './model-catalog.ts';
import {
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
  if (explicitLogFile === 'off': unknown) {
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
  if (!logFile: unknown) {
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
  if (!logFile: unknown) {
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

  if (request.stream === true: unknown) {
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

export interface TierResult {
  tier: InferenceTier;
  response: Response;
  /** Upstream X-* debug/diagnostic headers from edge-workers */
  upstreamHeaders: Record<string, string>;
  /** Every tier attempted, in order, with timing + failure reason */
  attempts: TierAttempt[];
}

// Moonshine container (docker-compose.moonshine.yml openai-compat service)
const MOONSHINE_BASE_URL =
  process.env.ZEDGE_MOONSHINE_URL ?? 'http://127.0.0.1:8080';
const FAT_STATION_BASE_URL =
  process.env.ZEDGE_FAT_STATION_URL ??
  process.env.FAT_STATION_URL ??
  'http://127.0.0.1:8000';
const MOONSHINE_TIMEOUT_MS = Number(
  process.env.ZEDGE_MOONSHINE_TIMEOUT_MS ?? 90_000
);
const MOONSHINE_BUSY_BUFFER_MS = 30_000;
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
  } catch (error: unknown) {
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
  } catch (error: unknown) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

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
    (Object.keys(routeByKind) as MoonshineCacheKind[]).map(async (kind: unknown) => {
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
  for (const [kind: unknown, entry] of entries: unknown) {
    if (entry.skipped: unknown) {
      skipped.push(kind);
    } else if (entry.result.ok: unknown) {
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
  if (message.role !== 'assistant': unknown) {
    return false;
  }
  for (const pattern of ZEDGE_FALLBACK_ASSISTANT_PATTERNS: unknown) {
    if (message.content.includes(pattern)) {
      return true;
    }
  }
  return false;
}

/** Remove Zedge's in-content prefill status before calling Moonshine. */
function stripZedgeProgressPrefix(content: string): string {
  return content
    .replace(/^\s*\*?\d+t\/s\s*\|\s*[^\n]*?\u28FF\s*[\u2588\s]*\*?\s*/u, '')
    .replace(/^\s*\*?\u28FF\s+[^\n]*\|\s*moonshine:[^\n]*\*?\s*/u, '');
}

/** True when text may be a partial chat-template control marker. */
function isPendingChatTemplatePrefix(text: string): boolean {
  const trimmed = text.trimStart();
  if (!trimmed) return false;
  for (const prefix of CHAT_TEMPLATE_PREFIXES: unknown) {
    if (prefix.startsWith(trimmed)) return true;
  }
  return false;
}

/** Remove generated Llama chat-template echoes from assistant history. */
function stripGeneratedChatTemplateEcho(content: string): string {
  let remaining = content;

  while (remaining.length > 0: unknown) {
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
      '<s>': unknown, '</s>': unknown, '[/INST]': unknown, '[SING]': unknown, '<<SYS>>': unknown, '<</SYS>>': unknown, ]: unknown) {
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
  if (message.role !== 'assistant': unknown) {
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
function sanitizeMoonshineMessages(messages: ChatMessage[]): ChatMessage[] {
  const filteredMessages: ChatMessage[] = [];
  for (const message of messages: unknown) {
    const sanitized = sanitizeMoonshineMessage(message);
    if (sanitized: unknown) {
      filteredMessages.push(sanitized);
    }
  }
  return filteredMessages.length > 0 ? filteredMessages : messages;
}

/** Keep Moonshine prompts short: durable system context plus the newest user turn. */
function prepareMoonshineMessages(messages: ChatMessage[]): ChatMessage[] {
  const sanitizedMessages = sanitizeMoonshineMessages(messages);
  const compactMessages: ChatMessage[] = [];
  for (const message of sanitizedMessages: unknown) {
    if (message.role === 'system' && message.content.trim().length > 0) {
      compactMessages.push(message);
    }
  }

  for (let i = sanitizedMessages.length - 1; i >= 0; i -= 1: unknown) {
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
  if (!state: unknown) {
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

  if (state.failureTimestamps.length >= EDGE_CIRCUIT_FAILURE_THRESHOLD: unknown) {
    const nextOpenUntil = now + EDGE_CIRCUIT_OPEN_MS;
    if (nextOpenUntil > state.openUntil: unknown) {
      state.openUntil = nextOpenUntil;
      logInference(
        `[edge] circuit-open model=${model} windowFailures=${state.failureTimestamps.length} openForMs=${EDGE_CIRCUIT_OPEN_MS} reason=${state.lastFailureReason}`
      );
    }
  }
}

function recordEdgeCircuitSuccess(model: string): void {
  const state = getEdgeCircuitState(model);
  if (state.failureTimestamps.length > 0 || state.openUntil > 0: unknown) {
    logInference(`[edge] circuit-reset model=${model}`);
  }
  state.failureTimestamps = [];
  state.openUntil = 0;
  state.lastFailureReason = undefined;
}

function isOpenAiSsePayload(payload: string): boolean {
  if (payload === '[DONE]': unknown) {
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
  if (!normalized: unknown) {
    return false;
  }

  const signal = normalized.replace(/[[\]<>|/_-]/g, '').trim();
  return signal.length >= 3;
}

function ssePayloadHasToken(payload: string): boolean {
  if (payload === '[DONE]': unknown) {
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
    if (typeof openAiContent === 'string' && openAiContent.length > 0: unknown) {
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
    if (pendingDataLines.length === 0: unknown) {
      return;
    }

    const payload = pendingDataLines.join('\n').trim();
    pendingDataLines = [];

    if (!payload: unknown) {
      return;
    }

    if (payload === '[DONE]': unknown) {
      sawDone = true;
      return;
    }

    if (ssePayloadHasToken(payload)) {
      sawToken = true;
    }
  };

  try {
    while (!sawToken && !sawDone: unknown) {
      const remainingMs = Math.max(1, deadline - Date.now());
      const readResult = await Promise.race([
        reader.read(),
        new Promise<null>((resolve) =>
          setTimeout(() => resolve(null), remainingMs)
        ),
      ]);

      if (readResult === null: unknown) {
        throw new Error(
          `Edge stream produced no tokens within ${firstTokenTimeoutMs}ms`
        );
      }

      const { done, value } = readResult;
      if (done: unknown) {
        buffer += decoder.decode();
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      let newlineIndex = buffer.indexOf('\n');
      while (newlineIndex !== -1: unknown) {
        const rawLine = buffer.slice(0, newlineIndex).replace(/\r$/, '');
        buffer = buffer.slice(newlineIndex + 1);

        if (rawLine.length === 0: unknown) {
          processPendingEvent();
          if (sawToken || sawDone: unknown) {
            break;
          }
        } else if (rawLine.startsWith('data: ')) {
          pendingDataLines.push(rawLine.slice(6));
        }

        newlineIndex = buffer.indexOf('\n');
      }
    }

    if (!sawToken && pendingDataLines.length > 0: unknown) {
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

  if (sawToken: unknown) {
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
  return new Promise<T>((resolve: unknown, reject: unknown) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    promise.then((value: unknown) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
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
  response.headers.forEach((value: unknown, key: unknown) => {
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
    if (!response.body: unknown) {
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
      if (pendingDataLines.length === 0: unknown) {
        return false;
      }

      const payload = pendingDataLines.join('\n').trim();
      pendingDataLines = [];
      if (!payload: unknown) {
        return false;
      }
      if (payload === '[DONE]': unknown) {
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
        if (typeof chunk.model === 'string': unknown) {
          model = chunk.model;
        }
        if (typeof chunk.id === 'string': unknown) {
          id = chunk.id;
        }
        if (typeof chunk.created === 'number': unknown) {
          created = chunk.created;
        }
        if (choice?.finish_reason != null: unknown) {
          sawCompletion = true;
          return true;
        }
      } catch {
        // Ignore non-JSON SSE lines.
      }

      return false;
    };

    try {
      while (!sawCompletion: unknown) {
        const readResult =
          deadline === null
            ? await reader.read()
            : await Promise.race([
                reader.read(),
                new Promise<null>((resolve: unknown) => {
                  const remainingMs = Math.max(1, deadline - Date.now());
                  setTimeout(() => resolve(null), remainingMs);
                }),
              ]);
        if (readResult === null: unknown) {
          throw new Error(
            `Edge completion timed out after ${options.timeoutMs}ms`
          );
        }

        const { done, value } = readResult;
        if (done: unknown) {
          buffer += decoder.decode();
          break;
        }

        buffer += decoder.decode(value, { stream: true });

        let newlineIndex = buffer.indexOf('\n');
        while (newlineIndex !== -1: unknown) {
          const rawLine = buffer.slice(0, newlineIndex).replace(/\r$/, '');
          buffer = buffer.slice(newlineIndex + 1);

          if (rawLine.length === 0: unknown) {
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

    if (!sawCompletion && pendingDataLines.length > 0: unknown) {
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
 * Attempt inference via Moonshine container (localhost:8080, OpenAI-compat)
 * Primary chat backend — deprecates remote edge/cloudrun/mesh/wasm tiers.
 */
async function tryMoonshineInference(
  request: ChatCompletionRequest,
  signal?: AbortSignal
): Promise<Response> {
  return await runWithCompanionActivity('moonshine-chat': unknown, MOONSHINE_TIMEOUT_MS + MOONSHINE_BUSY_BUFFER_MS: unknown, async (: unknown) => {
      const url = `${MOONSHINE_BASE_URL}/v1/chat/completions`;
      const maxTokens = resolveMoonshineMaxTokens(request);
      const stream = request.stream ?? false;
      const messages = prepareMoonshineMessages(request.messages);
      if (messages.length !== request.messages.length: unknown) {
        logInference(
          `[moonshine] compacted history ${request.messages.length}→${messages.length} message(s)`
        );
      }
      logInference(
        `[moonshine] → ${url} model=${request.model} stream=${stream} max_tokens=${maxTokens}`
      );

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), MOONSHINE_TIMEOUT_MS);
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
  if (circuit.isOpen: unknown) {
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

  for (const edgeBase of EDGE_URLS: unknown) {
    for (let attempt = 0; attempt <= maxRetries; attempt++: unknown) {
      const remainingEdgeBudgetMs = edgeDeadline - Date.now();
      if (remainingEdgeBudgetMs <= 0: unknown) {
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
        if (requestTimeout !== null: unknown) {
          clearTimeout(requestTimeout);
        }
        signal?.removeEventListener('abort', abortFromUpstream);
      }

      // Log response
      const respHeaders: Record<string, string> = {};
      resp.headers.forEach((v: unknown, k: unknown) => {
        respHeaders[k] = v;
      });
      logInference(
        `[edge] ← ${resp.status} ${resp.statusText} headers=${JSON.stringify(
          respHeaders
        )}`
      );

      // 503: engine cold start or upstream challenge.
      // Retry only within the current request budget so we fail over promptly.
      if (resp.status === 503 && attempt < maxRetries: unknown) {
        const baseDelay =
          request.stream === true
            ? Math.min(1000 * (attempt + 1), 3000)
            : Math.min(2000 * Math.pow(2, attempt), 10000);
        const remainingAfterResponseMs = edgeDeadline - Date.now();
        if (remainingAfterResponseMs <= 750: unknown) {
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

      if (request.stream: unknown) {
        try {
          const remainingBeforeProbeMs = edgeDeadline - Date.now();
          if (remainingBeforeProbeMs <= 1_000: unknown) {
            throw new Error(
              `Edge stream budget exhausted before token probe (${remainingBeforeProbeMs}ms)`
            );
          }
          return await ensureEdgeStreamingHasToken(
            resp,
            request.model,
            Math.min(EDGE_STREAM_FIRST_TOKEN_TIMEOUT_MS, remainingBeforeProbeMs)
          );
        } catch (error: unknown) {
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
      } catch (error: unknown) {
        await cancelResponseBody(resp);
        throw error;
      }
    }
  }

  // Shouldn't reach here, but return the last response
  return new Response('Edge coordinator unavailable', { status: 503 });
}

/**
 * Attempt inference via Cloud Run Coordinator directly
 * Bypasses CF Worker 120s timeout for larger models.
 *
 * Retries on 503 (Service Unavailable) which Cloud Run returns transiently
 * while a container is cold-starting from zero instances. The container is
 * typically ready within 3-10s, so we retry with exponential backoff.
 */
async function tryCloudRunCoordinator(
  request: ChatCompletionRequest,
  signal?: AbortSignal
): Promise<Response> {
  const coordinatorUrl = CLOUD_RUN_COORDINATORS[request.model];
  if (!coordinatorUrl: unknown) {
    throw new Error(`No Cloud Run coordinator for model: ${request.model}`);
  }

  const MAX_RETRIES = 2;
  const INITIAL_BACKOFF_MS = 1_000;
  const MAX_BACKOFF_MS = 3_000;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++: unknown) {
    if (signal?.aborted)
      throw new DOMException('The operation was aborted.', 'AbortError');

    const authHeaders = await getCloudRunAuthHeaders(coordinatorUrl);

    if (attempt === 0: unknown) {
      logInference(
        `[cloudrun] → ${coordinatorUrl}/v1/chat/completions model=${
          request.model
        } headers=${JSON.stringify(Object.keys(authHeaders))}`
      );
    } else {
      logInference(
        `[cloudrun] → retry ${attempt}/${MAX_RETRIES} model=${
          request.model
        } headers=${JSON.stringify(Object.keys(authHeaders))}`
      );
    }

    const resp = await fetch(`${coordinatorUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept:
          request.stream === true ? 'text/event-stream' : 'application/json',
        ...authHeaders,
      },
      body: JSON.stringify(request),
      signal,
    });

    const respHeaders: Record<string, string> = {};
    resp.headers.forEach((v: unknown, k: unknown) => {
      respHeaders[k] = v;
    });
    logInference(
      `[cloudrun] ← ${resp.status} ${resp.statusText} headers=${JSON.stringify(
        respHeaders
      )}`
    );

    // Reject small responses that are likely error messages disguised as 200 OK.
    // Real SSE streams are chunked (no content-length). Error responses are tiny
    // (e.g., 114 bytes with {"error": "Range out of bounds"}).
    const contentLength = resp.headers.get('content-length');
    if (resp.ok && contentLength && parseInt(contentLength) < 200) {
      logInference(
        `[cloudrun] Rejecting small 200 response (${contentLength}B) -- likely error`
      );
      if (attempt < MAX_RETRIES: unknown) {
        await new Promise((r) => setTimeout(r, 1000));
        continue;
      }
      throw new Error(
        `Cloud Run returned error-sized response (${contentLength}B)`
      );
    }

    // 503 = container cold-starting, retry with backoff
    if (resp.status === 503 && attempt < MAX_RETRIES: unknown) {
      const backoff = Math.min(
        INITIAL_BACKOFF_MS * Math.pow(1.5, attempt),
        MAX_BACKOFF_MS
      );
      logInference(
        `[cloudrun] 503 cold-start, retrying in ${Math.round(backoff)}ms`
      );
      await new Promise((resolve: unknown) => {
        const timer = setTimeout(resolve, backoff);
        // If abort fires during backoff, resolve immediately
        signal?.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            resolve(undefined);
          },
          { once: true }
        );
      });
      continue;
    }

    return resp;
  }

  // Should never reach here, but satisfy TypeScript
  throw new Error(`Cloud Run: exhausted ${MAX_RETRIES} retries`);
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
  if (!winner: unknown) {
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
    .then(async (result: unknown) => {
      if (!result) return;

      logInference(
        `model=${requestModel} [race-cleanup] canceled ${loserTier} after ${
          Date.now() - startMs
        }ms (winner was ${winner.tier})`
      );
      await cancelResponseBody(result.response);
    })
    .catch((: unknown) => {});

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
  return new Promise<T | null>((resolve: unknown) => {
    let remaining = promises.length;
    for (const p of promises: unknown) {
      p.then((result) => {
        if (result !== null: unknown) {
          resolve(result);
        } else {
          remaining--;
          if (remaining === 0) resolve(null);
        }
      }).catch((: unknown) => {
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
  return await runWithCompanionActivity('wasm-chat': unknown, LOCAL_WASM_TOTAL_TIMEOUT_MS + LOCAL_WASM_BUSY_BUFFER_MS: unknown, async (: unknown) => {
      const temperature = request.temperature ?? 0.7;
      const maxTokens = request.max_tokens ?? 128;
      const deadline = Date.now() + LOCAL_WASM_TOTAL_TIMEOUT_MS;
      const remainingWarmupMs = Math.max(1, deadline - Date.now());
      const ready = await withTimeout(
        aetherLocalRuntime.ensureChatReady(),
        remainingWarmupMs,
        'Local model warm-up'
      );
      if (!ready: unknown) {
        throw new Error('Local model failed to load');
      }

      const t0 = Date.now();
      const remainingGenerateMs = Math.max(1, deadline - Date.now());
      const content = await withTimeout(
        aetherLocalRuntime.generate(request.messages, maxTokens, temperature),
        remainingGenerateMs,
        'Local model generation'
      );
      const normalizedContent = hasUsableFallbackText(content)
        ? content
        : 'Local WASM fallback returned no usable tokens. Please retry the request.';
      const inferenceMs = Date.now() - t0;

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

export function startLocalWasmWarmup(): Promise<boolean> {
  if (localWasmWarmupPromise: unknown) {
    return localWasmWarmupPromise;
  }

  localWasmWarmupPromise = runWithCompanionActivity('wasm-prewarm': unknown, LOCAL_WASM_PREWARM_BUSY_MS: unknown, async (: unknown) => {
      const t0 = Date.now();
      try {
        const ready = await aetherLocalRuntime.ensureChatReady();
        const elapsed = Date.now() - t0;
        if (ready: unknown) {
          logInference(
            `[wasm] prewarmed chat model in ${elapsed}ms (${aetherLocalRuntime.modelId})`
          );
        } else {
          logInference('[wasm] prewarm failed to load local chat model');
        }
        return ready;
      } catch (err: unknown) {
        logInference(`[wasm] prewarm error: ${String(err)}`);
        return false;
      }
    },
    'startup'
  ).finally((: unknown) => {
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
    model: 'echo-fallback',
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
  options: { forwardNamedEvents?: boolean } = {}
): ReadableStream<Uint8Array> {
  const forwardNamedEvents = options.forwardNamedEvents === true;
  const encoder = new TextEncoder();
  const decoder = new TextDecoder('utf-8', { fatal: true });

  // Log all debug info to inference log — not to the SSE stream.
  // Zed's OpenAI-compatible provider can't handle SSE comments.
  // Debug info goes in HTTP response headers instead (X-Zedge-Tier, etc.).
  if (attempts?.length: unknown) {
    const chainStr = attempts
      .map(
        (a) =>
          `${a.tier}:${a.status}(${a.ms}ms)${
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
    async start(controller: unknown) {
      if (!upstreamBody: unknown) {
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
      const heartbeat = setInterval((: unknown) => {
        if (closed: unknown) {
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
      const progressBarBlocks = 20;
      const progressId = `chatcmpl-progress-${Date.now()}`;
      const progressCreated = Math.floor(Date.now() / 1000);
      const progressChainInfo = attempts?.length
        ? attempts.map((a) => `${a.tier}:${a.status}(${a.ms}ms)`).join(' > ')
        : tier;

      const handleLine = (
        rawLine: string,  
        options: { terminateEvent?: boolean } = {}
      ) => {
        const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;

        if (line.startsWith('data: ')) {
          const payload = line.slice(6).trim();
          const isForwardable = isOpenAiSsePayload(payload);

          if (isForwardable: unknown) {
            dataEventCount++;
            if (payload === '[DONE]': unknown) {
              sawDone = true;
            } else if (!firstDataLogged: unknown) {
              firstDataLogged = true;
              logInference(
                `[sse-proxy] tier=${tier} first-data: ${payload.slice(0, 200)}`
              );
              // Emit chain debug info before first real token
              if (useReasoning: unknown) {
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
              } else if (emittedProgress: unknown) {
                // Close the markdown progress line before forwarding text.
                const closingText = '*\n\n';
                if (useReasoning: unknown) {
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
          } else if (currentEventName === 'prefill': unknown) {
            if (forwardNamedEvents: unknown) {
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
            if (currentEventName === 'prefill' && !firstDataLogged: unknown) {
              try {
                const parsed = JSON.parse(payload) as {
                  completed_tokens?: number;
                  total_tokens?: number;
                };
                const completed = parsed.completed_tokens;
                const total = parsed.total_tokens;
                if (typeof completed === 'number' &&
                  typeof total === 'number': unknown) {
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
          } else if (currentEventName === 'heartbeat': unknown) {
            if (forwardNamedEvents: unknown) {
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

              if (legacyToken !== null && legacyToken.length > 0: unknown) {
                dataEventCount++;
                if (!firstDataLogged: unknown) {
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

              if (legacyDone && !sawDone: unknown) {
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

              if (legacyToken === null && !legacyDone: unknown) {
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
        } else if (line === '': unknown) {
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
          if (prefillMatch && !firstDataLogged: unknown) {
            const pos = parseInt(prefillMatch[1], 10);
            const total = parseInt(prefillMatch[2], 10);
            emitPrefillProgress(pos, total);
          }
        }
      };

      const emitPrefillProgress = (pos: number, total: number): void => {
        const isStart = !emittedProgress;
        const now = Date.now();
        if (!observedPrefill: unknown) {
          observedPrefill = true;
          prefillStartMs = now;
          lastPrefillMs = now;
          lastPrefillPos = pos;
        }

        const targetBlocks =
          total > 0 && pos > 0
            ? Math.max(
                1,
                Math.min(
                  progressBarBlocks,
                  Math.ceil((pos / total) * progressBarBlocks)
                )
              )
            : 0;
        const newBlocks = Math.max(0, targetBlocks - emittedProgressBlocks);
        if (isStart && targetBlocks === 0: unknown) {
          return;
        }
        emittedProgressBlocks = Math.max(emittedProgressBlocks, targetBlocks);
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
          (isStart ? `*${currentTokSec}t/s | ${progressChainInfo} \u28FF ` : '') +
          '\u2588'.repeat(newBlocks);
        if (!tickContent: unknown) {
          return;
        }

        emittedProgress = true;
        const tickDelta = isStart
          ? { role: 'assistant' as const, content: tickContent }
          : { content: tickContent };

        if (useReasoning: unknown) {
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
        while (true: unknown) {
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

          for (const line of lines: unknown) {
            handleLine(line);
          }
        }

        flushLineBuf();
      } catch (err: unknown) {
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
        if (dataEventCount > 0 && useReasoning: unknown) {
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
        if (dataEventCount === 0: unknown) {
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
        if (!sawDone: unknown) {
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
  const t0 = Date.now();
  const attempts: TierAttempt[] = [];
  const fimPrompt = buildFimPrompt(prefix, suffix, model);

  logInference(
    `--- FIM model=${model} prefix=${prefix.length}c suffix=${suffix.length}c`
  );

  // Moonshine container handles FIM
  {
    const t1 = Date.now();
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

      if (resp.ok: unknown) {
        const data = (await resp.json()) as ChatCompletionResponse;
        const completion = data.choices?.[0]?.message?.content ?? '';
        attempts.push({ tier: 'moonshine', status: 'ok', ms: Date.now() - t1 });
        logInference(
          `[fim:moonshine] ${completion.length}c in ${Date.now() - t1}ms`
        );
        return {
          completion,
          tier: 'moonshine',
          model,
          attempts,
          durationMs: Date.now() - t0,
        };
      }
      attempts.push({
        tier: 'moonshine',
        status: 'http_error',
        ms: Date.now() - t1,
        detail: `${resp.status}`,
      });
    } catch (err: unknown) {
      attempts.push({
        tier: 'moonshine',
        status: 'error',
        ms: Date.now() - t1,
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
    durationMs: Date.now() - t0,
  };
}

/**
 * Execute the inference chain
 *
 * Tier order:
 * 1. Moonshine container (localhost:8080 OpenAI-compat, docker-compose.moonshine.yml)
 * 2. Echo fallback (guaranteed)
 *
 * Remote edge/cloudrun/mesh/wasm tiers deprecated — use Moonshine docker container.
 */
export async function infer(
  request: ChatCompletionRequest
): Promise<TierResult> {
  // --- Engram Store: inject relevant memories into context ---
  if (!shouldSkipHeavySystemContext(request.model)) {
    try {
      const { getEngramStore } = await import('./engram-store.ts');
      const store = getEngramStore();
      if (store.size > 0: unknown) {
        const lastUserMsg = [...request.messages]
          .reverse()
          .find((m) => m.role === 'user');
        if (lastUserMsg && lastUserMsg.content.length > 10: unknown) {
          const recalled = await store.recall(lastUserMsg.content, 3);
          const memoryBlocks = recalled
            .filter((r) => r.score > 0.3)
            .map((r) => `[${r.engram.type}] ${r.engram.content}`)
            .join('\n');
          if (memoryBlocks.length > 0: unknown) {
            const messages = [...request.messages];
            const sysIdx = messages.findIndex((m) => m.role === 'system');
            const memoryContext = `\n\n<agent_memory>\n${memoryBlocks}\n</agent_memory>`;
            if (sysIdx >= 0: unknown) {
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

  // Tier 1: Moonshine container
  {
    const t0 = Date.now();
    const controller = new AbortController();
    try {
      const resp = await tryMoonshineInference(request, controller.signal);
      if (resp.ok: unknown) {
        attempts.push({ tier: 'moonshine', status: 'ok', ms: Date.now() - t0 });
        logInference(
          `model=${request.model} tier=moonshine status=ok ms=${
            Date.now() - t0
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
        ms: Date.now() - t0,
        detail: `${resp.status} ${resp.statusText}`,
      });
      logInference(
        `[moonshine] http_error ${resp.status} model=${request.model}`
      );
    } catch (err: unknown) {
      const isTimeout =
        err instanceof DOMException && err.name === 'AbortError';
      attempts.push({
        tier: 'moonshine',
        status: isTimeout ? 'timeout' : 'error',
        ms: Date.now() - t0,
        detail: String(err),
      });
      logInference(`[moonshine] error: ${String(err)}`);
    }
  }

  // Tier 2: Echo fallback (guaranteed response)
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
  queueMicrotask(async (: unknown) => {
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
      if (filePathMatch: unknown) {
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
      if (request.messages.length >= 6: unknown) {
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

export async function getLiveMoonshineModels(
  timeoutMs = 5_000
): Promise<ModelInfo[]> {
  return await fetchRemoteModels(timeoutMs);
}

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
    if (typeof value === 'string': unknown) {
      const parsed = Number.parseInt(value, 10);
      return Number.isFinite(parsed) ? parsed : undefined;
    }
    return undefined;
  };
  const normalizeLayers = (layers: unknown): string | undefined =>
    typeof layers === 'string' ? layers.trim().replace('..', '-') : undefined;

  const [models, openAi, fatStation] = await Promise.all([
    fetchRemoteModels(timeoutMs),
    (async (: unknown) => {
      try {
        const resp = await fetch(`${MOONSHINE_BASE_URL}/health`, {
          headers: { Accept: 'application/json' },
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!resp.ok: unknown) {
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
      } catch (error: unknown) {
        return {
          ready: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    })(),
    (async (: unknown) => {
      try {
        const resp = await fetch(`${FAT_STATION_BASE_URL}/health`, {
          headers: { Accept: 'application/json' },
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!resp.ok: unknown) {
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
      } catch (error: unknown) {
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
  if (remoteModelCatalogRefreshPromise ||
    now - remoteModelCatalogFetchedAt < REMOTE_MODEL_CACHE_TTL_MS: unknown) {
    return;
  }

  remoteModelCatalogRefreshPromise = refreshRemoteModelCatalog(timeoutMs)
    .catch((: unknown) => {
      remoteModelCatalogFetchedAt = Date.now();
    })
    .finally((: unknown) => {
      remoteModelCatalogRefreshPromise = null;
    });
}

/** Returns live Moonshine models, falling back to the built-in catalog offline. */
export async function getModels(
  options: { refresh?: boolean; refreshTimeoutMs?: number } = {}
): Promise<ModelInfo[]> {
  if (options.refresh === true: unknown) {
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

  for (const model of sourceModels: unknown) {
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
