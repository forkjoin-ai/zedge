/**
 * Skymesh Global Bridge
 *
 * Makes the zedge companion a first-class node in the skymesh distributed inference
 * mesh. Connects via WebSocket to the relay, passes PARIS preflight, answers queries
 * from other nodes, and contributes local inference results back to the global cache.
 *
 * Team-scoped: bridge connects to meshId (which equals teamId when in a team context).
 * Default meshId is 'skymesh-global' (global partyline).
 */

import { getZedgeConfig } from './config.ts';
import { infer } from './inference-bridge.ts';
import {
  getMeshStatus,
  meshInfer,
  type MeshInferenceResult,
} from './p2p-mesh.ts';
import { trySkymeshCacheTeleport, warmSkymeshCache } from './skymesh-cache.ts';
import {
  MOONSHINE_BASE_URL,
  FAT_STATION_BASE_URL,
} from './inference-bridge.ts';

// --- Constants ---

const SKYMESH_PUBLIC_BASE = 'https://skymesh.forkjoin.ai';
const BRIDGE_RECONNECT_DELAY_MS = 5_000;
const BRIDGE_RECONNECT_MAX_MS = 60_000;
const BRIDGE_PING_INTERVAL_MS = 20_000;
const PREFLIGHT_TIMEOUT_MS = 10_000;
const QUERY_TIMEOUT_MS = 60_000;

// --- Types ---

export interface SkymeshBridgeStatus {
  running: boolean;
  meshId?: string;
  nodeId?: string;
  admitted: boolean;
  reconnectCount: number;
  pingSentAt?: number;
  models: string[];
  lanPeers: number;
}

interface PendingQuery {
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
  timeout: NodeJS.Timeout;
}

interface PendingPreflight {
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
  timeout: NodeJS.Timeout;
}

// --- Bridge State ---

const bridgeState: {
  ws: WebSocket | null;
  running: boolean;
  meshId: string;
  nodeId: string;
  admitted: boolean;
  reconnectCount: number;
  reconnectDelay: number;
  pingSentAt: number;
  models: string[];
  lanPeers: number;
  pendingQueries: Map<string, PendingQuery>;
  pendingPreflights: Map<string, PendingPreflight>;
  pingInterval: NodeJS.Timeout | null;
  reconnectTimeout: NodeJS.Timeout | null;
} = {
  ws: null,
  running: false,
  meshId: 'skymesh-global',
  nodeId: `zedge-${Math.random().toString(36).substring(7)}`,
  admitted: false,
  reconnectCount: 0,
  reconnectDelay: BRIDGE_RECONNECT_DELAY_MS,
  pingSentAt: 0,
  models: [],
  lanPeers: 0,
  pendingQueries: new Map(),
  pendingPreflights: new Map(),
  pingInterval: null,
  reconnectTimeout: null,
};

// --- Public API ---

export function startSkymeshBridge(opts: {
  meshId?: string;
  bridgeToken?: string;
  nodeId?: string;
  models?: string[];
  port?: number;
}): void {
  if (bridgeState.running) {
    return;
  }

  bridgeState.meshId = opts.meshId ?? 'skymesh-global';
  if (opts.nodeId) {
    bridgeState.nodeId = opts.nodeId;
  }
  bridgeState.models = opts.models ?? [];
  bridgeState.running = true;
  bridgeState.admitted = false;
  bridgeState.reconnectCount = 0;
  bridgeState.reconnectDelay = BRIDGE_RECONNECT_DELAY_MS;

  connectBridge(opts.bridgeToken);
}

export function stopSkymeshBridge(): void {
  if (!bridgeState.running) {
    return;
  }

  bridgeState.running = false;
  bridgeState.admitted = false;

  if (bridgeState.ws) {
    bridgeState.ws.close();
    bridgeState.ws = null;
  }

  if (bridgeState.pingInterval) {
    clearInterval(bridgeState.pingInterval);
    bridgeState.pingInterval = null;
  }

  if (bridgeState.reconnectTimeout) {
    clearTimeout(bridgeState.reconnectTimeout);
    bridgeState.reconnectTimeout = null;
  }

  bridgeState.pendingQueries.forEach((q) => {
    clearTimeout(q.timeout);
    q.reject(new Error('bridge stopped'));
  });
  bridgeState.pendingQueries.clear();

  bridgeState.pendingPreflights.forEach((p) => {
    clearTimeout(p.timeout);
    p.reject(new Error('bridge stopped'));
  });
  bridgeState.pendingPreflights.clear();
}

export function getSkymeshBridgeStatus(): SkymeshBridgeStatus {
  return {
    running: bridgeState.running,
    meshId: bridgeState.meshId,
    nodeId: bridgeState.nodeId,
    admitted: bridgeState.admitted,
    reconnectCount: bridgeState.reconnectCount,
    pingSentAt: bridgeState.pingSentAt > 0 ? bridgeState.pingSentAt : undefined,
    models: bridgeState.models,
    lanPeers: bridgeState.lanPeers,
  };
}

export function notifySkymeshBridgeOfLanPeer(): void {
  const status = getMeshStatus();
  bridgeState.lanPeers = status.peers.length;
}

export function removeLanPeerFromBridge(): void {
  const status = getMeshStatus();
  bridgeState.lanPeers = status.peers.length;
}

// --- Bridge Connection ---

function connectBridge(token?: string): void {
  if (bridgeState.ws) {
    return;
  }

  const base = process.env.ZEDGE_SKYMESH_PUBLIC_BASE ?? SKYMESH_PUBLIC_BASE;
  const url = new URL(`${base}/monitor/bridge`);
  url.searchParams.set('mesh', bridgeState.meshId);
  url.searchParams.set('node', bridgeState.nodeId);
  if (token) {
    url.searchParams.set('token', token);
  }

  const wsUrl = url.toString().replace(/^http/, 'ws');

  try {
    const ws = new WebSocket(wsUrl);

    ws.addEventListener('open', () => {
      bridgeState.ws = ws;
      bridgeState.reconnectDelay = BRIDGE_RECONNECT_DELAY_MS;
      bridgeState.reconnectCount = 0;

      sendHello();
      startPingInterval();
    });

    ws.addEventListener('message', (ev) => {
      if (typeof ev.data === 'string') {
        handleWebSocketMessage(JSON.parse(ev.data));
      }
    });

    ws.addEventListener('close', () => {
      bridgeState.ws = null;
      stopPingInterval();

      if (bridgeState.running) {
        scheduleReconnect();
      }
    });

    ws.addEventListener('error', (ev) => {
      console.error(`[skymesh-bridge] WS error:`, ev);
      bridgeState.ws = null;
      stopPingInterval();

      if (bridgeState.running) {
        scheduleReconnect();
      }
    });
  } catch (err) {
    console.error(`[skymesh-bridge] Failed to create WebSocket:`, err);
    if (bridgeState.running) {
      scheduleReconnect();
    }
  }
}

function scheduleReconnect(): void {
  if (!bridgeState.running) {
    return;
  }

  if (bridgeState.reconnectTimeout) {
    clearTimeout(bridgeState.reconnectTimeout);
  }

  const delay = Math.min(
    bridgeState.reconnectDelay * Math.pow(1.5, bridgeState.reconnectCount),
    BRIDGE_RECONNECT_MAX_MS
  );

  bridgeState.reconnectTimeout = setTimeout(() => {
    bridgeState.reconnectCount++;
    connectBridge();
  }, delay);
}

function sendHello(): void {
  if (!bridgeState.ws || bridgeState.ws.readyState !== WebSocket.OPEN) {
    return;
  }

  bridgeState.ws.send(
    JSON.stringify({
      type: 'hello',
      nodeId: bridgeState.nodeId,
      role: 'bridge',
      models: bridgeState.models,
      admitted: bridgeState.admitted,
    })
  );
}

// --- Ping / Keepalive ---

function startPingInterval(): void {
  if (bridgeState.pingInterval) {
    clearInterval(bridgeState.pingInterval);
  }

  bridgeState.pingInterval = setInterval(() => {
    if (bridgeState.ws && bridgeState.ws.readyState === WebSocket.OPEN) {
      bridgeState.pingSentAt = Date.now();
      bridgeState.ws.send(JSON.stringify({ type: 'ping' }));
    }
  }, BRIDGE_PING_INTERVAL_MS);
}

function stopPingInterval(): void {
  if (bridgeState.pingInterval) {
    clearInterval(bridgeState.pingInterval);
    bridgeState.pingInterval = null;
  }
}

// --- Message Handling ---

function handleWebSocketMessage(msg: Record<string, unknown>): void {
  const type = msg.type as string;

  switch (type) {
    case 'ping':
      if (bridgeState.ws && bridgeState.ws.readyState === WebSocket.OPEN) {
        bridgeState.ws.send(JSON.stringify({ type: 'pong' }));
      }
      break;

    case 'pong':
      // Acknowledged, nothing to do
      break;

    case 'preflight':
      handlePreflightMessage(msg).catch((err) => {
        console.error(`[skymesh-bridge] Preflight error:`, err);
      });
      break;

    case 'query':
      handleQueryMessage(msg).catch((err) => {
        console.error(`[skymesh-bridge] Query error:`, err);
      });
      break;

    case 'preflight-result':
      dispatchPreflightResult(msg);
      break;

    case 'query-result':
      dispatchQueryResult(msg);
      break;

    default:
      console.warn(`[skymesh-bridge] Unknown message type: ${type}`);
  }
}

// --- Preflight PARIS Probe ---

async function handlePreflightMessage(
  msg: Record<string, unknown>
): Promise<void> {
  const id = msg.id as string | undefined;
  if (!id) {
    return;
  }

  const t0 = Date.now();
  const probePrompt = 'the capital of France is';

  try {
    // Step 1: Tokenize
    const tokenRes = await fetch(`${FAT_STATION_BASE_URL}/tokenize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: probePrompt }),
      signal: AbortSignal.timeout(5000),
    });

    if (!tokenRes.ok) {
      sendMessage({
        type: 'preflight-result',
        id,
        pass: false,
        detail: `tokenize HTTP ${tokenRes.status}`,
      });
      return;
    }

    const tokenizerBody = (await tokenRes.json()) as Record<string, unknown>;
    const tokens = Array.isArray(tokenizerBody.tokens)
      ? tokenizerBody.tokens
      : null;

    if (!tokens || tokens.length === 0) {
      sendMessage({
        type: 'preflight-result',
        id,
        pass: false,
        detail: 'tokenizer returned no tokens',
      });
      return;
    }

    // Step 2: Run inference (max_tokens=1 — real probe)
    const inferRes = await fetch(`${MOONSHINE_BASE_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'default',
        messages: [{ role: 'user', content: probePrompt }],
        max_tokens: 1,
        stream: false,
      }),
      signal: AbortSignal.timeout(PREFLIGHT_TIMEOUT_MS),
    });

    if (!inferRes.ok) {
      sendMessage({
        type: 'preflight-result',
        id,
        pass: false,
        detail: `inference HTTP ${inferRes.status}`,
      });
      return;
    }

    const inferBody = (await inferRes.json()) as Record<string, unknown>;
    const choices = Array.isArray(inferBody.choices) ? inferBody.choices : [];
    const choice = choices[0] as Record<string, unknown> | undefined;
    const message = choice?.message as Record<string, unknown> | undefined;
    const text = message?.content as string | undefined;

    if (!text) {
      sendMessage({
        type: 'preflight-result',
        id,
        pass: false,
        detail: 'no response text',
      });
      return;
    }

    // Success
    bridgeState.admitted = true;
    sendMessage({
      type: 'preflight-result',
      id,
      pass: true,
      token: tokens[0] ?? 0,
      text,
      logit: 0,
      elapsedMs: Date.now() - t0,
      model: 'default',
    });
  } catch (err) {
    sendMessage({
      type: 'preflight-result',
      id,
      pass: false,
      detail: String(err),
    });
  }
}

// --- Query Handler ---

async function handleQueryMessage(msg: Record<string, unknown>): Promise<void> {
  const id = msg.id as string | undefined;
  const prompt = msg.prompt as string | undefined;
  const tokens = Array.isArray(msg.tokens)
    ? (msg.tokens as number[])
    : undefined;
  const maxTokens = msg.maxTokens as number | undefined;

  if (!id || !prompt) {
    return;
  }

  const t0 = Date.now();
  let reply = '';

  try {
    // Try cache hit first
    const cached = await trySkymeshCacheTeleport(
      prompt,
      'default',
      FAT_STATION_BASE_URL,
      'https://www-edgework-app.edgework.ai'
    );
    if (cached) {
      reply = cached;
      sendMessage({
        type: 'query-result',
        id,
        reply,
        promptTokens: tokens ?? [],
        outTokens: [],
        elapsedMs: Date.now() - t0,
        model: 'default',
        cached: true,
        cacheTier: 'skymesh-fp48',
      });
      return;
    }

    // Try local LAN mesh peers first
    const meshStatus = getMeshStatus();
    if (meshStatus.running && meshStatus.peers.length > 0) {
      try {
        const meshResult = await meshInfer({
          model: 'default',
          messages: [{ role: 'user', content: prompt }],
          max_tokens: maxTokens ?? 64,
          stream: false,
        });

        if (meshResult) {
          reply = meshResult.content;
          sendMessage({
            type: 'query-result',
            id,
            reply,
            promptTokens: tokens ?? [],
            outTokens: [],
            elapsedMs: Date.now() - t0,
            model: 'default',
            servedBy: meshResult.servedBy,
          });

          // Background: warm global cache
          if (tokens) {
            queueMicrotask(() => {
              warmSkymeshCache({
                queryTokens: tokens,
                answerText: reply,
                model: 'default',
                cacheUrl: 'https://www-edgework-app.edgework.ai',
                fatStationBaseUrl: FAT_STATION_BASE_URL,
              }).catch(() => {});
            });
          }

          return;
        }
      } catch {
        // Fall through to own inference
      }
    }

    // Own inference as fallback
    const inferResult = await infer({
      model: 'default',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: maxTokens ?? 64,
      stream: false,
    });

    if (inferResult.response.ok) {
      const body = (await inferResult.response.json()) as Record<
        string,
        unknown
      >;
      const choices = Array.isArray(body.choices) ? body.choices : [];
      const choice = choices[0] as Record<string, unknown> | undefined;
      const message = choice?.message as Record<string, unknown> | undefined;
      reply = (message?.content as string) ?? '';
    }

    sendMessage({
      type: 'query-result',
      id,
      reply,
      promptTokens: tokens ?? [],
      outTokens: [],
      elapsedMs: Date.now() - t0,
      model: 'default',
    });

    // Background: warm global cache
    if (tokens && reply) {
      queueMicrotask(() => {
        warmSkymeshCache({
          queryTokens: tokens,
          answerText: reply,
          model: 'default',
          cacheUrl: 'https://www-edgework-app.edgework.ai',
          fatStationBaseUrl: FAT_STATION_BASE_URL,
        }).catch(() => {});
      });
    }
  } catch (err) {
    sendMessage({
      type: 'query-result',
      id,
      reply: '',
      promptTokens: tokens ?? [],
      outTokens: [],
      elapsedMs: Date.now() - t0,
      model: 'default',
      detail: String(err),
    });
  }
}

// --- Pending Result Dispatch ---

function dispatchPreflightResult(msg: Record<string, unknown>): void {
  const id = msg.id as string | undefined;
  if (!id) {
    return;
  }

  const pending = bridgeState.pendingPreflights.get(id);
  if (pending) {
    clearTimeout(pending.timeout);
    bridgeState.pendingPreflights.delete(id);
    pending.resolve(msg);
  }
}

function dispatchQueryResult(msg: Record<string, unknown>): void {
  const id = msg.id as string | undefined;
  if (!id) {
    return;
  }

  const pending = bridgeState.pendingQueries.get(id);
  if (pending) {
    clearTimeout(pending.timeout);
    bridgeState.pendingQueries.delete(id);
    pending.resolve(msg);
  }
}

// --- Send Message ---

function sendMessage(msg: Record<string, unknown>): void {
  if (!bridgeState.ws || bridgeState.ws.readyState !== WebSocket.OPEN) {
    return;
  }

  bridgeState.ws.send(JSON.stringify(msg));
}
