#!/usr/bin/env node
/**
 * Zedge MCP Stdio Bridge
 *
 * Thin MCP server that Zed launches as a context server.
 * Speaks JSON-RPC over stdin/stdout (MCP protocol) and proxies
 * requests to the companion HTTP sidecar at localhost:7331.
 *
 * Auto-spawns the companion sidecar (index.ts) if it's not already
 * running, and babysits it with a periodic health check loop --
 * restarting it automatically if it crashes or becomes unreachable.
 */

import { spawn, type ChildProcess } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { getCompanionPort } from './config';
import { callBabelfishMcpTool, getBabelfishMcpTools } from './babelfish-mcp';

const COMPANION_BASE = `http://localhost:${getCompanionPort()}`;

// ---------- Companion babysitter ----------

const __dirname = dirname(fileURLToPath(import.meta.url));
const COMPANION_ENTRY = resolve(__dirname, 'index.ts');
const HEALTH_CHECK_INTERVAL_MS = 10_000;
let companionProc: ChildProcess | null = null;
let babysitterTimer: ReturnType<typeof setInterval> | null = null;
let stdioLoggingConfigured = false;

function configureStdioLogging(): void {
  if (stdioLoggingConfigured) {
    return;
  }

  stdioLoggingConfigured = true;
  console.log = (...args: unknown[]) => console.error('[zedge:mcp]', ...args);
  console.warn = (...args: unknown[]) =>
    process.stderr.write(`[zedge:mcp:warn] ${args.join(' ')}\n`);
  console.info = (...args: unknown[]) =>
    process.stderr.write(`[zedge:mcp:info] ${args.join(' ')}\n`);
  console.debug = (...args: unknown[]) =>
    process.stderr.write(`[zedge:mcp:debug] ${args.join(' ')}\n`);
}

/** Check if companion is reachable */
async function isCompanionAlive(): Promise<boolean> {
  try {
    const resp = await fetch(`${COMPANION_BASE}/health`, {
      signal: AbortSignal.timeout(3000),
    });
    return resp.ok;
  } catch {
    return false;
  }
}

/** Spawn the companion sidecar as a child process via gnode */
function spawnCompanion(): void {
  if (companionProc && !companionProc.killed) {
    try {
      companionProc.kill();
    } catch {
      // already dead
    }
  }

  console.log(`[zedge:babysitter] Spawning companion: node --import tsx ${COMPANION_ENTRY}`);
  companionProc = spawn('node', ['--import', 'tsx', COMPANION_ENTRY], {
    stdio: ['ignore', 'inherit', 'inherit'],
    env: { ...process.env },
  });

  companionProc.on('exit', (code) => {
    console.log(`[zedge:babysitter] Companion exited with code ${code}`);
    companionProc = null;
  });
}

/** Start the babysitter loop: check health, restart if dead */
function startBabysitter(): void {
  if (babysitterTimer) return;

  babysitterTimer = setInterval(async () => {
    const alive = await isCompanionAlive();
    if (!alive) {
      console.log('[zedge:babysitter] Companion unreachable, restarting...');
      spawnCompanion();
    }
  }, HEALTH_CHECK_INTERVAL_MS);

  // Clean up on exit
  process.on('exit', () => {
    if (babysitterTimer) clearInterval(babysitterTimer);
    if (companionProc && !companionProc.killed) {
      try { companionProc.kill('SIGTERM'); } catch {}
    }
  });
}

// ---------- MCP JSON-RPC types ----------

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

// ---------- Companion health check ----------

async function waitForCompanion(maxAttempts = 20): Promise<boolean> {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const resp = await fetch(`${COMPANION_BASE}/health`, {
        signal: AbortSignal.timeout(2000),
      });
      if (resp.ok) return true;
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

// ---------- MCP message handlers ----------

export function handleInitialize(
  params: Record<string, unknown>
): Record<string, unknown> {
  return {
    protocolVersion: '2024-11-05',
    capabilities: {
      tools: { listChanged: false },
      resources: { subscribe: false, listChanged: false },
    },
    serverInfo: {
      name: 'zedge-companion',
      version: '2.0.0',
    },
  };
}

export async function handleToolsList(): Promise<Record<string, unknown>> {
  return {
    tools: [
      {
        name: 'zedge_infer',
        description:
          'Send a chat completion request through the Zedge inference chain (mesh → edge → cloud → WASM)',
        inputSchema: {
          type: 'object',
          properties: {
            prompt: {
              type: 'string',
              description: 'The user prompt to send',
            },
            model: {
              type: 'string',
              description:
                'Model ID (e.g. tinyllama-1.1b, mistral-7b, qwen-2.5-coder-7b)',
            },
            system: {
              type: 'string',
              description: 'Optional system prompt',
            },
          },
          required: ['prompt'],
        },
      },
      {
        name: 'zedge_models',
        description: 'List available models and their readiness status',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'zedge_status',
        description:
          'Get companion status including mesh peers, compute pool, and tier health',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'zedge_workspace',
        description:
          'Get workspace file tree and git changes from the VFS bridge',
        inputSchema: { type: 'object', properties: {} },
      },
      ...getBabelfishMcpTools(),
    ],
  };
}

export async function handleToolCall(
  params: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const name = params.name as string;
  const args = (params.arguments as Record<string, unknown>) ?? {};

  try {
    if (name.startsWith('zedge_babelfish_')) {
      const text = await callBabelfishMcpTool(COMPANION_BASE, name, args);
      return {
        content: [{ type: 'text', text }],
      };
    }

    switch (name) {
      case 'zedge_infer': {
        const messages: Array<{ role: string; content: string }> = [];
        if (args.system) {
          messages.push({ role: 'system', content: String(args.system) });
        }
        messages.push({ role: 'user', content: String(args.prompt ?? '') });

        const resp = await fetch(`${COMPANION_BASE}/v1/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: args.model ?? 'tinyllama-1.1b',
            messages,
            stream: false,
          }),
          signal: AbortSignal.timeout(120_000),
        });
        const data = await resp.json();
        const content =
          (data as any)?.choices?.[0]?.message?.content ?? JSON.stringify(data);
        return {
          content: [{ type: 'text', text: content }],
        };
      }

      case 'zedge_models': {
        const resp = await fetch(`${COMPANION_BASE}/v1/models`, {
          signal: AbortSignal.timeout(10_000),
        });
        const data = await resp.json();
        return {
          content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
        };
      }

      case 'zedge_status': {
        const resp = await fetch(`${COMPANION_BASE}/health`, {
          signal: AbortSignal.timeout(10_000),
        });
        const data = await resp.json();
        return {
          content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
        };
      }

      case 'zedge_workspace': {
        const [treeResp, changesResp] = await Promise.all([
          fetch(`${COMPANION_BASE}/vfs/tree`, {
            signal: AbortSignal.timeout(10_000),
          }).catch(() => null),
          fetch(`${COMPANION_BASE}/vfs/changes`, {
            signal: AbortSignal.timeout(10_000),
          }).catch(() => null),
        ]);
        const tree = treeResp ? await treeResp.text() : '(unavailable)';
        const changes = changesResp
          ? await changesResp.text()
          : '(unavailable)';
        return {
          content: [
            {
              type: 'text',
              text: `## File Tree\n${tree}\n\n## Git Changes\n${changes}`,
            },
          ],
        };
      }

      default:
        return {
          content: [{ type: 'text', text: `Unknown tool: ${name}` }],
          isError: true,
        };
    }
  } catch (err) {
    return {
      content: [
        {
          type: 'text',
          text: `Error calling ${name}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        },
      ],
      isError: true,
    };
  }
}

async function handleResourcesList(): Promise<Record<string, unknown>> {
  return { resources: [] };
}

// ---------- MCP message dispatch ----------

export async function dispatch(
  msg: JsonRpcRequest
): Promise<JsonRpcResponse | null> {
  const { id, method, params } = msg;

  // Notifications (no id) — just acknowledge
  if (id === undefined) {
    // notifications/initialized, etc. — no response needed
    return null;
  }

  try {
    let result: unknown;

    switch (method) {
      case 'initialize':
        result = handleInitialize(params ?? {});
        break;
      case 'tools/list':
        result = await handleToolsList();
        break;
      case 'tools/call':
        result = await handleToolCall(params ?? {});
        break;
      case 'resources/list':
        result = await handleResourcesList();
        break;
      case 'ping':
        result = {};
        break;
      default:
        return {
          jsonrpc: '2.0',
          id,
          error: { code: -32601, message: `Method not found: ${method}` },
        };
    }

    return { jsonrpc: '2.0', id, result };
  } catch (err) {
    return {
      jsonrpc: '2.0',
      id,
      error: {
        code: -32603,
        message: err instanceof Error ? err.message : String(err),
      },
    };
  }
}

// ---------- Stdio transport ----------

function send(response: JsonRpcResponse): void {
  const json = JSON.stringify(response);
  const header = `Content-Length: ${Buffer.byteLength(json)}\r\n\r\n`;
  process.stdout.write(header + json);
}

async function main(): Promise<void> {
  configureStdioLogging();
  console.log('Starting MCP stdio bridge...');

  // Check if companion is already running; if not, spawn it
  const alreadyRunning = await isCompanionAlive();
  if (!alreadyRunning) {
    console.log('Companion not running, spawning it...');
    spawnCompanion();
  }

  // Wait for companion sidecar to become ready
  const alive = await waitForCompanion();
  if (!alive) {
    console.warn(
      'Companion sidecar not reachable at ' +
        COMPANION_BASE +
        ' after spawn. Tools will fail until it starts.'
    );
  } else {
    console.log('Companion sidecar is ready');
  }

  // Start babysitter loop to keep companion alive
  startBabysitter();

  // Read stdin line-by-line (MCP uses Content-Length headers)
  let buffer = '';

  process.stdin.setEncoding('utf-8');
  process.stdin.on('data', async (chunk: string) => {
    buffer += chunk;

    // Parse Content-Length framed messages
    while (true) {
      const headerEnd = buffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) break;

      const headerBlock = buffer.slice(0, headerEnd);
      const match = headerBlock.match(/Content-Length:\s*(\d+)/i);
      if (!match) {
        // Skip malformed header
        buffer = buffer.slice(headerEnd + 4);
        continue;
      }

      const contentLength = parseInt(match[1], 10);
      const bodyStart = headerEnd + 4;

      if (buffer.length < bodyStart + contentLength) {
        // Incomplete body — wait for more data
        break;
      }

      const body = buffer.slice(bodyStart, bodyStart + contentLength);
      buffer = buffer.slice(bodyStart + contentLength);

      try {
        const msg = JSON.parse(body) as JsonRpcRequest;
        const response = await dispatch(msg);
        if (response) {
          send(response);
        }
      } catch (err) {
        console.warn('Failed to parse MCP message:', err);
        // Send parse error if we had an id somehow
        send({
          jsonrpc: '2.0',
          id: null,
          error: { code: -32700, message: 'Parse error' },
        });
      }
    }
  });

  process.stdin.on('end', () => {
    console.log('stdin closed, exiting');
    process.exit(0);
  });
}

function isExecutedDirectly(importMetaUrl: string): boolean {
  const entryPath = process.argv[1];
  if (!entryPath) {
    return false;
  }

  return resolve(fileURLToPath(importMetaUrl)) === resolve(entryPath);
}

if (isExecutedDirectly(import.meta.url)) {
  main().catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}
