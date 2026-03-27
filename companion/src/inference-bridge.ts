/**
 * Zedge Inference Bridge
 *
 * 5-tier inference chain (v1.0):
 * 1. LAN Mesh — P2P inference via discovered companion nodes (fastest, free)
 * 2. Edge Coordinator (CF Workers) — via OpenAI-compat endpoint
 * 3. Cloud Run Coordinator — direct HTTP (bypasses CF 120s timeout)
 * 4. Local WASM — on-device Aether-backed SmolLM2/MiniLM inference
 * 5. Echo fallback — guaranteed response acknowledging the message
 *
 * All inference is local/coordinator-based, zero paid AI.
 */

import { getApiBaseUrl, getAuthHeaders, getZedgeConfig } from './config.ts';
import {
  CLOUD_RUN_COORDINATORS,
  hasCloudRunCoordinatorForModel,
} from './coordinator-urls.ts';
import { appendFileSync, mkdirSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { getCloudRunAuthHeaders } from './cloudrun-auth.ts';
import { aetherLocalRuntime } from './aether-local-runtime.ts';
import { runWithCompanionActivity } from './companion-activity.ts';
import { getKnownZedgeModels } from './model-catalog.ts';
import {
  applySystemPromptBudget,
  shouldSkipHeavySystemContext,
} from './prompt-budget.ts';

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

export type InferenceTier = 'mesh' | 'edge' | 'cloudrun' | 'wasm' | 'echo';

function isExplicitLocalOnlyModel(model: string): boolean {
  return (
    model.startsWith('wasm-local') ||
    model.startsWith('echo-local') ||
    model.startsWith('local-only')
  );
}

function shouldUseLocalEmbeddingFallback(model: string): boolean {
  return isExplicitLocalOnlyModel(model) || !REMOTE_EMBEDDING_MODELS.has(model);
}

function getEdgeRequestTimeoutMs(
  request: ChatCompletionRequest
): number | null {
  if (request.stream !== true) {
    return EDGE_NON_STREAMING_TOTAL_TIMEOUT_MS;
  }

  if (request.model === 'tinyllama-1.1b') {
    return EDGE_NON_STREAMING_TOTAL_TIMEOUT_MS;
  }

  return null;
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

const LOCAL_WASM_TOTAL_TIMEOUT_MS = 45_000;
const LOCAL_WASM_BUSY_BUFFER_MS = 15_000;
const LOCAL_WASM_PREWARM_BUSY_MS = 5 * 60_000;
const EDGE_NON_STREAMING_TOTAL_TIMEOUT_MS = 25_000;
const EDGE_NON_STREAMING_COMPLETION_TIMEOUT_MS = 20_000;
const REMOTE_MODEL_CACHE_TTL_MS = 60_000;

let cachedRemoteModels: ModelInfo[] = [];
let remoteModelCatalogFetchedAt = 0;
let remoteModelCatalogRefreshPromise: Promise<void> | null = null;

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
  // Use /ai/communicate (Glossolalia MOA with GGUF streaming transformer).
  // Supports stream=true for real per-token SSE.
  const EDGE_URLS = [
    'https://edge.affectively.ai',
    baseUrl, // api.edgework.ai
  ];

  const MAX_RETRIES = 4;
  for (const edgeBase of EDGE_URLS) {
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      // Use /ai/communicate -- this is the Glossolalia MOA endpoint with full
      // GGUF transformer inference. Supports stream=true for real per-token SSE.
      const url = `${edgeBase}/ai/communicate`;
      const lastUserMsg =
        [...request.messages]
          .reverse()
          .find((message) => message.role === 'user')?.content ?? '';
      const lastMsg =
        request.messages[request.messages.length - 1]?.content ?? '';
      const communicateBody = {
        prompt: lastUserMsg || lastMsg,
        messages: request.messages,
        model: request.model,
        max_tokens: request.max_tokens ?? 128,
        temperature: request.temperature ?? 0.7,
        stream: true,
      };
      logInference(
        `[edge] → ${url} model=${request.model} stream=${communicateBody.stream} attempt=${attempt}`
      );

      const edgeSignalController = new AbortController();
      const abortFromUpstream = () => edgeSignalController.abort();
      signal?.addEventListener('abort', abortFromUpstream, { once: true });
      const edgeTimeoutMs = getEdgeRequestTimeoutMs(request);
      const requestTimeout =
        edgeTimeoutMs === null
          ? null
          : setTimeout(() => edgeSignalController.abort(), edgeTimeoutMs);

      let resp: Response;
      try {
        resp = await fetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify(communicateBody),
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

      // 503: engine cold start or bot challenge. Retry with backoff.
      // GGUF engine takes ~14s to init on cold start, so retry 4 times
      // with exponential backoff up to 15s between attempts.
      if (resp.status === 503 && attempt < MAX_RETRIES) {
        const baseDelay = Math.min(2000 * Math.pow(2, attempt), 15000);
        logInference(
          `[edge] 503 engine cold start, retrying in ${baseDelay}ms (attempt ${
            attempt + 1
          }/${MAX_RETRIES})...`
        );
        await new Promise((resolve) => setTimeout(resolve, baseDelay));
        continue;
      }

      if (!resp.ok) break; // Try next EDGE_URL

      if (request.stream) {
        return resp;
      }

      // Batch mode: normalize either JSON or unexpected SSE to OpenAI JSON.
      try {
        return await collapseEdgeStreamingResponse(resp, request.model, {
          timeoutMs: EDGE_NON_STREAMING_COMPLETION_TIMEOUT_MS,
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
  if (!coordinatorUrl) {
    throw new Error(`No Cloud Run coordinator for model: ${request.model}`);
  }

  const MAX_RETRIES = 2;
  const INITIAL_BACKOFF_MS = 1_000;
  const MAX_BACKOFF_MS = 3_000;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (signal?.aborted)
      throw new DOMException('The operation was aborted.', 'AbortError');

    const authHeaders = await getCloudRunAuthHeaders(coordinatorUrl);

    if (attempt === 0) {
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
    resp.headers.forEach((v, k) => {
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
      if (attempt < MAX_RETRIES) {
        await new Promise((r) => setTimeout(r, 1000));
        continue;
      }
      throw new Error(
        `Cloud Run returned error-sized response (${contentLength}B)`
      );
    }

    // 503 = container cold-starting, retry with backoff
    if (resp.status === 503 && attempt < MAX_RETRIES) {
      const backoff = Math.min(
        INITIAL_BACKOFF_MS * Math.pow(1.5, attempt),
        MAX_BACKOFF_MS
      );
      logInference(
        `[cloudrun] 503 cold-start, retrying in ${Math.round(backoff)}ms`
      );
      await new Promise((resolve) => {
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
    await body.cancel();
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

      const t0 = Date.now();
      const remainingGenerateMs = Math.max(1, deadline - Date.now());
      const content = await withTimeout(
        aetherLocalRuntime.generate(request.messages, maxTokens, temperature),
        remainingGenerateMs,
        'Local model generation'
      );
      const inferenceMs = Date.now() - t0;

      const promptTokens = request.messages.reduce(
        (acc, m) => acc + Math.ceil(m.content.length / 4),
        0
      );
      const completionTokens = Math.ceil(content.length / 4);

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
            message: { role: 'assistant', content },
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
  if (localWasmWarmupPromise) {
    return localWasmWarmupPromise;
  }

  localWasmWarmupPromise = runWithCompanionActivity(
    'wasm-prewarm',
    LOCAL_WASM_PREWARM_BUSY_MS,
    async () => {
      const t0 = Date.now();
      try {
        const ready = await aetherLocalRuntime.ensureChatReady();
        const elapsed = Date.now() - t0;
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
  const content = `I received your message, but Zedge could not start a usable inference tier. The local fallback also failed to start cleanly. Your message was: "${
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
  modelName?: string
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder('utf-8', { fatal: true });

  // Log all debug info to inference log — not to the SSE stream.
  // Zed's OpenAI-compatible provider can't handle SSE comments.
  // Debug info goes in HTTP response headers instead (X-Zedge-Tier, etc.).
  if (attempts?.length) {
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
      let lastPrefillPct = -1;
      let emittedProgress = false;
      let prefillStartMs = 0;
      let lastPrefillMs = 0;
      let lastPrefillPos = 0;
      const prefillTokSec: number[] = []; // tok/s at each checkpoint for sparkline
      const progressId = `chatcmpl-progress-${Date.now()}`;
      const progressCreated = Math.floor(Date.now() / 1000);

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
            } else if (!firstDataLogged) {
              firstDataLogged = true;
              logInference(
                `[sse-proxy] tier=${tier} first-data: ${payload.slice(0, 200)}`
              );
              // Emit chain debug info before first real token
              const chainInfo = attempts?.length
                ? attempts
                    .map((a) => `${a.tier}:${a.status}(${a.ms}ms)`)
                    .join(' > ')
                : tier;
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
                      delta: { reasoning_content: `[${chainInfo}]\n` },
                      finish_reason: null,
                    },
                  ],
                };
                enqueue(
                  encoder.encode(`data: ${JSON.stringify(debugChunk)}\n\n`)
                );
              } else if (emittedProgress) {
                // Close the sparkline with stats and italic marker
                const prefillMs = Date.now() - prefillStartMs;
                const avgTokSec =
                  prefillMs > 0 && lastPrefillPos > 0
                    ? Math.round((lastPrefillPos / prefillMs) * 1000)
                    : 0;
                const closingText = ` ${avgTokSec}t/s | ${chainInfo}*\n\n`;
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
          } else {
            logInference(
              `[sse-proxy] tier=${tier} filtered non-OpenAI data: ${payload.slice(
                0,
                100
              )}`
            );
          }
        } else if (line === '') {
          enqueue(encoder.encode('\n'));
        } else if (line.startsWith(':')) {
          // Log upstream comments (heartbeat, prefill) but don't forward raw
          logInference(
            `[sse-proxy] tier=${tier} upstream: ${line.slice(0, 100)}`
          );

          // Convert prefill progress into an append-friendly sparkline.
          // Each tick emits ONE character — the sparkline grows naturally
          // as SSE content deltas append. No replacement needed.
          // Result: `*⠿ ▁▃▅▇████▇▅ 450t/s*`
          const prefillMatch = line.match(/^: prefill (\d+)\/(\d+)/);
          if (prefillMatch && !firstDataLogged) {
            const sparks = '\u2581\u2582\u2583\u2584\u2585\u2586\u2587\u2588';
            const pos = parseInt(prefillMatch[1], 10);
            const total = parseInt(prefillMatch[2], 10);
            const isStart = !emittedProgress;
            const now = Date.now();
            if (isStart) {
              prefillStartMs = now;
              lastPrefillMs = now;
              lastPrefillPos = 0;
            }
            // Compute segment tok/s for this tick's spark height
            const segmentMs = now - lastPrefillMs;
            const segmentToks = pos - lastPrefillPos;
            let sparkChar = sparks[0]; // default lowest
            if (segmentMs > 0 && segmentToks > 0) {
              const tokSec = Math.round((segmentToks / segmentMs) * 1000);
              prefillTokSec.push(tokSec);
              // Scale spark: 0-500 t/s range mapped to spark index
              const idx = Math.min(
                sparks.length - 1,
                Math.round((tokSec / 500) * (sparks.length - 1))
              );
              sparkChar = sparks[idx];
            }
            lastPrefillMs = now;
            lastPrefillPos = pos;
            lastPrefillPct = Math.floor((pos / total) * 100);
            emittedProgress = true;

            // Build the delta content for this tick
            let tickContent: string;
            if (isStart) {
              // Open italic, braille spinner, first spark
              tickContent = `*\u28FF ` + sparkChar;
            } else {
              // Just append one more spark character
              tickContent = sparkChar;
            }

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
              enqueue(
                encoder.encode(`data: ${JSON.stringify(progressChunk)}\n\n`)
              );
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
              enqueue(
                encoder.encode(`data: ${JSON.stringify(progressChunk)}\n\n`)
              );
            }
          }
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
 * Skips the edge tier (latency penalty, no quality gain for short completions)
 * and races Cloud Run against local WASM in parallel. WASM gives instant ghost
 * text; Cloud Run upgrades quality if it arrives within the race window.
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

  // Tier 0: Try LAN mesh first (100ms timeout -- if no peer responds, fall through)
  {
    const meshT0 = Date.now();
    try {
      const { meshInfer, getMeshStatus } = await import('./p2p-mesh.ts');
      const status = getMeshStatus();
      if (status.running && status.peers.length > 0) {
        const meshResult = await Promise.race([
          meshInfer({
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
          }),
          new Promise<null>((resolve) => setTimeout(() => resolve(null), 100)),
        ]);
        if (meshResult && meshResult.content) {
          attempts.push({
            tier: 'mesh',
            status: 'ok',
            ms: Date.now() - meshT0,
          });
          logInference(
            `[fim:mesh] ${meshResult.content.length}c in ${
              Date.now() - meshT0
            }ms`
          );
          return {
            completion: meshResult.content,
            tier: 'mesh',
            model,
            attempts,
            durationMs: Date.now() - t0,
          };
        }
      }
      attempts.push({
        tier: 'mesh',
        status: 'skipped',
        ms: Date.now() - meshT0,
        detail: 'no peers or timeout',
      });
    } catch {
      attempts.push({
        tier: 'mesh',
        status: 'skipped',
        ms: Date.now() - meshT0,
        detail: 'mesh unavailable',
      });
    }
  }

  // Skip edge for FIM -- go straight to Cloud Run + WASM race
  attempts.push({
    tier: 'edge',
    status: 'skipped',
    ms: 0,
    detail: 'FIM fast path bypasses edge',
  });

  // Race Cloud Run vs WASM in parallel
  const cloudRunUrl = CLOUD_RUN_COORDINATORS[model];

  const wasmPromise = (async (): Promise<{
    completion: string;
    tier: InferenceTier;
  } | null> => {
    const wt0 = Date.now();
    try {
      const content = await runWithCompanionActivity(
        'wasm-fim',
        LOCAL_WASM_TOTAL_TIMEOUT_MS + LOCAL_WASM_BUSY_BUFFER_MS,
        async () => {
          const ready = await withTimeout(
            aetherLocalRuntime.ensureChatReady(),
            LOCAL_WASM_TOTAL_TIMEOUT_MS,
            'Local FIM model warm-up'
          );
          if (!ready) {
            throw new Error('Local FIM model failed to load');
          }

          return await withTimeout(
            aetherLocalRuntime.generate(
              [
                {
                  role: 'system',
                  content:
                    'Complete the code. Output ONLY the completion, no explanation.',
                },
                { role: 'user', content: fimPrompt },
              ],
              Math.min(maxTokens, 256),
              temperature
            ),
            LOCAL_WASM_TOTAL_TIMEOUT_MS,
            'Local FIM generation'
          );
        },
        model
      );
      attempts.push({ tier: 'wasm', status: 'ok', ms: Date.now() - wt0 });
      logInference(`[fim:wasm] ${content.length}c in ${Date.now() - wt0}ms`);
      return { completion: content, tier: 'wasm' };
    } catch (err) {
      attempts.push({
        tier: 'wasm',
        status: 'error',
        ms: Date.now() - wt0,
        detail: String(err),
      });
      return null;
    }
  })();

  const cloudRunPromise = cloudRunUrl
    ? (async (): Promise<{
        completion: string;
        tier: InferenceTier;
      } | null> => {
        const ct0 = Date.now();
        try {
          const authHeaders = await getCloudRunAuthHeaders(cloudRunUrl);
          const resp = await fetch(`${cloudRunUrl}/v1/chat/completions`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...authHeaders,
            },
            body: JSON.stringify({
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
              stream: false,
            }),
            signal: AbortSignal.timeout(15_000),
          });

          if (!resp.ok) {
            attempts.push({
              tier: 'cloudrun',
              status: 'http_error',
              ms: Date.now() - ct0,
              detail: `${resp.status}`,
            });
            return null;
          }

          const data = (await resp.json()) as ChatCompletionResponse;
          const content = data.choices?.[0]?.message?.content ?? '';
          attempts.push({
            tier: 'cloudrun',
            status: 'ok',
            ms: Date.now() - ct0,
          });
          logInference(
            `[fim:cloudrun] ${content.length}c in ${Date.now() - ct0}ms`
          );
          return { completion: content, tier: 'cloudrun' };
        } catch (err) {
          attempts.push({
            tier: 'cloudrun',
            status: 'error',
            ms: Date.now() - ct0,
            detail: err instanceof Error ? err.message : String(err),
          });
          return null;
        }
      })()
    : (async () => {
        attempts.push({
          tier: 'cloudrun',
          status: 'skipped',
          ms: 0,
          detail: 'no coordinator URL',
        });
        return null;
      })();

  // Race: first non-null wins
  const results = await Promise.allSettled([wasmPromise, cloudRunPromise]);
  let winner: { completion: string; tier: InferenceTier } | null = null;

  for (const result of results) {
    if (result.status === 'fulfilled' && result.value !== null) {
      // Prefer Cloud Run if both succeeded (higher quality)
      if (!winner || result.value.tier === 'cloudrun') {
        winner = result.value;
      }
    }
  }

  if (!winner) {
    // Echo fallback for FIM
    attempts.push({
      tier: 'echo',
      status: 'ok',
      ms: 0,
      detail: 'FIM all tiers failed',
    });
    return {
      completion: '',
      tier: 'echo',
      model,
      attempts,
      durationMs: Date.now() - t0,
    };
  }

  logInference(
    `--- FIM DONE tier=${winner.tier} ${winner.completion.length}c ${
      Date.now() - t0
    }ms`
  );

  return {
    completion: winner.completion,
    tier: winner.tier,
    model,
    attempts,
    durationMs: Date.now() - t0,
  };
}

/**
 * Execute the 5-tier inference chain
 *
 * Tier order:
 * 1. LAN Mesh (if running and peers available)
 * 2. Edge + Cloud Run RACED (first 200 wins, eliminates 30s edge timeout waste)
 * 3. Local WASM (on-device n-gram model)
 * 4. Echo fallback (guaranteed)
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

  const config = getZedgeConfig();
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

  if (isExplicitLocalOnlyModel(request.model)) {
    attempts.push({
      tier: 'mesh',
      status: 'skipped',
      ms: 0,
      detail: `model ${request.model} requires local-only execution`,
    });
    attempts.push({
      tier: 'edge',
      status: 'skipped',
      ms: 0,
      detail: `model ${request.model} requires local-only execution`,
    });
    attempts.push({
      tier: 'cloudrun',
      status: 'skipped',
      ms: 0,
      detail: `model ${request.model} requires local-only execution`,
    });

    const wasmStart = Date.now();
    try {
      const response = await tryWasmFallback(request);
      attempts.push({
        tier: 'wasm',
        status: 'ok',
        ms: Date.now() - wasmStart,
        detail: 'local-only model short-circuit',
      });

      return {
        tier: 'wasm',
        response,
        upstreamHeaders: {},
        attempts,
      };
    } catch (err) {
      attempts.push({
        tier: 'wasm',
        status: 'error',
        ms: Date.now() - wasmStart,
        detail: String(err),
      });
      attempts.push({
        tier: 'echo',
        status: 'ok',
        ms: 0,
        detail: 'local-only model fallback after WASM load failure',
      });

      return {
        tier: 'echo',
        response: echoFallback(request),
        upstreamHeaders: {},
        attempts,
      };
    }
  }

  function attempt(
    tier: InferenceTier,
    startMs: number,
    status: TierAttempt['status'],
    detail?: string
  ): void {
    attempts.push({ tier, status, ms: Date.now() - startMs, detail });
  }

  // Tier 1: LAN Mesh
  {
    const t0 = Date.now();
    try {
      const meshResponse = await tryMeshInference(request);
      if (meshResponse && meshResponse.ok) {
        attempt('mesh', t0, 'ok');
        logInference(
          `model=${request.model} tier=mesh status=ok ms=${Date.now() - t0}`
        );
        return {
          tier: 'mesh',
          response: meshResponse,
          upstreamHeaders: extractUpstreamDebugHeaders(meshResponse),
          attempts,
        };
      }
      attempt('mesh', t0, 'skipped', 'no peers or not running');
    } catch (err) {
      attempt('mesh', t0, 'error', String(err));
    }
  }

  // Tier 2: Race Edge + Cloud Run in parallel
  // Edge consistently takes 30s to timeout — racing both eliminates the waste.
  // First successful (200 OK) response wins. Large coordinators can take a long
  // time to cold-start, so elapsed time alone is not a failure condition here.
  //
  // STREAMING EXCEPTION: When stream=true and Cloud Run is available, prefer
  // Cloud Run directly. The edge CF Worker doesn't forward per-token SSE —
  // it buffers the entire response and sends only the stop event. Cloud Run
  // coordinators stream real per-token deltas via TransformStream.
  //
  // Large models can take minutes to cold-start and load weights from GCS FUSE.
  // The race between edge + cloudrun means whichever responds first wins.
  // Edge handles routing internally via /ai/communicate.
  // Cloud Run is a backup path for models the edge can't handle.
  const canCloudRun =
    config.cloudRunDirect && hasCloudRunCoordinatorForModel(request.model);
  // Edge-first: always try edge, even for streaming. Cloud Run has cold starts
  // and weight errors. The edge path (Glossolalia MOA) is more reliable.
  const preferCloudRunForStreaming = false;
  {
    const t0 = Date.now();
    const edgeController = new AbortController();
    const cloudRunController = new AbortController();

    // Edge attempt: skip when streaming + Cloud Run available (edge doesn't stream tokens)
    let edgePromise: Promise<{
      tier: InferenceTier;
      response: Response;
    } | null>;
    if (preferCloudRunForStreaming) {
      attempt('edge', t0, 'skipped', 'streaming prefers cloudrun direct');
      edgePromise = Promise.resolve(null);
    } else {
      edgePromise = tryEdgeCoordinator(request, edgeController.signal)
        .then(
          (response): { tier: InferenceTier; response: Response } | null => {
            if (response.ok) return { tier: 'edge', response };
            attempt(
              'edge',
              t0,
              'http_error',
              `${response.status} ${response.statusText}`
            );
            return null;
          }
        )
        .catch((err): null => {
          const isTimeout =
            err instanceof DOMException && err.name === 'AbortError';
          attempt('edge', t0, isTimeout ? 'timeout' : 'error', String(err));
          return null;
        });
    }

    // Cloud Run attempt (only if available)
    let cloudRunPromise: Promise<{
      tier: InferenceTier;
      response: Response;
    } | null>;
    if (canCloudRun) {
      cloudRunPromise = tryCloudRunCoordinator(
        request,
        cloudRunController.signal
      )
        .then(
          (response): { tier: InferenceTier; response: Response } | null => {
            if (response.ok) return { tier: 'cloudrun', response };
            attempt(
              'cloudrun',
              t0,
              'http_error',
              `${response.status} ${response.statusText}`
            );
            return null;
          }
        )
        .catch((err): null => {
          const isTimeout =
            err instanceof DOMException && err.name === 'AbortError';
          attempt('cloudrun', t0, isTimeout ? 'timeout' : 'error', String(err));
          return null;
        });
    } else {
      attempts.push({
        tier: 'cloudrun',
        status: 'skipped',
        ms: 0,
        detail: !config.cloudRunDirect
          ? 'cloudRunDirect disabled'
          : `no coordinator URL for ${request.model}`,
      });
      cloudRunPromise = Promise.resolve(null);
    }

    const { winner, backgroundCleanup } = await raceCoordinatorResponses({
      requestModel: request.model,
      startMs: t0,
      edgePromise,
      cloudRunPromise,
      abortEdge: () => edgeController.abort(),
      abortCloudRun: () => cloudRunController.abort(),
    });

    if (winner) {
      void backgroundCleanup;

      attempt(winner.tier, t0, 'ok');
      const xHeaders = extractUpstreamDebugHeaders(winner.response);
      logInference(
        `model=${request.model} tier=${winner.tier} status=ok ms=${
          Date.now() - t0
        } x-headers=${JSON.stringify(xHeaders)}`
      );
      return {
        tier: winner.tier,
        response: winner.response,
        upstreamHeaders: xHeaders,
        attempts,
      };
    }
  }

  // Tier 4: Local WASM inference (real on-device generation)
  {
    const t0 = Date.now();
    try {
      const response = await tryWasmFallback(request);
      attempt('wasm', t0, 'ok');

      // Log full chain when falling to WASM — this is always interesting
      const chainStr = attempts
        .map(
          (a) =>
            `${a.tier}:${a.status}(${a.ms}ms)${
              a.detail ? '[' + a.detail.slice(0, 40) + ']' : ''
            }`
        )
        .join(' → ');
      console.warn(
        `[zedge] fell to WASM for model=${request.model} | chain: ${chainStr}`
      );
      logInference(
        `model=${request.model} tier=wasm FALLBACK chain: ${chainStr}`
      );

      return {
        tier: 'wasm',
        response,
        upstreamHeaders: {},
        attempts,
      };
    } catch (err) {
      attempt('wasm', t0, 'error', String(err));
    }
  }

  // Tier 5: Echo fallback (guaranteed response)
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
 * Get merged model list from remote + local + mesh peers
 */
async function fetchRemoteModels(): Promise<ModelInfo[]> {
  for (const edgeBase of ['https://edge.affectively.ai', getApiBaseUrl()]) {
    try {
      const resp = await fetch(`${edgeBase}/v1/models`, {
        headers: {
          ...getAuthHeaders(),
          'User-Agent':
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
          Accept: 'application/json',
          Origin: 'https://edge.affectively.ai',
        },
        signal: AbortSignal.timeout(5_000),
      });
      if (!resp.ok) {
        continue;
      }

      const data = (await resp.json()) as { data?: ModelInfo[] };
      if (Array.isArray(data.data)) {
        return data.data;
      }
    } catch {
      // This edge URL unavailable -- try next
    }
  }

  return [];
}

function refreshRemoteModelCatalogInBackground(): void {
  const now = Date.now();
  if (
    remoteModelCatalogRefreshPromise ||
    now - remoteModelCatalogFetchedAt < REMOTE_MODEL_CACHE_TTL_MS
  ) {
    return;
  }

  remoteModelCatalogRefreshPromise = fetchRemoteModels()
    .then((models) => {
      cachedRemoteModels = models;
      remoteModelCatalogFetchedAt = Date.now();
    })
    .catch(() => {
      remoteModelCatalogFetchedAt = Date.now();
    })
    .finally(() => {
      remoteModelCatalogRefreshPromise = null;
    });
}

export async function getModels(): Promise<ModelInfo[]> {
  refreshRemoteModelCatalogInBackground();

  const models: ModelInfo[] = [];
  const seen = new Set<string>();

  for (const model of cachedRemoteModels) {
    if (!seen.has(model.id)) {
      seen.add(model.id);
      models.push(model);
    }
  }

  // Always include all known local + edge models (canonical list).
  for (const model of getKnownZedgeModels()) {
    if (!seen.has(model.id)) {
      seen.add(model.id);
      models.push({
        id: model.id,
        object: 'model',
        owned_by: model.ownedBy,
      });
    }
  }

  // Add mesh peer models
  try {
    const { getMeshStatus } = await import('./p2p-mesh.ts');
    const meshStatus = getMeshStatus();
    for (const peer of meshStatus.peers) {
      for (const modelId of peer.capabilities.models) {
        if (!seen.has(modelId)) {
          seen.add(modelId);
          models.push({
            id: modelId,
            object: 'model',
            owned_by: `edgework-mesh-${peer.hostname}`,
          });
        }
      }
    }
  } catch {
    // Mesh not available
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
