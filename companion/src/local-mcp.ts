import {
  dispatch,
  handleToolCall,
  handleToolsList,
  type JsonRpcRequest,
  type JsonRpcResponse,
} from './mcp-stdio.ts';

export interface LocalMcpTool {
  name: string;
  description?: string;
  inputSchema?: {
    type?: string;
    properties?: Record<string, unknown>;
    required?: string[];
  };
}

export interface LocalToolPreflight {
  tools: LocalMcpTool[];
  cached: boolean;
  durationMs: number;
  cachedAt: number;
  expiresAt: number;
}

const TOOL_CACHE_TTL_MS = 5 * 60_000;
let cachedTools: { tools: LocalMcpTool[]; cachedAt: number } | null = null;

function isLocalMcpTool(value: unknown): value is LocalMcpTool {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof (value as { name?: unknown }).name === 'string'
  );
}

export async function preflightLocalTools(
  options: { forceRefresh?: boolean } = {},
): Promise<LocalToolPreflight> {
  const now = Date.now();
  if (
    !options.forceRefresh &&
    cachedTools &&
    now - cachedTools.cachedAt < TOOL_CACHE_TTL_MS
  ) {
    return {
      tools: cachedTools.tools,
      cached: true,
      durationMs: 0,
      cachedAt: cachedTools.cachedAt,
      expiresAt: cachedTools.cachedAt + TOOL_CACHE_TTL_MS,
    };
  }

  const startedAt = Date.now();
  const result = await handleToolsList();
  const rawTools = Array.isArray(result.tools) ? result.tools : [];
  const tools = rawTools.filter(isLocalMcpTool);
  cachedTools = { tools, cachedAt: Date.now() };

  return {
    tools,
    cached: false,
    durationMs: Date.now() - startedAt,
    cachedAt: cachedTools.cachedAt,
    expiresAt: cachedTools.cachedAt + TOOL_CACHE_TTL_MS,
  };
}

export async function callLocalTool(
  name: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return handleToolCall({ name, arguments: args });
}

export async function handleLocalMcpJsonRpc(
  request: JsonRpcRequest,
): Promise<JsonRpcResponse | null> {
  return dispatch(request);
}
