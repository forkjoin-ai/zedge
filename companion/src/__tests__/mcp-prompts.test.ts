import { describe, expect, mock, test } from '@a0n/gnosis/test';
import { readFileSync } from 'fs';
import { dispatch } from '../mcp-stdio';

function getExtensionSlashCommands(): string[] {
  const extensionToml = readFileSync(
    new URL('../../../extension.toml', import.meta.url),
    'utf8'
  );

  return [...extensionToml.matchAll(/^\[slash_commands\.([^\]]+)\]$/gm)]
    .map((match) => match[1])
    .sort();
}

function getRustSlashCommandDispatches(): string[] {
  const libRs = readFileSync(
    new URL('../../../src/lib.rs', import.meta.url),
    'utf8'
  );
  const matchBlock = libRs.match(
    /fn run_slash_command\([\s\S]*?match command\.name\.as_str\(\) \{([\s\S]*?)\n\s*}\n\s*fn complete_slash_command_argument/
  );
  if (!matchBlock) {
    throw new Error('Could not locate run_slash_command dispatch block');
  }

  return [...matchBlock[1].matchAll(/"([^"]+)"\s*=>/g)]
    .map((match) => match[1])
    .sort();
}

describe('Zedge MCP prompt surface', () => {
  test('advertises MCP prompt capability during initialize', async () => {
    const response = await dispatch({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {},
    });

    const result = response?.result as {
      capabilities: Record<string, unknown>;
    };

    expect(result.capabilities.prompts).toEqual({ listChanged: false });
  });

  test('mirrors extension slash commands through prompts/list', async () => {
    const response = await dispatch({
      jsonrpc: '2.0',
      id: 2,
      method: 'prompts/list',
    });

    const prompts = (
      response?.result as { prompts: Array<{ name: string }> }
    ).prompts
      .map((prompt) => prompt.name)
      .sort();

    expect(prompts).toEqual(getExtensionSlashCommands());
  });

  test('keeps Rust slash-command dispatch aligned with extension.toml', () => {
    expect(getRustSlashCommandDispatches()).toEqual(
      getExtensionSlashCommands()
    );
  });

  test('returns a prompt payload for zedge-selftest', async () => {
    const response = await dispatch({
      jsonrpc: '2.0',
      id: 3,
      method: 'prompts/get',
      params: {
        name: 'zedge-selftest',
        arguments: {
          args: 'qwen-2.5-coder-7b',
        },
      },
    });

    const result = response?.result as {
      messages: Array<{ content: { type: string; text: string } }>;
    };

    expect(result.messages[0]?.content.type).toBe('text');
    expect(result.messages[0]?.content.text).toContain(
      '"command": "zedge-selftest"'
    );
    expect(result.messages[0]?.content.text).toContain(
      '"args": "qwen-2.5-coder-7b"'
    );
  });

  test('runs the selftest command through the generic zedge command tool', async () => {
    const fetchMock = mock(async (url: string | URL) => {
      expect(String(url)).toBe(
        'http://localhost:7331/selftest/inference?model=qwen-2.5-coder-7b'
      );

      return new Response(JSON.stringify({ ok: true }), {
        headers: { 'Content-Type': 'application/json' },
      });
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as typeof fetch;
    try {
      const response = await dispatch({
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: {
          name: 'zedge_command',
          arguments: {
            command: 'zedge-selftest',
            args: 'qwen-2.5-coder-7b',
          },
        },
      });

      const content = (response?.result as { content: Array<{ text: string }> })
        .content[0]?.text;
      expect(content).toContain('"ok": true');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('reads file-backed command inputs from the repo root instead of the companion cwd', async () => {
    const fetchMock = mock(async (url: string | URL, init?: RequestInit) => {
      expect(String(url)).toBe('http://localhost:7331/gnosis/eval');
      expect(init?.method).toBe('POST');

      const body = JSON.parse(String(init?.body)) as { code?: string };
      expect(typeof body.code).toBe('string');
      expect((body.code ?? '').length).toBeGreaterThan(0);

      return new Response(JSON.stringify({ b1: 0, output: 'ok' }), {
        headers: { 'Content-Type': 'application/json' },
      });
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as typeof fetch;
    try {
      const response = await dispatch({
        jsonrpc: '2.0',
        id: 5,
        method: 'tools/call',
        params: {
          name: 'zedge_command',
          arguments: {
            command: 'zedge-test',
          },
        },
      });

      const content = (response?.result as { content: Array<{ text: string }> })
        .content[0]?.text;
      expect(content).toContain(
        'Ran open-source/gnosis/topologies/services/isolation-tests.gg'
      );
      expect(content).toContain('"b1": 0');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('submits feedback with quoted comments through the generic tool surface', async () => {
    const fetchMock = mock(async (url: string | URL, init?: RequestInit) => {
      expect(String(url)).toBe('http://localhost:7331/feedback');
      expect(init?.method).toBe('POST');

      const body = JSON.parse(String(init?.body)) as {
        rating?: number;
        comment?: string;
        source?: string;
      };
      expect(body.rating).toBe(4);
      expect(body.comment).toBe('Great response with spaces');
      expect(body.source).toBe('zed-agent');

      return new Response(JSON.stringify({ status: 'recorded' }), {
        headers: { 'Content-Type': 'application/json' },
      });
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as typeof fetch;
    try {
      const response = await dispatch({
        jsonrpc: '2.0',
        id: 6,
        method: 'tools/call',
        params: {
          name: 'zedge_command',
          arguments: {
            command: 'zedge-feedback',
            args: '4 "Great response with spaces"',
          },
        },
      });

      const content = (response?.result as { content: Array<{ text: string }> })
        .content[0]?.text;
      expect(content).toContain('"status": "recorded"');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('routes structured gnot actions through the dedicated gnot tool', async () => {
    const fetchMock = mock(async (url: string | URL, init?: RequestInit) => {
      expect(String(url)).toBe('http://localhost:7331/gnot/command');
      expect(init?.method).toBe('POST');

      const body = JSON.parse(String(init?.body)) as {
        action?: string;
        app?: string;
        environment?: string;
      };
      expect(body.action).toBe('doctor');
      expect(body.app).toBe('apps-hello-world');
      expect(body.environment).toBe('staging');

      return new Response(
        JSON.stringify({ action: 'doctor', ready: true, checks: [] }),
        {
          headers: { 'Content-Type': 'application/json' },
        }
      );
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as typeof fetch;
    try {
      const response = await dispatch({
        jsonrpc: '2.0',
        id: 7,
        method: 'tools/call',
        params: {
          name: 'zedge_gnot',
          arguments: {
            action: 'doctor',
            app: 'apps-hello-world',
            environment: 'staging',
          },
        },
      });

      const content = (response?.result as { content: Array<{ text: string }> })
        .content[0]?.text;
      expect(content).toContain('"action": "doctor"');
      expect(content).toContain('"ready": true');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
