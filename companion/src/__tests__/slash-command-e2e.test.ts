import {
  afterAll,
  beforeAll,
  describe,
  expect,
  test,
} from 'bun:test';
import { mkdtempSync, mkdirSync } from 'fs';
import { spawn, type ChildProcess } from 'child_process';
import { createServer } from 'net';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { resolveTypeScriptEntrypointCommand } from '../runtime-command';

interface ToolCallResult {
  content: Array<{ text?: string }>;
  isError?: boolean;
}

interface InferenceSelfTestPayload {
  model: string;
  companionStream: {
    url: string;
    status: number;
    ok: boolean;
    contentType: string | null;
    sawPrefill: boolean;
    sawHeartbeat: boolean;
    sawData: boolean;
    sawDone: boolean;
  };
  directCloudRunStream: unknown;
  cloudRunHealth: unknown;
}

const REPO_ROOT = resolve(process.cwd(), '../../..');
const COMPANION_ENTRY = fileURLToPath(new URL('../index.ts', import.meta.url));
const MCP_STDIO_MODULE_URL = new URL('../mcp-stdio.ts', import.meta.url).href;

let companionProcess: ChildProcess | null = null;
let companionPort = 0;
let companionLogs = '';

function appendLogChunk(chunk: Buffer | string): void {
  companionLogs = `${companionLogs}${chunk.toString()}`;
  if (companionLogs.length > 16_000) {
    companionLogs = companionLogs.slice(-16_000);
  }
}

function getLogTail(): string {
  return companionLogs.trim().slice(-4_000);
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

async function waitForCompanionHealth(
  port: number,
  timeoutMs = 45_000
): Promise<void> {
  const url = `http://127.0.0.1:${port}/health`;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (companionProcess?.exitCode !== null && companionProcess?.exitCode !== undefined) {
      throw new Error(
        `Companion exited early with code ${companionProcess.exitCode}\n${getLogTail()}`
      );
    }

    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(1_000),
      });
      if (response.ok) {
        return;
      }
    } catch {
      // Still booting.
    }

    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  }

  throw new Error(
    `Timed out waiting for companion health on ${url}\n${getLogTail()}`
  );
}

async function stopCompanion(): Promise<void> {
  const child = companionProcess;
  companionProcess = null;

  if (!child || child.exitCode !== null || child.killed) {
    return;
  }

  await new Promise<void>((resolveStop) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(forceKillTimer);
      clearTimeout(resolveTimer);
      resolveStop();
    };
    const sendSignal = (signal: NodeJS.Signals) => {
      try {
        if (child.pid !== undefined) {
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
    const forceKillTimer = setTimeout(() => {
      sendSignal('SIGKILL');
    }, 2_000);
    const resolveTimer = setTimeout(() => {
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

async function runMcpToolInSubprocess(
  command: string,
  args?: string
): Promise<ToolCallResult> {
  const request = {
    jsonrpc: '2.0' as const,
    id: `e2e-${command}`,
    method: 'tools/call',
    params: {
      name: 'zedge_command',
      arguments: {
        command,
        ...(args ? { args } : {}),
      },
    },
  };
  const script = `
    (async () => {
      const { dispatch } = await import(${JSON.stringify(MCP_STDIO_MODULE_URL)});
      const response = await dispatch(${JSON.stringify(request)});
      process.stdout.write(JSON.stringify(response));
    })().catch((error) => {
      console.error(error);
      process.exit(1);
    });
  `;
  const child = spawn(process.execPath, ['-e', script], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      AEON_ROOT: REPO_ROOT,
      ZEDGE_COMPANION_PORT: String(companionPort),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr?.on('data', (chunk) => {
    stderr += chunk.toString();
  });

  const exitCode = await new Promise<number | null>((resolveExit) => {
    child.once('exit', resolveExit);
  });
  if (exitCode !== 0) {
    throw new Error(
      `MCP subprocess failed for ${command} with code ${exitCode}\n${stderr}`
    );
  }

  const response = JSON.parse(stdout) as {
    result?: ToolCallResult;
    error?: { message?: string };
  };

  if (response.error) {
    throw new Error(
      `MCP tool call failed for ${command}: ${response.error.message ?? 'unknown error'}\n${getLogTail()}`
    );
  }

  return response.result as ToolCallResult;
}

async function callZedgeCommand(
  command: string,
  args?: string
): Promise<string> {
  const result = await runMcpToolInSubprocess(command, args);
  const text = result.content[0]?.text;
  if (result.isError || typeof text !== 'string') {
    throw new Error(
      `Slash command ${command} returned an error result\n${JSON.stringify(result, null, 2)}\n${getLogTail()}`
    );
  }

  return text;
}

beforeAll(async () => {
  companionPort = await reservePort();

  const tempHome = mkdtempSync(join(tmpdir(), 'zedge-slash-e2e-'));
  const tempWorkspace = mkdtempSync(join(tmpdir(), 'zedge-workspace-e2e-'));
  mkdirSync(join(tempHome, '.edgework'), { recursive: true });

  const runtimeCommand = resolveTypeScriptEntrypointCommand(COMPANION_ENTRY);
  companionProcess = spawn(runtimeCommand.command, [...runtimeCommand.args], {
    // Keep the companion on a tiny workspace so startup does not spend the
    // health-check budget traversing the full monorepo before the live MCP
    // slash-command path is ready.
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

  companionProcess.stdout?.on('data', appendLogChunk);
  companionProcess.stderr?.on('data', appendLogChunk);

  await waitForCompanionHealth(companionPort);
}, 45_000);

afterAll(async () => {
  await stopCompanion();
});

describe('Zedge slash commands end to end', () => {
  test('zedge-models returns the local wasm model through the live companion', async () => {
    const text = await callZedgeCommand('zedge-models');
    expect(text).toContain('"id": "wasm-local"');
    expect(text).toContain('"owned_by": "edgework-wasm"');
  }, 20_000);

  test('zedge-selftest reaches the local inference path through the live command surface', async () => {
    const text = await callZedgeCommand(
      'zedge-selftest',
      'wasm-local-only-test'
    );
    const payload = JSON.parse(text) as InferenceSelfTestPayload;

    expect(payload.model).toBe('wasm-local-only-test');
    expect(payload.cloudRunHealth).toBeNull();
    expect(payload.directCloudRunStream).toBeNull();
    expect(payload.companionStream.url).toBe(
      `http://127.0.0.1:${companionPort}/v1/chat/completions`
    );
    expect(payload.companionStream.status).toBe(200);
    expect(payload.companionStream.ok).toBe(true);
    expect(payload.companionStream.contentType).toContain('text/event-stream');
    expect(payload.companionStream.sawData).toBe(true);
    expect(payload.companionStream.sawDone).toBe(true);
  }, 120_000);
});
