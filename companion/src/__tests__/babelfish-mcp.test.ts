import { describe, expect, mock, test } from '@a0n/gnosis/test';
import { dispatch } from '../mcp-stdio';

describe('Babelfish MCP stdio bridge', () => {
  test('lists all Babelfish tools through the MCP tools/list method', async () => {
    const response = await dispatch({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
    });

    const tools = (response?.result as { tools: Array<{ name: string }> })
      .tools;
    expect(tools.map((tool) => tool.name)).toContain(
      'zedge_babelfish_capabilities'
    );
    expect(tools.map((tool) => tool.name)).toContain('zedge_babelfish_code');
    expect(tools.map((tool) => tool.name)).toContain('zedge_babelfish_apply');
    expect(tools.map((tool) => tool.name)).toContain('zedge_babelfish_text');
    expect(tools.map((tool) => tool.name)).toContain('zedge_babelfish_explain');
    expect(tools.map((tool) => tool.name)).toContain('zedge_babelfish_gnarly');
  });

  test('proxies Babelfish tool calls through the MCP tools/call method', async () => {
    const fetchMock = mock(async (url: string | URL, init?: RequestInit) => {
      expect(String(url)).toBe('http://127.0.0.1:7331/babelfish/code/preview');
      expect(init?.method).toBe('POST');
      expect(String(init?.body)).toContain('"targetLanguage":"rust"');
      return new Response(JSON.stringify({ previewId: 'preview-123' }), {
        headers: { 'Content-Type': 'application/json' },
      });
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as typeof fetch;
    try {
      const response = await dispatch({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'zedge_babelfish_code',
          arguments: {
            scope: { kind: 'inline', filePath: 'input.ts', sourceText: 'x' },
            targetLanguage: 'rust',
            mode: 'translate-code',
            outputMode: 'preview',
          },
        },
      });

      const content = (
        response?.result as { content: Array<{ type: string; text: string }> }
      ).content[0];
      expect(content?.type).toBe('text');
      expect(content?.text).toContain('preview-123');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('proxies Gnarly MCP tool calls to the Babelfish Gnarly route', async () => {
    const fetchMock = mock(async (url: string | URL, init?: RequestInit) => {
      expect(String(url)).toBe('http://127.0.0.1:7331/babelfish/gnarly/fastest');
      expect(init?.method).toBe('POST');
      expect(String(init?.body)).toContain('"candidateLanguages":["rust"]');
      return new Response(JSON.stringify({ topoRaceGg: '(race)' }), {
        headers: { 'Content-Type': 'application/json' },
      });
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as typeof fetch;
    try {
      const response = await dispatch({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'zedge_babelfish_gnarly',
          arguments: {
            action: 'fastest',
            scope: {
              kind: 'inline',
              filePath: 'input.gnarly',
              sourceText: '(say: PolyglotBridgeCall { fastest: true })',
            },
            candidateLanguages: ['rust'],
          },
        },
      });

      const content = (
        response?.result as { content: Array<{ type: string; text: string }> }
      ).content[0];
      expect(content?.type).toBe('text');
      expect(content?.text).toContain('topoRaceGg');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
