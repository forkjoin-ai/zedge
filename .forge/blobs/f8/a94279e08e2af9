#!/usr/bin/env node
/**
 * Zedge Companion Sidecar v2.0
 *
 * The companion now exports an async `main()` so the checked-in launcher can
 * route the full sidecar through `gnode`. The HTTP listener itself comes from
 * `startServer()`, which binds through x-gnosis on either Bun or Node.
 */

import { existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const LAUNCH_AGENT_LABEL = 'ai.forkjoin.zedge.sidecar';

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
    // console.log(`[zedge] Gateway: models=${count} status=${resp.status}`);
  } catch (err) {
    console.warn(`[zedge] Gateway probe failed: ${err}`);
  }
}

async function companionAlreadyRunning(): Promise<boolean> {
  const port = process.env.ZEDGE_COMPANION_PORT ?? '7331';
  try {
    const resp = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(1_000),
    });
    return resp.ok;
  } catch {
    return false;
  }
}

function shouldYieldToLaunchAgent(): boolean {
  if (process.platform !== 'darwin') return false;
  if (process.env.ZEDGE_ALLOW_DIRECT_SIDECAR === '1') return false;
  if (process.env.XPC_SERVICE_NAME === LAUNCH_AGENT_LABEL) return false;
  return existsSync(
    join(homedir(), 'Library/LaunchAgents', `${LAUNCH_AGENT_LABEL}.plist`)
  );
}

async function waitForExistingCompanion(timeoutMs = 15_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await companionAlreadyRunning()) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

/** Normalizes unknown thrown values for log messages. */
function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isAddressInUseError(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    (error as Error & { code?: string }).code === 'EADDRINUSE'
  );
}

/** Refreshes the live model catalog and writes it into Zed's static picker config. */
async function syncZedSettingsFromModelCatalog(): Promise<void> {
  const [
    { getModels },
    { syncZedgeProviderAccess },
    {
      getCompanionPort,
      isDefaultModelMigrationPending,
      markDefaultModelMigrated,
      readZedgeDefaultModelPin,
    },
    { DEFAULT_ZEDGE_PREFERRED_MODEL_ID, isSupersededDefaultModelId },
  ] = await Promise.all([
    import('./inference-bridge.ts'),
    import('./zed-provider-sync.ts'),
    import('./config.ts'),
    import('./model-catalog.ts'),
  ]);
  const port = getCompanionPort();
  const models = await getModels({ refresh: true, refreshTimeoutMs: 5_000 });

  // One-time migration of a stale default pin. Zed keeps whatever model it was
  // handed, and the catalog sync only rewrites a pin that has left
  // `available_models` — so a default from two product generations ago
  // (mistral-7b) survived every boot. Migrate exactly once, and only when the
  // pin is an old SHIPPED default: a deliberate pick of anything else is never
  // touched, and once recorded this never fires again.
  const pinnedModel = readZedgeDefaultModelPin();
  const migrateStalePin =
    pinnedModel !== null &&
    isSupersededDefaultModelId(pinnedModel) &&
    isDefaultModelMigrationPending();

  const syncResult = syncZedgeProviderAccess(
    port,
    models.map((model) => model.id),
    process.env.ZEDGE_MOONSHINE_MODEL ??
      (migrateStalePin ? DEFAULT_ZEDGE_PREFERRED_MODEL_ID : undefined)
  );

  if (migrateStalePin) {
    markDefaultModelMigrated();
    console.log(
      `[zedge] Migrated Zed default model ${pinnedModel} -> ${DEFAULT_ZEDGE_PREFERRED_MODEL_ID} ` +
        '(stale pin from an older shipped default; runs once)'
    );
  }
  if (syncResult.keychain.updated) {
    console.log(
      `[zedge] Seeded Zedge API key in macOS keychain for ${syncResult.keychain.apiUrl}`
    );
  } else if (syncResult.keychain.error) {
    console.warn(
      `[zedge] Keychain seed skipped: ${syncResult.keychain.error}`
    );
  }
  if (syncResult.settings.updatedPaths.length > 0) {
    console.log(
      `[zedge] Synced Zedge provider settings: ${syncResult.settings.updatedPaths.join(', ')}`
    );
  }
}

/**
 * Companion boot may start the watchdog, but must not birth fat-station.
 * Watchdog only repairs after explicit demand (infer / model-use / doctor).
 */
async function startMoonshineAndSyncZedSettings(): Promise<void> {
  try {
    const { startMoonshineRuntimeWatchdog } = await import(
      './moonshine-docker.ts'
    );
    startMoonshineRuntimeWatchdog();
  } catch (err) {
    console.warn(`[moonshine] Startup failed: ${getErrorMessage(err)}`);
  }

  try {
    await syncZedSettingsFromModelCatalog();
  } catch (error) {
    console.warn(
      `[zedge] Zed settings sync skipped: ${getErrorMessage(error)}`
    );
  }
}

/**
 * Runs the zedge command-line workflow.
 */
export async function main(): Promise<void> {
  // console.log('[zedge] Starting companion sidecar v2.0...');

  await runCompanionBootstrap();
  return;
}

async function runCompanionBootstrap(): Promise<void> {
  try {
    const { clearCompanionActivityOnBoot } = await import(
      './companion-activity.ts'
    );
    clearCompanionActivityOnBoot();

    if (await companionAlreadyRunning()) {
      // console.log('[zedge] Companion already running; direct launch exiting.');
      return;
    }
    if (shouldYieldToLaunchAgent() && (await waitForExistingCompanion())) {
      console.log(
        '[zedge] Launch agent companion became healthy; direct launch exiting.'
      );
      return;
    }

    const serverMod = await import('./server.ts');
    await serverMod.startServer();

    // Start Moonshine and then sync Zed's static picker from the live catalog.
    void startMoonshineAndSyncZedSettings();

    // console.log('[zedge] Companion sidecar v2.0 ready');

    const { whoami } = await import('./auth.ts');
    const { getZedgeConfig, getApiBaseUrl, getAuthHeaders } = await import(
      './config.ts'
    );
    const config = getZedgeConfig();

    const authStatus = whoami();
    if (authStatus.authenticated) {
      console.log(
        `[zedge] Authenticated via ${authStatus.method}${
          authStatus.email ? ` (${authStatus.email})` : ''
        }`
      );
      void verifyKeyTier(getApiBaseUrl, getAuthHeaders);
    } else {
      // console.log('[zedge] Not authenticated.');
    }

    const { startProbing } = await import('./latency-probe.ts');
    startProbing();

    const { startMesh, getMeshStatus } = await import('./p2p-mesh.ts');
    const mesh = startMesh();
    // console.log(`[zedge] Mesh started. Node ID: ${mesh.nodeId}`);

    if (config.computePool.enabled) {
      const { joinPool, getPoolStatus } = await import('./compute-node.ts');
      await joinPool();
      // console.log(`[zedge] Pool: ${getPoolStatus().connectedNodes} nodes`);
    }

    const [
      { VfsBridge },
      { CollabBridge },
      { KernelBridge },
      { CapacitorBridge },
    ] = await Promise.all([
      import('./vfs-bridge.ts'),
      import('./collab-bridge.ts'),
      import('./kernel-bridge.ts'),
      import('./capacitor-bridge.ts'),
    ]);

    const workspacePath = process.cwd();
    try {
      const { ForgeBridge } = await import('./forge-bridge.ts');
      const forge = new ForgeBridge(workspacePath);
      const projects = await forge.discoverProjects();
      serverMod.setForgeBridge(forge);
      // console.log(`[zedge] Forge: ${projects.length} project(s) discovered`);
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
    // console.log(`[zedge] Kernel: ${kernel.listCommands().length} commands`);
    serverMod.setCapacitorBridge(new CapacitorBridge());

    const crdtCfg = {
      workspaceId: Buffer.from(workspacePath)
        .toString('base64url')
        .slice(0, 16),
      peerId: meshNodeId,
      displayName,
      relayUrl: config.dashRelayUrl,
      ucan: config.ucanToken,
      apiKey: config.dashRelayApiKey,
    };
    try {
      const { CrdtBridge } = await import('./crdt-bridge.ts');
      const crdt = new CrdtBridge(crdtCfg);
      serverMod.setCrdtBridge(crdt);
      await crdt.connect();
    } catch {
      // console.log('[zedge] CRDT offline.');
    }

    try {
      const { UcanBridge } = await import('./ucan-bridge.ts');
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
        import('./inference-bridge.ts')
          .then(({ startLocalWasmWarmup }) => void startLocalWasmWarmup())
          .catch(() => {});
      }, 1_000);
    }

    setTimeout(() => {
      import('./wire-phase3.ts')
        .then(({ wirePhase3 }) => wirePhase3())
        .then((status) => {
          console.log(
            `[zedge] Phase 3 wired: trainer=${status.buleyeanTrainerActive}, engrams=${status.totalEngramsStored}`
          );
        })
        .catch(() => {});
    }, 2_000);

    // console.log(`[zedge] Ready. Mesh peers: ${getMeshStatus().peers.length}`);
  } catch (err) {
    if (isAddressInUseError(err)) {
      console.log(
        '[zedge] Companion bind raced an existing listener; direct launch exiting.'
      );
      return;
    }

    console.error('[zedge] Init error:', err);
    throw err instanceof Error ? err : new Error(String(err));
  }
}
