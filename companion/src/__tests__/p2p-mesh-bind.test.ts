import { describe, expect, test } from '@a0n/gnosis/test';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

interface SpawnedMeshProbe {
  child: ChildProcess;
  stdout: string;
  stderr: string;
}

function appendOutput(target: SpawnedMeshProbe, chunk: Buffer | string): void {
  const text = chunk.toString();
  target.stdout += text;
}

function appendError(target: SpawnedMeshProbe, chunk: Buffer | string): void {
  const text = chunk.toString();
  target.stderr += text;
}

function isLoopbackBindDenied(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.message.includes('listen EPERM') ||
      error.message.includes('operation not permitted'))
  );
}

async function reservePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('Could not determine reserved port'));
        return;
      }

      const { port } = address;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolvePort(port);
      });
    });
  });
}

function spawnMeshProbe(companionPort: number): SpawnedMeshProbe {
  const tempHome = mkdtempSync(join(tmpdir(), 'zedge-mesh-home-'));
  mkdirSync(join(tempHome, '.edgework'), { recursive: true });
  const meshModulePath = fileURLToPath(
    new URL('../p2p-mesh.ts', import.meta.url)
  );
  const script = `
    (async () => {
      const { startMesh, stopMesh } = await import(${JSON.stringify(
        meshModulePath
      )});
      startMesh();
      setTimeout(() => {
        process.stdout.write('mesh-ready\\n');
      }, 250);
      setTimeout(() => {
        stopMesh();
        process.exit(0);
      }, 3000);
    })().catch((error) => {
      console.error(error);
      process.exit(1);
    });
  `;

  const child = spawn(process.execPath, ['-e', script], {
    env: {
      ...process.env,
      HOME: tempHome,
      ZEDGE_COMPANION_PORT: String(companionPort),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const probe: SpawnedMeshProbe = {
    child,
    stdout: '',
    stderr: '',
  };
  child.stdout?.on('data', (chunk) => appendOutput(probe, chunk));
  child.stderr?.on('data', (chunk) => appendError(probe, chunk));
  return probe;
}

async function waitForMarker(
  probe: SpawnedMeshProbe,
  marker: string,
  timeoutMs = 10_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (probe.stdout.includes(marker) || probe.stderr.includes(marker)) {
      return;
    }

    if (probe.child.exitCode !== null) {
      throw new Error(
        `Mesh probe exited early with code ${probe.child.exitCode}\nstdout:\n${probe.stdout}\nstderr:\n${probe.stderr}`
      );
    }

    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  throw new Error(
    `Timed out waiting for marker "${marker}"\nstdout:\n${probe.stdout}\nstderr:\n${probe.stderr}`
  );
}

async function stopProbe(probe: SpawnedMeshProbe): Promise<void> {
  if (probe.child.exitCode !== null) {
    return;
  }

  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(forceKillTimer);
      resolve();
    };

    const forceKillTimer = setTimeout(() => {
      try {
        probe.child.kill('SIGKILL');
      } catch {
        // Best-effort cleanup only.
      }
    }, 1_000);

    probe.child.once('exit', finish);
    try {
      probe.child.kill('SIGTERM');
    } catch {
      finish();
    }
  });
}

function getUdpBinding(pid: number, port: number): string {
  const result = spawnSync(
    'lsof',
    ['-nP', '-a', '-p', String(pid), `-iUDP:${port}`],
    { encoding: 'utf-8' }
  );
  return `${result.stdout}${result.stderr}`;
}

describe('P2P Mesh bind behavior', () => {
  test('isolated companions derive and share the discovery UDP port', async () => {
    let companionPort: number;
    try {
      companionPort = await reservePort();
    } catch (error) {
      if (isLoopbackBindDenied(error)) {
        return;
      }
      throw error;
    }
    const expectedDiscoveryPort = companionPort + 1;
    const firstProbe = spawnMeshProbe(companionPort);
    let secondProbe: SpawnedMeshProbe | null = null;

    try {
      await waitForMarker(firstProbe, 'mesh-ready');
      secondProbe = spawnMeshProbe(companionPort);
      await waitForMarker(secondProbe, 'mesh-ready');
      if (!firstProbe.child.pid || !secondProbe.child.pid) {
        throw new Error('Mesh probe child PID was not available');
      }

      expect(
        getUdpBinding(firstProbe.child.pid, expectedDiscoveryPort)
      ).toContain(`UDP *:${expectedDiscoveryPort}`);
      expect(
        getUdpBinding(secondProbe.child.pid, expectedDiscoveryPort)
      ).toContain(`UDP *:${expectedDiscoveryPort}`);
      expect(firstProbe.stderr).not.toContain('EADDRINUSE');
      expect(secondProbe.stderr).not.toContain('EADDRINUSE');
      expect(firstProbe.stdout).not.toContain('EADDRINUSE');
      expect(secondProbe.stdout).not.toContain('EADDRINUSE');
    } finally {
      if (secondProbe) {
        await stopProbe(secondProbe);
      }
      await stopProbe(firstProbe);
    }
  });
});
