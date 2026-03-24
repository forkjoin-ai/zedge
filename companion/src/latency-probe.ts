/**
 * Model Latency Probing
 *
 * On startup, pings each inference tier to measure latency.
 * Caches results and periodically re-probes.
 * Routes to the fastest healthy coordinator per model.
 */

import { getApiBaseUrl, getAuthHeaders } from "./config.ts";
import { CLOUD_RUN_COORDINATORS } from "./coordinator-urls.ts";
import { buildCloudRunHealthUrls } from "./cloudrun-auth.ts";

// --- Types ---

export interface ProbeResult {
  tier: string;
  model: string;
  url: string;
  latencyMs: number;
  healthy: boolean;
  lastProbed: number;
}

export interface TierHealth {
  edge: { healthy: boolean; latencyMs: number };
  cloudRun: Record<string, { healthy: boolean; latencyMs: number }>;
  mesh: { healthy: boolean; peerCount: number };
  wasm: { healthy: boolean; latencyMs: number };
}

// --- State ---

const probeCache = new Map<string, ProbeResult>();
const PROBE_INTERVAL_MS = 60_000; // Re-probe every 60s
const PROBE_TIMEOUT_MS = 5_000;

// Cloud Run coordinator URLs imported from coordinator-urls.ts (single source of truth)

let probeInterval: ReturnType<typeof setInterval> | null = null;
let probeAbortController: AbortController | null = null;

export function isReachableCoordinatorHealthStatus(status: number): boolean {
  // 2xx = healthy. 403 = service is alive but requires IAM auth we don't have
  // locally -- still reachable for inference (which sends its own auth).
  return (status >= 200 && status < 300) || status === 403;
}

export interface CloudRunHealthProbeResult {
  url: string;
  latencyMs: number;
  healthy: boolean;
  status: number;
}

export async function probeCloudRunHealth(
  baseUrl: string,
  timeoutMs = PROBE_TIMEOUT_MS
): Promise<CloudRunHealthProbeResult> {
  const candidateUrls = buildCloudRunHealthUrls(baseUrl);
  const startedAt = Date.now();
  let lastStatus = 0;
  let lastUrl = candidateUrls[0] ?? baseUrl;

  for (const url of candidateUrls) {
    lastUrl = url;
    const probeStartedAt = Date.now();
    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: {},
        signal: AbortSignal.timeout(timeoutMs),
      });
      lastStatus = response.status;
      if (isReachableCoordinatorHealthStatus(response.status)) {
        return {
          url,
          latencyMs: Date.now() - probeStartedAt,
          healthy: true,
          status: response.status,
        };
      }
    } catch {
      // Try the next canonical health path before marking the coordinator dead.
    }
  }

  return {
    url: lastUrl,
    latencyMs: Date.now() - startedAt,
    healthy: false,
    status: lastStatus,
  };
}

// --- Public API ---

/**
 * Start latency probing — runs immediately then every 60s
 */
export function startProbing(): void {
  if (probeInterval) return;

  probeAbortController = new AbortController();

  // Probe immediately (non-blocking)
  probeAll().catch(() => {});

  // Re-probe periodically
  probeInterval = setInterval(() => {
    probeAll().catch(() => {});
  }, PROBE_INTERVAL_MS);

  console.log('[zedge:probe] Latency probing started (60s interval)');
}

/**
 * Stop latency probing
 */
export function stopProbing(): void {
  if (probeAbortController) {
    probeAbortController.abort();
    probeAbortController = null;
  }
  if (probeInterval) {
    clearInterval(probeInterval);
    probeInterval = null;
  }
}

/**
 * Get the fastest healthy tier for a given model
 */
export function getFastestTier(model: string): string | null {
  const candidates: ProbeResult[] = [];

  // Check edge
  const edge = probeCache.get('edge:global');
  if (edge && edge.healthy) {
    candidates.push(edge);
  }

  // Check Cloud Run for this model
  const cloudRun = probeCache.get(`cloudrun:${model}`);
  if (cloudRun && cloudRun.healthy) {
    candidates.push(cloudRun);
  }

  // WASM is always available
  candidates.push({
    tier: 'wasm',
    model: 'wasm-local',
    url: 'local',
    latencyMs: 1, // Near-instant
    healthy: true,
    lastProbed: Date.now(),
  });

  if (candidates.length === 0) return null;

  // Sort by latency, return fastest
  candidates.sort((a, b) => a.latencyMs - b.latencyMs);
  return candidates[0].tier;
}

/**
 * Get full tier health report
 */
export function getTierHealth(): TierHealth {
  const edge = probeCache.get('edge:global');
  const cloudRunHealth: Record<
    string,
    { healthy: boolean; latencyMs: number }
  > = {};

  for (const model of Object.keys(CLOUD_RUN_COORDINATORS)) {
    const probe = probeCache.get(`cloudrun:${model}`);
    cloudRunHealth[model] = probe
      ? { healthy: probe.healthy, latencyMs: probe.latencyMs }
      : { healthy: false, latencyMs: -1 };
  }

  return {
    edge: edge
      ? { healthy: edge.healthy, latencyMs: edge.latencyMs }
      : { healthy: false, latencyMs: -1 },
    cloudRun: cloudRunHealth,
    mesh: { healthy: false, peerCount: 0 }, // Mesh health comes from p2p-mesh
    wasm: { healthy: true, latencyMs: 1 },
  };
}

/**
 * Get all cached probe results
 */
export function getProbeResults(): ProbeResult[] {
  return Array.from(probeCache.values());
}

// --- Internal ---

/**
 * Probe all tiers
 */
async function probeAll(): Promise<void> {
  const promises: Promise<void>[] = [];

  // Probe edge coordinator
  promises.push(
    probeEndpoint('edge', 'global', `${getApiBaseUrl()}/v1/models`)
  );

  // Probe each Cloud Run coordinator
  for (const [model, url] of Object.entries(CLOUD_RUN_COORDINATORS)) {
    promises.push(probeCloudRunEndpoint(model, url));
  }

  await Promise.allSettled(promises);
}

async function probeCloudRunEndpoint(
  model: string,
  baseUrl: string
): Promise<void> {
  const key = `cloudrun:${model}`;
  const result = await probeCloudRunHealth(baseUrl);
  probeCache.set(key, {
    tier: 'cloudrun',
    model,
    url: result.url,
    latencyMs: result.latencyMs,
    healthy: result.healthy,
    lastProbed: Date.now(),
  });
}

/**
 * Probe a single endpoint
 */
async function probeEndpoint(
  tier: string,
  model: string,
  url: string
): Promise<void> {
  const key = `${tier}:${model}`;
  const start = Date.now();

  try {
    const resp = await fetch(url, {
      method: 'GET',
      headers:
        tier === 'edge' || tier === 'cloudrun' ? getAuthHeaders() : {},
      signal: probeAbortController
        ? AbortSignal.any([
            AbortSignal.timeout(PROBE_TIMEOUT_MS),
            probeAbortController.signal,
          ])
        : AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });

    const latencyMs = Date.now() - start;
    probeCache.set(key, {
      tier,
      model,
      url,
      latencyMs,
      healthy: isReachableCoordinatorHealthStatus(resp.status),
      lastProbed: Date.now(),
    });
  } catch {
    const latencyMs = Date.now() - start;
    probeCache.set(key, {
      tier,
      model,
      url,
      latencyMs,
      healthy: false,
      lastProbed: Date.now(),
    });
  }
}
