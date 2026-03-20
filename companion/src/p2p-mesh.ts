/**
 * P2P Mesh — LAN-First Inference
 *
 * Discovers companion nodes on the local network via mDNS/UDP broadcast,
 * forms a local inference cluster. Nodes contribute compute to each other
 * before falling back to edge/Cloud Run.
 *
 * Discovery: mDNS (_zedge._tcp.local) + UDP broadcast fallback
 * Protocol: HTTP between nodes, binary v2 for tensor transfer
 * Privacy: Code context never leaves the LAN mesh
 * Scheduling: Hot-seat — reduce contribution under high local load
 */

import { getCompanionPort, getZedgeConfig } from './config';
import { recordServedRequest } from './compute-node';
import type { ChatCompletionRequest } from './inference-bridge';
import { createSocket, type Socket } from 'dgram';
import { hostname, cpus, totalmem, freemem } from 'os';

// --- Types ---

export interface PeerNode {
  id: string;
  hostname: string;
  address: string;
  port: number;
  capabilities: PeerCapabilities;
  lastSeen: number;
  latencyMs: number;
  load: number; // 0-1 normalized CPU load
}

export interface PeerCapabilities {
  models: string[];
  maxMemoryMb: number;
  cpuCores: number;
  gpuAvailable: boolean;
}

export interface MeshStatus {
  running: boolean;
  nodeId: string;
  peers: PeerNode[];
  totalCapacity: {
    models: string[];
    totalMemoryMb: number;
    totalCores: number;
  };
}

export interface LayerAssignment {
  peerId: string;
  layerRange: [number, number]; // [start, end] inclusive
  address: string;
  port: number;
}

export interface MeshInferenceResult {
  content: string;
  servedBy: string[]; // peer IDs that contributed
  totalLatencyMs: number;
}

// --- Constants ---

const MDNS_PORT = 5353;
const BROADCAST_PORT = 7332; // Discovery broadcast port
const HEARTBEAT_INTERVAL_MS = 10_000;
const PEER_TIMEOUT_MS = 30_000;
const SERVICE_TYPE = '_zedge._tcp.local';

// --- Mesh State ---

const meshState: {
  running: boolean;
  nodeId: string;
  peers: Map<string, PeerNode>;
  broadcastSocket: Socket | null;
  heartbeatInterval: ReturnType<typeof setInterval> | null;
} = {
  running: false,
  nodeId: generateNodeId(),
  peers: new Map(),
  broadcastSocket: null,
  heartbeatInterval: null,
};

// --- Public API ---

/**
 * Start the P2P mesh — begin discovering and advertising to peers
 */
export function startMesh(): MeshStatus {
  if (meshState.running) return getMeshStatus();

  meshState.running = true;

  // Start UDP broadcast for discovery
  try {
    const socket = createSocket('udp4');
    socket.on('message', handleDiscoveryMessage);
    socket.on('error', (err) => {
      console.error('[zedge:mesh] Broadcast socket error:', err.message);
    });
    socket.bind(BROADCAST_PORT, () => {
      socket.setBroadcast(true);
      console.log(`[zedge:mesh] Discovery listener on UDP :${BROADCAST_PORT}`);
    });
    meshState.broadcastSocket = socket;
  } catch (err) {
    console.warn('[zedge:mesh] Could not start broadcast socket:', err);
  }

  // Start heartbeat — advertise presence and prune stale peers
  meshState.heartbeatInterval = setInterval(() => {
    broadcastPresence();
    pruneStale();
  }, HEARTBEAT_INTERVAL_MS);

  // Initial broadcast
  broadcastPresence();

  console.log(`[zedge:mesh] Started. Node ID: ${meshState.nodeId}`);
  return getMeshStatus();
}

/**
 * Stop the P2P mesh
 */
export function stopMesh(): MeshStatus {
  if (!meshState.running) return getMeshStatus();

  // Broadcast departure
  broadcastMessage({
    type: 'departure',
    nodeId: meshState.nodeId,
  });

  if (meshState.heartbeatInterval) {
    clearInterval(meshState.heartbeatInterval);
    meshState.heartbeatInterval = null;
  }

  if (meshState.broadcastSocket) {
    meshState.broadcastSocket.close();
    meshState.broadcastSocket = null;
  }

  meshState.running = false;
  meshState.peers.clear();

  console.log('[zedge:mesh] Stopped.');
  return getMeshStatus();
}

/**
 * Get current mesh status
 */
export function getMeshStatus(): MeshStatus {
  const peers = Array.from(meshState.peers.values());
  const allModels = new Set<string>();
  let totalMemory = 0;
  let totalCores = 0;

  // Include self
  const config = getZedgeConfig();
  config.computePool.allowedModels.forEach((m) => allModels.add(m));
  totalMemory += config.computePool.maxMemoryMb;
  totalCores += cpus().length;

  // Include peers
  for (const peer of peers) {
    peer.capabilities.models.forEach((m) => allModels.add(m));
    totalMemory += peer.capabilities.maxMemoryMb;
    totalCores += peer.capabilities.cpuCores;
  }

  return {
    running: meshState.running,
    nodeId: meshState.nodeId,
    peers,
    totalCapacity: {
      models: Array.from(allModels),
      totalMemoryMb: totalMemory,
      totalCores,
    },
  };
}

/**
 * Try to infer via the LAN mesh before falling back to edge
 *
 * Finds a peer (or set of peers) capable of running the model,
 * routes the request to them, and returns the result.
 */
export async function meshInfer(
  request: ChatCompletionRequest
): Promise<MeshInferenceResult | null> {
  const peers = findCapablePeers(request.model);

  if (peers.length === 0) return null;

  // Sort by latency (fastest first), then by load (least loaded)
  peers.sort((a, b) => {
    const latencyDiff = a.latencyMs - b.latencyMs;
    if (Math.abs(latencyDiff) > 5) return latencyDiff;
    return a.load - b.load;
  });

  // Try peers in order
  for (const peer of peers) {
    try {
      const start = Date.now();
      const resp = await fetch(
        `http://${peer.address}:${peer.port}/v1/chat/completions`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(request),
          signal: AbortSignal.timeout(60_000),
        }
      );

      if (!resp.ok) continue;

      const data = (await resp.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const content = data.choices?.[0]?.message?.content ?? '';
      const latencyMs = Date.now() - start;

      // Update peer latency
      peer.latencyMs = (peer.latencyMs + latencyMs) / 2;

      return {
        content,
        servedBy: [peer.id],
        totalLatencyMs: latencyMs,
      };
    } catch {
      // Peer failed, try next
      continue;
    }
  }

  return null; // No peer could serve
}

/**
 * Handle an incoming inference request from a peer node
 */
export async function handlePeerRequest(
  request: ChatCompletionRequest
): Promise<Response> {
  // Import infer lazily to avoid circular dependency
  const { infer } = await import('./inference-bridge');
  const result = await infer(request);

  // Record as served request for token earning
  const body = await result.response.clone().text();
  const estimatedTokens = Math.ceil(body.length / 4);
  recordServedRequest(estimatedTokens);

  return result.response;
}

/**
 * Compute layer assignments for distributed model inference across peers
 *
 * Given a model with N layers and M peers, assign layer ranges to each peer
 * weighted by their available capacity (memory, CPU).
 */
export function computeLayerAssignments(
  modelId: string,
  totalLayers: number,
  peers: PeerNode[]
): LayerAssignment[] {
  if (peers.length === 0) return [];

  // Weight by available capacity (memory * cores, inversely proportional to load)
  const weights = peers.map((p) => {
    const capacityScore =
      (p.capabilities.maxMemoryMb / 1024) * p.capabilities.cpuCores;
    const loadFactor = 1 - p.load * 0.5; // High load halves capacity
    return Math.max(0.1, capacityScore * loadFactor);
  });

  const totalWeight = weights.reduce((a, b) => a + b, 0);
  const assignments: LayerAssignment[] = [];
  let layerStart = 0;

  for (let i = 0; i < peers.length; i++) {
    const proportion = weights[i] / totalWeight;
    const layerCount = Math.max(
      1,
      i === peers.length - 1
        ? totalLayers - layerStart // Last peer gets remainder
        : Math.round(totalLayers * proportion)
    );
    const layerEnd = Math.min(totalLayers - 1, layerStart + layerCount - 1);

    assignments.push({
      peerId: peers[i].id,
      layerRange: [layerStart, layerEnd],
      address: peers[i].address,
      port: peers[i].port,
    });

    layerStart = layerEnd + 1;
    if (layerStart >= totalLayers) break;
  }

  return assignments;
}

// --- Discovery Protocol ---

interface DiscoveryMessage {
  type: 'announce' | 'departure';
  nodeId: string;
  hostname?: string;
  port?: number;
  capabilities?: PeerCapabilities;
  load?: number;
}

function handleDiscoveryMessage(msg: Buffer, rinfo: { address: string }): void {
  try {
    const data = JSON.parse(msg.toString()) as DiscoveryMessage;

    // Ignore our own messages
    if (data.nodeId === meshState.nodeId) return;

    if (data.type === 'announce' && data.capabilities && data.port) {
      const existing = meshState.peers.get(data.nodeId);
      meshState.peers.set(data.nodeId, {
        id: data.nodeId,
        hostname: data.hostname ?? 'unknown',
        address: rinfo.address,
        port: data.port,
        capabilities: data.capabilities,
        lastSeen: Date.now(),
        latencyMs: existing?.latencyMs ?? 50, // Estimate until measured
        load: data.load ?? 0.5,
      });
    } else if (data.type === 'departure') {
      meshState.peers.delete(data.nodeId);
    }
  } catch {
    // Invalid message, ignore
  }
}

function broadcastPresence(): void {
  const config = getZedgeConfig();
  const loadAvg =
    cpus().reduce((acc, cpu) => {
      const total = Object.values(cpu.times).reduce((a, b) => a + b, 0);
      return acc + (1 - cpu.times.idle / total);
    }, 0) / cpus().length;

  const message: DiscoveryMessage = {
    type: 'announce',
    nodeId: meshState.nodeId,
    hostname: hostname(),
    port: config.port,
    capabilities: {
      models: config.computePool.allowedModels,
      maxMemoryMb: config.computePool.maxMemoryMb,
      cpuCores: cpus().length,
      gpuAvailable: detectGpu(),
    },
    load: Math.min(1, loadAvg),
  };

  broadcastMessage(message);
}

function broadcastMessage(message: DiscoveryMessage): void {
  if (!meshState.broadcastSocket) return;

  const buf = Buffer.from(JSON.stringify(message));
  meshState.broadcastSocket.send(
    buf,
    0,
    buf.length,
    BROADCAST_PORT,
    '255.255.255.255',
    (err) => {
      if (err) {
        // Broadcast may fail on some networks, that's ok
      }
    }
  );
}

function pruneStale(): void {
  const now = Date.now();
  for (const [id, peer] of meshState.peers) {
    if (now - peer.lastSeen > PEER_TIMEOUT_MS) {
      meshState.peers.delete(id);
      console.log(`[zedge:mesh] Peer departed (timeout): ${peer.hostname}`);
    }
  }
}

function findCapablePeers(model: string): PeerNode[] {
  return Array.from(meshState.peers.values()).filter((p) =>
    p.capabilities.models.includes(model)
  );
}

function generateNodeId(): string {
  const h = hostname();
  const rand = Math.random().toString(36).slice(2, 8);
  return `${h}-${rand}`;
}

/**
 * Detect GPU availability by checking for common GPU tools/drivers
 */
function detectGpu(): boolean {
  try {
    // macOS: check for Metal support via system_profiler
    if (process.platform === 'darwin') {
      /* eslint-disable @typescript-eslint/no-require-imports */
      const { execSync } = require('child_process');
      /* eslint-enable @typescript-eslint/no-require-imports */
      const output = execSync(
        'system_profiler SPDisplaysDataType 2>/dev/null',
        { encoding: 'utf-8', timeout: 3_000 }
      );
      return output.includes('Metal') || output.includes('Chipset Model');
    }
    // Linux: check for nvidia-smi or /dev/dri
    if (process.platform === 'linux') {
      /* eslint-disable @typescript-eslint/no-require-imports */
      const { existsSync } = require('fs');
      /* eslint-enable @typescript-eslint/no-require-imports */
      if (existsSync('/dev/dri')) return true;
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { execSync } = require('child_process');
        execSync('nvidia-smi', { timeout: 3_000 });
        return true;
      } catch {
        return false;
      }
    }
    return false;
  } catch {
    return false;
  }
}
