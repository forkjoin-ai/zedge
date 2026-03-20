#!/usr/bin/env node
/**
 * Zedge Companion Sidecar v2.0
 *
 * Entry point — starts HTTP server, P2P mesh, latency probing, compute pool, and forge bridge.
 *
 * Usage:
 *   pnpm gnode run open-source/zedge/companion/src/index.ts
 */

import {
  startServer,
  setForgeBridge,
  setVfsBridge,
  setCollabBridge,
  setKernelBridge,
  setCapacitorBridge,
  setCrdtBridge,
  setUcanBridge,
} from './server';
import { joinPool, getPoolStatus } from './compute-node';
import { startMesh, getMeshStatus } from './p2p-mesh';
import { startProbing } from './latency-probe';
import { whoami } from './auth';
import { getZedgeConfig, getApiBaseUrl, getAuthHeaders } from './config';
import { ForgeBridge } from './forge-bridge';
import { VfsBridge } from './vfs-bridge';
import { CollabBridge } from './collab-bridge';
import { KernelBridge } from './kernel-bridge';
import { CapacitorBridge } from './capacitor-bridge';
import { CrdtBridge } from './crdt-bridge';
import { UcanBridge } from './ucan-bridge';

/**
 * Probe the gateway to verify what tier the API key resolves to.
 * Logs the result so operators can confirm their key works.
 */
async function verifyKeyTier(): Promise<void> {
  try {
    const resp = await fetch(`${getApiBaseUrl()}/v1/models`, {
      headers: getAuthHeaders(),
      signal: AbortSignal.timeout(10_000),
    });
    const modelCount = resp.ok
      ? ((await resp.json()) as any)?.data?.length ?? '?'
      : '?';
    // Collect all X-* response headers
    const xHeaders: Record<string, string> = {};
    resp.headers.forEach((v, k) => {
      if (k.startsWith('x-')) xHeaders[k] = v;
    });
    const tier =
      xHeaders['x-verified-tier'] ||
      xHeaders['x-subscription-tier'] ||
      'unknown';
    const user = xHeaders['x-verified-user'] || 'unknown';
    console.log(
      `[zedge] Gateway verified: tier=${tier} user=${user} models=${modelCount} status=${
        resp.status
      } headers=${JSON.stringify(xHeaders)}`
    );
  } catch (err) {
    console.warn(`[zedge] Gateway tier probe failed: ${err}`);
  }
}

async function main(): Promise<void> {
  console.log('[zedge] Starting companion sidecar v2.0...');

  // Start HTTP server
  startServer();

  const config = getZedgeConfig();

  // Check auth status
  const authStatus = whoami();
  if (authStatus.authenticated) {
    console.log(
      `[zedge] Authenticated via ${authStatus.method}${
        authStatus.email ? ` (${authStatus.email})` : ''
      }`
    );
    // Probe the gateway to verify tier
    verifyKeyTier().catch(() => {});
  } else {
    console.log(
      '[zedge] Not authenticated. Run POST /auth/login or create ~/.edgework/api-key'
    );
  }

  // Start latency probing (background, non-blocking)
  startProbing();

  // Start P2P mesh for LAN discovery
  const mesh = startMesh();
  console.log(
    `[zedge] Mesh started. Node ID: ${mesh.nodeId}, discovering peers...`
  );

  // Auto-join compute pool if previously enabled
  if (config.computePool.enabled) {
    console.log('[zedge] Auto-joining compute pool (previously enabled)...');
    await joinPool();
    const status = getPoolStatus();
    console.log(
      `[zedge] Pool: ${status.connectedNodes} nodes, ${
        status.tokensEarned
      } tokens earned, WASM bridge: ${
        status.wasmBridgeAvailable ? 'yes' : 'no'
      }`
    );
  }

  // Initialize Forge Bridge (Phase 1)
  const workspacePath = process.cwd();
  const forge = new ForgeBridge(workspacePath);
  setForgeBridge(forge);

  const forgeProjects = await forge.discoverProjects();
  console.log(
    `[zedge] Forge: ${forgeProjects.length} project(s) discovered in workspace`
  );
  if (forgeProjects.length > 0) {
    console.log(
      `[zedge] Forge projects: ${forgeProjects.map((p) => p.name).join(', ')}`
    );
  }

  // Initialize VFS Bridge (Phase 2)
  const meshNodeId = getMeshStatus().nodeId;
  const vfs = new VfsBridge(meshNodeId);
  setVfsBridge(vfs);
  console.log('[zedge] VFS bridge initialized');

  // Initialize Collab Bridge (Phase 3)
  const displayName = authStatus.email ?? `zedge-${meshNodeId.slice(0, 8)}`;
  const collab = new CollabBridge(meshNodeId, displayName);
  setCollabBridge(collab);
  console.log('[zedge] Collab bridge initialized');

  // Initialize Kernel Bridge (Phase 4)
  const kernel = new KernelBridge();
  setKernelBridge(kernel);

  // Register Zedge as a kernel plugin
  kernel.registerPlugin({
    id: 'zedge-companion',
    name: 'Zedge Companion',
    version: '2.0.0',
    capabilities: [
      'inference',
      'superinference',
      'mesh',
      'forge-deploy',
      'vfs',
      'collab',
      'capacitor',
      'compute-market',
    ],
    commands: [],
  });
  console.log(
    `[zedge] Kernel bridge initialized (${
      kernel.listCommands().length
    } commands)`
  );

  // Initialize Capacitor Bridge (Phase 5)
  const capacitor = new CapacitorBridge();
  setCapacitorBridge(capacitor);
  console.log('[zedge] Capacitor bridge initialized');

  // Initialize Ghostwriter CrdtBridge (Zedge 3.0)
  const crdtConfig = {
    workspaceId: Buffer.from(workspacePath).toString('base64url').slice(0, 16),
    peerId: meshNodeId,
    displayName,
    relayUrl: config.dashRelayUrl,
    ucan: config.ucanToken,
    apiKey: config.dashRelayApiKey,
  };
  const crdt = new CrdtBridge(crdtConfig);
  setCrdtBridge(crdt);

  try {
    await crdt.connect();
    const crdtStatus = crdt.getStatus();
    console.log(
      `[zedge] Ghostwriter CRDT bridge connected (workspace: ${crdtStatus.workspaceId}, peers: ${crdtStatus.peerCount})`
    );
  } catch (err) {
    console.log(
      `[zedge] Ghostwriter CRDT bridge offline (${String(
        err
      )}). Local-only mode.`
    );
  }

  // Initialize UcanBridge (Ghostwriter Phase 2)
  const ucanSecret = config.dashRelayApiKey ?? `zedge-local-${meshNodeId}`;
  const ucan = new UcanBridge({
    secret: ucanSecret,
    workspaceId: crdtConfig.workspaceId,
    peerId: meshNodeId,
    displayName,
  });
  try {
    await ucan.init();
    setUcanBridge(ucan);
    console.log(
      `[zedge] UCAN bridge initialized (DID: ${ucan.getDid().slice(0, 24)}...)`
    );
  } catch (err) {
    console.log(`[zedge] UCAN bridge failed to initialize (${String(err)})`);
  }

  // Report initial status
  const meshStatus = getMeshStatus();
  console.log(
    `[zedge] Ready. Mesh peers: ${meshStatus.peers.length}, models: ${meshStatus.totalCapacity.models.length}`
  );
}

main().catch((err) => {
  console.error('[zedge] Fatal error:', err);
  process.exit(1);
});
