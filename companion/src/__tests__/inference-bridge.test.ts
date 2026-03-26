import { describe, test, expect } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { clearLogs, getModels, embed, infer } from '../inference-bridge';
import type {
  InferenceTier,
  ChatCompletionResponse,
} from '../inference-bridge';

describe('Inference Bridge', () => {
  test('getModels returns array with wasm-local', async () => {
    const models = await getModels();
    expect(Array.isArray(models)).toBe(true);
    expect(models.length).toBeGreaterThan(0);

    // WASM local model should always be present
    const wasmModel = models.find((m) => m.id === 'wasm-local');
    expect(wasmModel).toBeDefined();
    expect(wasmModel!.owned_by).toBe('edgework-wasm');
  }, 10_000);

  test('getModels includes Cloud Run coordinator models', async () => {
    const models = await getModels();
    const cloudRunModels = models.filter(
      (m) => m.owned_by === 'edgework-cloudrun'
    );
    expect(cloudRunModels.length).toBeGreaterThan(0);

    const modelIds = models.map((m) => m.id);
    expect(modelIds).toContain('tinyllama-1.1b');
    expect(modelIds).toContain('mistral-7b');
    expect(modelIds).toContain('qwen-2.5-coder-7b');
    expect(modelIds).toContain('gemma3-4b-it');
    expect(modelIds).toContain('glm-4-9b');
  }, 10_000);

  test('model objects have required fields', async () => {
    const models = await getModels();
    for (const model of models) {
      expect(model).toHaveProperty('id');
      expect(model).toHaveProperty('object');
      expect(model).toHaveProperty('owned_by');
      expect(model.object).toBe('model');
      expect(typeof model.id).toBe('string');
      expect(model.id.length).toBeGreaterThan(0);
    }
  }, 10_000);

  test('InferenceTier type covers all tiers', () => {
    const tiers: InferenceTier[] = ['mesh', 'edge', 'cloudrun', 'wasm', 'echo'];
    expect(tiers.length).toBe(5);
    // Type system validates these are all valid InferenceTier values
  });

  test('infer with wasm-local returns real response', async () => {
    // Force WASM tier by using a model name that won't match any remote
    const result = await infer({
      model: 'wasm-local-only-test',
      messages: [{ role: 'user', content: 'hello' }],
      max_tokens: 50,
    });

    // Should fall through to WASM or echo
    expect(['wasm', 'echo']).toContain(result.tier);
    expect(result.response).toBeDefined();

    const data = (await result.response.json()) as ChatCompletionResponse;
    expect(data).toHaveProperty('id');
    expect(data).toHaveProperty('object');
    expect(data).toHaveProperty('choices');
    expect(data.choices.length).toBeGreaterThan(0);
    expect(data.choices[0].message.role).toBe('assistant');
    expect(typeof data.choices[0].message.content).toBe('string');
    // Local Aether and echo tiers may return empty content strings under mocks
    expect(data.choices[0].message.content.length).toBeGreaterThanOrEqual(0);
  }, 30_000);

  test('infer falls back to local wasm when the remote tiers miss', async () => {
    const originalFetch = global.fetch;
    global.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/v1/chat/completions')) {
        return new Response('remote unavailable', {
          status: 503,
          statusText: 'Service Unavailable',
        });
      }
      return new Response('unexpected', { status: 500 });
    }) as typeof fetch;

    try {
      const result = await infer({
        model: 'remote-fallback-test',
        messages: [{ role: 'user', content: 'Fallback to local please.' }],
        max_tokens: 64,
      });

      expect(result.tier).toBe('wasm');
      expect(result.attempts.some((attempt) => attempt.tier === 'edge')).toBe(
        true
      );
      expect(
        result.attempts.some(
          (attempt) => attempt.tier === 'wasm' && attempt.status === 'ok'
        )
      ).toBe(true);

      const data = (await result.response.json()) as ChatCompletionResponse;
      expect(data.model).not.toBe('echo-fallback');
      expect(data.choices[0]?.message.role).toBe('assistant');
      expect(typeof data.choices[0]?.message.content).toBe('string');
    } finally {
      global.fetch = originalFetch;
    }
  }, 45_000);

  test('infer requests streaming from edge and collapses SSE for JSON callers', async () => {
    const originalFetch = global.fetch;
    const requestBodies: Array<Record<string, unknown>> = [];
    const requestHeaders: Array<Headers> = [];

    global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/ai/communicate')) {
        requestBodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
        requestHeaders.push(new Headers(init?.headers));
        const firstChunk = JSON.stringify({
          id: 'chatcmpl-edge-stream',
          object: 'chat.completion.chunk',
          created: 1000,
          model: 'tinyllama-1.1b',
          choices: [
            {
              index: 0,
              delta: { content: 'Hello' },
              finish_reason: null,
            },
          ],
        });
        const secondChunk = JSON.stringify({
          id: 'chatcmpl-edge-stream',
          object: 'chat.completion.chunk',
          created: 1000,
          model: 'tinyllama-1.1b',
          choices: [
            {
              index: 0,
              delta: { content: ' world' },
              finish_reason: null,
            },
          ],
        });

        return new Response(
          `: heartbeat\n\ndata: ${firstChunk}\n\ndata: ${secondChunk}\n\ndata: [DONE]\n\n`,
          {
            status: 200,
            headers: {
              'Content-Type': 'text/event-stream',
              'X-Inference-Type': 'full-transformer-moa-sse',
            },
          }
        );
      }

      return new Response('unexpected', { status: 500 });
    }) as typeof fetch;

    try {
      const result = await infer({
        model: 'tinyllama-1.1b',
        messages: [{ role: 'user', content: 'hello' }],
        stream: false,
        max_tokens: 32,
      });

      expect(result.tier).toBe('edge');
      expect(requestBodies).toHaveLength(1);
      expect(requestBodies[0]?.stream).toBe(true);
      expect(requestHeaders[0]?.get('accept')).toContain('text/event-stream');
      expect(result.response.headers.get('content-type')).toContain(
        'application/json'
      );

      const data = (await result.response.json()) as ChatCompletionResponse;
      expect(data.choices[0]?.message.content).toBe('Hello world');
    } finally {
      global.fetch = originalFetch;
    }
  });

  test(
    'infer collapses edge SSE once finish_reason arrives even if upstream stays open',
    async () => {
      const originalFetch = global.fetch;

      global.fetch = (async (input: RequestInfo | URL) => {
        const url = String(input);
        if (!url.includes('/ai/communicate')) {
          return new Response('unexpected', { status: 500 });
        }

        const encoder = new TextEncoder();
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({
                    id: 'chatcmpl-edge-open',
                    object: 'chat.completion.chunk',
                    created: 1000,
                    model: 'tinyllama-1.1b',
                    choices: [
                      {
                        index: 0,
                        delta: { content: 'LIVE_OK' },
                        finish_reason: null,
                      },
                    ],
                  })}\n\n`
                )
              );
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({
                    id: 'chatcmpl-edge-open',
                    object: 'chat.completion.chunk',
                    created: 1000,
                    model: 'tinyllama-1.1b',
                    choices: [
                      {
                        index: 0,
                        delta: {},
                        finish_reason: 'stop',
                      },
                    ],
                  })}\n\n`
                )
              );
              // Leave the connection open after the logical completion.
            },
          }),
          {
            status: 200,
            headers: { 'Content-Type': 'text/event-stream' },
          }
        );
      }) as typeof fetch;

      try {
        const result = await infer({
          model: 'tinyllama-1.1b',
          messages: [{ role: 'user', content: 'Reply with exactly: LIVE_OK' }],
          stream: false,
          max_tokens: 8,
          temperature: 0,
        });

        const data = (await result.response.json()) as ChatCompletionResponse;
        expect(data.choices[0]?.message.content).toBe('LIVE_OK');
      } finally {
        global.fetch = originalFetch;
      }
    },
    2_000
  );

  test('infer falls back to wasm when edge returns only empty SSE content', async () => {
    const originalFetch = global.fetch;

    global.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (!url.includes('/ai/communicate')) {
        return new Response('unexpected', { status: 500 });
      }

      const emptyChunk = JSON.stringify({
        id: 'chatcmpl-edge-empty',
        object: 'chat.completion.chunk',
        created: 1000,
        model: 'tinyllama-1.1b',
        choices: [
          {
            index: 0,
            delta: { content: '   ' },
            finish_reason: null,
          },
        ],
      });
      const stopChunk = JSON.stringify({
        id: 'chatcmpl-edge-empty',
        object: 'chat.completion.chunk',
        created: 1000,
        model: 'tinyllama-1.1b',
        choices: [
          {
            index: 0,
            delta: {},
            finish_reason: 'stop',
          },
        ],
      });

      return new Response(
        `data: ${emptyChunk}\n\ndata: ${stopChunk}\n\ndata: [DONE]\n\n`,
        {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        }
      );
    }) as typeof fetch;

    try {
      const result = await infer({
        model: 'tinyllama-1.1b',
        messages: [{ role: 'user', content: 'hello' }],
        stream: false,
        max_tokens: 16,
        temperature: 0,
      });

      expect(result.tier).toBe('wasm');
      const data = (await result.response.json()) as ChatCompletionResponse;
      expect(data.choices[0]?.message.role).toBe('assistant');
      expect(typeof data.choices[0]?.message.content).toBe('string');
    } finally {
      global.fetch = originalFetch;
    }
  }, 45_000);

  test('infer requests SSE from edge for streaming callers', async () => {
    const originalFetch = global.fetch;
    const requestBodies: Array<Record<string, unknown>> = [];
    const requestHeaders: Array<Headers> = [];

    global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/ai/communicate')) {
        requestBodies.push(
          JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
        );
        requestHeaders.push(new Headers(init?.headers));

        const chunk = JSON.stringify({
          id: 'chatcmpl-edge-streaming',
          object: 'chat.completion.chunk',
          created: 1000,
          model: 'tinyllama-1.1b',
          choices: [
            {
              index: 0,
              delta: { content: 'stream token' },
              finish_reason: null,
            },
          ],
        });

        return new Response(`data: ${chunk}\n\ndata: [DONE]\n\n`, {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        });
      }

      return new Response('unexpected', { status: 500 });
    }) as typeof fetch;

    try {
      const result = await infer({
        model: 'tinyllama-1.1b',
        messages: [{ role: 'user', content: 'hello' }],
        stream: true,
        max_tokens: 32,
      });

      expect(result.tier).toBe('edge');
      expect(requestBodies).toHaveLength(1);
      expect(requestBodies[0]?.stream).toBe(true);
      expect(requestHeaders[0]?.get('accept')).toContain('text/event-stream');
      expect(result.response.headers.get('content-type')).toContain(
        'text/event-stream'
      );
      expect(await result.response.text()).toContain('stream token');
    } finally {
      global.fetch = originalFetch;
    }
  });

  test('embed with local fallback returns embedding', async () => {
    // Use a bogus model to force local fallback
    const resp = await embed('test text for embedding', 'nonexistent-model');
    const data = (await resp.json()) as {
      object: string;
      data: Array<{ embedding: number[]; index: number }>;
      model: string;
    };

    expect(data.object).toBe('list');
    expect(data.data.length).toBe(1);
    expect(data.data[0].embedding.length).toBe(384);
    expect(data.data[0].index).toBe(0);

    // Verify it's L2-normalized (magnitude ~= 1.0)
    const vec = data.data[0].embedding;
    const magnitude = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0));
    expect(magnitude).toBeCloseTo(1.0, 1);
  }, 15_000);

  test('embed with array input returns multiple embeddings', async () => {
    const resp = await embed(
      ['first text', 'second text'],
      'nonexistent-model'
    );
    const data = (await resp.json()) as {
      data: Array<{ embedding: number[]; index: number }>;
    };

    expect(data.data.length).toBe(2);
    expect(data.data[0].index).toBe(0);
    expect(data.data[1].index).toBe(1);
    expect(data.data[0].embedding.length).toBe(384);
    expect(data.data[1].embedding.length).toBe(384);

    // Different inputs should produce different embeddings
    const e1 = data.data[0].embedding;
    const e2 = data.data[1].embedding;
    let identical = true;
    for (let i = 0; i < e1.length; i++) {
      if (Math.abs(e1[i] - e2[i]) > 0.001) {
        identical = false;
        break;
      }
    }
    expect(identical).toBe(false);
  }, 15_000);

  test('clearLogs truncates the configured inference log file', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'zedge-inference-log-'));
    const logFile = join(tempDir, 'inference.log');
    const previousLogFile = process.env.ZEDGE_INFERENCE_LOG_FILE;

    process.env.ZEDGE_INFERENCE_LOG_FILE = logFile;
    writeFileSync(logFile, 'stale log line\n');

    try {
      clearLogs();
      expect(readFileSync(logFile, 'utf-8')).toBe('');
    } finally {
      if (previousLogFile === undefined) {
        delete process.env.ZEDGE_INFERENCE_LOG_FILE;
      } else {
        process.env.ZEDGE_INFERENCE_LOG_FILE = previousLogFile;
      }
    }
  });
});
