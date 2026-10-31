import { afterAll, beforeAll, describe, expect, test } from '@a0n/gnosis/test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Python type server (TSP) end to end against a REAL analyzer.
 *
 * The unit and route-audit suites use a fake server, which proves plumbing and
 * nothing about a real type checker. This suite drives a real
 * pyright-typeserver (or whatever TSP_E2E_COMMAND names) through two real
 * boundaries:
 *
 *   - the companion HTTP router, in process, for the four /tsp/* routes;
 *   - one real mcp-stdio bridge child process, for the MCP tools.
 *
 * The companion's own listener is deliberately not crossed: booting it needs the
 * checked-in monster launcher, which is unusable in this checkout (the installed
 * monster binary rejects the ladder flags the wrapper passes), and the
 * pre-existing slash-command e2e fails on the same wall. The route audit covers
 * the listener contract; this suite covers the handler plus a real analyzer.
 *
 * The suite self-skips when no type server is installed:
 *
 *   TSP_E2E_COMMAND='pyright-typeserver --stdio' \
 *     node open-source/zedge/scripts/run-companion-tests.mjs \
 *     open-source/zedge/companion/src/__tests__/tsp-real-server.e2e.test.ts
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '../../../../..');
const TS_HOST_LOADER = join(
  REPO_ROOT,
  'open-source/gnosis/gnode/register-ts-host.mjs'
);
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

const { handleWebRequest } = await import('../server.ts');

interface PythonTypePayload {
  available?: boolean;
  kind?: string;
  text?: string | null;
  reason?: string;
  snapshot?: number | null;
  range?: { start: { line: number; character: number } };
  description?: { kindName?: string };
}

interface SearchPathsPayload {
  available?: boolean;
  paths?: string[];
}

interface ResolveImportPayload {
  available?: boolean;
  resolvedUri?: string | null;
  reason?: string;
}

interface StatusPayload {
  enabled?: boolean;
  commandLine?: string;
  sessions?: Array<{ protocolVersion?: string | null; compatible?: boolean }>;
}

interface McpToolResult {
  text: string;
  isError: boolean;
}

let typeServerCommand = '';
let skipReason: string | null = null;
let testWorkspace = '';
let pythonFile = '';
const previousAeonRoot = process.env.AEON_ROOT;
const previousCommand = process.env.ZEDGE_TYPE_SERVER_COMMAND;

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

async function callRoute<T>(
  method: 'GET' | 'POST',
  path: string,
  body?: Record<string, unknown>
): Promise<{ status: number; payload: T }> {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.headers = { 'Content-Type': 'application/json' };
    init.body = JSON.stringify(body);
  }
  const response = await handleWebRequest(
    new Request('http://127.0.0.1:7331' + path, init)
  );
  const payload = (await response.json()) as T;
  return { status: response.status, payload };
}

/**
 * Drive several MCP tool calls through ONE real mcp-stdio bridge process.
 *
 * One process means one bridge session and one type-server session, which is
 * also what a real agent turn looks like -- and it keeps the suite to a single
 * TypeScript compile.
 */
function callMcpTools(
  calls: Array<{ name: string; args: Record<string, unknown> }>
): McpToolResult[] {
  const framed = calls
    .map((call, index) => {
      const payload = JSON.stringify({
        jsonrpc: '2.0' as const,
        id: 'tsp-e2e-' + String(index),
        method: 'tools/call',
        params: { name: call.name, arguments: call.args },
      });
      return (
        'Content-Length: ' +
        String(Buffer.byteLength(payload)) +
        '\r\n\r\n' +
        payload
      );
    })
    .join('');
  const outputPath = join(testWorkspace, '.mcp-session.json');
  const runner = [
    "const { writeFileSync } = require('node:fs');",
    "const { spawnSync } = require('node:child_process');",
    'const [command, argsJson, cwd, envJson, framedPayload, outputPath] = process.argv.slice(1);',
    'const result = spawnSync(command, JSON.parse(argsJson), {',
    '  cwd,',
    '  env: { ...process.env, ...JSON.parse(envJson) },',
    '  input: framedPayload,',
    "  encoding: 'utf8',",
    '  timeout: 180000,',
    '});',
    'writeFileSync(outputPath, JSON.stringify({',
    '  status: result.status,',
    '  stdout: result.stdout ?? "",',
    '  stderr: result.stderr ?? "",',
    '}), "utf8");',
  ].join('\n');
  const env = {
    HOME: testWorkspace,
    AEON_ROOT: testWorkspace,
    ZEDGE_TYPE_SERVER_COMMAND: typeServerCommand,
    ZEDGE_TYPE_SERVER_TIMEOUT_MS: '60000',
    // These tools never touch the companion, and this suite does not want one.
    ZEDGE_MCP_AUTOSPAWN: '0',
  };
  // Launch through the same TypeScript host loader the sovereign runner uses,
  // without the wrapper: the checked-in wrapper goes through monster (which
  // rejects the ladder flags here), and gnode run stalls when its cwd is a
  // temporary workspace rather than the checkout.
  const result = spawnSync(
    process.execPath,
    [
      '-e',
      runner,
      process.execPath,
      JSON.stringify(['--import', TS_HOST_LOADER, MCP_STDIO_ENTRY]),
      testWorkspace,
      JSON.stringify(env),
      framed,
      outputPath,
    ],
    { encoding: 'utf8', timeout: 240_000 }
  );
  if (result.status !== 0) {
    throw new Error(
      'MCP runner failed: ' +
        String(result.status) +
        '\nstdout=' +
        (result.stdout ?? '') +
        '\nstderr=' +
        (result.stderr ?? '')
    );
  }
  const captured = JSON.parse(readFileSync(outputPath, 'utf8')) as {
    stdout: string;
    stderr: string;
  };
  const responses: Array<{
    id?: string;
    result?: { content?: Array<{ text?: string }>; isError?: boolean };
    error?: { message?: string };
  }> = [];
  let rest = captured.stdout;
  for (;;) {
    const separator = rest.indexOf('\r\n\r\n');
    if (separator === -1) break;
    const header = rest.slice(0, separator);
    const match = /content-length\s*:\s*(\d+)/i.exec(header);
    if (match === null) break;
    const length = Number(match[1]);
    const bodyStart = separator + 4;
    if (rest.length < bodyStart + length) break;
    const body = rest.slice(bodyStart, bodyStart + length);
    rest = rest.slice(bodyStart + length);
    responses.push(JSON.parse(body) as (typeof responses)[number]);
  }
  if (responses.length !== calls.length) {
    throw new Error(
      'MCP bridge returned ' +
        String(responses.length) +
        ' of ' +
        String(calls.length) +
        ' framed responses\nstdout=' +
        captured.stdout +
        '\nstderr=' +
        captured.stderr
    );
  }
  return responses
    .sort((left, right) => Number(left.id) - Number(right.id))
    .map((response) => {
      if (response.error) {
        throw new Error('MCP error: ' + response.error.message);
      }
      const text = response.result?.content?.[0]?.text;
      return {
        text: typeof text === 'string' ? text : '',
        isError: response.result?.isError === true,
      };
    });
}

describe('Python type server end to end (real analyzer)', () => {
  beforeAll(() => {
    const command = resolveRealTypeServerCommand();
    if (command === null) {
      skipReason =
        'no pyright-typeserver on PATH; set TSP_E2E_COMMAND to run this suite';
      return;
    }
    typeServerCommand = command;
    testWorkspace = mkdtempSync(join(tmpdir(), 'zedge-tsp-e2e-'));
    pythonFile = join(testWorkspace, 'app.py');
    writeFileSync(pythonFile, PY_SOURCE, 'utf8');
    writeFileSync(
      join(testWorkspace, 'pyrightconfig.json'),
      JSON.stringify({ include: ['app.py'], typeCheckingMode: 'basic' }, null, 2),
      'utf8'
    );
    mkdirSync(join(testWorkspace, '.edgework'), { recursive: true });

    process.env.AEON_ROOT = testWorkspace;
    process.env.ZEDGE_TYPE_SERVER_COMMAND = typeServerCommand;
    process.env.ZEDGE_TYPE_SERVER_TIMEOUT_MS = '60000';
  }, 60_000);

  afterAll(() => {
    if (previousAeonRoot === undefined) {
      delete process.env.AEON_ROOT;
    } else {
      process.env.AEON_ROOT = previousAeonRoot;
    }
    if (previousCommand === undefined) {
      delete process.env.ZEDGE_TYPE_SERVER_COMMAND;
    } else {
      process.env.ZEDGE_TYPE_SERVER_COMMAND = previousCommand;
    }
    if (testWorkspace.length > 0) {
      rmSync(testWorkspace, { recursive: true, force: true });
    }
  });

  test('status reports the configured real type server', async () => {
    if (skipReason !== null) return;
    const { status, payload } = await callRoute<StatusPayload>('GET', '/tsp/status');
    expect(status).toBe(200);
    expect(payload.enabled).toBe(true);
    expect(payload.commandLine).toBe(typeServerCommand);
  });

  test('declared type of a union-annotated parameter', async () => {
    if (skipReason !== null) return;
    const { status, payload } = await callRoute<PythonTypePayload>('POST', '/tsp/type', {
      file_path: pythonFile,
      line: 4,
      character: 11,
      kind: 'declared',
    });
    expect(status).toBe(200);
    expect(payload.available).toBe(true);
    expect(payload.kind).toBe('declared');
    expect(payload.text).toBe('int | str');
    expect(payload.description?.kindName).toBe('Union');
    expect(payload.range?.start.character).toBe(10);
    expect(typeof payload.snapshot).toBe('number');
  });

  test('computed type narrows inside isinstance', async () => {
    if (skipReason !== null) return;
    const { status, payload } = await callRoute<PythonTypePayload>('POST', '/tsp/type', {
      file_path: pythonFile,
      line: 13,
      character: 8,
      kind: 'computed',
    });
    expect(status).toBe(200);
    expect(payload.text).toBe('int');
  });

  test('computed type keeps the literal at a call argument', async () => {
    if (skipReason !== null) return;
    const { status, payload } = await callRoute<PythonTypePayload>('POST', '/tsp/type', {
      file_path: pythonFile,
      line: 8,
      character: 12,
      kind: 'computed',
    });
    expect(status).toBe(200);
    expect(payload.text).toBe('Literal[1]');
  });

  test('expected type at a call argument', async () => {
    if (skipReason !== null) return;
    const { status, payload } = await callRoute<PythonTypePayload>('POST', '/tsp/type', {
      file_path: pythonFile,
      line: 8,
      character: 12,
      kind: 'expected',
    });
    expect(status).toBe(200);
    expect(payload.text).toBe('int');
  });

  test('a zero-width range on an annotation yields no declared type', async () => {
    if (skipReason !== null) return;
    // Documents why token expansion exists: TSP answers for nodes, so an
    // explicitly collapsed range can legitimately return nothing.
    const { status, payload } = await callRoute<PythonTypePayload>('POST', '/tsp/type', {
      file_path: pythonFile,
      line: 4,
      character: 20,
      endLine: 4,
      endCharacter: 20,
      kind: 'declared',
    });
    expect(status).toBe(200);
    expect(payload.text).toBe(null);
    expect(typeof payload.reason).toBe('string');
  });

  test('python search paths come from the analyzer', async () => {
    if (skipReason !== null) return;
    const { status, payload } = await callRoute<SearchPathsPayload>(
      'GET',
      '/tsp/search-paths?file_path=' + encodeURIComponent(pythonFile)
    );
    expect(status).toBe(200);
    expect(payload.available).toBe(true);
    expect(Array.isArray(payload.paths)).toBe(true);
    expect((payload.paths ?? []).length).toBeGreaterThan(0);
  });

  test('python import resolution comes from the analyzer', async () => {
    if (skipReason !== null) return;
    const { status, payload } = await callRoute<ResolveImportPayload>(
      'POST',
      '/tsp/resolve-import',
      { file_path: pythonFile, module: 'os.path' }
    );
    expect(status).toBe(200);
    expect(typeof payload.resolvedUri).toBe('string');
    expect(payload.resolvedUri ?? '').toContain('os/path');
  });

  test('a missing module resolves to null, not an error', async () => {
    if (skipReason !== null) return;
    const { status, payload } = await callRoute<ResolveImportPayload>(
      'POST',
      '/tsp/resolve-import',
      { file_path: pythonFile, module: 'definitely_not_installed_zzz' }
    );
    expect(status).toBe(200);
    expect(payload.resolvedUri).toBe(null);
    expect(typeof payload.reason).toBe('string');
  });

  test('the MCP bridge answers over real stdio against the same analyzer', () => {
    if (skipReason !== null) return;
    const results = callMcpTools([
      {
        name: 'zedge_python_type',
        args: { path: 'app.py', line: 4, character: 11, kind: 'declared' },
      },
      {
        name: 'zedge_python_type',
        args: { path: 'app.py', line: 13, character: 8, kind: 'computed' },
      },
      {
        name: 'zedge_python_resolve_import',
        args: { path: 'app.py', module: 'os.path' },
      },
      { name: 'zedge_type_server_status', args: {} },
    ]);
    const [declared, computed, resolved, status] = results;
    expect(declared?.isError).toBe(false);
    expect(declared?.text).toContain('declared type: int | str');
    expect(computed?.isError).toBe(false);
    expect(computed?.text).toContain('computed type: int');
    expect(resolved?.text).toContain('os/path');
    expect(status?.text).toContain('"running": true');
    expect(status?.text).toContain(typeServerCommand);
  });
});
