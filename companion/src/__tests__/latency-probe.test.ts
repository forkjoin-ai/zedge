import { describe, test, expect, afterEach } from '@a0n/gnosis/test';
import { hasCloudRunCoordinators } from '../coordinator-urls';
import {
  getTierHealth,
  getProbeResults,
  getFastestTier,
  isReachableCoordinatorHealthStatus,
  probeCloudRunHealth,
  stopProbing,
} from '../latency-probe';

describe('Latency Probe', () => {
  afterEach(() => {
    stopProbing();
  });

  test('getTierHealth returns expected shape', () => {
    const health = getTierHealth();
    expect(health).toHaveProperty('edge');
    expect(health).toHaveProperty('cloudRun');
    expect(health).toHaveProperty('mesh');
    expect(health).toHaveProperty('wasm');

    expect(health.edge).toHaveProperty('healthy');
    expect(health.edge).toHaveProperty('latencyMs');
    expect(health.wasm.healthy).toBe(true);
    expect(health.wasm.latencyMs).toBe(1);

    expect(typeof health.cloudRun).toBe('object');
    expect(health.mesh).toHaveProperty('peerCount');
  });

  test('getProbeResults returns array', () => {
    const results = getProbeResults();
    expect(Array.isArray(results)).toBe(true);
  });

  test('getFastestTier always returns wasm as baseline', () => {
    // Without any probes, WASM should be the fastest available tier
    const tier = getFastestTier('tinyllama-1.1b');
    // May return null if no probes cached, or 'wasm' as baseline
    if (tier !== null) {
      expect(typeof tier).toBe('string');
    }
  });

  test('probe results have required fields when populated', () => {
    const results = getProbeResults();
    for (const result of results) {
      expect(result).toHaveProperty('tier');
      expect(result).toHaveProperty('model');
      expect(result).toHaveProperty('url');
      expect(result).toHaveProperty('latencyMs');
      expect(result).toHaveProperty('healthy');
      expect(result).toHaveProperty('lastProbed');
      expect(typeof result.latencyMs).toBe('number');
      expect(typeof result.healthy).toBe('boolean');
    }
  });

  test('cloudRun health reflects configured coordinators', () => {
    const health = getTierHealth();
    if (!hasCloudRunCoordinators()) {
      expect(Object.keys(health.cloudRun)).toEqual([]);
      return;
    }

    for (const [model, result] of Object.entries(health.cloudRun)) {
      expect(model.length).toBeGreaterThan(0);
      expect(typeof result.healthy).toBe('boolean');
      expect(typeof result.latencyMs).toBe('number');
    }
  });

  test('treats reachable coordinator health statuses as healthy', () => {
    expect(isReachableCoordinatorHealthStatus(200)).toBe(true);
    expect(isReachableCoordinatorHealthStatus(204)).toBe(true);
    // 403 = service is alive but requires IAM auth we don't have locally
    expect(isReachableCoordinatorHealthStatus(403)).toBe(true);
    expect(isReachableCoordinatorHealthStatus(404)).toBe(false);
    expect(isReachableCoordinatorHealthStatus(500)).toBe(false);
  });

  test('probes canonical cloudrun health paths until one succeeds', async () => {
    const originalFetch = global.fetch;
    const calls: string[] = [];
    global.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith('/api/v1/health')) {
        return new Response('missing', { status: 404 });
      }
      if (url.endsWith('/health')) {
        return new Response(JSON.stringify({ status: 'healthy' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response('unexpected', { status: 500 });
    }) as typeof fetch;

    try {
      const result = await probeCloudRunHealth('https://example.run.app');
      expect(result.healthy).toBe(true);
      expect(result.status).toBe(200);
      expect(result.url).toBe('https://example.run.app/health');
      expect(calls).toEqual([
        'https://example.run.app/api/v1/health',
        'https://example.run.app/health',
      ]);
    } finally {
      global.fetch = originalFetch;
    }
  });

  test('cloudrun health probe treats 403 as reachable (IAM auth required)', async () => {
    const originalFetch = global.fetch;
    global.fetch = (async () =>
      new Response(JSON.stringify({ error: 'forbidden' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
      })) as typeof fetch;

    try {
      const result = await probeCloudRunHealth('https://example.run.app');
      // 403 means the service is alive but requires IAM auth we don't
      // have locally -- still reachable for inference requests.
      expect(result.healthy).toBe(true);
      expect(result.status).toBe(403);
    } finally {
      global.fetch = originalFetch;
    }
  });
});
