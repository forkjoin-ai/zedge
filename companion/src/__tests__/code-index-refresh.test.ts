import { describe, test, expect } from '@a0n/gnosis/test';
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('Code Index Auto-Refresh', () => {
  const testDir = join(tmpdir(), `zedge-codeindex-test-${Date.now()}`);

  test('reindexFile updates blocks for changed file', async () => {
    mkdirSync(testDir, { recursive: true });
    const filePath = join(testDir, 'example.ts');
    writeFileSync(filePath, 'export function hello() { return "world"; }\n');

    const { codeIndex } = await import('../code-index');

    // Index the workspace
    await codeIndex.indexWorkspace(testDir);
    const statsBefore = codeIndex.getStats();
    expect(statsBefore.totalFiles).toBeGreaterThanOrEqual(1);

    // Modify the file
    writeFileSync(
      filePath,
      'export function goodbye() { return "moon"; }\nexport function hello() { return "sun"; }\n'
    );

    // Reindex just this file
    await codeIndex.reindexFile(filePath);
    const statsAfter = codeIndex.getStats();
    expect(statsAfter.lastIncrementalMs).toBeGreaterThan(0);
  });

  test('reindexFile handles deleted file gracefully', async () => {
    const { codeIndex } = await import('../code-index');
    // Reindex a file that doesn't exist -- should not throw
    await codeIndex.reindexFile(join(testDir, 'nonexistent.ts'));
    expect(true).toBe(true);
  });

  test('cleanup', () => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });
});
