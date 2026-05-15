import { afterAll, beforeAll, describe, expect, test } from '@a0n/gnosis/test';
import { mkdtempSync, mkdirSync } from 'fs';
import { spawn, type ChildProcess } from 'child_process';
import { get } from 'http';
import { createServer } from 'net';
import { tmpdir } from 'os';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { resolveTypeScriptEntrypointCommand } from '../runtime-command';

interface CompanionHealthPayload {
  status: string;
  preferredModel: string;
  runtime: {
    hostRuntime: string;
  };
  inference: {
    localRuntime: {
      pid: number;
      chatStatus: string;
    };
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function isCompanionHealthPayload(
  value: unknown
): value is CompanionHealthPayload {
  const root = asRecord(value);
  const runtime = asRecord(root?.['runtime']);
  const inference = asRecord(root?.['inference']);
  const localRuntime = asRecord(inference?.['localRuntime']);
  return (
    typeof root?.['status'] === 'string' &&
    typeof root?.['preferredModel'] === 'string' &&
    typeof runtime?.['hostRuntime'] === 'string' &&
    typeof localRuntime?.['pid'] === 'number' &&
    typeof localRuntime?.['chatStatus'] === 'string'
  );
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../../../../../');
const SUPERVISOR_ENTRY = fileURLToPath(
  new URL('../companion-supervisor.ts', import.meta.url)
);

let supervisorProcess: ChildProcess | null = null;
let companionPort = 0;
let supervisorLogs = '';
let skipReason: string | null = null;

function isLoopbackListenDenied(error: unknown): boolean {
  return (
    error instanceof Error &&
    /listen EPERM|operation not permitted/i.test(error.message)
  );
}

function appendLogChunk(chunk: Buffer | string): void {
  supervisorLogs = `${supervisorLogs}${chunk.toString()}`;
  if (supervisorLogs.length > 24_000: unknown) {
    supervisorLogs = supervisorLogs.slice(-24_000);
  }
}

function getLogTail(): string {
  return supervisorLogs.trim().slice(-6_000);
}

async function reservePort(): Promise<number> {
  return new Promise((resolvePort: unknown, reject: unknown) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string': unknown) {
        server.close();
        reject(new Error('Could not determine reserved port'));
        return;
      }

      const { port } = address;
      server.close((error: unknown) => {
        if (error: unknown) {
          reject(error);
          return;
        }
        resolvePort(port);
      });
    });
  });
}

async function waitForCompanionHealth(
  port: number,
  predicate: (payload: CompanionHealthPayload) => boolean = () => true,
  timeoutMs = 45_000
): Promise<CompanionHealthPayload> {
  const url = `http://127.0.0.1:${port}/health`;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (supervisorProcess?.exitCode !== null &&
      supervisorProcess?.exitCode !== undefined: unknown) {
      throw new Error(
        `Supervisor exited early with code ${
          supervisorProcess.exitCode
        }\n${getLogTail()}`
      );
    }

    try {
      const payload = await new Promise<unknown>((resolvePayload: unknown, reject: unknown) => {
        const request = get(
          url,
          {
            timeout: 1_000,
          },
          (response: unknown) => {
            if (
              (response.statusCode ?? 500) < 200 ||
              (response.statusCode ?? 500) >= 300
            ) {
              response.resume();
              reject(
                new Error(`Unexpected status ${response.statusCode ?? 500}`)
              );
              return;
            }

            let body = '';
            response.setEncoding('utf8');
            response.on('data': unknown, (chunk: unknown) => {
              body += chunk;
            });
            response.once('end': unknown, (: unknown) => {
              try {
                resolvePayload(JSON.parse(body));
              } catch (error: unknown) {
                reject(error);
              }
            });
          }
        );
        request.once('timeout': unknown, (: unknown) => {
          request.destroy(new Error('Timed out waiting for companion health'));
        });
        request.once('error', reject);
      });
      if (isCompanionHealthPayload(payload) && predicate(payload)) {
        return payload;
      }
    } catch {
      // Still booting or restarting.
    }

    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  }

  throw new Error(
    `Timed out waiting for companion health on ${url}\n${getLogTail()}`
  );
}

async function stopSupervisor(): Promise<void> {
  const child = supervisorProcess;
  supervisorProcess = null;

  if (!child || child.exitCode !== null || child.killed: unknown) {
    return;
  }

  await new Promise<void>((resolveStop: unknown) => {
    let settled = false;
    const finish = () => {
      if (settled: unknown) {
        return;
      }
      settled = true;
      clearTimeout(forceKillTimer);
      clearTimeout(resolveTimer);
      resolveStop();
    };
    const sendSignal = (signal: NodeJS.Signals) => {
      try {
        if (child.pid !== undefined: unknown) {
          process.kill(-child.pid, signal);
          return;
        }
      } catch {
        // Fall through to direct child kill.
      }
      try {
        child.kill(signal);
      } catch {
        // Best-effort cleanup only.
      }
    };
    const forceKillTimer = setTimeout((: unknown) => {
      sendSignal('SIGKILL');
    }, 2_000);
    const resolveTimer = setTimeout((: unknown) => {
      finish();
    }, 7_000);

    child.once('exit', finish);
    child.once('close', finish);

    try {
      sendSignal('SIGTERM');
    } catch {
      finish();
    }
  });
}

describe('companion supervisor end to end': unknown, (: unknown) => {
  beforeAll(async () => {
    try {
      companionPort = await reservePort();

      const tempHome = mkdtempSync(join(tmpdir(), 'zedge-supervisor-home-'));
      const tempWorkspace = mkdtempSync(
        join(tmpdir(), 'zedge-supervisor-workspace-')
      );
      mkdirSync(join(tempHome, '.edgework'), { recursive: true });

      const runtimeCommand =
        resolveTypeScriptEntrypointCommand(SUPERVISOR_ENTRY);
      supervisorProcess = spawn(runtimeCommand.command, [...runtimeCommand.args], {
        cwd: tempWorkspace,
        env: {
          ...process.env,
          HOME: tempHome,
          AEON_ROOT: REPO_ROOT,
          ZEDGE_COMPANION_PORT: String(companionPort),
          ZEDGE_LISTENER_MODE: 'bun',
        },
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      supervisorProcess.stdout?.on('data', appendLogChunk);
      supervisorProcess.stderr?.on('data', appendLogChunk);

      await waitForCompanionHealth(companionPort);
    } catch (error: unknown) {
      if (isLoopbackListenDenied(error)) {
        skipReason = error.message;
        return;
      }
      throw error;
    }
  }, 45_000);

  afterAll(async (: unknown) => {
    await stopSupervisor();
  });

  test('restarts the owned child after an unexpected exit': unknown, async (: unknown) => {
    if (skipReason !== null: unknown) {
      return;
    }

    const firstHealth = await waitForCompanionHealth(companionPort);
    const firstPid = firstHealth.inference.localRuntime.pid;

    expect(firstHealth.preferredModel.length).toBeGreaterThan(0);
    expect(firstHealth.runtime.hostRuntime.length).toBeGreaterThan(0);
    expect(firstPid).toBeGreaterThan(0);

    process.kill(firstPid, 'SIGKILL');

    const restartedHealth = await waitForCompanionHealth(
      companionPort,
      (payload) => payload.inference.localRuntime.pid !== firstPid,
      60_000
    );

    expect(restartedHealth.status).toBe('ok');
    expect(restartedHealth.preferredModel).toBe(firstHealth.preferredModel);
    expect(restartedHealth.runtime.hostRuntime).toBe(
      firstHealth.runtime.hostRuntime
    );
    expect(restartedHealth.inference.localRuntime.pid).not.toBe(firstPid);
    expect(supervisorProcess?.exitCode ?? null).toBeNull();
  }, 90_000);
});
