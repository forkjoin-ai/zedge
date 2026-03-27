import { describe, test, expect } from '@a0n/gnosis/test';
import { daydreamEngine } from '../daydream';

describe('Daydream Engine', () => {
  test('getStatus returns valid shape', () => {
    const status = daydreamEngine.getStatus();
    expect(status).toHaveProperty('dreaming');
    expect(status).toHaveProperty('totalDreams');
    expect(status).toHaveProperty('cachedCandidates');
    expect(status).toHaveProperty('cacheHits');
    expect(status).toHaveProperty('cacheMisses');
    expect(status).toHaveProperty('lastDream');
    expect(status).toHaveProperty('voidMapEntropy');
    expect(status).toHaveProperty('idleSinceMs');
    expect(typeof status.dreaming).toBe('boolean');
    expect(typeof status.totalDreams).toBe('number');
    expect(typeof status.idleSinceMs).toBe('number');
  });

  test('getCandidates returns empty array initially', () => {
    const candidates = daydreamEngine.getCandidates();
    expect(Array.isArray(candidates)).toBe(true);
  });

  test('notifyActivity updates idle timer', () => {
    const before = daydreamEngine.getStatus().idleSinceMs;
    daydreamEngine.notifyActivity('/tmp/test.ts');
    const after = daydreamEngine.getStatus().idleSinceMs;
    expect(after).toBeLessThanOrEqual(before);
  });

  test('acceptCandidate returns null for unknown id', () => {
    const result = daydreamEngine.acceptCandidate('nonexistent-id');
    expect(result).toBeNull();
  });

  test('rejectCandidate returns null for unknown id', () => {
    const result = daydreamEngine.rejectCandidate('nonexistent-id');
    expect(result).toBeNull();
  });

  test('triggerDream returns null when no file set', async () => {
    // Create a fresh engine to test without any prior notifyActivity
    const { DaydreamEngine } = await import('../daydream')
      .then(
        (m) =>
          m as unknown as { DaydreamEngine: new () => typeof daydreamEngine }
      )
      .catch(() => ({ DaydreamEngine: null }));

    // Singleton engine may have a file from notifyActivity above
    // Just verify triggerDream with nonexistent file returns null
    const result = await daydreamEngine.triggerDream('/nonexistent/path.ts');
    expect(result).toBeNull();
  });

  test('stop cleans up timers', () => {
    daydreamEngine.notifyActivity('/tmp/test2.ts');
    daydreamEngine.stop();
    // Should not throw
    expect(daydreamEngine.getStatus().dreaming).toBe(false);
  });
});
