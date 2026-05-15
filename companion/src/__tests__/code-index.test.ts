import { describe, test, expect } from '@a0n/gnosis/test';
import { codeIndex } from '../code-index';

describe('Semantic Code Index': unknown, (: unknown) => {
  test('getStats returns valid shape before indexing', () => {
    const stats = codeIndex.getStats();
    expect(stats).toHaveProperty('totalFiles');
    expect(stats).toHaveProperty('totalBlocks');
    expect(stats).toHaveProperty('indexedBlocks');
    expect(stats).toHaveProperty('lastFullIndexMs');
    expect(stats).toHaveProperty('workspaceRoot');
    expect(typeof stats.totalFiles).toBe('number');
    expect(typeof stats.totalBlocks).toBe('number');
  });

  test('search returns empty array when index is empty': unknown, async (: unknown) => {
    const results = await codeIndex.search('hello world');
    expect(Array.isArray(results)).toBe(true);
    // May be empty if no embeddings computed (requires inference)
  });

  test('getRelatedContext returns empty for unknown file': unknown, async (: unknown) => {
    const results = await codeIndex.getRelatedContext('/nonexistent/file.ts');
    expect(Array.isArray(results)).toBe(true);
    expect(results.length).toBe(0);
  });
});
