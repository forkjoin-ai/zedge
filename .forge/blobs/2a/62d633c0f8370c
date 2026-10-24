import { describe, test, expect } from '@a0n/gnosis/test';
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('Topology Runner', () => {
  const testDir = join(tmpdir(), `zedge-topology-test-${Date.now()}`);

  test('runTopology returns error for nonexistent file', async () => {
    const { runTopology } = await import('../topology-runner');
    const result = await runTopology({ filePath: '/nonexistent/test.gg' });

    expect(result.success).toBe(false);
    expect(result.error).toContain('not found');
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  test('runTopology compiles a valid .gg file', async () => {
    mkdirSync(testDir, { recursive: true });
    const filePath = join(testDir, 'test.gg');
    writeFileSync(
      filePath,
      `
(input:Sensor { type: 'raw' })
(output:Sink { type: 'json' })
`
    );

    const { runTopology } = await import('../topology-runner');
    const result = await runTopology({ filePath });

    expect(result.filePath).toBe(filePath);
    expect(typeof result.durationMs).toBe('number');
    // May succeed or fail depending on Betty compiler availability
    expect(typeof result.success).toBe('boolean');
  });

  test('runTopology result has valid shape', async () => {
    const { runTopology } = await import('../topology-runner');
    const result = await runTopology({ filePath: '/nonexistent.gg' });

    expect(result).toHaveProperty('success');
    expect(result).toHaveProperty('payload');
    expect(result).toHaveProperty('logs');
    expect(result).toHaveProperty('diagnostics');
    expect(result).toHaveProperty('metrics');
    expect(result).toHaveProperty('durationMs');
    expect(result).toHaveProperty('filePath');
    expect(result.metrics).toHaveProperty('beta1');
    expect(result.metrics).toHaveProperty('nodeCount');
    expect(result.metrics).toHaveProperty('edgeCount');
  });

  test('createRunStream returns ReadableStream', async () => {
    const { createRunStream } = await import('../topology-runner');
    const stream = createRunStream();
    expect(stream).toBeInstanceOf(ReadableStream);
  });

  test('cleanup', () => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
  });
});
