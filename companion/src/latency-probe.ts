/**
 * Model Latency Probing
 *
 * On startup, pings each inference tier to measure latency.
 * Caches results and periodically re-probes.
 * Routes to the fastest healthy coordinator per model.
 */

import { getApiBaseUrl, getAuthHeaders } from './config.ts';
import { CLOUD_RUN_COORDINATORS } from './coordinator-urls.ts';
import { buildCloudRunHealthUrls } from './cloudrun-auth.ts';

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

/**
 * Returns whether is Reachable Coordinator Health Status is true.
 */
export function isReachableCoordinatorHealthStatus(status: number): boolean {
  // ONLY 2xx counts. 403 used to be treated as healthy on the theory that the
  // service is alive and merely wants IAM auth the probe does not send. That is
  // unsound as a routing signal on two counts:
  //   1. An unauthenticated 403 is refused at the Cloud Run front door, so the
  //      probe never reaches the container and its `latencyMs` measures the
  //      edge rejection, not the coordinator. Routing then ranks a lane it has
  //      never actually timed.
  //   2. It cannot distinguish "alive but locked" from "locked and dead" — a
  //      broken coordinator behind a 403 reads as healthy forever.
  // Since 2026-07-29 the monofat coordinators have no allUsers invoker binding,
  // so every anonymous probe gets 403; under the old rule all six would report
  // healthy and attract traffic that can only fail.
  return status >= 200 && status < 300;
}

/**
 * Cloud Run coordinator probing is OPT-IN and defaults to OFF.
 *
 * A 60s health probe defeats `min-instances=0`. Cloud Run keeps an instance
 * warm ~15 min after each request, so any ping faster than that pins the
 * instance permanently. This probe pinned all six CPU-middle coordinators at
 * ~24 billable instance-hours/day each — measured 2026-07-29 at ~$99/day
 * (5x 8vCPU/32GiB + 1x 4vCPU/16GiB, cpu-throttling=false). Same failure mode
 * as the 2026-06-15 L4 GPU drain.
 *
 * Infra belongs on Skymesh, not Cloud Run. Set ZEDGE_PROBE_CLOUDRUN=1 to
 * re-enable this lane deliberately, and expect the bill.
 */
export function isCloudRunProbeEnabled(): boolean {
  const raw = process.env.ZEDGE_PROBE_CLOUDRUN?.trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes';
}

export interface CloudRunHealthProbeResult {
  url: string;
  latencyMs: number;
  healthy: boolean;
  status: number;
}

/**
 * Handles the zedge probe Cloud Run Health workflow.
 */
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

  // console.log('[zedge:probe] Latency probing started (60s interval)');
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

  // Probe each Cloud Run coordinator (opt-in — see isCloudRunProbeEnabled)
  if (isCloudRunProbeEnabled()) {
    for (const [model, url] of Object.entries(CLOUD_RUN_COORDINATORS)) {
      promises.push(probeCloudRunEndpoint(model, url));
    }
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
      headers: tier === 'edge' || tier === 'cloudrun' ? getAuthHeaders() : {},
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
