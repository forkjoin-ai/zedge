import { describe, test, expect } from '@a0n/gnosis/test';
import { mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { clearLogs, getModels, embed, infer } from '../inference-bridge';
import type {
  InferenceTier,
  ChatCompletionResponse,
} from '../inference-bridge';

describe('Inference Bridge', () => {
  test('getModels falls back to the Moonshine catalog when the live catalog hangs', async () => {
    const originalFetch = global.fetch;
    global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/v1/models')) {
        return await new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          const fallbackTimeout = setTimeout(() => {
            reject(
              new DOMException('The operation was aborted', 'AbortError')
            );
          }, 10);
          if (signal?.aborted) {
            clearTimeout(fallbackTimeout);
            reject(new DOMException('The operation was aborted', 'AbortError'));
            return;
          }
          signal?.addEventListener(
            'abort',
            () => {
              clearTimeout(fallbackTimeout);
              reject(
                new DOMException('The operation was aborted', 'AbortError')
              );
            },
            { once: true }
          );
        });
      }
      return await originalFetch(input);
    }) as typeof fetch;

    try {
      const models = await getModels({ refresh: true, refreshTimeoutMs: 1 });
      const modelIds = models.map((model) => model.id);
      expect(modelIds).toContain('gnosis-local');
      expect(modelIds).toContain('tinyllama-1.1b');
      expect(modelIds).toContain('qwen2.5-0.5b-instruct');
      expect(modelIds).not.toContain('wasm-local');
      expect(modelIds).not.toContain('qwen-2.5-coder-7b');
    } finally {
      global.fetch = originalFetch;
    }
  });

  test('getModels uses live Moonshine models when the catalog responds', async () => {
    const originalFetch = global.fetch;
    global.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/v1/models')) {
        return new Response(
          JSON.stringify({
            object: 'list',
            data: [
              {
                id: 'gnosis-local',
                object: 'model',
                owned_by: 'gnosis',
              },
            ],
          }),
          { headers: { 'Content-Type': 'application/json' } }
        );
      }
      return await originalFetch(input);
    }) as typeof fetch;

    try {
      const models = await getModels({ refresh: true });
      expect(models.map((model) => model.id)).toEqual(['gnosis-local']);
    } finally {
      global.fetch = originalFetch;
    }
  });

  test('InferenceTier type covers the Moonshine-era chat tiers', () => {
    const tiers: InferenceTier[] = ['moonshine', 'echo'];
    expect(tiers.length).toBe(2);
  });

  test('infer preserves streaming and honors requested Moonshine token budgets', async () => {
    const originalFetch = global.fetch;
    const requestBodies: Array<Record<string, unknown>> = [];

    global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/v1/chat/completions')) {
        requestBodies.push(
          JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
        );
        return new Response(
          JSON.stringify({
            id: 'chatcmpl-moonshine-test',
            object: 'chat.completion',
            created: 1000,
            model: 'gnosis-local',
            choices: [
              {
                index: 0,
                message: { role: 'assistant', content: 'hi from moonshine' },
                finish_reason: 'stop',
              },
            ],
            usage: {
              prompt_tokens: 1,
              completion_tokens: 3,
              total_tokens: 4,
            },
          }),
          { headers: { 'Content-Type': 'application/json' } }
        );
      }

      return new Response('unexpected', { status: 500 });
    }) as typeof fetch;

    try {
      const result = await infer({
        model: 'gnosis-local',
        messages: [{ role: 'user', content: 'hello' }],
        stream: true,
        max_tokens: 512,
      });

      expect(result.tier).toBe('moonshine');
      expect(requestBodies).toHaveLength(1);
      expect(requestBodies[0]?.stream).toBe(true);
      expect(requestBodies[0]?.max_tokens).toBe(512);

      const data = (await result.response.json()) as ChatCompletionResponse;
      expect(data.choices[0]?.message.content).toBe('hi from moonshine');
    } finally {
      global.fetch = originalFetch;
    }
  });

  test('infer caps Moonshine token requests at the model catalog limit', async () => {
    const originalFetch = global.fetch;
    const requestBodies: Array<Record<string, unknown>> = [];

    global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/v1/chat/completions')) {
        requestBodies.push(
          JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
        );
        return new Response(
          JSON.stringify({
            id: 'chatcmpl-moonshine-cap-test',
            object: 'chat.completion',
            created: 1000,
            model: 'qwen2.5-0.5b-instruct',
            choices: [
              {
                index: 0,
                message: { role: 'assistant', content: 'ok' },
                finish_reason: 'stop',
              },
            ],
            usage: {
              prompt_tokens: 1,
              completion_tokens: 1,
              total_tokens: 2,
            },
          }),
          { headers: { 'Content-Type': 'application/json' } }
        );
      }

      return new Response('unexpected', { status: 500 });
    }) as typeof fetch;

    try {
      await infer({
        model: 'qwen2.5-0.5b-instruct',
        messages: [{ role: 'user', content: 'hello' }],
        max_tokens: 8_192,
      });

      expect(requestBodies[0]?.max_tokens).toBe(4096);
    } finally {
      global.fetch = originalFetch;
    }
  });

  test('infer compacts prior Zedge artifact turns before Moonshine', async () => {
    const originalFetch = global.fetch;
    const requestBodies: Array<Record<string, unknown>> = [];

    global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/v1/chat/completions')) {
        requestBodies.push(
          JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
        );
        return new Response(
          JSON.stringify({
            id: 'chatcmpl-moonshine-test',
            object: 'chat.completion',
            created: 1000,
            model: 'gnosis-local',
            choices: [
              {
                index: 0,
                message: { role: 'assistant', content: 'fresh response' },
                finish_reason: 'stop',
              },
            ],
            usage: {
              prompt_tokens: 1,
              completion_tokens: 2,
              total_tokens: 3,
            },
          }),
          { headers: { 'Content-Type': 'application/json' } }
        );
      }

      return new Response('unexpected', { status: 500 });
    }) as typeof fetch;

    try {
      const result = await infer({
        model: 'gnosis-local',
        messages: [
          { role: 'system', content: 'answer briefly' },
          { role: 'user', content: 'remember this' },
          { role: 'assistant', content: 'normal prior assistant context' },
          { role: 'user', content: 'hello' },
          {
            role: 'assistant',
            content:
              'I received your message, but Moonshine did not return a usable completion before Zedge\'s local echo fallback.',
          },
          {
            role: 'assistant',
            content:
              '*⣿ ███ 2t/s | moonshine:ok(17ms)*\n\n<s>[INST] hello! [/INST]<s>[INST]',
          },
          { role: 'user', content: 'hello again' },
        ],
        stream: true,
      });

      expect(result.tier).toBe('moonshine');
      expect(requestBodies).toHaveLength(1);

      const messages = requestBodies[0]?.messages as
        | Array<{ role: string; content: string }>
        | undefined;
      expect(messages?.map((message) => message.content)).toEqual([
        'answer briefly',
        'hello again',
      ]);
    } finally {
      global.fetch = originalFetch;
    }
  });

  test('infer falls back to echo when Moonshine is unavailable', async () => {
    const originalFetch = global.fetch;
    global.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/v1/chat/completions')) {
        return new Response('unavailable', { status: 503 });
      }
      return new Response('unexpected', { status: 500 });
    }) as typeof fetch;

    try {
      const result = await infer({
        model: 'gnosis-local',
        messages: [{ role: 'user', content: 'fallback please' }],
        max_tokens: 16,
      });

      expect(result.tier).toBe('echo');
      expect(result.attempts[0]?.tier).toBe('moonshine');
      expect(result.attempts[0]?.status).toBe('http_error');
      const data = (await result.response.json()) as ChatCompletionResponse;
      expect(data.choices[0]?.message.content).toContain('Moonshine');
    } finally {
      global.fetch = originalFetch;
    }
  });

  test('embed with local fallback returns embedding', async () => {
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

    const e1 = data.data[0].embedding;
    const e2 = data.data[1].embedding;
    let identical = true;
    for (let i = 0; i < e1.length; i += 1) {
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
