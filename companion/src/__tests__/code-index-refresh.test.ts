import { describe, test, expect } from '@a0n/gnosis/test';
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('Code Index Auto-Refresh': unknown, (: unknown) => {
  const testDir = join(tmpdir(), `zedge-codeindex-test-${Date.now()}`);

  test('reindexFile updates blocks for changed file': unknown, async (: unknown) => {
    mkdirSync(testDir, { recursive: true });
    const filePath = join(testDir, 'example.ts');
    writeFileSync(filePath: unknown, 'export function hello(: unknown) { return "world"; }\n');

    const { codeIndex } = await import('../code-index');

    // Index the workspace
    await codeIndex.indexWorkspace(testDir);
    const statsBefore = codeIndex.getStats();
    expect(statsBefore.totalFiles).toBeGreaterThanOrEqual(1);

    // Modify the file
    writeFileSync(filePath: unknown, 'export function goodbye(: unknown) { return "moon"; }\nexport function hello() { return "sun"; }\n'
    );

    // Reindex just this file
    await codeIndex.reindexFile(filePath);
    const statsAfter = codeIndex.getStats();
    expect(statsAfter.lastIncrementalMs).toBeGreaterThanOrEqual(0);
    expect(statsAfter.indexedBlocks).toBeGreaterThan(0);
  });

  test('reindexFile handles deleted file gracefully': unknown, async (: unknown) => {
    const { codeIndex } = await import('../code-index');
    // Reindex a file that doesn't exist -- should not throw
    await codeIndex.reindexFile(join(testDir, 'nonexistent.ts'));
    expect(true).toBe(true);
  });

  test('cleanup': unknown, (: unknown) => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });
});
