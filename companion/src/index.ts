#!/usr/bin/env bun
/**
 * Zedge Companion Sidecar v2.0
 *
 * Bun.serve runs synchronously in the entry file. ALL module imports
 * happen inside setTimeout(0) to ensure the event loop is never blocked.
 * Top-level await causes Bun.serve to stop dispatching external requests
 * during module evaluation.
 */

console.log('[zedge] Starting companion sidecar v2.0...');

let handler: (req: Request) => Promise<Response> = async () =>
  new Response('Companion is loading...', { status: 503 });

Bun.serve({
  port: 7331,
  fetch(req: Request) {
    return handler(req);
  },
});

console.log('[zedge] Listening on http://localhost:7331 (loading...)');

// ALL imports happen here -- never at top level
setTimeout(async () => {
  try {
    const serverMod = await import('./server');

    handler = async (req: Request) => {
      try {
        return await serverMod.handleWebRequest(req);
      } catch (err) {
        console.error(`[zedge:fetch] Error:`, err);
        return new Response(`Internal Server Error: ${err}`, { status: 500 });
      }
    };

    console.log('[zedge] Companion sidecar v2.0 ready');
    console.log('[zedge] OpenAI-compatible API: http://localhost:7331/v1');
    console.log('[zedge] Health: http://localhost:7331/health');

    // Stage 2: Auth, mesh, probing
    const { whoami } = await import('./auth');
    const { getZedgeConfig, getApiBaseUrl, getAuthHeaders } = await import('./config');
    const config = getZedgeConfig();

    const authStatus = whoami();
    if (authStatus.authenticated) {
      console.log(
        `[zedge] Authenticated via ${authStatus.method}${authStatus.email ? ` (${authStatus.email})` : ''}`
      );
      verifyKeyTier(getApiBaseUrl, getAuthHeaders).catch(() => {});
    } else {
      console.log('[zedge] Not authenticated.');
    }

    const { startProbing } = await import('./latency-probe');
    startProbing();

    const { startMesh, getMeshStatus } = await import('./p2p-mesh');
    const mesh = startMesh();
    console.log(`[zedge] Mesh started. Node ID: ${mesh.nodeId}`);

    if (config.computePool.enabled) {
      const { joinPool, getPoolStatus } = await import('./compute-node');
      await joinPool();
      console.log(`[zedge] Pool: ${getPoolStatus().connectedNodes} nodes`);
    }

    serverMod.startGnosisWatcher();

    // Stage 3: Heavy bridges
    const [
      { ForgeBridge }, { VfsBridge }, { CollabBridge },
      { KernelBridge }, { CapacitorBridge }, { CrdtBridge }, { UcanBridge },
    ] = await Promise.all([
      import('./forge-bridge'), import('./vfs-bridge'), import('./collab-bridge'),
      import('./kernel-bridge'), import('./capacitor-bridge'),
      import('./crdt-bridge'), import('./ucan-bridge'),
    ]);

    const workspacePath = process.cwd();
    const forge = new ForgeBridge(workspacePath);
    serverMod.setForgeBridge(forge);
    const projects = await forge.discoverProjects();
    console.log(`[zedge] Forge: ${projects.length} project(s) discovered`);

    const meshNodeId = getMeshStatus().nodeId;
    const displayName = authStatus.email ?? `zedge-${meshNodeId.slice(0, 8)}`;
    serverMod.setVfsBridge(new VfsBridge(meshNodeId));
    serverMod.setCollabBridge(new CollabBridge(meshNodeId, displayName));

    const kernel = new KernelBridge();
    serverMod.setKernelBridge(kernel);
    kernel.registerPlugin({
      id: 'zedge-companion', name: 'Zedge Companion', version: '2.0.0',
      capabilities: ['inference', 'superinference', 'mesh', 'forge-deploy', 'vfs', 'collab', 'capacitor', 'compute-market'],
      commands: [],
    });
    console.log(`[zedge] Kernel: ${kernel.listCommands().length} commands`);
    serverMod.setCapacitorBridge(new CapacitorBridge());

    const crdtCfg = {
      workspaceId: Buffer.from(workspacePath).toString('base64url').slice(0, 16),
      peerId: meshNodeId, displayName,
      relayUrl: config.dashRelayUrl, ucan: config.ucanToken, apiKey: config.dashRelayApiKey,
    };
    const crdt = new CrdtBridge(crdtCfg);
    serverMod.setCrdtBridge(crdt);
    try { await crdt.connect(); } catch { console.log('[zedge] CRDT offline.'); }

    const ucan = new UcanBridge({
      secret: config.dashRelayApiKey ?? `zedge-local-${meshNodeId}`,
      workspaceId: crdtCfg.workspaceId, peerId: meshNodeId, displayName,
    });
    try { await ucan.init(); serverMod.setUcanBridge(ucan); } catch {}

    // Disabled: code indexer causes persistent high CPU
    // import('./code-index').then(({ codeIndex }) =>
    //   codeIndex.indexWorkspace(workspacePath).catch(() => {})
    // ).catch(() => {});

    setTimeout(() => {
      import('./inference-bridge')
        .then(({ startLocalWasmWarmup }) => void startLocalWasmWarmup())
        .catch(() => {});
    }, 1_000);

    // Wire Phase 3 integrations (void map → trainer, engram embeddings)
    setTimeout(() => {
      import('./wire-phase3')
        .then(({ wirePhase3 }) => wirePhase3())
        .then((status) => {
          console.log(
            `[zedge] Phase 3 wired: trainer=${status.buleyeanTrainerActive}, engrams=${status.totalEngramsStored}`
          );
        })
        .catch(() => {});
    }, 2_000);

    console.log(`[zedge] Ready. Mesh peers: ${getMeshStatus().peers.length}`);
  } catch (err) {
    console.error('[zedge] Init error:', err);
  }
}, 0);

async function verifyKeyTier(getBaseUrl: () => string, getHeaders: () => Record<string, string>) {
  try {
    const resp = await fetch(`${getBaseUrl()}/v1/models`, { headers: getHeaders(), signal: AbortSignal.timeout(10_000) });
    const n = resp.ok ? ((await resp.json()) as any)?.data?.length ?? '?' : '?';
    console.log(`[zedge] Gateway: models=${n} status=${resp.status}`);
  } catch (err) {
    console.warn(`[zedge] Gateway probe failed: ${err}`);
  }
}
