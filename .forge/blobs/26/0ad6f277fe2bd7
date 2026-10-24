/**
 * Zed's "Zedge's servers are temporarily unavailable" banner is a 0-byte
 * stall, not a Cloudflare outage. The local fat-station /generate holds a
 * request gate for the whole forward; /health stays 200 because it try_locks
 * the inner pipeline between tokens. Companion used to wait 90s, treat the
 * abort as a dead listener, and repair a healthy :8080 shim.
 *
 * Pin the route, not a live generate: driving infer() here would need the
 * laptop station.
 */
import { describe, expect, test } from '@a0n/gnosis/test';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const here = dirname(fileURLToPath(import.meta.url));
const bridgeSource = readFileSync(
  join(here, '..', 'inference-bridge.ts'),
  'utf8'
);
const serverSource = readFileSync(join(here, '..', 'server.ts'), 'utf8');

function moonshineRepairGate(): string {
  const start = bridgeSource.indexOf('function moonshineFailureWorthRepair');
  const end = bridgeSource.indexOf('function moonshineStationBusyResponse');
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return bridgeSource.slice(start, end);
}

function moonshineTier(): string {
  const start = bridgeSource.indexOf('async function runMoonshineTier');
  const end = bridgeSource.indexOf(
    '// --- Forkjoin distributed-inference tier'
  );
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return bridgeSource.slice(start, end);
}

describe('Moonshine busy vs Zed timeout', () => {
  test('a hung generate is not treated as a dead listener', () => {
    const gate = moonshineRepairGate();
    expect(gate).toContain('econnrefused');
    expect(gate).toContain('socket hang up');
    // Timeout/abort used to trigger ensureMoonshineRunning, which killed a
    // healthy shim sitting in front of a busy station.
    expect(gate.includes("lower.includes('aborted')")).toBe(false);
    expect(gate.includes("lower.includes('timeout')")).toBe(false);
    expect(gate.includes('httpStatus === 503')).toBe(false);
  });

  test('inflight generate fails closed before joining the station mutex', () => {
    const tier = moonshineTier();
    const probeAt = tier.indexOf('probeFatStationInflight');
    const generateAt = tier.indexOf('tryMoonshineInference');
    expect(probeAt).toBeGreaterThanOrEqual(0);
    expect(generateAt).toBeGreaterThan(probeAt);
    expect(tier).toContain('station inflight=');
    expect(tier).toContain('moonshineStationBusyResponse');
  });

  test('Zed streaming gets an assistant-role chunk before infer()', () => {
    const start = serverSource.indexOf(
      "if (path === '/v1/chat/completions' && req.method === 'POST')"
    );
    const end = serverSource.indexOf(
      'const inferRequest = { ...request, stream: false }'
    );
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const route = serverSource.slice(start, end);
    // buildUpstream is declared first (so `await infer` appears earlier in
    // the file); runtime order is enqueue-then-infer via this start() body.
    const keepaliveAt = route.indexOf(
      'controller.enqueue(zedOpenAiRoleChunk(request.model))'
    );
    const inferAt = route.indexOf('await buildUpstream()');
    expect(keepaliveAt).toBeGreaterThanOrEqual(0);
    expect(inferAt).toBeGreaterThan(keepaliveAt);
    expect(route).toContain('await infer(request)');
    expect(route).toContain('zedOpenAiKeepaliveChunk(request.model)');
    expect(route).toContain('15_000');
    const agenticKeepalive = route.indexOf(
      'controller.enqueue(zedOpenAiRoleChunk(request.model))'
    );
    const agenticRun = route.indexOf('runCompanionAgenticChatCompletion(');
    expect(agenticKeepalive).toBeGreaterThanOrEqual(0);
    expect(agenticRun).toBeGreaterThan(agenticKeepalive);
    // SSE comments are rejected by Zed's OpenAI-compatible provider.
    expect(route.includes(': zedge')).toBe(false);
  });

  test('non-stream Moonshine 503 is forwarded, not rewritten to 200 echo', () => {
    const start = serverSource.indexOf(
      'const inferRequest = { ...request, stream: false }'
    );
    const end = serverSource.indexOf(
      'const data = await extractResponseData(result.response)'
    );
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const route = serverSource.slice(start, end);
    expect(route).toContain('if (!result.response.ok)');
    expect(route).toContain('status: result.response.status');
  });
});
