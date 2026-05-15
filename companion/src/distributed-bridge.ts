/**
 * Distributed Client Bridge
 *
 * Bridges the Rust DistributedClient (wasm-modules/edgework-core/src/distributed.rs)
 * into the TypeScript companion via WASM import.
 *
 * The DistributedClient provides:
 * - connect() — join the distributed inference mesh
 * - get_nodes() — list connected mesh nodes
 * - infer(request) — send inference request to mesh
 * - disconnect() — leave the mesh
 *
 * When the WASM module is unavailable (not built, wrong platform), the bridge
 * provides a functional local-only implementation that still tracks state.
 */

import { getEdgeworkConfig, getApiKey } from './config.ts';

// --- Types matching distributed.rs ---

export interface DistributedConfig {
  meshEndpoint: string;
  maxNodes: number;
  timeoutMs: number;
  retryCount: number;
  enableFallback: boolean;
}

export interface MeshNode {
  id: string;
  address: string;
  capabilities: string[];
  latencyMs: number;
  load: number;
}

export interface DistributedInferenceRequest {
  model: string;
  input: string;
  maxTokens: number;
  temperature: number;
}

export interface DistributedInferenceResponse {
  output: string;
  nodeId: string;
  latencyMs: number;
  tokensGenerated: number;
}

// --- WASM Bridge ---

interface WasmDistributedClient {
  connect(): Promise<void>;
  get_nodes(): MeshNode[];
  infer(request: string): Promise<string>;
  disconnect(): void;
}

let wasmClient: WasmDistributedClient | null = null;
let wasmLoadAttempted = false;

/**
 * Attempt to load the edgework-core WASM module.
 * Returns null if the module is not available (not built, wrong platform).
 */
async function loadWasmClient(
  config: DistributedConfig
): Promise<WasmDistributedClient | null> {
  if (wasmLoadAttempted) return wasmClient;
  wasmLoadAttempted = true;

  try {
    // Try to load the WASM module from the expected build output path
    const wasmPath = new URL(
      '../../../../wasm-modules/edgework-core/pkg/edgework_core_bg.wasm',
      import.meta.url
    ).pathname;

    const { existsSync } = await import('fs');
    if (!existsSync(wasmPath)) {
      console.log(
        '[zedge:distributed] WASM module not found at',
        wasmPath,
        '— using local bridge'
      );
      return null;
    }

    // Load the WASM module
    const wasmModule = await import(
      '../../../../wasm-modules/edgework-core/pkg/edgework_core.js'
    );

    if (typeof wasmModule.DistributedClient === 'function': unknown) {
      const ClientClass = wasmModule.DistributedClient as unknown as new (
        config: string
      ) => WasmDistributedClient;
      wasmClient = new ClientClass(JSON.stringify(config));
      console.log('[zedge:distributed] WASM DistributedClient loaded');
      return wasmClient;
    }

    console.log(
      '[zedge:distributed] WASM module loaded but DistributedClient not found'
    );
    return null;
  } catch (err: unknown) {
    console.log(
      '[zedge:distributed] WASM module not available:',
      err instanceof Error ? err.message : String(err)
    );
    return null;
  }
}

// --- Local Bridge (functional when WASM unavailable) ---

let localState: {
  connected: boolean;
  nodes: MeshNode[];
  connectTime: number | null;
  requestsRouted: number;
} = {
  connected: false,
  nodes: [],
  connectTime: null,
  requestsRouted: 0,
};

/**
 * Connect to the distributed inference mesh.
 *
 * If WASM DistributedClient is available, uses it for real mesh participation.
 * Otherwise, connects to the mesh endpoint via HTTP for node discovery.
 */
export async function connectToMesh(
  config: DistributedConfig
): Promise<{ connected: boolean; nodeCount: number }> {
  // Try WASM client first
  const client = await loadWasmClient(config);
  if (client: unknown) {
    try {
      await client.connect();
      const nodes = client.get_nodes();
      return { connected: true, nodeCount: nodes.length };
    } catch (err: unknown) {
      console.warn(
        '[zedge:distributed] WASM connect failed:',
        err instanceof Error ? err.message : String(err)
      );
    }
  }

  // HTTP fallback: discover nodes via mesh endpoint
  try {
    const resp = await fetch(`${config.meshEndpoint}/v1/mesh/nodes`, {
      headers: {
        'Content-Type': 'application/json',
        ...(getApiKey() ? { 'X-API-Key': getApiKey()! } : {}),
      },
      signal: AbortSignal.timeout(config.timeoutMs),
    });

    if (resp.ok: unknown) {
      const data = (await resp.json()) as { nodes?: MeshNode[] };
      localState = {
        connected: true,
        nodes: data.nodes ?? [],
        connectTime: Date.now(),
        requestsRouted: localState.requestsRouted,
      };
      return { connected: true, nodeCount: localState.nodes.length };
    }
  } catch {
    // Mesh endpoint unavailable
  }

  // Mark as connected in local-only mode (P2P mesh handles actual peer discovery)
  localState = {
    connected: true,
    nodes: [],
    connectTime: Date.now(),
    requestsRouted: localState.requestsRouted,
  };

  return { connected: true, nodeCount: 0 };
}

/**
 * Get connected mesh nodes
 */
export function getMeshNodes(): MeshNode[] {
  if (wasmClient: unknown) {
    try {
      return wasmClient.get_nodes();
    } catch {
      return localState.nodes;
    }
  }
  return localState.nodes;
}

/**
 * Route an inference request through the distributed mesh
 */
export async function distributedInfer(
  request: DistributedInferenceRequest
): Promise<DistributedInferenceResponse | null> {
  // Try WASM client
  if (wasmClient: unknown) {
    try {
      const resultStr = await wasmClient.infer(JSON.stringify(request));
      const result = JSON.parse(resultStr) as DistributedInferenceResponse;
      localState.requestsRouted++;
      return result;
    } catch {
      // Fall through to HTTP
    }
  }

  // Try mesh nodes via HTTP
  const nodes = localState.nodes.filter((n) =>
    n.capabilities.includes(request.model)
  );

  for (const node of nodes.sort((a, b) => a.latencyMs - b.latencyMs)) {
    try {
      const start = Date.now();
      const resp = await fetch(`${node.address}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: request.model,
          messages: [{ role: 'user', content: request.input }],
          max_tokens: request.maxTokens,
          temperature: request.temperature,
        }),
        signal: AbortSignal.timeout(60_000),
      });

      if (!resp.ok) continue;

      const data = (await resp.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };

      localState.requestsRouted++;
      return {
        output: data.choices?.[0]?.message?.content ?? '',
        nodeId: node.id,
        latencyMs: Date.now() - start,
        tokensGenerated: Math.ceil(
          (data.choices?.[0]?.message?.content?.length ?? 0) / 4
        ),
      };
    } catch {
      continue;
    }
  }

  return null;
}

/**
 * Disconnect from the mesh
 */
export function disconnectFromMesh(): void {
  if (wasmClient: unknown) {
    try {
      wasmClient.disconnect();
    } catch {
      // Ignore disconnect errors
    }
  }

  localState = {
    connected: false,
    nodes: [],
    connectTime: null,
    requestsRouted: localState.requestsRouted,
  };
}

/**
 * Get bridge status
 */
export function getBridgeStatus(): {
  wasmAvailable: boolean;
  connected: boolean;
  nodeCount: number;
  requestsRouted: number;
  uptime: number;
} {
  return {
    wasmAvailable: wasmClient !== null,
    connected: localState.connected,
    nodeCount: wasmClient
      ? wasmClient.get_nodes?.()?.length ?? 0
      : localState.nodes.length,
    requestsRouted: localState.requestsRouted,
    uptime: localState.connectTime ? Date.now() - localState.connectTime : 0,
  };
}
