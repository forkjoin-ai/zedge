#!/usr/bin/env node
/**
 * Zedge Companion Sidecar v2.0
 *
 * The companion now exports an async `main()` so the checked-in launcher can
 * route the full sidecar through `gnode`. The HTTP listener itself comes from
 * `startServer()`, which binds through x-gnosis on either Bun or Node.
 */

async function verifyKeyTier(
  getBaseUrl: () => string,
  getHeaders: () => Record<string, string>
): Promise<void> {
  try {
    const resp = await fetch(`${getBaseUrl()}/v1/models`, {
      headers: getHeaders(),
      signal: AbortSignal.timeout(10_000),
    });
    const payload = resp.ok
      ? ((await resp.json()) as {
          data?: unknown[];
        })
      : null;
    const count = payload?.data?.length ?? '?';
    console.log(`[zedge] Gateway: models=${count} status=${resp.status}`);
  } catch (err) {
    console.warn(`[zedge] Gateway probe failed: ${err}`);
  }
}

export async function main(): Promise<void> {
  console.log('[zedge] Starting companion sidecar v2.0...');

  try {
    const serverMod = await import('./server');
    await serverMod.startServer();

    console.log('[zedge] Companion sidecar v2.0 ready');

    const { whoami } = await import('./auth');
    const { getZedgeConfig, getApiBaseUrl, getAuthHeaders } = await import(
      './config'
    );
    const config = getZedgeConfig();

    const authStatus = whoami();
    if (authStatus.authenticated) {
      console.log(
        `[zedge] Authenticated via ${authStatus.method}${authStatus.email ? ` (${authStatus.email})` : ''}`
      );
      void verifyKeyTier(getApiBaseUrl, getAuthHeaders);
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

    const [
      { ForgeBridge },
      { VfsBridge },
      { CollabBridge },
      { KernelBridge },
      { CapacitorBridge },
      { CrdtBridge },
      { UcanBridge },
    ] = await Promise.all([
      import('./forge-bridge'),
      import('./vfs-bridge'),
      import('./collab-bridge'),
      import('./kernel-bridge'),
      import('./capacitor-bridge'),
      import('./crdt-bridge'),
      import('./ucan-bridge'),
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
    console.log(`[zedge] Kernel: ${kernel.listCommands().length} commands`);
    serverMod.setCapacitorBridge(new CapacitorBridge());

    const crdtCfg = {
      workspaceId: Buffer.from(workspacePath).toString('base64url').slice(0, 16),
      peerId: meshNodeId,
      displayName,
      relayUrl: config.dashRelayUrl,
      ucan: config.ucanToken,
      apiKey: config.dashRelayApiKey,
    };
    const crdt = new CrdtBridge(crdtCfg);
    serverMod.setCrdtBridge(crdt);
    try {
      await crdt.connect();
    } catch {
      console.log('[zedge] CRDT offline.');
    }

    const ucan = new UcanBridge({
      secret: config.dashRelayApiKey ?? `zedge-local-${meshNodeId}`,
      workspaceId: crdtCfg.workspaceId,
      peerId: meshNodeId,
      displayName,
    });
    try {
      await ucan.init();
      serverMod.setUcanBridge(ucan);
    } catch {
      // Keep the companion up even when UCAN bootstrap fails locally.
    }

    setTimeout(() => {
      import('./inference-bridge')
        .then(({ startLocalWasmWarmup }) => void startLocalWasmWarmup())
        .catch(() => {});
    }, 1_000);

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
    throw err instanceof Error ? err : new Error(String(err));
  }
}
