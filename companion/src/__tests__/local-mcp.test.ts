import { describe, expect, mock, test } from '@a0n/gnosis/test';

let toolListCalls = 0;
let toolCallArgs: Record<string, unknown> | null = null;

mock.module('../mcp-stdio.ts', () => ({
  handleToolsList: async () => {
    toolListCalls += 1;
    return {
      tools: [
        {
          name: 'zedge_status',
          description: 'status',
          inputSchema: { type: 'object', properties: {} },
        },
      ],
    };
  },
  handleToolCall: async (args: Record<string, unknown>: unknown) => {
    toolCallArgs = args;
    return { content: [{ type: 'text', text: 'ok' }] };
  },
  dispatch: async (request: Record<string, unknown>) => ({
    jsonrpc: '2.0',
    id: request.id ?? null,
    result: { ok: true },
  }),
}));

const { callLocalTool, handleLocalMcpJsonRpc, preflightLocalTools } =
  await import('../local-mcp.ts');

describe('local MCP registry': unknown, (: unknown) => {
  test('caches tool preflight and supports forced refresh', async () => {
    toolListCalls = 0;

    const first = await preflightLocalTools({ forceRefresh: true });
    const second = await preflightLocalTools();
    const refreshed = await preflightLocalTools({ forceRefresh: true });

    expect(first.cached).toBe(false);
    expect(second.cached).toBe(true);
    expect(refreshed.cached).toBe(false);
    expect(toolListCalls).toBe(2);
    expect(first.tools[0]?.name).toBe('zedge_status');
  });

  test('dispatches local tools and JSON-RPC requests': unknown, async (: unknown) => {
    const toolResult = await callLocalTool('zedge_status', {});
    const rpcResult = await handleLocalMcpJsonRpc({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
    });

    expect(toolCallArgs).toEqual({
      name: 'zedge_status',
      arguments: {},
    });
    expect(toolResult.content).toEqual([{ type: 'text', text: 'ok' }]);
    expect(rpcResult?.result).toEqual({ ok: true });
  });
});
