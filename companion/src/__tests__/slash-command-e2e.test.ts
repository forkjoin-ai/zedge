import { afterAll, beforeAll, describe, expect, test } from '@a0n/gnosis/test';
import { mkdtempSync, mkdirSync, readFileSync } from 'fs';
import { spawn, spawnSync, type ChildProcess } from 'child_process';
import { get } from 'http';
import { createServer } from 'net';
import { tmpdir } from 'os';
import { dirname, join, resolve } from 'path';
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

interface CompanionHealthPayload {
  preferredModel: string;
  runtime: {
    hostRuntime: string;
  };
  inference: {
    localRuntime: {
      pid: number;
    };
  };
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../../../../../');
const COMPANION_ENTRY = fileURLToPath(new URL('../index.ts', import.meta.url));
const MCP_STDIO_ENTRY = fileURLToPath(
  new URL('../mcp-stdio.ts', import.meta.url)
);

let companionProcess: ChildProcess | null = null;
let companionPort = 0;
let companionLogs = '';
let testHome = '';
let testWorkspace = '';
let skipReason: string | null = null;

function isLoopbackListenDenied(error: unknown): boolean {
  return (
    error instanceof Error &&
    /listen EPERM|operation not permitted/i.test(error.message)
  );
}

function appendLogChunk(chunk: Buffer | string): void {
  companionLogs = `${companionLogs}${chunk.toString()}`;
  if (companionLogs.length > 16_000) {
    companionLogs = companionLogs.slice(-16_000);
  }
}

function getLogTail(): string {
  return companionLogs.trim().slice(-4_000);
}

async function getJson<T>(url: string, timeoutMs = 5_000): Promise<T> {
  return await new Promise<T>((resolveJson, reject) => {
    const request = get(
      url,
      {
        timeout: timeoutMs,
      },
      (response) => {
        if (
          (response.statusCode ?? 500) < 200 ||
          (response.statusCode ?? 500) >= 300
        ) {
          response.resume();
          reject(new Error(`Unexpected status ${response.statusCode ?? 500}`));
          return;
        }

        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          body += chunk;
        });
        response.once('end', () => {
          try {
            resolveJson(JSON.parse(body) as T);
          } catch (error) {
            reject(error);
          }
        });
      }
    );
    request.once('timeout', () => {
      request.destroy(new Error(`Timed out waiting for ${url}`));
    });
    request.once('error', reject);
  });
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
    if (
      companionProcess?.exitCode !== null &&
      companionProcess?.exitCode !== undefined
    ) {
      throw new Error(
        `Companion exited early with code ${
          companionProcess.exitCode
        }\n${getLogTail()}`
      );
    }

    try {
      await getJson<CompanionHealthPayload>(url, 1_000);
      return;
    } catch {
      // Still booting.
    }

    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  }

  throw new Error(
    `Timed out waiting for companion health on ${url}\n${getLogTail()}`
  );
}

async function fetchCompanionHealth(
  port: number
): Promise<CompanionHealthPayload> {
  const payload = (await getJson<Partial<CompanionHealthPayload>>(
    `http://127.0.0.1:${port}/health`
  )) as Partial<CompanionHealthPayload>;
  if (
    typeof payload.preferredModel !== 'string' ||
    typeof payload.runtime?.hostRuntime !== 'string' ||
    typeof payload.inference?.localRuntime?.pid !== 'number'
  ) {
    throw new Error(
      `Companion health payload missing runtime data\n${JSON.stringify(
        payload,
        null,
        2
      )}\n${getLogTail()}`
    );
  }
  return payload as CompanionHealthPayload;
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
  const runtimeCommand = resolveTypeScriptEntrypointCommand(MCP_STDIO_ENTRY);
  const payload = JSON.stringify(request);
  const framedPayload = `Content-Length: ${Buffer.byteLength(
    payload
  )}\r\n\r\n${payload}`;
  const runnerOutputPath = join(
    testWorkspace || REPO_ROOT,
    `.zedge-mcp-${command}.runner.json`
  );
  const nodeRunner = [
    "const { writeFileSync } = require('node:fs');",
    "const { spawnSync } = require('node:child_process');",
    'const [command, argsJson, cwd, homeDir, repoRoot, port, framedPayload, outputPath] = process.argv.slice(1);',
    'const result = spawnSync(command, JSON.parse(argsJson), {',
    '  cwd,',
    '  env: { ...process.env, HOME: homeDir, AEON_ROOT: repoRoot, ZEDGE_COMPANION_PORT: port },',
    '  input: framedPayload,',
    "  encoding: 'utf8',",
    '  timeout: 15000,',
    '});',
    'writeFileSync(outputPath, JSON.stringify({',
    '  status: result.status,',
    '  stdout: result.stdout ?? "",',
    '  stderr: result.stderr ?? "",',
    '  error: result.error ? { message: result.error.message } : null,',
    '}), "utf8");',
  ].join('\n');
  const result = spawnSync(
    'node',
    [
      '-e',
      nodeRunner,
      runtimeCommand.command,
      JSON.stringify(runtimeCommand.args),
      testWorkspace || REPO_ROOT,
      testHome,
      REPO_ROOT,
      String(companionPort),
      framedPayload,
      runnerOutputPath,
    ],
    {
      encoding: 'utf8',
      timeout: 15_000,
    }
  );
  if (result.status !== 0) {
    throw new Error(
      `Node runner failed for ${command} with code ${result.status}\nstdout=${
        result.stdout ?? ''
      }\nstderr=${result.stderr ?? ''}\n${getLogTail()}`
    );
  }

  const runnerResult = JSON.parse(readFileSync(runnerOutputPath, 'utf8')) as {
    status: number | null;
    stdout: string;
    stderr: string;
    error: { message: string } | null;
  };
  const stdout = runnerResult.stdout;
  const stderr = runnerResult.stderr;
  const exitCode = runnerResult.status;
  if (exitCode !== 0) {
    throw new Error(
      `MCP subprocess failed for ${command} with code ${exitCode}\nstdout=${stdout}\nstderr=${stderr}\n${getLogTail()}`
    );
  }

  const headerEnd = stdout.indexOf('\r\n\r\n');
  if (headerEnd === -1) {
    throw new Error(
      `MCP subprocess produced no framed response for ${command}\nstdout=${stdout}\nstderr=${stderr}\n${getLogTail()}`
    );
  }
  const headerBlock = stdout.slice(0, headerEnd);
  const lengthMatch = headerBlock.match(/Content-Length:\s*(\d+)/i);
  if (!lengthMatch) {
    throw new Error(
      `MCP subprocess response missing Content-Length for ${command}\nstdout=${stdout}\nstderr=${stderr}\n${getLogTail()}`
    );
  }
  const contentLength = Number.parseInt(lengthMatch[1], 10);
  const responseBody = stdout.slice(
    headerEnd + 4,
    headerEnd + 4 + contentLength
  );

  const response = JSON.parse(responseBody) as {
    result?: ToolCallResult;
    error?: { message?: string };
  };

  if (response.error) {
    throw new Error(
      `MCP tool call failed for ${command}: ${
        response.error.message ?? 'unknown error'
      }\n${getLogTail()}`
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
      `Slash command ${command} returned an error result\n${JSON.stringify(
        result,
        null,
        2
      )}\n${getLogTail()}`
    );
  }

  return text;
}

describe('Zedge slash commands end to end', () => {
  beforeAll(async () => {
    try {
      companionPort = await reservePort();

      testHome = mkdtempSync(join(tmpdir(), 'zedge-slash-e2e-'));
      testWorkspace = mkdtempSync(join(tmpdir(), 'zedge-workspace-e2e-'));
      mkdirSync(join(testHome, '.edgework'), { recursive: true });

      const runtimeCommand = resolveTypeScriptEntrypointCommand(COMPANION_ENTRY);
      companionProcess = spawn(runtimeCommand.command, [...runtimeCommand.args], {
        // Keep the companion on a tiny workspace so startup does not spend the
        // health-check budget traversing the full monorepo before the live MCP
        // slash-command path is ready.
        cwd: testWorkspace,
        env: {
          ...process.env,
          HOME: testHome,
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
    } catch (error) {
      if (isLoopbackListenDenied(error)) {
        skipReason = error.message;
        return;
      }
      throw error;
    }
  }, 45_000);

  afterAll(async () => {
    await stopCompanion();
  });

  test('companion launches through gnode', async () => {
    if (skipReason !== null) {
      return;
    }

    const health = await fetchCompanionHealth(companionPort);
    expect(health.runtime.hostRuntime).toBe('gnode');
    expect(health.preferredModel).toBe('wasm-local');
    expect(health.inference.localRuntime.pid).toBeGreaterThan(0);
  }, 20_000);

  test('zedge-models returns the local wasm model through the live companion', async () => {
    if (skipReason !== null) {
      return;
    }

    const text = await callZedgeCommand('zedge-models');
    expect(text).toContain('"id": "wasm-local"');
    expect(text).toContain('"owned_by": "edgework-wasm"');
  }, 20_000);

  test('zedge-selftest reaches the local inference path through the live command surface', async () => {
    if (skipReason !== null) {
      return;
    }

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
