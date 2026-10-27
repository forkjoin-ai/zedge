/**
 * Zedge Python type-server (TSP) surface.
 *
 * The fake type server from @a0n/gnosis/polyglot-tsp runs as a real child
 * process over stdio, so these tests cover command resolution, spawn, document
 * synchronization, the MCP tool wiring, and shutdown without requiring
 * pyright-typeserver to be installed.
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, test } from '@a0n/gnosis/test';
import { writeFakeTypeServerScript } from '@a0n/gnosis/polyglot-tsp';

import { handleToolCall, handleToolsList } from '../mcp-stdio.ts';
import {
  disposePythonTypeServer,
  getPythonTypeServerStatus,
  queryPythonType,
  resolvePythonFile,
} from '../tsp.ts';

const TSP_TOOL_NAMES = [
  'zedge_python_type',
  'zedge_python_search_paths',
  'zedge_python_resolve_import',
  'zedge_type_server_status',
];

const scratch = mkdtempSync(join(tmpdir(), 'zedge-tsp-test-'));
const workspace = join(scratch, 'workspace');
const previousAeonRoot = process.env.AEON_ROOT;
const previousCommand = process.env.ZEDGE_TYPE_SERVER_COMMAND;

function regularDeclaration(name: string, category: number) {
  return {
    kind: 0,
    category,
    node: {
      uri: 'file:///workspace/main.py',
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: name.length } },
    },
    name,
  };
}

function classType(id: number, name: string, category: number) {
  return {
    id,
    kind: 3,
    flags: 0,
    declaration: regularDeclaration(name, category),
  };
}

const intType = classType(11, 'int', 6);
const strType = classType(12, 'str', 6);

const fixtures = {
  computed: classType(1, 'int', 6),
  declared: {
    id: 10,
    kind: 4,
    flags: 0,
    subTypes: [intType, strType],
  },
  expected: {
    id: 20,
    kind: 2,
    flags: 0,
    declaration: regularDeclaration('add', 5),
    specializedTypes: {
      parameterTypes: [classType(21, 'int', 6), classType(22, 'int', 6)],
      parameterNames: ['x', 'y'],
      returnType: classType(23, 'int', 6),
    },
  },
  searchPaths: ['/workspace/src', '/usr/lib/python3.12'],
  imports: {
    'os.path': 'file:///usr/lib/python3.12/os/path.py',
  },
};

function toolText(result: Record<string, unknown>): string {
  const content = result.content;
  if (!Array.isArray(content) || content.length === 0) return '';
  const first = content[0] as { text?: unknown };
  return typeof first.text === 'string' ? first.text : '';
}

async function callTool(
  name: string,
  args: Record<string, unknown>
): Promise<Record<string, unknown>> {
  return handleToolCall({ name, arguments: args });
}

beforeAll(() => {
  mkdirSync(workspace, { recursive: true });
  writeFileSync(
    join(workspace, 'main.py'),
    ['def add(x: int, y: int) -> int:', '    return x + y', '', 'result = add(1, 2)', ''].join('\n'),
    'utf8'
  );
  writeFileSync(join(workspace, 'notes.txt'), 'not python\n', 'utf8');
  const generated = writeFakeTypeServerScript({ fixtures }, scratch);
  process.env.ZEDGE_TYPE_SERVER_COMMAND = generated.commandLine;
  process.env.AEON_ROOT = workspace;
});

afterAll(() => {
  disposePythonTypeServer();
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
  rmSync(scratch, { recursive: true, force: true });
});

describe('zedge python type server MCP tools', () => {
  test('advertises the four TSP tools', async () => {
    const listed = await handleToolsList();
    const tools = Array.isArray(listed.tools)
      ? (listed.tools as Array<{ name?: unknown }>)
      : [];
    const names = tools
      .map((tool) => (typeof tool.name === 'string' ? tool.name : ''))
      .filter((name) => name.length > 0);
    for (const expected of TSP_TOOL_NAMES) {
      expect(names).toContain(expected);
    }
  });

  test('answers a declared-type query over a real child process', async () => {
    const result = await callTool('zedge_python_type', {
      path: 'main.py',
      line: 3,
      character: 9,
      kind: 'declared',
    });
    const text = toolText(result);
    expect(result.isError).toBeUndefined();
    expect(text).toContain('declared type: int | str');
    expect(text).toContain('"kindName": "Union"');
  });

  test('answers computed and expected type queries', async () => {
    const computed = await callTool('zedge_python_type', {
      path: 'main.py',
      line: 3,
      character: 9,
      kind: 'computed',
    });
    expect(toolText(computed)).toContain('computed type: int');

    const expected = await callTool('zedge_python_type', {
      path: 'main.py',
      line: 3,
      character: 9,
      kind: 'expected',
    });
    expect(toolText(expected)).toContain('def add(x: int, y: int) -> int');
  });

  test('defaults to the computed type query', async () => {
    const result = await callTool('zedge_python_type', {
      path: 'main.py',
      line: 0,
      character: 4,
    });
    expect(toolText(result)).toContain('computed type: int');
  });

  test('returns the raw graph only when verbose is set', async () => {
    const compact = await callTool('zedge_python_type', {
      path: 'main.py',
      line: 0,
      character: 4,
      kind: 'computed',
    });
    expect(toolText(compact)).not.toContain('"raw"');

    const verbose = await callTool('zedge_python_type', {
      path: 'main.py',
      line: 0,
      character: 4,
      kind: 'computed',
      verbose: true,
    });
    expect(toolText(verbose)).toContain('"raw"');
  });

  test('resolves python imports and reports search paths', async () => {
    const resolved = await callTool('zedge_python_resolve_import', {
      path: 'main.py',
      module: 'os.path',
    });
    const resolvedText = toolText(resolved);
    expect(resolved.isError).toBeUndefined();
    expect(resolvedText).toContain('file:///usr/lib/python3.12/os/path.py');

    const paths = await callTool('zedge_python_search_paths', { path: 'main.py' });
    const pathsText = toolText(paths);
    expect(pathsText).toContain('/usr/lib/python3.12');
  });

  test('reports a live session in the status tool', async () => {
    const status = await callTool('zedge_type_server_status', {});
    const text = toolText(status);
    expect(text).toContain('"running": true');
    expect(text).toContain('fake-type-server');
    expect(text).toContain('"commandLine"');
  });

  test('fails closed with a precise message for a non-Python file', async () => {
    const result = await callTool('zedge_python_type', {
      path: 'notes.txt',
      line: 0,
      character: 0,
    });
    expect(result.isError).toBe(true);
    expect(toolText(result)).toContain('Not a Python document');
  });

  test('fails closed when line or character is missing', async () => {
    const result = await callTool('zedge_python_type', { path: 'main.py' });
    expect(result.isError).toBe(true);
    expect(toolText(result)).toContain('line and character are required');
  });

  test('rejects an unknown query kind', async () => {
    const result = await callTool('zedge_python_type', {
      path: 'main.py',
      line: 0,
      character: 0,
      kind: 'guessed',
    });
    expect(result.isError).toBe(true);
    expect(toolText(result)).toContain('kind must be one of');
  });
});

describe('zedge python type server session API', () => {
  test('resolves a file and refuses a directory', () => {
    const resolved = resolvePythonFile(workspace, 'main.py');
    expect(resolved.relativePath).toBe('main.py');
    expect(resolved.uri.startsWith('file://')).toBe(true);

    let message = '';
    try {
      resolvePythonFile(workspace, '.');
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain('Not a file');
  });

  test('queries a workspace by explicit root, independent of AEON_ROOT', async () => {
    const result = await queryPythonType({
      workspaceRoot: workspace,
      filePath: 'main.py',
      line: 3,
      character: 9,
      kind: 'declared',
    });
    expect(result.available).toBe(true);
    expect(result.text).toBe('int | str');
    expect(result.snapshot).not.toBe(null);
  });

  test('reports configuration and sessions', () => {
    const status = getPythonTypeServerStatus();
    expect(status.enabled).toBe(true);
    expect(status.commandLine.length).toBeGreaterThan(0);
    expect(status.sessions.length).toBeGreaterThan(0);
    expect(status.requestTimeoutMs).toBeGreaterThan(0);
  });
});
