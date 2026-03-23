/**
 * Zedge Inference Bridge
 *
 * 5-tier inference chain (v1.0):
 * 1. LAN Mesh — P2P inference via discovered companion nodes (fastest, free)
 * 2. Edge Coordinator (CF Workers) — via OpenAI-compat endpoint
 * 3. Cloud Run Coordinator — direct HTTP (bypasses CF 120s timeout)
 * 4. Local WASM — on-device inference via n-gram language model
 * 5. Echo fallback — guaranteed response acknowledging the message
 *
 * All inference is WASM/coordinator-based, zero paid AI.
 */

import { getApiBaseUrl, getAuthHeaders, getZedgeConfig } from './config';
import { appendFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

// --- Inference log file + in-memory ring buffer ---
const __inference_dirname = dirname(fileURLToPath(import.meta.url));
const LOG_DIR = join(__inference_dirname, '..', '..', '.edgework');
try {
  mkdirSync(LOG_DIR, { recursive: true });
} catch {}
const LOG_FILE = join(LOG_DIR, 'inference.log');

const LOG_RING_MAX = 200;
const logRing: string[] = [];

function logInference(line: string): void {
  const ts = new Date().toISOString();
  const entry = `[${ts}] ${line}`;
  logRing.push(entry);
  if (logRing.length > LOG_RING_MAX) logRing.shift();
  try {
    appendFileSync(LOG_FILE, entry + '\n');
  } catch {}
}

/** Get recent inference logs (most recent last) */
export function getRecentLogs(count?: number): string[] {
  const n = count ?? LOG_RING_MAX;
  return logRing.slice(-n);
}

/** Clear the in-memory log ring */
export function clearLogs(): void {
  logRing.length = 0;
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

// Cloud Run coordinator URLs for direct access (bypasses CF 120s timeout)
const CLOUD_RUN_COORDINATORS: Record<string, string> = {
  'tinyllama-1.1b':
    'https://inference-tinyllama-coordinator-6ptd7xm6fq-uc.a.run.app',
  'mistral-7b': 'https://inference-7b-coordinator-6ptd7xm6fq-uc.a.run.app',
  'qwen-2.5-coder-7b':
    'https://inference-qwen-coordinator-6ptd7xm6fq-uc.a.run.app',
  'gemma3-4b-it':
    'https://inference-gemma3-4b-it-coordinator-6ptd7xm6fq-uc.a.run.app',
  'gemma3-1b-it':
    'https://inference-gemma3-1b-it-coordinator-6ptd7xm6fq-uc.a.run.app',
  'glm-4-9b': 'https://inference-glm-4-9b-coordinator-6ptd7xm6fq-uc.a.run.app',
  'personaplex-7b':
    'https://inference-personaplex-7b-coordinator-6ptd7xm6fq-uc.a.run.app',
  'lfm2.5-1.2b-glm-4.7-flash-thinking':
    'https://inference-lfm2-5-coordinator-6ptd7xm6fq-uc.a.run.app',
};

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
  return (
    isExplicitLocalOnlyModel(model) || !REMOTE_EMBEDDING_MODELS.has(model)
  );
}

/**
 * Speculative warm-up: fire /health pings to ALL Cloud Run coordinators
 * whenever any inference request arrives. This wakes coordinators from
 * cold sleep (min-instances=0) so they're ready for subsequent requests.
 * Fire-and-forget — never blocks the primary request.
 */
let lastWarmupTime = 0;
const WARMUP_INTERVAL_MS = 60_000; // At most once per minute

function speculativeWarmup(excludeModel?: string): void {
  const now = Date.now();
  if (now - lastWarmupTime < WARMUP_INTERVAL_MS) return;
  lastWarmupTime = now;

  for (const [model, url] of Object.entries(CLOUD_RUN_COORDINATORS)) {
    if (model === excludeModel) continue; // Already being hit by the real request
    fetch(`${url}/health`, { signal: AbortSignal.timeout(10_000) })
      .then((r) => {
        logInference(`[warmup] ${model} → ${r.status} (${Date.now() - now}ms)`);
      })
      .catch((err) => {
        logInference(
          `[warmup] ${model} → ${
            err instanceof Error ? err.message : 'error'
          } (${Date.now() - now}ms)`
        );
      });
  }
  logInference(
    `[warmup] pinged ${
      Object.keys(CLOUD_RUN_COORDINATORS).length - (excludeModel ? 1 : 0)
    } coordinators`
  );
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

/**
 * Attempt inference via LAN mesh peers
 */
async function tryMeshInference(
  request: ChatCompletionRequest
): Promise<Response | null> {
  // Lazy import to avoid circular deps at module load time
  const { meshInfer, getMeshStatus } = await import('./p2p-mesh');
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
    ...authHeaders,
  };

  logInference(
    `[edge] → ${baseUrl}/v1/chat/completions model=${request.model} stream=${
      request.stream
    } headers=${JSON.stringify(Object.keys(authHeaders))}`
  );

  const resp = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify(request),
    signal,
  });

  // Log all response headers for debugging
  const respHeaders: Record<string, string> = {};
  resp.headers.forEach((v, k) => {
    respHeaders[k] = v;
  });
  logInference(
    `[edge] ← ${resp.status} ${resp.statusText} headers=${JSON.stringify(
      respHeaders
    )}`
  );

  return resp;
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

    if (attempt === 0) {
      logInference(
        `[cloudrun] → ${coordinatorUrl}/v1/chat/completions model=${request.model}`
      );
    } else {
      logInference(
        `[cloudrun] → retry ${attempt}/${MAX_RETRIES} model=${request.model}`
      );
    }

    const resp = await fetch(`${coordinatorUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
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

/**
 * Local WASM inference — on-device SmolLM2-360M via transformers.js
 *
 * Uses @xenova/transformers with ONNX Runtime to run a real LLM
 * entirely on-device. The model is downloaded and cached on first use
 * (~230MB for SmolLM2-360M quantized). Subsequent loads are instant
 * from the local HuggingFace cache.
 *
 * Model cascade:
 * 1. onnx-community/SmolLM2-360M-Instruct (360M params, fast)
 * 2. Xenova/TinyLlama-1.1B-Chat-v1.0 (1.1B params, proven fallback)
 */

// Dynamic import to avoid blocking startup — model loads lazily on first inference
type TransformersPipeline = (
  input: unknown,
  options?: Record<string, unknown>
) => Promise<unknown>;

const LOCAL_MODEL_CASCADE = [
  'onnx-community/SmolLM2-360M-Instruct',
  'Xenova/TinyLlama-1.1B-Chat-v1.0',
] as const;

class LocalInferenceEngine {
  private pipe: TransformersPipeline | null = null;
  private loadingPromise: Promise<boolean> | null = null;
  private loadedModelId: string | null = null;
  private loadFailed = false;

  /**
   * Lazily load the model pipeline. Returns true if ready.
   * First call downloads the model (~230MB); subsequent calls use cache.
   */
  async ensureReady(): Promise<boolean> {
    if (this.pipe) return true;
    if (this.loadFailed) return false;
    if (this.loadingPromise) return this.loadingPromise;

    this.loadingPromise = this.loadModel();
    return this.loadingPromise;
  }

  private async loadModel(): Promise<boolean> {
    try {
      // Dynamic import so the module isn't loaded until needed
      const { pipeline, env } = await import('@xenova/transformers');

      // Configure for Node/Bun environment
      env.allowLocalModels = false;
      env.allowRemoteModels = true;
      if (env.backends?.onnx?.wasm) {
        env.backends.onnx.wasm.numThreads = 1;
      }

      // Try each model in cascade
      for (const modelId of LOCAL_MODEL_CASCADE) {
        try {
          logInference(`[wasm] Loading ${modelId}...`);
          const t0 = Date.now();
          this.pipe = (await pipeline('text-generation', modelId, {
            quantized: true,
          })) as unknown as TransformersPipeline;
          this.loadedModelId = modelId;
          logInference(`[wasm] ${modelId} ready (${Date.now() - t0}ms)`);
          return true;
        } catch (err) {
          logInference(
            `[wasm] ${modelId} failed: ${
              err instanceof Error ? err.message : String(err)
            }`
          );
        }
      }

      logInference('[wasm] All model candidates failed');
      this.loadFailed = true;
      return false;
    } catch (err) {
      logInference(
        `[wasm] transformers.js import failed: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
      this.loadFailed = true;
      return false;
    }
  }

  /**
   * Generate a response using the loaded transformer model.
   * Formats messages in ChatML format and runs real inference.
   */
  async generate(
    messages: ChatMessage[],
    maxTokens: number,
    temperature: number
  ): Promise<string> {
    if (!this.pipe) throw new Error('Model not loaded');

    // ChatML format (works with SmolLM2 and TinyLlama)
    const prompt =
      messages
        .map((m) => `<|im_start|>${m.role}\n${m.content}<|im_end|>`)
        .join('\n') + '\n<|im_start|>assistant\n';

    const result = await this.pipe(prompt, {
      max_new_tokens: Math.min(maxTokens, 512),
      temperature: Math.max(0.1, temperature),
      do_sample: true,
      return_full_text: false,
    });

    const generated = Array.isArray(result)
      ? (result as Array<{ generated_text?: string }>)[0]?.generated_text ?? ''
      : String(result);

    // Strip any trailing ChatML tokens from the output
    return generated
      .replace(/<\|im_end\|>.*/s, '')
      .replace(/<\|im_start\|>.*/s, '')
      .trim();
  }

  get modelId(): string {
    return this.loadedModelId ?? 'wasm-local';
  }
}

const localEngine = new LocalInferenceEngine();

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
 * Local WASM inference — generates a real response using on-device SmolLM2-360M
 */
async function tryWasmFallback(
  request: ChatCompletionRequest
): Promise<Response> {
  const temperature = request.temperature ?? 0.7;
  const maxTokens = request.max_tokens ?? 128;

  // Ensure model is loaded (lazy — first call downloads weights)
  const ready = await localEngine.ensureReady();
  if (!ready) {
    throw new Error('Local model failed to load');
  }

  const t0 = Date.now();
  const content = await localEngine.generate(
    request.messages,
    maxTokens,
    temperature
  );
  const inferenceMs = Date.now() - t0;

  const promptTokens = request.messages.reduce(
    (acc, m) => acc + Math.ceil(m.content.length / 4),
    0
  );
  const completionTokens = Math.ceil(content.length / 4);

  logInference(
    `[wasm] generated ${completionTokens} tokens in ${inferenceMs}ms (${localEngine.modelId})`
  );

  const response: ChatCompletionResponse = {
    id: `chatcmpl-wasm-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: localEngine.modelId,
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
}

/**
 * Echo fallback — guaranteed response acknowledging the message
 * Used when even WASM inference fails (should never happen, but belt + suspenders)
 */
function echoFallback(request: ChatCompletionRequest): Response {
  const lastMessage = request.messages[request.messages.length - 1];
  const content = `I received your message. All inference tiers are currently unavailable. Your message was: "${
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
  const decoder = new TextDecoder();

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
            if (line.startsWith('data: ')) {
              dataEventCount++;
              const payload = line.slice(6).trim();
              if (payload === '[DONE]') {
                sawDone = true;
              } else if (!firstDataLogged) {
                firstDataLogged = true;
                logInference(
                  `[sse-proxy] tier=${tier} first-data: ${payload.slice(
                    0,
                    200
                  )}`
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
              // Only forward valid OpenAI SSE data lines (chunks with "choices" or [DONE])
              // Filter out non-standard upstream payloads like {"status":"ready"}
              if (payload === '[DONE]' || payload.includes('"choices"')) {
                enqueue(encoder.encode(line + '\n'));
              } else {
                logInference(
                  `[sse-proxy] tier=${tier} filtered non-OpenAI data: ${payload.slice(0, 100)}`
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
                const sparks =
                  '\u2581\u2582\u2583\u2584\u2585\u2586\u2587\u2588';
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
          }
        }

        // Flush remaining buffer
        if (lineBuf.startsWith('data: ')) {
          enqueue(encoder.encode(lineBuf + '\n\n'));
          const payload = lineBuf.slice(6).trim();
          if (payload === '[DONE]') sawDone = true;
          else dataEventCount++;
        }
      } catch (err) {
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

  // Speculatively warm all other coordinators while this request is in flight
  speculativeWarmup(request.model);

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
  // First successful (200 OK) response wins; loser is aborted.
  //
  // STREAMING EXCEPTION: When stream=true and Cloud Run is available, prefer
  // Cloud Run directly. The edge CF Worker doesn't forward per-token SSE —
  // it buffers the entire response and sends only the stop event. Cloud Run
  // coordinators stream real per-token deltas via TransformStream.
  //
  // Large models can take minutes to cold-start and load weights from GCS FUSE.
  // The race between edge + cloudrun means whichever responds first wins —
  // the deadline is just a safety net before falling to WASM.
  const RACE_DEADLINE_MS = 15_000; // 15 seconds
  const canCloudRun =
    config.cloudRunDirect && !!CLOUD_RUN_COORDINATORS[request.model];
  const preferCloudRunForStreaming = request.stream && canCloudRun;
  {
    const t0 = Date.now();
    const edgeAbort = new AbortController();
    const cloudRunAbort = new AbortController();

    // Edge attempt: skip when streaming + Cloud Run available (edge doesn't stream tokens)
    let edgePromise: Promise<{
      tier: InferenceTier;
      response: Response;
    } | null>;
    let edgeTimeout: ReturnType<typeof setTimeout> | undefined;
    if (preferCloudRunForStreaming) {
      attempt('edge', t0, 'skipped', 'streaming prefers cloudrun direct');
      edgePromise = Promise.resolve(null);
    } else {
      edgeTimeout = setTimeout(() => edgeAbort.abort(), 150_000);
      edgePromise = tryEdgeCoordinator(request, edgeAbort.signal)
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

    // Cloud Run attempt (only if available): 15 min timeout for cold starts
    let cloudRunPromise: Promise<{
      tier: InferenceTier;
      response: Response;
    } | null>;
    if (canCloudRun) {
      const cloudRunTimeout = setTimeout(() => cloudRunAbort.abort(), 900_000);
      cloudRunPromise = tryCloudRunCoordinator(request, cloudRunAbort.signal)
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
        })
        .finally(() => clearTimeout(cloudRunTimeout));
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

    // Race with a deadline — if neither responds in time, fall to WASM so the
    // client (Zed) gets an immediate response. CRITICALLY: do NOT abort the
    // coordinator requests — let them continue in the background so Cold Start
    // completes and the coordinator is warm for the next request.
    const deadlinePromise = new Promise<null>((resolve) =>
      setTimeout(() => {
        attempt('edge', t0, 'timeout', `race deadline ${RACE_DEADLINE_MS}ms`);
        if (canCloudRun) {
          attempt(
            'cloudrun',
            t0,
            'timeout',
            `race deadline ${RACE_DEADLINE_MS}ms`
          );
        }
        resolve(null);
      }, RACE_DEADLINE_MS)
    );

    const winner = await Promise.race([
      raceForFirst([edgePromise, cloudRunPromise]),
      deadlinePromise.then(
        () => null as { tier: InferenceTier; response: Response } | null
      ),
    ]);
    if (edgeTimeout) clearTimeout(edgeTimeout);

    if (winner) {
      // Don't abort the loser — let it complete in the background so it
      // warms the coordinator cache (loads weights from GCS FUSE, etc.).
      // This is especially important for large models where cold start +
      // weight loading can take minutes.
      const loserTier = winner.tier === 'edge' ? 'cloudrun' : 'edge';
      const loserPromise =
        winner.tier === 'edge' ? cloudRunPromise : edgePromise;
      loserPromise
        .then((result) => {
          if (result) {
            logInference(
              `model=${
                request.model
              } [background-warm] ${loserTier} completed after ${
                Date.now() - t0
              }ms (winner was ${winner.tier})`
            );
            // Consume body to avoid leak, but let the request complete on the server
            result.response.body?.cancel().catch(() => {});
          }
        })
        .catch(() => {});

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

    // Deadline hit — fall to WASM immediately but DO NOT abort coordinators.
    // Let edge/cloudrun continue warming up in the background. Log when they finish.
    logInference(
      `model=${request.model} edge+cloudrun race: no winner within ${RACE_DEADLINE_MS}ms, falling to WASM (coordinators still warming)`
    );

    // Fire-and-forget: track when coordinators eventually respond (for diagnostics)
    raceForFirst([edgePromise, cloudRunPromise])
      .then((lateWinner) => {
        if (lateWinner) {
          const warmMs = Date.now() - t0;
          logInference(
            `model=${request.model} [background-warm] ${lateWinner.tier} responded after ${warmMs}ms (was past ${RACE_DEADLINE_MS}ms deadline)`
          );
          // Consume the response body to avoid memory leaks
          lateWinner.response.body?.cancel().catch(() => {});
        } else {
          logInference(
            `model=${request.model} [background-warm] both tiers failed even after waiting`
          );
        }
      })
      .catch(() => {});
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
 * Get merged model list from remote + local + mesh peers
 */
export async function getModels(): Promise<ModelInfo[]> {
  const models: ModelInfo[] = [];

  // Try to fetch remote model list
  try {
    const baseUrl = getApiBaseUrl();
    const resp = await fetch(`${baseUrl}/v1/models`, {
      headers: getAuthHeaders(),
      signal: AbortSignal.timeout(5_000),
    });
    if (resp.ok) {
      const data = (await resp.json()) as { data?: ModelInfo[] };
      if (data.data) {
        models.push(...data.data);
      }
    }
  } catch {
    // Remote unavailable
  }

  // Add Cloud Run models that may not be in remote list
  for (const modelId of Object.keys(CLOUD_RUN_COORDINATORS)) {
    if (!models.some((m) => m.id === modelId)) {
      models.push({
        id: modelId,
        object: 'model',
        owned_by: 'edgework-cloudrun',
      });
    }
  }

  // Add mesh peer models
  try {
    const { getMeshStatus } = await import('./p2p-mesh');
    const meshStatus = getMeshStatus();
    for (const peer of meshStatus.peers) {
      for (const modelId of peer.capabilities.models) {
        if (!models.some((m) => m.id === modelId)) {
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

  // Add local models
  models.push({
    id: 'wasm-local',
    object: 'model',
    owned_by: 'edgework-wasm',
  });

  return models;
}

/**
 * Generate embeddings via edge with local fallback
 *
 * If the edge endpoint is unavailable, generates a simple bag-of-words
 * embedding locally using character n-gram hashing.
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

  // Local fallback: character n-gram hash embedding
  const inputs = Array.isArray(input) ? input : [input];
  const data = inputs.map((text, index) => ({
    object: 'embedding',
    embedding: localEmbed(text),
    index,
  }));

  return new Response(
    JSON.stringify({
      object: 'list',
      data,
      model: 'local-ngram-hash',
      usage: {
        prompt_tokens: inputs.reduce((a, t) => a + Math.ceil(t.length / 4), 0),
        total_tokens: inputs.reduce((a, t) => a + Math.ceil(t.length / 4), 0),
      },
    }),
    { headers: { 'Content-Type': 'application/json' } }
  );
}

/**
 * Generate a local embedding using character n-gram hashing
 * Projects text into a 384-dimensional vector via hash bucketing
 */
function localEmbed(text: string, dims = 384): number[] {
  const vec = new Float32Array(dims);
  const normalized = text.toLowerCase();

  // Character 3-grams hashed into buckets
  for (let i = 0; i <= normalized.length - 3; i++) {
    const trigram = normalized.slice(i, i + 3);
    let hash = 0;
    for (let j = 0; j < trigram.length; j++) {
      hash = ((hash << 5) - hash + trigram.charCodeAt(j)) | 0;
    }
    const bucket = ((hash % dims) + dims) % dims;
    vec[bucket] += 1;
  }

  // L2 normalize
  let norm = 0;
  for (let i = 0; i < dims; i++) {
    norm += vec[i] * vec[i];
  }
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let i = 0; i < dims; i++) {
      vec[i] /= norm;
    }
  }

  return Array.from(vec);
}
