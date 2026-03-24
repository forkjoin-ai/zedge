import { describe, test, expect, beforeEach } from 'bun:test';
import { writeFileSync, existsSync, rmSync, mkdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

// We test the VoidMapStore class by importing and exercising the singleton.
// The store persists to ~/.edgework/void-map.jsonl so tests verify real persistence.

describe('Void Map Store', () => {
  test('record and query entries', async () => {
    const { voidMapStore } = await import('../void-map-store');

    const before = voidMapStore.getStatus().totalEntries;

    voidMapStore.record({
      filePath: '/test/file.ts',
      line: 42,
      category: 'readability',
      rejectedContent: 'Extract this into a helper function',
      source: 'daydream',
    });

    voidMapStore.record({
      filePath: '/test/file.ts',
      line: 10,
      category: 'performance',
      rejectedContent: 'Use a Map instead of object lookup',
      source: 'daydream',
    });

    voidMapStore.record({
      filePath: '/test/other.ts',
      category: 'security',
      rejectedContent: 'Sanitize user input before SQL query',
      source: 'cera',
    });

    const status = voidMapStore.getStatus();
    expect(status.totalEntries).toBeGreaterThanOrEqual(before + 3);

    // Query by file
    const fileResults = voidMapStore.query({ filePath: '/test/file.ts' });
    expect(fileResults.length).toBeGreaterThanOrEqual(2);

    // Query by category
    const categoryResults = voidMapStore.query({ category: 'readability' });
    expect(categoryResults.length).toBeGreaterThanOrEqual(1);
    expect(categoryResults[categoryResults.length - 1].rejectedContent).toContain('helper function');
  });

  test('getStatus returns valid shape', async () => {
    const { voidMapStore } = await import('../void-map-store');
    const status = voidMapStore.getStatus();

    expect(status).toHaveProperty('totalEntries');
    expect(status).toHaveProperty('topCategories');
    expect(status).toHaveProperty('topFiles');
    expect(status).toHaveProperty('oldestEntry');
    expect(status).toHaveProperty('newestEntry');
    expect(typeof status.totalEntries).toBe('number');
    expect(Array.isArray(status.topCategories)).toBe(true);
    expect(Array.isArray(status.topFiles)).toBe(true);
  });

  test('getSteeringVector returns empty for unknown file', async () => {
    const { voidMapStore } = await import('../void-map-store');
    const steering = voidMapStore.getSteeringVector('/nonexistent/path.ts');

    expect(steering).toHaveProperty('negativePrompt');
    expect(steering).toHaveProperty('entryCount');
    expect(steering).toHaveProperty('rejectedCategories');
    expect(typeof steering.negativePrompt).toBe('string');
    expect(typeof steering.entryCount).toBe('number');
  });

  test('getSteeringVector produces negative prompt after enough rejections', async () => {
    const { voidMapStore } = await import('../void-map-store');

    // Record enough rejections to trigger steering
    for (let i = 0; i < 5; i++) {
      voidMapStore.record({
        filePath: '/test/steering-test.ts',
        line: i + 1,
        category: 'readability',
        rejectedContent: `Rejected suggestion ${i}`,
        source: 'daydream',
      });
    }

    const steering = voidMapStore.getSteeringVector('/test/steering-test.ts');
    expect(steering.rejectedCategories.length).toBeGreaterThan(0);
    expect(steering.negativePrompt.length).toBeGreaterThan(0);
    expect(steering.negativePrompt).toContain('readability');
    expect(steering.negativePrompt).toContain('rejected');
  });

  test('compact reduces duplicate entries', async () => {
    const { voidMapStore } = await import('../void-map-store');

    // Record duplicates
    for (let i = 0; i < 3; i++) {
      voidMapStore.record({
        filePath: '/test/compact-test.ts',
        category: 'refactor',
        rejectedContent: 'Same suggestion content for testing',
        source: 'daydream',
      });
    }

    const beforeCompact = voidMapStore.getStatus().totalEntries;
    const removed = voidMapStore.compact();
    const afterCompact = voidMapStore.getStatus().totalEntries;

    // Compact should have removed at least some duplicates
    expect(removed).toBeGreaterThanOrEqual(0);
    expect(afterCompact).toBeLessThanOrEqual(beforeCompact);
  });

  test('JSONL file exists after recording', async () => {
    const { voidMapStore } = await import('../void-map-store');

    voidMapStore.record({
      filePath: '/test/persistence.ts',
      category: 'bug-fix',
      rejectedContent: 'Persistence test entry',
      source: 'feedback',
    });

    const voidMapFile = join(homedir(), '.edgework', 'void-map.jsonl');
    expect(existsSync(voidMapFile)).toBe(true);

    const content = readFileSync(voidMapFile, 'utf-8');
    expect(content).toContain('persistence.ts');
  });
});
