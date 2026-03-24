import { describe, test, expect } from 'bun:test';
import { fimCache, fimCacheKey, speculativePrefetch } from '../fim-cache';

describe('FIM Cache', () => {
  test('fimCacheKey produces deterministic 32-char hex', () => {
    const key = fimCacheKey('src/index.ts', 42, 'function hello() {');
    expect(typeof key).toBe('string');
    expect(key.length).toBe(32);
    expect(/^[0-9a-f]+$/.test(key)).toBe(true);

    // Same inputs produce same key
    const key2 = fimCacheKey('src/index.ts', 42, 'function hello() {');
    expect(key2).toBe(key);
  });

  test('different inputs produce different keys', () => {
    const key1 = fimCacheKey('src/a.ts', 1, 'const x');
    const key2 = fimCacheKey('src/b.ts', 1, 'const x');
    const key3 = fimCacheKey('src/a.ts', 2, 'const x');
    const key4 = fimCacheKey('src/a.ts', 1, 'const y');
    expect(key1).not.toBe(key2);
    expect(key1).not.toBe(key3);
    expect(key1).not.toBe(key4);
  });

  test('cache miss returns null', () => {
    const result = fimCache.get('nonexistent-key');
    expect(result).toBeNull();
  });

  test('set and get returns entry', () => {
    const key = fimCacheKey('test.ts', 1, 'test prefix');
    fimCache.set(key, {
      completion: 'return true;',
      model: 'qwen-2.5-coder-7b',
      tier: 'wasm',
      createdAt: Date.now(),
    });

    const result = fimCache.get(key);
    expect(result).not.toBeNull();
    expect(result!.completion).toBe('return true;');
    expect(result!.model).toBe('qwen-2.5-coder-7b');
    expect(result!.tier).toBe('wasm');
  });

  test('expired entries return null', () => {
    const key = fimCacheKey('expired.ts', 1, 'old prefix');
    fimCache.set(key, {
      completion: 'stale',
      model: 'test',
      tier: 'wasm',
      createdAt: Date.now() - 10_000, // 10s ago (> 5s TTL)
    });

    const result = fimCache.get(key);
    expect(result).toBeNull();
  });

  test('getStats returns valid shape', () => {
    const stats = fimCache.getStats();
    expect(stats).toHaveProperty('size');
    expect(stats).toHaveProperty('maxSize');
    expect(stats).toHaveProperty('hits');
    expect(stats).toHaveProperty('misses');
    expect(stats).toHaveProperty('hitRate');
    expect(stats).toHaveProperty('evictions');
    expect(stats).toHaveProperty('prefetches');
    expect(stats.maxSize).toBe(256);
    expect(typeof stats.hitRate).toBe('number');
  });

  test('speculativePrefetch calls inferFn and caches result', async () => {
    let called = false;
    const inferFn = async () => {
      called = true;
      return { completion: 'prefetched result', tier: 'wasm' };
    };

    speculativePrefetch(
      'prefetch-test.ts', 10, 'prefix text', 'suffix text',
      'test-model', inferFn
    );

    // Wait for async prefetch to complete
    await new Promise((r) => setTimeout(r, 50));
    expect(called).toBe(true);

    // Verify the prefetched value is in cache
    const key = fimCacheKey('prefetch-test.ts', 10, 'prefix text');
    const cached = fimCache.get(key);
    expect(cached).not.toBeNull();
    expect(cached!.completion).toBe('prefetched result');
  });
});
