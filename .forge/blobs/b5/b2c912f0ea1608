import { afterAll, beforeAll, describe, expect, test } from '@a0n/gnosis/test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

interface ChatCompletionPayload {
  choices?: Array<{ message?: { content?: string | null } }>;
  tools_used?: string[];
  agentic?: {
    toolPreflight?: {
      toolCount?: number;
      visibleToolCount?: number;
      cached?: boolean;
    };
  };
}

interface JsonResponse<T> {
  status: number;
  body: T;
  headers: Headers;
}

interface MoonshineChatCall {
  headers: Record<string, string>;
  body: {
    messages?: Array<{ role?: string; content?: string | null; name?: string }>;
  };
}

type WebRequestHandler = (req: Request) => Promise<Response>;

const MOONSHINE_ORIGIN = 'http://moonshine.e2e';
const ENV_KEYS = [
  'HOME',
  'AEON_ROOT',
  'ZEDGE_COMPANION_PORT',
  'ZEDGE_LISTENER_MODE',
  'ZEDGE_MOONSHINE_URL',
  'ZEDGE_MOONSHINE_TIMEOUT_MS',
  'ZEDGE_AGENTIC_MOONSHINE_TIMEOUT_MS',
  'ZEDGE_TTS_AUDIO_MODE',
  'ZEDGE_TTS_ENABLED',
  'ZEDGE_INFERENCE_LOG_FILE',
] as const;

let companionOrigin = '';
let handleWebRequest: WebRequestHandler | null = null;
let testHome = '';
let testWorkspace = '';
let sampleFile = '';
const originalFetch = globalThis.fetch;
const originalEnv: Record<string, string | undefined> = {};
const moonshineChatCalls: MoonshineChatCall[] = [];
const moonshineSpeechBodies: unknown[] = [];

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
    .map(
      (message) =>
        `${message.role ?? 'unknown'}:${message.name ?? ''}: ${
          message.content ?? ''
        }`
    )
    .join('\n');
}

function requestFromFetch(input: RequestInfo | URL, init?: RequestInit): Request {
  if (input instanceof Request && init === undefined) {
    return input;
  }
  return new Request(input, init);
}

function requestUrl(input: RequestInfo | URL): URL {
  if (input instanceof Request) return new URL(input.url);
  if (input instanceof URL) return input;
  return new URL(String(input));
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function handleMockMoonshineChat(request: Request): Promise<Response> {
  const rawBody = await request.text();
  const body = JSON.parse(rawBody || '{}') as MoonshineChatCall['body'];
  moonshineChatCalls.push({
    headers: Object.fromEntries(request.headers.entries()),
    body,
  });
  const prompt = renderMessages(body.messages ?? []);

  if (prompt.includes('Evaluate whether the assistant has fully satisfied')) {
    return jsonResponse(
      200,
      chatResponse(
        '{"satisfied":true,"confidence":0.95,"reasoning":"e2e tools completed","suggestedNextAction":""}'
      )
    );
  }

  if (prompt.includes('proactive code reviewer')) {
    return jsonResponse(
      200,
      chatResponse(
        '[LINE:1] [CATEGORY:readability] Name the integration constant clearly'
      )
    );
  }

  if (prompt.includes('\ntool::') || prompt.includes('all requested tools have returned')) {
    return jsonResponse(
      200,
      chatResponse('All requested companion tools have returned results.')
    );
  }

  if (prompt.includes('TOOL CALLING INSTRUCTIONS')) {
    return jsonResponse(
      200,
      chatResponse(
        [
          'I will inspect the connected companion tools.',
          '```tool_call',
          `{"name":"zedge_babelfish_code","arguments":{"scope":{"kind":"inline","filePath":"sample.ts","sourceText":"const value = 1;"},"targetLanguage":"rust","mode":"translate-code","outputMode":"preview"}}`,
          '```',
          '```tool_call',
          '{"name":"zedge_swarm","arguments":{"action":"roles"}}',
          '```',
          '```tool_call',
          `{"name":"zedge_daydream","arguments":{"action":"dream","file_path":${JSON.stringify(
            sampleFile
          )}}}`,
          '```',
          '```tool_call',
          '{"name":"zedge_tts_preview","arguments":{"input":"Read the integration result"}}',
          '```',
          '```tool_call',
          `{"name":"zedge_preview_range_replace","arguments":{"file_path":${JSON.stringify(
            sampleFile
          )},"range":{"start":{"line":0,"character":13},"end":{"line":0,"character":18}},"replacement_text":"answer"}}`,
          '```',
        ].join('\n')
      )
    );
  }

  return jsonResponse(200, chatResponse('Bare Moonshine response.'));
}

async function handleMockMoonshine(request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === '/health') {
    return jsonResponse(200, { status: 'ok' });
  }
  if (url.pathname === '/v1/models') {
    return jsonResponse(200, {
      object: 'list',
      data: [{ id: 'moonshine-e2e', object: 'model', owned_by: 'e2e' }],
    });
  }
  if (url.pathname === '/v1/chat/completions' && request.method === 'POST') {
    return handleMockMoonshineChat(request);
  }
  if (url.pathname === '/v1/audio/speech' && request.method === 'POST') {
    const rawBody = await request.text();
    moonshineSpeechBodies.push(JSON.parse(rawBody || '{}'));
    return new Response(Buffer.from('RIFF-e2e-wave-data'), {
      status: 200,
      headers: { 'Content-Type': 'audio/wav' },
    });
  }
  return jsonResponse(404, { error: url.pathname });
}

function installFetchMultiplexer(): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = requestUrl(input);
    const request = requestFromFetch(input, init);

    if (url.origin === companionOrigin) {
      if (!handleWebRequest) {
        throw new Error('Companion request handler is not ready');
      }
      return handleWebRequest(request);
    }

    if (url.origin === MOONSHINE_ORIGIN) {
      return handleMockMoonshine(request);
    }

    throw new Error(`Unexpected network request in e2e: ${url.href}`);
  }) as typeof fetch;
}

async function requestJson<T>(
  path: string,
  init: RequestInit = {}
): Promise<JsonResponse<T>> {
  const headers = new Headers(init.headers);
  if (init.body !== undefined && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  const response = await fetch(`${companionOrigin}${path}`, {
    ...init,
    headers,
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

function setE2eEnv(): void {
  for (const key of ENV_KEYS) {
    originalEnv[key] = process.env[key];
  }

  const companionPort = 17_331 + Math.floor(Math.random() * 1_000);
  companionOrigin = `http://127.0.0.1:${companionPort}`;
  testHome = mkdtempSync(join(tmpdir(), 'zedge-agentic-home-e2e-'));
  testWorkspace = mkdtempSync(join(tmpdir(), 'zedge-agentic-workspace-e2e-'));
  sampleFile = join(testWorkspace, 'sample.ts');
  mkdirSync(join(testHome, '.edgework'), { recursive: true });
  writeFileSync(
    sampleFile,
    [
      'export const value = 1;',
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

  process.env.HOME = testHome;
  process.env.AEON_ROOT = testWorkspace;
  process.env.ZEDGE_COMPANION_PORT = String(companionPort);
  process.env.ZEDGE_LISTENER_MODE = 'bun';
  process.env.ZEDGE_MOONSHINE_URL = MOONSHINE_ORIGIN;
  process.env.ZEDGE_MOONSHINE_TIMEOUT_MS = '15000';
  process.env.ZEDGE_AGENTIC_MOONSHINE_TIMEOUT_MS = '15000';
  process.env.ZEDGE_TTS_AUDIO_MODE = 'file';
  process.env.ZEDGE_TTS_ENABLED = '1';
  process.env.ZEDGE_INFERENCE_LOG_FILE = 'off';
}

function restoreE2eEnv(): void {
  for (const key of ENV_KEYS) {
    const value = originalEnv[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

describe('Zedge companion agentic e2e', () => {
  beforeAll(async () => {
    setE2eEnv();
    installFetchMultiplexer();
    const server = await import('../server.ts');
    handleWebRequest = server.handleWebRequest;
  }, 30_000);

  afterAll(() => {
    globalThis.fetch = originalFetch;
    restoreE2eEnv();
    if (testHome) rmSync(testHome, { recursive: true, force: true });
    if (testWorkspace) rmSync(testWorkspace, { recursive: true, force: true });
  });

  test('preflights tools and dispatches Babelfish through the public MCP endpoint', async () => {
    const preflight = await requestJson<{
      cached: boolean;
      tools: Array<{ name: string }>;
    }>('/tools/preflight?refresh=1');
    expect(preflight.status).toBe(200);
    expect(preflight.body.cached).toBe(false);
    const toolNames = preflight.body.tools.map((tool) => tool.name);
    expect(toolNames).toContain('zedge_babelfish_code');
    expect(toolNames).toContain('zedge_daydream');
    expect(toolNames).toContain('zedge_swarm');
    expect(toolNames).toContain('zedge_tts_preview');

    const cachedPreflight = await requestJson<{ cached: boolean }>(
      '/tools/preflight'
    );
    expect(cachedPreflight.status).toBe(200);
    expect(cachedPreflight.body.cached).toBe(true);

    const voices = await requestJson<{
      defaultVoice: string;
      voices: Array<{ id: string; model: string }>;
    }>('/tts/voices');
    expect(voices.status).toBe(200);
    expect(voices.body.defaultVoice).toBe('local');
    expect(voices.body.voices.map((voice) => voice.id)).toContain('moonshine');

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
    const response = await requestJson<ChatCompletionPayload>(
      '/v1/chat/completions',
      {
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
      }
    );

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
    expect(readFileSync(sampleFile, 'utf8')).toContain('export const value = 1;');
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
      agenticMoonshineCalls.length === 0 ||
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
    const editTarget = join(testWorkspace, 'edit-target.ts');
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
    expect(readFileSync(editTarget, 'utf8')).toContain("'old'");

    const apply = await requestJson<{ applied: boolean }>('/edit/range/apply', {
      method: 'POST',
      body: JSON.stringify({ previewId: preview.body.previewId }),
    });
    expect(apply.status).toBe(200);
    expect(apply.body.applied).toBe(true);
    expect(readFileSync(editTarget, 'utf8')).toContain("'new'");

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
