import { afterAll, beforeAll, describe, expect, test } from '@a0n/gnosis/test';
import { execFileSync, spawn, type ChildProcess } from 'child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse,
} from 'http';
import { createServer as createNetServer } from 'net';
import { tmpdir } from 'os';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { resolveTypeScriptEntrypointCommand } from '../runtime-command';

interface ChatCompletionPayload {
  choices?: Array<{ message?: { content?: string | null } }>;
  tools_used?: string[];
  agentic?: {
    toolPreflight?: {
      toolCount?: number;
      visibleToolCount?: number;
    };
  };
}

interface JsonResponse<T> {
  status: number;
  body: T;
  headers: Headers;
}

interface MoonshineChatCall {
  headers: Record<string, string | string[] | undefined>;
  body: {
    messages?: Array<{ role?: string; content?: string | null; name?: string }>;
  };
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../../../../../');
const COMPANION_ENTRY = fileURLToPath(new URL('../index.ts', import.meta.url));

let companionProcess: ChildProcess | null = null;
let moonshineServer: HttpServer | null = null;
let companionPort = 0;
let moonshinePort = 0;
let testHome = '';
let testWorkspace = '';
let companionLogs = '';
let skipReason: string | null = null;
const moonshineChatCalls: MoonshineChatCall[] = [];
const moonshineSpeechBodies: unknown[] = [];

function isLoopbackListenDenied(error: unknown): boolean {
  return (
    error instanceof Error &&
    /listen EPERM|operation not permitted/i.test(error.message)
  );
}

function appendLogChunk(chunk: Buffer | string): void {
  companionLogs = `${companionLogs}${chunk.toString()}`;
  if (companionLogs.length > 24_000) {
    companionLogs = companionLogs.slice(-24_000);
  }
}

function getLogTail(): string {
  return companionLogs.trim().slice(-6_000);
}

async function reservePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createNetServer();
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

function readRequestBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolveBody, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.once('end', () => resolveBody(body));
    req.once('error', reject);
  });
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(text),
  });
  res.end(text);
}

function chatResponse(content: string): Record<string, unknown> {
  return {
    id: `chatcmpl-e2e-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: 'moonshine-e2e',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content },
        finish_reason: 'stop',
      },
    ],
    usage: {
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 15,
    },
  };
}

function renderMessages(
  messages: Array<{ role?: string; content?: string | null; name?: string }>
): string {
  return messages
    .map((message) => `${message.role ?? 'unknown'}:${message.name ?? ''}: ${message.content ?? ''}`)
    .join('\n');
}

async function handleMockMoonshineChat(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const rawBody = await readRequestBody(req);
  const body = JSON.parse(rawBody || '{}') as MoonshineChatCall['body'];
  moonshineChatCalls.push({ headers: req.headers, body });
  const prompt = renderMessages(body.messages ?? []);

  if (prompt.includes('Evaluate whether the assistant has fully satisfied')) {
    writeJson(
      res,
      200,
      chatResponse(
        '{"satisfied":true,"confidence":0.95,"reasoning":"e2e tools completed","suggestedNextAction":""}'
      )
    );
    return;
  }

  if (prompt.includes('proactive code reviewer')) {
    writeJson(
      res,
      200,
      chatResponse(
        '[LINE:1] [CATEGORY:readability] Name the integration constant clearly'
      )
    );
    return;
  }

  if (prompt.includes('tool:zedge_') || prompt.includes('all requested tools have returned')) {
    writeJson(
      res,
      200,
      chatResponse('All requested companion tools have returned results.')
    );
    return;
  }

  if (prompt.includes('TOOL CALLING INSTRUCTIONS')) {
    writeJson(
      res,
      200,
      chatResponse(
        [
          'I will inspect the connected companion tools.',
          '```tool_call',
          '{"name":"zedge_babelfish_code","arguments":{"scope":{"kind":"inline","filePath":"sample.ts","sourceText":"const value = 1;"},"targetLanguage":"rust","mode":"translate-code","outputMode":"preview"}}',
          '```',
          '```tool_call',
          '{"name":"zedge_swarm","arguments":{"action":"roles"}}',
          '```',
          '```tool_call',
          '{"name":"zedge_daydream","arguments":{"action":"dream","file_path":"sample.ts"}}',
          '```',
          '```tool_call',
          '{"name":"zedge_tts_preview","arguments":{"input":"Read the integration result"}}',
          '```',
          '```tool_call',
          '{"name":"zedge_preview_range_replace","arguments":{"file_path":"sample.ts","range":{"start":{"line":0,"character":6},"end":{"line":0,"character":11}},"replacement_text":"answer"}}',
          '```',
        ].join('\n')
      )
    );
    return;
  }

  writeJson(res, 200, chatResponse('Bare Moonshine response.'));
}

async function startMockMoonshine(): Promise<void> {
  moonshineServer = createHttpServer(async (req, res) => {
    try {
      if (req.url === '/health') {
        writeJson(res, 200, { status: 'ok' });
        return;
      }
      if (req.url === '/v1/models') {
        writeJson(res, 200, {
          object: 'list',
          data: [{ id: 'moonshine-e2e', object: 'model', owned_by: 'e2e' }],
        });
        return;
      }
      if (req.url === '/v1/chat/completions' && req.method === 'POST') {
        await handleMockMoonshineChat(req, res);
        return;
      }
      if (req.url === '/v1/audio/speech' && req.method === 'POST') {
        const rawBody = await readRequestBody(req);
        moonshineSpeechBodies.push(JSON.parse(rawBody || '{}'));
        const audio = Buffer.from('RIFF-e2e-wave-data');
        res.writeHead(200, {
          'Content-Type': 'audio/wav',
          'Content-Length': audio.byteLength,
        });
        res.end(audio);
        return;
      }
      writeJson(res, 404, { error: req.url });
    } catch (error) {
      writeJson(res, 500, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  await new Promise<void>((resolveListen, reject) => {
    moonshineServer?.once('error', reject);
    moonshineServer?.listen(0, '127.0.0.1', () => {
      const address = moonshineServer?.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Could not determine Moonshine mock port'));
        return;
      }
      moonshinePort = address.port;
      resolveListen();
    });
  });
}

async function stopMockMoonshine(): Promise<void> {
  const server = moonshineServer;
  moonshineServer = null;
  if (!server) return;
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
}

function childProcessIds(pid: number): number[] {
  try {
    return execFileSync('pgrep', ['-P', String(pid)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .split('\n')
      .map((value) => Number.parseInt(value.trim(), 10))
      .filter((value) => Number.isInteger(value) && value > 0);
  } catch {
    return [];
  }
}

function killProcessTree(pid: number, signal: NodeJS.Signals): void {
  for (const childPid of childProcessIds(pid)) {
    killProcessTree(childPid, signal);
  }
  try {
    process.kill(pid, signal);
  } catch {
    // Best-effort cleanup only.
  }
}

async function waitForCompanionHealth(timeoutMs = 45_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const url = `http://127.0.0.1:${companionPort}/health`;

  while (Date.now() < deadline) {
    if (
      companionProcess?.exitCode !== null &&
      companionProcess?.exitCode !== undefined
    ) {
      throw new Error(
        `Companion exited early with code ${companionProcess.exitCode}\n${getLogTail()}`
      );
    }

    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) return;
    } catch {
      // Still booting.
    }

    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  }

  throw new Error(`Timed out waiting for companion health\n${getLogTail()}`);
}

async function stopCompanion(): Promise<void> {
  const child = companionProcess;
  companionProcess = null;
  if (!child || child.exitCode !== null || child.killed) return;

  await new Promise<void>((resolveStop) => {
    let settled = false;
    const forceKillTimer = setTimeout(() => {
      if (child.pid !== undefined) killProcessTree(child.pid, 'SIGKILL');
    }, 2_000);
    const resolveTimer = setTimeout(() => finish(), 7_000);
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(forceKillTimer);
      clearTimeout(resolveTimer);
      resolveStop();
    };

    child.once('exit', finish);
    child.once('close', finish);
    if (child.pid !== undefined) {
      killProcessTree(child.pid, 'SIGTERM');
    } else {
      finish();
    }
  });
}

async function requestJson<T>(
  path: string,
  init: RequestInit = {}
): Promise<JsonResponse<T>> {
  const response = await fetch(`http://127.0.0.1:${companionPort}${path}`, {
    ...init,
    headers: {
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init.headers ?? {}),
    },
    signal: AbortSignal.timeout(45_000),
  });
  const text = await response.text();
  const body = (text ? JSON.parse(text) : null) as T;
  return { status: response.status, body, headers: response.headers };
}

function mcpText(result: unknown): string {
  const root = result as {
    result?: { content?: Array<{ text?: string }> };
  };
  return root.result?.content?.[0]?.text ?? '';
}

describe('Zedge companion agentic e2e', () => {
  beforeAll(async () => {
    try {
      companionPort = await reservePort();
      testHome = mkdtempSync(join(tmpdir(), 'zedge-agentic-home-e2e-'));
      testWorkspace = mkdtempSync(join(tmpdir(), 'zedge-agentic-workspace-e2e-'));
      mkdirSync(join(testHome, '.edgework'), { recursive: true });
      writeFileSync(
        join(testWorkspace, 'sample.ts'),
        [
          'const value = 1;',
          'export function compute() {',
          '  return value + 41;',
          '}',
          '',
        ].join('\n'),
        'utf8'
      );
      writeFileSync(
        join(testWorkspace, 'edit-target.ts'),
        "export const status = 'old';\n",
        'utf8'
      );

      await startMockMoonshine();

      const runtimeCommand = resolveTypeScriptEntrypointCommand(COMPANION_ENTRY);
      companionProcess = spawn(runtimeCommand.command, [...runtimeCommand.args], {
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          HOME: testHome,
          AEON_ROOT: testWorkspace,
          ZEDGE_COMPANION_PORT: String(companionPort),
          ZEDGE_LISTENER_MODE: 'bun',
          ZEDGE_MOONSHINE_URL: `http://127.0.0.1:${moonshinePort}`,
          ZEDGE_TTS_AUDIO_MODE: 'file',
          ZEDGE_TTS_ENABLED: '1',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      companionProcess.stdout?.on('data', appendLogChunk);
      companionProcess.stderr?.on('data', appendLogChunk);

      await waitForCompanionHealth();
    } catch (error) {
      if (isLoopbackListenDenied(error)) {
        skipReason = error.message;
        return;
      }
      throw error;
    }
  }, 60_000);

  afterAll(async () => {
    await stopCompanion();
    await stopMockMoonshine();
  });

  test('preflights tools and dispatches Babelfish through the public MCP endpoint', async () => {
    if (skipReason !== null) return;

    const preflight = await requestJson<{
      tools: Array<{ name: string }>;
    }>('/tools/preflight?refresh=1');
    expect(preflight.status).toBe(200);
    const toolNames = preflight.body.tools.map((tool) => tool.name);
    expect(toolNames).toContain('zedge_babelfish_code');
    expect(toolNames).toContain('zedge_daydream');
    expect(toolNames).toContain('zedge_swarm');
    expect(toolNames).toContain('zedge_tts_preview');

    const mcp = await requestJson<Record<string, unknown>>('/mcp', {
      method: 'POST',
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'babelfish-e2e',
        method: 'tools/call',
        params: {
          name: 'zedge_babelfish_code',
          arguments: {
            scope: {
              kind: 'inline',
              filePath: 'sample.ts',
              sourceText: 'const value = 1;',
            },
            targetLanguage: 'rust',
            mode: 'translate-code',
            outputMode: 'preview',
          },
        },
      }),
    });

    expect(mcp.status).toBe(200);
    expect(mcpText(mcp.body)).toContain('previewId');
  }, 60_000);

  test('runs Babelfish, agent swarm, Daydream, TTS, and edit-preview tools through agentic chat', async () => {
    if (skipReason !== null) return;

    const response = await requestJson<ChatCompletionPayload>('/v1/chat/completions', {
      method: 'POST',
      headers: { 'X-Zedge-Agentic': 'tools' },
      body: JSON.stringify({
        model: 'moonshine-e2e',
        stream: false,
        messages: [
          {
            role: 'user',
            content:
              'Use Babelfish, agent swarm roles, Daydream, TTS preview, and a preview edit for sample.ts.',
          },
        ],
        max_tool_rounds: 4,
      }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('x-zedge-agentic')).toBe('true');
    expect(response.body.choices?.[0]?.message?.content).toContain(
      'companion tools'
    );
    const toolsUsed = response.body.tools_used ?? [];
    for (const toolName of [
      'zedge_babelfish_code',
      'zedge_swarm',
      'zedge_daydream',
      'zedge_tts_preview',
      'zedge_preview_range_replace',
    ]) {
      if (!toolsUsed.includes(toolName)) {
        throw new Error(
          `Expected ${toolName} to run; tools_used=${JSON.stringify(
            toolsUsed
          )}; body=${JSON.stringify(response.body)}`
        );
      }
    }
    expect(response.body.agentic?.toolPreflight?.toolCount).toBeGreaterThan(0);
    expect(response.body.agentic?.toolPreflight?.visibleToolCount).toBeGreaterThan(
      0
    );
    expect(readFileSync(join(testWorkspace, 'sample.ts'), 'utf8')).toContain(
      'const value = 1;'
    );
    if (
      !moonshineSpeechBodies.some(
        (body) =>
          typeof body === 'object' &&
          body !== null &&
          (body as { input?: unknown }).input === 'Read the integration result'
      )
    ) {
      throw new Error(
        `Moonshine speech was not called with the TTS preview input: ${JSON.stringify(
          moonshineSpeechBodies
        )}`
      );
    }
    const agenticMoonshineCalls = moonshineChatCalls.filter((call) =>
      renderMessages(call.body.messages ?? []).includes('TOOL CALLING INSTRUCTIONS')
    );
    if (
      !agenticMoonshineCalls.every(
        (call) => call.headers['x-zedge-agentic'] === 'off'
      )
    ) {
      throw new Error(
        `Agentic Moonshine calls did not all force bare mode: ${JSON.stringify(
          agenticMoonshineCalls.map((call) => call.headers['x-zedge-agentic'])
        )}`
      );
    }
    if (
      !moonshineChatCalls.some((call) =>
        renderMessages(call.body.messages ?? []).includes('proactive code reviewer')
      )
    ) {
      throw new Error('Daydream did not reach Moonshine for proactive review');
    }
  }, 90_000);

  test('applies preview-first range edits over live HTTP exactly once', async () => {
    if (skipReason !== null) return;

    const preview = await requestJson<{
      previewId: string;
      oldHash: string;
      newHash: string;
    }>('/edit/range/preview', {
      method: 'POST',
      body: JSON.stringify({
        file_path: 'edit-target.ts',
        search: "'old'",
        replace: "'new'",
      }),
    });
    expect(preview.status).toBe(200);
    expect(preview.body.previewId).toContain('edit-');
    expect(preview.body.oldHash).not.toBe(preview.body.newHash);
    expect(readFileSync(join(testWorkspace, 'edit-target.ts'), 'utf8')).toContain(
      "'old'"
    );

    const apply = await requestJson<{ applied: boolean }>('/edit/range/apply', {
      method: 'POST',
      body: JSON.stringify({ previewId: preview.body.previewId }),
    });
    expect(apply.status).toBe(200);
    expect(apply.body.applied).toBe(true);
    expect(readFileSync(join(testWorkspace, 'edit-target.ts'), 'utf8')).toContain(
      "'new'"
    );

    const secondApply = await requestJson<Record<string, unknown>>(
      '/edit/range/apply',
      {
        method: 'POST',
        body: JSON.stringify({ previewId: preview.body.previewId }),
      }
    );
    expect(secondApply.status).toBe(409);
  }, 30_000);
});
