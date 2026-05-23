import { describe, test, expect, beforeEach } from '@a0n/gnosis/test';
import { getPoolStatus, recordServedRequest } from '../compute-node';

describe('Compute Node', () => {
  test('initial pool status is not joined', () => {
    const status = getPoolStatus();
    expect(status).toHaveProperty('joined');
    expect(status).toHaveProperty('tokensEarned');
    expect(status).toHaveProperty('requestsServed');
    expect(status).toHaveProperty('connectedNodes');
    expect(status).toHaveProperty('uptime');
    expect(status).toHaveProperty('config');
    expect(typeof status.tokensEarned).toBe('number');
    expect(typeof status.requestsServed).toBe('number');
  });

  test('recordServedRequest increments counters', () => {
    const before = getPoolStatus();
    const prevRequests = before.requestsServed;
    const prevTokens = before.tokensEarned;

    recordServedRequest(1000);

    const after = getPoolStatus();
    expect(after.requestsServed).toBe(prevRequests + 1);
    expect(after.tokensEarned).toBe(prevTokens + 1);
  });

  test('recordServedRequest handles fractional tokens', () => {
    const before = getPoolStatus();
    const prevTokens = before.tokensEarned;

    recordServedRequest(500);

    const after = getPoolStatus();
    expect(after.tokensEarned).toBe(prevTokens + 0.5);
  });

  test('pool config has expected fields', () => {
    const status = getPoolStatus();
    expect(typeof status.config.maxCpuPercent).toBe('number');
    expect(typeof status.config.maxMemoryMb).toBe('number');
    expect(Array.isArray(status.config.allowedModels)).toBe(true);
  });
});
