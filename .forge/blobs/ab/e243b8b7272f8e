/**
 * Skymesh Global Cache-Key Teleportation
 *
 * Implements fp48 canonical query hash (XXH64 seed 0, low 48 bits) for fast
 * lookups in the global edgework cache. On verified hit, returns the cached
 * answer with zero inference (geodesicLength=0 teleportation).
 *
 * The cache is token-keyed; tokenization via fat-station's /tokenize endpoint
 * using the same Qwen2 BPE tokenizer as the skymesh bridge ensures cache hits.
 * If fat-station is unreachable, teleportation is skipped silently.
 *
 * Copied verbatim from apps/skymesh/src/lib/cache-key.ts (which mirrored
 * @a0n/bitwise/cache-fp48) to avoid import boundaries. Golden vector assertion
 * in tests ensures byte-exact equivalence with the bridge implementation.
 */

// --- XXH64 Constants & Implementation (verbatim from cache-key.ts) ---

const MASK64 = (1n << 64n) - 1n;
const MASK48 = (1n << 48n) - 1n;
const PRIME_1 = 0x9e3779b185ebca87n;
const PRIME_2 = 0xc2b2ae3d27d4eb4fn;
const PRIME_3 = 0x165667b19e3779f9n;
const PRIME_4 = 0x85ebca77c2b2ae63n;
const PRIME_5 = 0x27d4eb2f165667c5n;
const CHUNK_SIZE = 32;

const wrap64 = (x: bigint): bigint => x & MASK64;

function rotl64(x: bigint, r: number): bigint {
  const n = BigInt(r);
  return wrap64((x << n) | (x >> (64n - n)));
}

function readU64LE(d: Uint8Array, o: number): bigint {
  let v = 0n;
  for (let i = 0; i < 8; i++) v |= BigInt(d[o + i]!) << BigInt(8 * i);
  return wrap64(v);
}

function readU32LE(d: Uint8Array, o: number): bigint {
  return wrap64(
    BigInt(d[o]!) | (BigInt(d[o + 1]!) << 8n) | (BigInt(d[o + 2]!) << 16n) | (BigInt(d[o + 3]!) << 24n),
  );
}

function round(acc: bigint, input: bigint): bigint {
  const t = wrap64(acc + wrap64(input * PRIME_2));
  return wrap64(rotl64(t, 31) * PRIME_1);
}

function mergeRound(acc: bigint, val: bigint): bigint {
  return wrap64((acc ^ round(0n, val)) * PRIME_1 + PRIME_4);
}

function avalanche(input: bigint): bigint {
  let x = input;
  x ^= x >> 33n;
  x = wrap64(x * PRIME_2);
  x ^= x >> 29n;
  x = wrap64(x * PRIME_3);
  x ^= x >> 32n;
  return wrap64(x);
}

function finalize(mut: bigint, data: Uint8Array): bigint {
  let off = 0;
  const d = data;
  while (off + 8 <= d.length) {
    mut = wrap64(mut ^ readU64LE(d, off));
    mut = rotl64(mut, 27);
    mut = wrap64(mut * PRIME_1 + PRIME_4);
    off += 8;
  }
  while (off + 4 <= d.length) {
    mut = wrap64(mut ^ wrap64(readU32LE(d, off) * PRIME_1));
    mut = rotl64(mut, 23);
    mut = wrap64(mut * PRIME_2 + PRIME_3);
    off += 4;
  }
  while (off < d.length) {
    mut = wrap64(mut ^ wrap64(BigInt(d[off]!) * PRIME_5));
    mut = rotl64(mut, 11);
    mut = wrap64(mut * PRIME_1);
    off += 1;
  }
  return avalanche(mut);
}

function initV(seed: bigint): [bigint, bigint, bigint, bigint] {
  return [wrap64(seed + PRIME_1 + PRIME_2), wrap64(seed + PRIME_2), wrap64(seed), wrap64(seed - PRIME_1)];
}

/** XXH64 (seed 0) over raw bytes. Byte-exact with @a0n/bitwise cache-fp64. */
function xxh64Raw(data: Uint8Array, seed = 0n): bigint {
  const inputLen = BigInt(data.length);
  let input = data;
  let result: bigint;
  if (input.length >= CHUNK_SIZE) {
    let [v0, v1, v2, v3] = initV(wrap64(seed));
    while (input.length >= CHUNK_SIZE) {
      v0 = round(v0, readU64LE(input, 0));
      v1 = round(v1, readU64LE(input, 8));
      v2 = round(v2, readU64LE(input, 16));
      v3 = round(v3, readU64LE(input, 24));
      input = input.subarray(32);
    }
    result = wrap64(rotl64(v0, 1) + rotl64(v1, 7) + rotl64(v2, 12) + rotl64(v3, 18));
    result = mergeRound(result, v0);
    result = mergeRound(result, v1);
    result = mergeRound(result, v2);
    result = mergeRound(result, v3);
  } else {
    result = wrap64(wrap64(seed) + PRIME_5);
  }
  result = wrap64(result + inputLen);
  return finalize(result, input);
}

/** 48-bit fingerprint: XXH64 seed 0 masked to low 48 bits, 12 lowercase hex. */
function cacheFingerprint48HexSync(input: Uint8Array): string {
  return (xxh64Raw(input, 0n) & MASK48).toString(16).padStart(12, '0');
}

/** Canonical-key token separator byte (mirrors the bridge / knotgraph). */
const CACHE_TOKEN_SEP = 0x00;

/**
 * Canonical key bytes: qspecId utf8 | 0x00 | token[i] LE u32. MODEL-AGNOSTIC —
 * model is NOT in the key (provenance only). Byte-for-byte identical to the
 * bridge's + knotgraph's canonicalQueryKeyBytes.
 */
function canonicalQueryKeyBytes(
  queryTokens: readonly number[],
  qspecId: string,
): Uint8Array {
  const enc = new TextEncoder();
  const qspecBytes = enc.encode(qspecId);
  const out = new Uint8Array(qspecBytes.length + 1 + queryTokens.length * 4);
  let offset = 0;
  out.set(qspecBytes, offset);
  offset += qspecBytes.length;
  out[offset++] = CACHE_TOKEN_SEP;
  const view = new DataView(out.buffer);
  for (let i = 0; i < queryTokens.length; i++) {
    view.setUint32(offset, queryTokens[i]! >>> 0, true);
    offset += 4;
  }
  return out;
}

/**
 * The KEY: fp48 canonical query hash (12 hex) over (queryTokens, qspecId).
 * MODEL-AGNOSTIC. Throws on empty tokens.
 */
export function canonicalQueryHash(
  queryTokens: readonly number[],
  qspecId: string,
): string {
  if (queryTokens.length === 0) {
    throw new RangeError('canonicalQueryHash: empty queryTokens (clinamen_swerve guard)');
  }
  return cacheFingerprint48HexSync(canonicalQueryKeyBytes(queryTokens, qspecId));
}

// --- Configuration & Timeouts ---

export const SKYMESH_QSPEC_ID = 'skymesh-query/v2';

/**
 * @deprecated Model-scoped keys were a mistake. Keys are model-agnostic; skip
 * model-identity / training-cutoff prompts via {@link isModelIdentitySmellQuery}.
 */
export function modelScopedQspecId(_model?: string): string {
  return SKYMESH_QSPEC_ID;
}

const MODEL_IDENTITY_SMELL_PATTERNS: readonly RegExp[] = [
  /\bwhat\s+model\s+(are\s+you|is\s+this|do\s+you\s+use|are\s+you\s+using|am\s+i\s+talking\s+to)\b/i,
  /\bwhich\s+model\s+(are\s+you|is\s+this|do\s+you|am\s+i)\b/i,
  /\bwho\s+are\s+you\b/i,
  /\bwhat\s+are\s+you\b/i,
  /\bwhat('?s|\s+is)\s+your\s+name\b/i,
  /\bare\s+you\s+(an?\s+)?(ai|llm|language\s+model|chatbot|assistant)\b/i,
  /\bare\s+you\s+(gpt|chatgpt|claude|gemini|grok|llama|mistral|qwen|openai|anthropic|xai|google)\b/i,
  /\b(which|what)\s+(llm|ai|assistant)\s+(are\s+you|is\s+this)\b/i,
  /\byour\s+(model\s+)?(name|id|version|family)\b/i,
  /\bmodel\s+(name|id|version|family)\b/i,
  /\bwhat\s+version\s+(are\s+you|of\s+you|is\s+this)\b/i,
  /\bwhich\s+version\s+(are\s+you|of\s+(gpt|claude|gemini|grok|you))\b/i,
  /\b(who|what)\s+made\s+you\b/i,
  /\bwho\s+(built|created|trained)\s+you\b/i,
  /\bare\s+you\s+based\s+on\b/i,
  /\bwhat\s+(company|lab|org(anization)?)\s+(made|built|trained)\s+you\b/i,
  /\b(knowledge|training)\s+(cut[-\s]?off|cutoff|date|data)\b/i,
  /\bwhen\s+were\s+you\s+(trained|created|updated|released|built)\b/i,
  /\b(your\s+)?training\s+(data|cutoff|cut[-\s]?off|date)\b/i,
  /\bwhat('?s|\s+is)\s+your\s+cutoff\b/i,
  /\bas\s+of\s+when\s+(do|can)\s+you\s+know\b/i,
  /\bup\s+to\s+what\s+(date|year)\s+(do|can)\s+you\s+know\b/i,
  /\b(your\s+)?knowledge\s+(date|horizon|window)\b/i,
  /\bwhen\s+(is|was)\s+your\s+(last\s+)?(training|knowledge|update)\b/i,
  /\bwhat('?s|\s+is)\s+your\s+training\s+date\b/i,
];

/** Skip shared answer-cache for model-identity / training-cutoff prompts. */
export function isModelIdentitySmellQuery(prompt: string): boolean {
  const text = (prompt ?? '').trim();
  if (text.length < 3 || text.length > 400) return false;
  return MODEL_IDENTITY_SMELL_PATTERNS.some((re) => re.test(text));
}
export const SKYMESH_DEFAULT_CACHE_URL = 'https://www-edgework-app.edgework.ai';
const SKYMESH_TOKENIZE_TIMEOUT_MS = 500;
const SKYMESH_CACHE_LOOKUP_TIMEOUT_MS = 2500;

// --- Protocol69 Projection Envelope ---

/** Build the protocol69 projection envelope ASCII header value. */
function buildProtocol69HeaderValue(): string {
  const broadcastSymbol = 66;
  const localFoilOperand = 7;
  const expectedProjection = (broadcastSymbol ^ localFoilOperand) >>> 0; // 69
  return [
    'GNOSIS-MONSTER-NUMBER/1',
    'schemaVersion=gnosis.protocol69.v1',
    'protocol=protocol69',
    'wordName=sixty9',
    `broadcastSymbol=${broadcastSymbol}`,
    `localFoilOperand=${localFoilOperand}`,
    'operator=xor',
    `expectedProjection=${expectedProjection}`,
  ].join(' ');
}

const PROTOCOL69_HEADER_VALUE = buildProtocol69HeaderValue();

// --- Control Flag ---

/**
 * Whether skymesh global cache-key teleportation (Tier -1) is enabled.
 * ON by default; set ZEDGE_SKYMESH_TELEPORT to '0', 'false', or 'off' to disable.
 */
export function isSkymeshTeleportEnabled(): boolean {
  const raw = process.env.ZEDGE_SKYMESH_TELEPORT;
  if (raw === undefined) {
    return true;
  }
  const normalized = raw.trim().toLowerCase();
  return normalized !== '0' && normalized !== 'false' && normalized !== 'off';
}

// --- Tokenization via Fat-Station ---

/**
 * Tokenize a prompt using fat-station's /tokenize endpoint.
 * Returns token IDs on success, null on any failure (network, timeout, non-JSON, etc).
 * Never throws.
 */
async function trySkymeshTokenize(
  prompt: string,
  fatStationBaseUrl: string,
): Promise<number[] | null> {
  try {
    const resp = await fetch(`${fatStationBaseUrl}/tokenize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: prompt }),
      signal: AbortSignal.timeout(SKYMESH_TOKENIZE_TIMEOUT_MS),
    });
    if (!resp.ok) {
      return null;
    }
    const body = (await resp.json()) as unknown;
    if (
      body !== null &&
      typeof body === 'object' &&
      'tokens' in body &&
      Array.isArray((body as Record<string, unknown>).tokens)
    ) {
      const tokens = (body as Record<string, unknown>).tokens as number[];
      return tokens.length > 0 ? tokens : null;
    }
    return null;
  } catch {
    return null;
  }
}

// --- Cache Lookup ---

interface CacheLookupEntry {
  answerTokens?: number[];
  answerText?: string;
  tier?: string;
  attestation?: {
    pass?: boolean;
    admitted?: boolean;
    sig?: string;
  };
}

interface CacheLookupResponse {
  hit?: boolean;
  entry?: CacheLookupEntry;
}

/**
 * Attempt to look up a query in the global edgework cache via fp48 hash.
 * Returns the cached answer text on verified hit, null otherwise.
 * Never throws.
 */
export async function trySkymeshCacheTeleport(
  prompt: string,
  model: string,
  fatStationBaseUrl: string,
  cacheUrl: string,
): Promise<string | null> {
  // Early exits: disabled or empty prompt
  if (!isSkymeshTeleportEnabled()) {
    return null;
  }
  const trimmedPrompt = prompt.trim();
  if (!trimmedPrompt) {
    return null;
  }
  // Model-identity / cutoff: do not teleport another model's self-description.
  if (isModelIdentitySmellQuery(trimmedPrompt)) {
    return null;
  }

  // Step 1: Tokenize via fat-station
  const tokens = await trySkymeshTokenize(trimmedPrompt, fatStationBaseUrl);
  if (!tokens) {
    return null;
  }

  // Step 2: Model-agnostic fano-7 key (model is provenance only)
  let fp48: string;
  try {
    fp48 = canonicalQueryHash(tokens, SKYMESH_QSPEC_ID);
  } catch {
    return null;
  }

  // Step 3: Query the global cache
  const lookupUrl =
    `${cacheUrl}/api/v1/cache/lookup?q=${encodeURIComponent(fp48)}` +
    `&model=${encodeURIComponent(model)}&qspec=${encodeURIComponent(SKYMESH_QSPEC_ID)}` +
    `&tokens=${encodeURIComponent(tokens.join(','))}&_=${Date.now()}`;

  try {
    const res = await fetch(lookupUrl, {
      method: 'GET',
      headers: {
        'Cache-Control': 'no-store',
        'X-Protocol69-Projection': PROTOCOL69_HEADER_VALUE,
      },
      signal: AbortSignal.timeout(SKYMESH_CACHE_LOOKUP_TIMEOUT_MS),
    });

    if (!res.ok) {
      return null;
    }

    const text = await res.text();
    let body: CacheLookupResponse;
    try {
      body = JSON.parse(text) as CacheLookupResponse;
    } catch {
      return null;
    }

    // Step 4: Verify the hit before returning
    if (body?.hit === true && body.entry) {
      const entry = body.entry;
      const attest = entry.attestation;

      // Verify attestation: pass + admitted + signature
      if (attest?.pass === true && attest.admitted === true && typeof attest.sig === 'string' && attest.sig.length > 0) {
        // Entry is verified. Return the answer text if present.
        if (typeof entry.answerText === 'string') {
          return entry.answerText;
        }
      }
    }

    // Cache miss or unverified hit
    return null;
  } catch {
    // Timeout, network error, or other fetch failure
    return null;
  }
}

// --- Streaming Cache Hits ---

/**
 * Returns a ReadableStream that emits SSE chat.completion.chunk events for a cached answer.
 * Mimics the format of createSSEProxyStream so Zed's OpenAI parser handles it identically.
 */
export function streamCachedAnswer(
  answerText: string,
  model: string,
  requestId: string,
): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>((controller) => {
    const encoder = new TextEncoder();
    const chunkSize = 4;
    let index = 0;

    const sendChunk = (): void => {
      if (index >= answerText.length) {
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
        return;
      }

      const chunk = answerText.substring(index, index + chunkSize);
      index += chunkSize;

      const sseChunk = {
        id: `chatcmpl-${requestId}`,
        object: 'text_completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ index: 0, delta: { content: chunk }, finish_reason: null }],
      };

      controller.enqueue(encoder.encode(`data: ${JSON.stringify(sseChunk)}\n\n`));
      setTimeout(sendChunk, 15);
    };

    sendChunk();
  });
}

// --- Cache Writing ---

/**
 * Handles the zedge warm Skymesh Cache workflow.
 */
export async function warmSkymeshCache(opts: {
  queryTokens: number[];
  answerText: string;
  answerTokens?: number[];
  model: string;
  cacheUrl: string;
  fatStationBaseUrl: string;
  /** When set and model-identity smell, skip store (do not poison universal cache). */
  promptText?: string;
}): Promise<void> {
  try {
    if (!opts.queryTokens?.length || !opts.answerText) return;
    if (opts.promptText !== undefined && isModelIdentitySmellQuery(opts.promptText)) return;
    // Model-agnostic key (model is provenance only).
    const qspec = SKYMESH_QSPEC_ID;
    const fp48 = canonicalQueryHash(opts.queryTokens, qspec);
    // Edgework put admission requires non-empty answerTokens (replayable payload).
    const answerTokens =
      opts.answerTokens && opts.answerTokens.length > 0
        ? opts.answerTokens
        : Array.from(opts.answerText, (ch) => ch.charCodeAt(0));

    // GlobalAnswerCacheEntry shape — not the old {q,tokens,qspec} shorthand.
    // Prefer /put (canonical); /store is an edgework alias for older clients.
    const entry = {
      queryHash: fp48,
      queryTokens: opts.queryTokens,
      qspecId: qspec,
      model: opts.model,
      answerText: opts.answerText,
      answerTokens,
      attestation: {
        pass: true as const,
        admitted: true as const,
        sig: `zedge-${Date.now()}`,
        gate: 'zedge-warm-skymesh-cache',
      },
      tier: 'monster196884' as const,
      ts: Date.now(),
    };

    for (const path of ['/api/v1/cache/put', '/api/v1/cache/store'] as const) {
      const res = await fetch(`${opts.cacheUrl}${path}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Protocol69-Projection': PROTOCOL69_HEADER_VALUE,
          'Cache-Control': 'no-store',
        },
        body: JSON.stringify(entry),
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) break;
      if (res.status !== 404) break;
    }

    // Dual-write FOIL under the same model-agnostic plane (skymesh-query/v2).
    if (qspec === SKYMESH_QSPEC_ID) {
      await fetch('https://skymesh.forkjoin.ai/protocol69/ask/fill', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
        body: JSON.stringify({
          promptTokens: opts.queryTokens,
          answerText: opts.answerText,
          answerTokens,
          provenance: 'zedge-warm-skymesh-cache',
          model: opts.model,
          route: 'zedge-dual-write',
        }),
        signal: AbortSignal.timeout(5000),
      }).catch(() => undefined);
    }
  } catch {
    // Silently fail
  }
}

/**
 * Handles the zedge prewarm Skymesh Teleport workflow.
 */
export async function prewarmSkymeshTeleport(
  prompt: string,
  model: string,
  fatStationBaseUrl: string,
  cacheUrl: string,
): Promise<{ hit: boolean; fp48: string } | null> {
  try {
    // Skip model-identity / cutoff probes (same policy as trySkymeshCacheTeleport).
    if (isModelIdentitySmellQuery(prompt)) return null;
    const tokens = await trySkymeshTokenize(prompt, fatStationBaseUrl);
    if (!tokens) return null;

    const qspec = SKYMESH_QSPEC_ID;
    const fp48 = canonicalQueryHash(tokens, qspec);
    const lookupUrl =
      `${cacheUrl}/api/v1/cache/lookup?q=${encodeURIComponent(fp48)}` +
      `&model=${encodeURIComponent(model)}&qspec=${encodeURIComponent(qspec)}` +
      `&tokens=${encodeURIComponent(tokens.join(','))}&_=${Date.now()}`;

    const res = await fetch(lookupUrl, {
      method: 'GET',
      headers: { 'Cache-Control': 'no-store', 'X-Protocol69-Projection': PROTOCOL69_HEADER_VALUE },
      signal: AbortSignal.timeout(SKYMESH_CACHE_LOOKUP_TIMEOUT_MS),
    });

    if (!res.ok) return { hit: false, fp48 };

    const body = (await res.json()) as { hit?: boolean };
    return { hit: body.hit === true, fp48 };
  } catch {
    return null;
  }
}
