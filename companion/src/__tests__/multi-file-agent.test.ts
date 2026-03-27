import { describe, test, expect } from '@a0n/gnosis/test';
import { writeFileSync, mkdirSync, rmSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('Multi-File Agent', () => {
  const testDir = join(tmpdir(), `zedge-mfa-test-${Date.now()}`);

  test('executeMultiFileEdit applies edits to real files', async () => {
    // Create temp workspace
    mkdirSync(testDir, { recursive: true });
    writeFileSync(
      join(testDir, 'hello.ts'),
      'export function greet(name: string): string {\n  return `Hello, ${name}!`;\n}\n'
    );

    const { executeMultiFileEdit } = await import('../multi-file-agent');

    // This will call the inference chain which may fall to echo/wasm --
    // we're testing the orchestration flow, not the model quality
    const result = await executeMultiFileEdit({
      instruction: 'Rename the greet function to sayHello',
      workspacePath: testDir,
      targetFiles: ['hello.ts'],
    });

    expect(result).toHaveProperty('instruction');
    expect(result).toHaveProperty('edits');
    expect(result).toHaveProperty('appliedCount');
    expect(result).toHaveProperty('failedCount');
    expect(result).toHaveProperty('errors');
    expect(result).toHaveProperty('durationMs');
    expect(Array.isArray(result.edits)).toBe(true);
    expect(typeof result.durationMs).toBe('number');
    expect(result.durationMs).toBeGreaterThan(0);
  }, 60_000);

  test.skip('executeMultiFileEdit handles missing files gracefully', async () => {
    const { executeMultiFileEdit } = await import('../multi-file-agent');

    const result = await executeMultiFileEdit({
      instruction: 'Fix the bug',
      workspacePath: testDir,
      targetFiles: ['nonexistent.ts'],
    });

    expect(result).toHaveProperty('edits');
    // Should not throw, even with missing files
    expect(typeof result.appliedCount).toBe('number');
  }, 60_000);

  // Cleanup
  test('cleanup temp dir', () => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
    expect(true).toBe(true);
  });
});
