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

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function main(): Promise<void> {
  console.log('[zedge] Starting companion sidecar v2.0...');

  await runCompanionBootstrap();
  return;
}

async function runCompanionBootstrap(): Promise<void> {
  try {
    const serverMod = await import("./server.ts");
    await serverMod.startServer();

    console.log('[zedge] Companion sidecar v2.0 ready');

    void Promise.all([
      import("./inference-bridge.ts"),
      import("./zed-settings.ts"),
    ])
      .then(async ([{ getModels }, { syncZedSettingsModelCatalog }]) => {
        const models = await getModels();
        const syncResult = syncZedSettingsModelCatalog(
          models.map((model) => model.id)
        );
        if (syncResult.updatedPaths.length > 0) {
          console.log(
            `[zedge] Synced ${models.length} models into Zed settings: ${syncResult.updatedPaths.join(', ')}`
          );
        }
      })
      .catch((error) => {
        console.warn(
          `[zedge] Zed settings sync skipped: ${getErrorMessage(error)}`
        );
      });

    const { whoami } = await import("./auth.ts");
    const { getZedgeConfig, getApiBaseUrl, getAuthHeaders } = await import(
      "./config.ts"
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

    const { startProbing } = await import("./latency-probe.ts");
    startProbing();

    const { startMesh, getMeshStatus } = await import("./p2p-mesh.ts");
    const mesh = startMesh();
    console.log(`[zedge] Mesh started. Node ID: ${mesh.nodeId}`);

    if (config.computePool.enabled) {
      const { joinPool, getPoolStatus } = await import("./compute-node.ts");
      await joinPool();
      console.log(`[zedge] Pool: ${getPoolStatus().connectedNodes} nodes`);
    }

    const [
      { VfsBridge },
      { CollabBridge },
      { KernelBridge },
      { CapacitorBridge },
    ] = await Promise.all([
      import("./vfs-bridge.ts"),
      import("./collab-bridge.ts"),
      import("./kernel-bridge.ts"),
      import("./capacitor-bridge.ts"),
    ]);

    const workspacePath = process.cwd();
    try {
      const { ForgeBridge } = await import("./forge-bridge.ts");
      const forge = new ForgeBridge(workspacePath);
      const projects = await forge.discoverProjects();
      serverMod.setForgeBridge(forge);
      console.log(`[zedge] Forge: ${projects.length} project(s) discovered`);
    } catch (error) {
      console.warn(
        `[zedge] Forge unavailable: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }

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
    try {
      const { CrdtBridge } = await import("./crdt-bridge.ts");
      const crdt = new CrdtBridge(crdtCfg);
      serverMod.setCrdtBridge(crdt);
      await crdt.connect();
    } catch {
      console.log('[zedge] CRDT offline.');
    }

    try {
      const { UcanBridge } = await import("./ucan-bridge.ts");
      const ucan = new UcanBridge({
        secret: config.dashRelayApiKey ?? `zedge-local-${meshNodeId}`,
        workspaceId: crdtCfg.workspaceId,
        peerId: meshNodeId,
        displayName,
      });
      await ucan.init();
      serverMod.setUcanBridge(ucan);
    } catch {
      // Keep the companion up even when UCAN bootstrap fails locally.
    }

    if (process.env.ZEDGE_ENABLE_GNOSIS_WATCHER === '1') {
      setTimeout(() => {
        try {
          serverMod.startGnosisWatcher();
        } catch {
          // Best-effort background startup only.
        }
      }, 500);
    }

    if (process.env.ZEDGE_AUTO_WASM_WARMUP === '1') {
      setTimeout(() => {
        import("./inference-bridge.ts")
          .then(({ startLocalWasmWarmup }) => void startLocalWasmWarmup())
          .catch(() => {});
      }, 1_000);
    }

    setTimeout(() => {
      import("./wire-phase3.ts")
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
