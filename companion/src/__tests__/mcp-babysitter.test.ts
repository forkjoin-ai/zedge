import { describe, expect, test } from 'bun:test';
import { decideCompanionRestart } from '../companion-restart-policy';

describe('MCP companion babysitter policy', () => {
  test('does not restart during the startup grace window', () => {
    const now = 100_000;
    const decision = decideCompanionRestart({
      now,
      companionSpawnedAt: now - 5_000,
      consecutiveFailures: 3,
      restartTimestamps: [],
    });

    expect(decision.shouldRestart).toBe(false);
    expect(decision.reason).toBe('startup_grace');
  });

  test('restarts after enough consecutive failures outside startup grace', () => {
    const now = 100_000;
    const decision = decideCompanionRestart({
      now,
      companionSpawnedAt: now - 25_000,
      consecutiveFailures: 3,
      restartTimestamps: [],
    });

    expect(decision.shouldRestart).toBe(true);
    expect(decision.reason).toBe('restart');
    expect(decision.restartTimestamps).toEqual([now]);
  });

  test('force restart bypasses the health failure threshold', () => {
    const now = 100_000;
    const decision = decideCompanionRestart({
      now,
      companionSpawnedAt: now - 25_000,
      consecutiveFailures: 0,
      restartTimestamps: [],
      force: true,
    });

    expect(decision.shouldRestart).toBe(true);
    expect(decision.reason).toBe('restart');
  });

  test('rate limits restart storms even when forced', () => {
    const now = 100_000;
    const decision = decideCompanionRestart({
      now,
      companionSpawnedAt: now - 25_000,
      consecutiveFailures: 99,
      restartTimestamps: [now - 10_000, now - 20_000, now - 30_000, now - 40_000],
      force: true,
    });

    expect(decision.shouldRestart).toBe(false);
    expect(decision.reason).toBe('rate_limited');
    expect(decision.restartTimestamps).toHaveLength(4);
  });
});
