import { afterAll, beforeAll, describe, expect, test } from '@a0n/gnosis/test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveTypeScriptEntrypointCommand } from '../runtime-command';

/**
 * Python type server (TSP) end to end against a REAL type server.
 *
 * The unit and route-audit suites use a fake server, which proves plumbing and
 * nothing about a real analyzer. This suite boots the companion with a real
 * pyright-typeserver (or whatever TSP_E2E_COMMAND names), asks real questions
 * about a real Python file over both planes -- companion HTTP and the MCP stdio
 * bridge -- and asserts the answers are the analyzer's, not a fixture's.
 *
 * The suite self-skips when no type server is installed, so the default e2e run
 * stays green on machines without one:
 *
 *   TSP_E2E_COMMAND='pyright-typeserver --stdio' \
 *     node open-source/zedge/scripts/run-companion-tests.mjs \
 *     open-source/zedge/companion/src/__tests__/tsp-real-server.e2e.test.ts
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '../../../../..');
const COMPANION_ENTRY = join(HERE, '../index.ts');
const MCP_STDIO_ENTRY = join(HERE, '../mcp-stdio.ts');

const PY_SOURCE = [
  'def add(x: int, y: int) -> int:',
  '    return x + y',
  '',
  '',
  'def label(value: int | str) -> str:',
  '    return str(value)',
  '',
  '',
  'total = add(1, 2)',
  '',
  '',
  'def narrow(a: int | str) -> None:',
  '    if isinstance(a, int):',
  '        b = a + 1',
  '        print(b)',
  '',
].join('\n');

interface PythonTypePayload {
  available?: boolean;
  kind?: string;
  file?: string;
  text?: string | null;
  reason?: string;
  snapshot?: number | null;
  description?: { kindName?: string; text?: string };
}

interface SearchPathsPayload {
  available?: boolean;
  paths?: string[];
  reason?: string;
}

interface ResolveImportPayload {
  available?: boolean;
  resolvedUri?: string | null;
  resolvedPath?: string | null;
  reason?: string;
}

interface StatusPayload {
  enabled?: boolean;
  commandLine?: string;
  running?: boolean;
  lastFailure?: string | null;
  sessions?: Array<{
    protocolVersion?: string | null;
    compatible?: boolean;
    snapshot?: number | null;
    serverName?: string | null;
    documents?: number;
  }>;
}

let companionProcess: ChildProcess | null = null;
let companionPort = 0;
let companionLogs = '';
let testHome = '';
let testWorkspace = '';
let pythonFile = '';
let typeServerCommand = '';
let skipReason: string | null = null;

function appendLogChunk(chunk: Buffer | string): void {
  companionLogs = companionLogs + chunk.toString();
  if (companionLogs.length > 16_000) {
    companionLogs = companionLogs.slice(-16_000);
  }
}

function getLogTail(): string {
  return companionLogs.trim().slice(-4_000);
}

async function reservePort(): Promise<number> {
  return await new Promise<number>((resolvePort, reject) => {
    const server = createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        server.close();
        reject(new Error('could not reserve a loopback port'));
        return;
      }
      const port = address.port;
      server.close(() => resolvePort(port));
    });
  });
}

async function waitForHealth(port: number, timeoutMs = 60_000): Promise<void> {
  const url = 'http://127.0.0.1:' + String(port) + '/health';
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (
      companionProcess !== null &&
      companionProcess.exitCode !== null &&
      companionProcess.exitCode !== undefined
    ) {
      throw new Error(
        'companion exited early with code ' +
          String(companionProcess.exitCode) +
          '\n' +
          getLogTail()
      );
    }
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
      if (response.ok) {
        await response.arrayBuffer();
        return;
      }
      await response.arrayBuffer();
    } catch {
      // not listening yet
    }
    await new Promise((resolveTick) => setTimeout(resolveTick, 250));
  }
  throw new Error(
    'companion health never became ready on port ' +
      String(port) +
      '\n' +
      getLogTail()
  );
}

async function postJson<T>(
  path: string,
  body: Record<string, unknown>,
  timeoutMs = 60_000
): Promise<{ status: number; payload: T }> {
  const response = await fetch(
    'http://127.0.0.1:' + String(companionPort) + path,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    }
  );
  const payload = (await response.json()) as T;
  return { status: response.status, payload };
}

async function getJson<T>(
  path: string,
  timeoutMs = 60_000
): Promise<{ status: number; payload: T }> {
  const response = await fetch(
    'http://127.0.0.1:' + String(companionPort) + path,
    { signal: AbortSignal.timeout(timeoutMs) }
  );
  const payload = (await response.json()) as T;
  return { status: response.status, payload };
}

/** The command a real type server would run, or null when none is installed. */
function resolveRealTypeServerCommand(): string | null {
  const configured =
    process.env.TSP_E2E_COMMAND ?? process.env.ZEDGE_TYPE_SERVER_COMMAND;
  if (typeof configured === 'string' && configured.trim().length > 0) {
    return configured.trim();
  }
  const probe = spawnSync('sh', ['-c', 'command -v pyright-typeserver'], {
    encoding: 'utf8',
    timeout: 5_000,
  });
  if (probe.status !== 0) return null;
  return 'pyright-typeserver --stdio';
}

/** Drive one MCP tool call through a real mcp-stdio bridge process. */
function callMcpTool(
  name: string,
  args: Record<string, unknown>
): Record<string, unknown> {
  const request = {
    jsonrpc: '2.0' as const,
    id: 'tsp-e2e-' + name,
    method: 'tools/call',
    params: { name, arguments: args },
  };
  const payload = JSON.stringify(request);
  const framed =
    'Content-Length: ' + String(Buffer.byteLength(payload)) + '\r\n\r\n' + payload;
  const runtimeCommand = resolveTypeScriptEntrypointCommand(MCP_STDIO_ENTRY);
  const outputPath = join(testWorkspace, '.mcp-' + name + '.json');
  const runner = [
    "const { writeFileSync } = require('node:fs');",
    "const { spawnSync } = require('node:child_process');",
    'const [command, argsJson, cwd, envJson, framedPayload, outputPath] = process.argv.slice(1);',
    'const result = spawnSync(command, JSON.parse(argsJson), {',
    '  cwd,',
    '  env: { ...process.env, ...JSON.parse(envJson) },',
    '  input: framedPayload,',
    "  encoding: 'utf8',",
    '  timeout: 60000,',
    '});',
    'writeFileSync(outputPath, JSON.stringify({',
    '  status: result.status,',
    '  stdout: result.stdout ?? "",',
    '  stderr: result.stderr ?? "",',
    '  error: result.error ? { message: result.error.message } : null,',
    '}), "utf8");',
  ].join('\n');
  const env = {
    HOME: testHome,
    AEON_ROOT: testWorkspace,
    ZEDGE_COMPANION_PORT: String(companionPort),
    ZEDGE_TYPE_SERVER_COMMAND: typeServerCommand,
    ZEDGE_TYPE_SERVER_TIMEOUT_MS: '60000',
  };
  const result = spawnSync(
    process.execPath,
    [
      '-e',
      runner,
      runtimeCommand.command,
      JSON.stringify(runtimeCommand.args),
      testWorkspace,
      JSON.stringify(env),
      framed,
      outputPath,
    ],
    { encoding: 'utf8', timeout: 90_000 }
  );
  if (result.status !== 0) {
    throw new Error(
      'MCP runner failed for ' +
        name +
        ': ' +
        String(result.status) +
        '\nstdout=' +
        (result.stdout ?? '') +
        '\nstderr=' +
        (result.stderr ?? '')
    );
  }
  const captured = JSON.parse(readFileSync(outputPath, 'utf8')) as {
    status: number | null;
    stdout: string;
    stderr: string;
    error: { message: string } | null;
  };
  const separator = captured.stdout.indexOf('\r\n\r\n');
  if (separator === -1) {
    throw new Error(
      'MCP bridge produced no framed response for ' +
        name +
        '\nstdout=' +
        captured.stdout +
        '\nstderr=' +
        captured.stderr
    );
  }
  const header = captured.stdout.slice(0, separator);
  const match = /content-length\s*:\s*(\d+)/i.exec(header);
  const length = match === null ? Number.NaN : Number(match[1]);
  const bodyStart = separator + 4;
  const body = captured.stdout.slice(bodyStart, bodyStart + length);
  const response = JSON.parse(body) as {
    result?: { content?: Array<{ text?: string }>; isError?: boolean };
    error?: { message?: string };
  };
  if (response.error) {
    throw new Error('MCP error for ' + name + ': ' + response.error.message);
  }
  const content = response.result?.content ?? [];
  const text = content[0]?.text;
  return {
    text: typeof text === 'string' ? text : '',
    isError: response.result?.isError === true,
  };
}

describe('Python type server end to end (real analyzer)', () => {
  beforeAll(async () => {
    const command = resolveRealTypeServerCommand();
    if (command === null) {
      skipReason =
        'no pyright-typeserver on PATH; set TSP_E2E_COMMAND to run this suite';
      return;
    }
    typeServerCommand = command;
    companionPort = await reservePort();
    testHome = mkdtempSync(join(tmpdir(), 'zedge-tsp-e2e-home-'));
    testWorkspace = mkdtempSync(join(tmpdir(), 'zedge-tsp-e2e-ws-'));
    mkdirSync(join(testHome, '.edgework'), { recursive: true });
    pythonFile = join(testWorkspace, 'app.py');
    writeFileSync(pythonFile, PY_SOURCE, 'utf8');
    writeFileSync(
      join(testWorkspace, 'pyrightconfig.json'),
      JSON.stringify({ include: ['app.py'], typeCheckingMode: 'basic' }, null, 2),
      'utf8'
    );

    const runtimeCommand = resolveTypeScriptEntrypointCommand(COMPANION_ENTRY);
    companionProcess = spawn(runtimeCommand.command, [...runtimeCommand.args], {
      cwd: testWorkspace,
      env: {
        ...process.env,
        HOME: testHome,
        AEON_ROOT: testWorkspace,
        ZEDGE_COMPANION_PORT: String(companionPort),
        ZEDGE_LISTENER_MODE: 'bun',
        ZEDGE_TYPE_SERVER_COMMAND: typeServerCommand,
        ZEDGE_TYPE_SERVER_TIMEOUT_MS: '60000',
      },
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    companionProcess.stdout?.on('data', appendLogChunk);
    companionProcess.stderr?.on('data', appendLogChunk);
    await waitForHealth(companionPort);
  }, 120_000);

  afterAll(async () => {
    if (companionProcess !== null) {
      try {
        process.kill(-(companionProcess.pid ?? 0), 'SIGTERM');
      } catch {
        companionProcess.kill('SIGTERM');
      }
      companionProcess = null;
    }
    if (testHome.length > 0) {
      rmSync(testHome, { recursive: true, force: true });
    }
    if (testWorkspace.length > 0) {
      rmSync(testWorkspace, { recursive: true, force: true });
    }
  });

  test('companion reports the configured real type server', async () => {
    if (skipReason !== null) return;
    const { status, payload } = await getJson<StatusPayload>('/tsp/status');
    expect(status).toBe(200);
    expect(payload.enabled).toBe(true);
    expect(payload.commandLine).toBe(typeServerCommand);
    expect(Array.isArray(payload.sessions)).toBe(true);
  });

  test('declared type of a union-annotated parameter over HTTP', async () => {
    if (skipReason !== null) return;
    const { status, payload } = await postJson<PythonTypePayload>('/tsp/type', {
      file_path: pythonFile,
      line: 4,
      character: 11,
      kind: 'declared',
    });
    expect(status).toBe(200);
    expect(payload.available).toBe(true);
    expect(payload.kind).toBe('declared');
    expect(payload.text).toBe('int | str');
    expect(typeof payload.snapshot).toBe('number');
  });

  test('computed type narrows inside isinstance over HTTP', async () => {
    if (skipReason !== null) return;
    const { status, payload } = await postJson<PythonTypePayload>('/tsp/type', {
      file_path: pythonFile,
      line: 13,
      character: 8,
      kind: 'computed',
    });
    expect(status).toBe(200);
    expect(payload.text).toBe('int');
  });

  test('expected type at a call argument over HTTP', async () => {
    if (skipReason !== null) return;
    const { status, payload } = await postJson<PythonTypePayload>('/tsp/type', {
      file_path: pythonFile,
      line: 8,
      character: 12,
      kind: 'expected',
    });
    expect(status).toBe(200);
    expect(payload.text).toBe('int');
  });

  test('python search paths come from the analyzer over HTTP', async () => {
    if (skipReason !== null) return;
    const { status, payload } = await getJson<SearchPathsPayload>(
      '/tsp/search-paths?file_path=' + encodeURIComponent(pythonFile)
    );
    expect(status).toBe(200);
    expect(payload.available).toBe(true);
    expect(Array.isArray(payload.paths)).toBe(true);
    expect((payload.paths ?? []).length).toBeGreaterThan(0);
  });

  test('python import resolution comes from the analyzer over HTTP', async () => {
    if (skipReason !== null) return;
    const { status, payload } = await postJson<ResolveImportPayload>(
      '/tsp/resolve-import',
      { file_path: pythonFile, module: 'os.path' }
    );
    expect(status).toBe(200);
    expect(typeof payload.resolvedUri).toBe('string');
    expect(payload.resolvedUri ?? '').toContain('os');
    expect(payload.resolvedPath ?? '').toContain('os');
  });

  test('a missing module resolves to null, not an error', async () => {
    if (skipReason !== null) return;
    const { status, payload } = await postJson<ResolveImportPayload>(
      '/tsp/resolve-import',
      { file_path: pythonFile, module: 'definitely_not_installed_zzz' }
    );
    expect(status).toBe(200);
    expect(payload.resolvedUri).toBe(null);
    expect(typeof payload.reason).toBe('string');
  });

  test('the MCP bridge answers the same question over real stdio', async () => {
    if (skipReason !== null) return;
    const declared = callMcpTool('zedge_python_type', {
      path: 'app.py',
      line: 4,
      character: 11,
      kind: 'declared',
    });
    expect(declared.isError).toBe(false);
    expect(String(declared.text)).toContain('declared type: int | str');

    const computed = callMcpTool('zedge_python_type', {
      path: 'app.py',
      line: 13,
      character: 8,
      kind: 'computed',
    });
    expect(String(computed.text)).toContain('computed type: int');

    const status = callMcpTool('zedge_type_server_status', {});
    expect(String(status.text)).toContain('"running": true');
    expect(String(status.text)).toContain(typeServerCommand);
  });
});
