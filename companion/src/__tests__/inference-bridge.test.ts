import { describe, test, expect } from '@a0n/gnosis/test';
import { mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  clearLogs,
  getLiveMoonshineRuntimeHealth,
  getModels,
  embed,
  infer,
} from '../inference-bridge';
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
      expect(modelIds).toContain('qwen-coder-7b');
      expect(modelIds).not.toContain('wasm-local');
      expect(modelIds).not.toContain('qwen2.5-0.5b-instruct');
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

  test('runtime health detects stale OpenAI shim fingerprints', async () => {
    const originalFetch = global.fetch;
    global.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/v1/models')) {
        return new Response(
          JSON.stringify({
            object: 'list',
            data: [{ id: 'qwen2.5-0.5b-instruct', object: 'model' }],
          }),
          { headers: { 'Content-Type': 'application/json' } }
        );
      }
      if (url === 'http://127.0.0.1:8080/health') {
        return new Response(
          JSON.stringify({
            status: 'ok',
            model: 'qwen2.5-0.5b-instruct',
            hidden_dim: 2048,
            vocab_size: 32000,
            layers: '0-22',
          }),
          { headers: { 'Content-Type': 'application/json' } }
        );
      }
      if (url === 'http://127.0.0.1:8000/health') {
        return new Response(
          JSON.stringify({
            status: 'ok',
            hidden_dim: 896,
            vocab_size: 151936,
            layers: '0-24',
          }),
          { headers: { 'Content-Type': 'application/json' } }
        );
      }
      return await originalFetch(input);
    }) as typeof fetch;

    try {
      const health = await getLiveMoonshineRuntimeHealth();
      expect(health.models.map((model) => model.id)).toEqual([
        'qwen2.5-0.5b-instruct',
      ]);
      expect(health.openAi.ready).toBe(true);
      expect(health.fatStation.ready).toBe(true);
      expect(health.openAi.runtimeMatches).toBe(false);
    } finally {
      global.fetch = originalFetch;
    }
  });

  test('InferenceTier type covers the Forkjoin + Moonshine chat tiers', () => {
    const tiers: InferenceTier[] = ['forkjoin', 'moonshine', 'echo'];
    expect(tiers.length).toBe(3);
  });

  test('infer preserves streaming and honors requested Moonshine token budgets', async () => {
    const originalFetch = global.fetch;
    const previousForkjoinEnabled = process.env.ZEDGE_FORKJOIN_ENABLED;
    // Exercise the Moonshine tier directly (forkjoin is primary by default).
    process.env.ZEDGE_FORKJOIN_ENABLED = '0';
    const requestBodies: Array<Record<string, unknown>> = [];
    const requestHeaders: Headers[] = [];

    global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/v1/chat/completions')) {
        requestHeaders.push(new Headers(init?.headers));
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
        prefillWindowId: 'prefill-test',
      });

      expect(result.tier).toBe('moonshine');
      expect(requestBodies).toHaveLength(1);
      expect(requestBodies[0]?.stream).toBe(true);
      expect(requestBodies[0]?.max_tokens).toBe(512);
      expect(requestHeaders[0]?.get('X-Moonshine-Prefill-Window')).toBe(
        'prefill-test'
      );

      const data = (await result.response.json()) as ChatCompletionResponse;
      expect(data.choices[0]?.message.content).toBe('hi from moonshine');
    } finally {
      global.fetch = originalFetch;
      if (previousForkjoinEnabled === undefined)
        delete process.env.ZEDGE_FORKJOIN_ENABLED;
      else process.env.ZEDGE_FORKJOIN_ENABLED = previousForkjoinEnabled;
    }
  });

  test('infer forwards Moonshine prefill telemetry as Zedge headers', async () => {
    const originalFetch = global.fetch;
    const previousForkjoinEnabled = process.env.ZEDGE_FORKJOIN_ENABLED;
    process.env.ZEDGE_FORKJOIN_ENABLED = '0';
    global.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/v1/chat/completions')) {
        return new Response(
          JSON.stringify({
            id: 'chatcmpl-prefill-test',
            object: 'chat.completion',
            created: 1000,
            model: 'gnosis-local',
            choices: [
              {
                index: 0,
                message: { role: 'assistant', content: 'warmed' },
                finish_reason: 'stop',
              },
            ],
            usage: {
              prompt_tokens: 4,
              completion_tokens: 1,
              total_tokens: 5,
            },
          }),
          {
            headers: {
              'Content-Type': 'application/json',
              'X-Moonshine-Prefill': 'hit',
              'X-Moonshine-Prefill-Tokens': '4',
              'X-Moonshine-Prefill-Saved-Ms': '17',
            },
          }
        );
      }

      return new Response('unexpected', { status: 500 });
    }) as typeof fetch;

    try {
      const result = await infer({
        model: 'gnosis-local',
        messages: [{ role: 'user', content: 'hello' }],
        prefillWindowId: 'prefill-test',
      });

      expect(result.upstreamHeaders['X-Zedge-Prefill']).toBe('hit');
      expect(result.upstreamHeaders['X-Zedge-Prefill-Tokens']).toBe('4');
      expect(result.upstreamHeaders['X-Zedge-Prefill-Saved-Ms']).toBe('17');
    } finally {
      global.fetch = originalFetch;
      if (previousForkjoinEnabled === undefined)
        delete process.env.ZEDGE_FORKJOIN_ENABLED;
      else process.env.ZEDGE_FORKJOIN_ENABLED = previousForkjoinEnabled;
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
    const previousForkjoinEnabled = process.env.ZEDGE_FORKJOIN_ENABLED;
    process.env.ZEDGE_FORKJOIN_ENABLED = '0';
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
      if (previousForkjoinEnabled === undefined)
        delete process.env.ZEDGE_FORKJOIN_ENABLED;
      else process.env.ZEDGE_FORKJOIN_ENABLED = previousForkjoinEnabled;
    }
  });

  test('infer falls back to echo when Moonshine is unavailable', async () => {
    const originalFetch = global.fetch;
    const previousForkjoinEnabled = process.env.ZEDGE_FORKJOIN_ENABLED;
    process.env.ZEDGE_FORKJOIN_ENABLED = '0';
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
      // Forkjoin is disabled here, so it records a skipped attempt first.
      expect(result.attempts[0]?.tier).toBe('forkjoin');
      expect(result.attempts[0]?.status).toBe('skipped');
      expect(result.attempts[1]?.tier).toBe('moonshine');
      expect(result.attempts[1]?.status).toBe('http_error');
      const data = (await result.response.json()) as ChatCompletionResponse;
      expect(data.choices[0]?.message.content).toContain('Moonshine');
    } finally {
      global.fetch = originalFetch;
      if (previousForkjoinEnabled === undefined)
        delete process.env.ZEDGE_FORKJOIN_ENABLED;
      else process.env.ZEDGE_FORKJOIN_ENABLED = previousForkjoinEnabled;
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

  test('infer routes to the Forkjoin mesh first and passes the request through', async () => {
    const originalFetch = global.fetch;
    const previousUrl = process.env.ZEDGE_FORKJOIN_URL;
    const previousEnabled = process.env.ZEDGE_FORKJOIN_ENABLED;
    // Distinct base so the mock can tell forkjoin apart from Moonshine
    // (both POST /v1/chat/completions, default to :8080).
    process.env.ZEDGE_FORKJOIN_URL = 'http://127.0.0.1:9099';
    delete process.env.ZEDGE_FORKJOIN_ENABLED;

    const forkjoinBodies: Array<Record<string, unknown>> = [];
    const forkjoinHeaders: Headers[] = [];
    let moonshineCalled = false;

    global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === 'http://127.0.0.1:9099/v1/chat/completions') {
        forkjoinHeaders.push(new Headers(init?.headers));
        forkjoinBodies.push(
          JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
        );
        return new Response(
          JSON.stringify({
            id: 'chatcmpl-forkjoin-test',
            object: 'chat.completion',
            created: 1000,
            model: 'gnosis-local',
            choices: [
              {
                index: 0,
                message: { role: 'assistant', content: 'hi from forkjoin' },
                finish_reason: 'stop',
              },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 3, total_tokens: 4 },
          }),
          { headers: { 'Content-Type': 'application/json' } }
        );
      }
      if (url.endsWith('/v1/chat/completions')) {
        moonshineCalled = true;
        return new Response('moonshine should not be reached', { status: 500 });
      }
      return new Response('unexpected', { status: 500 });
    }) as typeof fetch;

    try {
      const result = await infer({
        model: 'gnosis-local',
        messages: [{ role: 'user', content: 'hello' }],
        stream: true,
        max_tokens: 256,
        prefillWindowId: 'forkjoin-prefill',
      });

      expect(result.tier).toBe('forkjoin');
      expect(result.attempts[0]?.tier).toBe('forkjoin');
      expect(result.attempts[0]?.status).toBe('ok');
      expect(moonshineCalled).toBe(false);
      expect(forkjoinBodies).toHaveLength(1);
      expect(forkjoinBodies[0]?.model).toBe('gnosis-local');
      expect(forkjoinBodies[0]?.stream).toBe(true);
      expect(forkjoinBodies[0]?.max_tokens).toBe(256);
      expect(forkjoinHeaders[0]?.get('X-Moonshine-Prefill-Window')).toBe(
        'forkjoin-prefill'
      );

      const data = (await result.response.json()) as ChatCompletionResponse;
      expect(data.choices[0]?.message.content).toBe('hi from forkjoin');
    } finally {
      global.fetch = originalFetch;
      if (previousUrl === undefined) delete process.env.ZEDGE_FORKJOIN_URL;
      else process.env.ZEDGE_FORKJOIN_URL = previousUrl;
      if (previousEnabled === undefined)
        delete process.env.ZEDGE_FORKJOIN_ENABLED;
      else process.env.ZEDGE_FORKJOIN_ENABLED = previousEnabled;
    }
  });

  test('infer falls through from Forkjoin to Moonshine on mesh failure', async () => {
    const originalFetch = global.fetch;
    const previousUrl = process.env.ZEDGE_FORKJOIN_URL;
    const previousEnabled = process.env.ZEDGE_FORKJOIN_ENABLED;
    process.env.ZEDGE_FORKJOIN_URL = 'http://127.0.0.1:9099';
    delete process.env.ZEDGE_FORKJOIN_ENABLED;

    global.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === 'http://127.0.0.1:9099/v1/chat/completions') {
        return new Response('mesh unavailable', { status: 503 });
      }
      if (url.endsWith('/v1/chat/completions')) {
        return new Response(
          JSON.stringify({
            id: 'chatcmpl-moonshine-fallback',
            object: 'chat.completion',
            created: 1000,
            model: 'gnosis-local',
            choices: [
              {
                index: 0,
                message: { role: 'assistant', content: 'moonshine rescued it' },
                finish_reason: 'stop',
              },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 3, total_tokens: 4 },
          }),
          { headers: { 'Content-Type': 'application/json' } }
        );
      }
      return new Response('unexpected', { status: 500 });
    }) as typeof fetch;

    try {
      const result = await infer({
        model: 'gnosis-local',
        messages: [{ role: 'user', content: 'fall through please' }],
        max_tokens: 16,
      });

      expect(result.tier).toBe('moonshine');
      expect(result.attempts[0]?.tier).toBe('forkjoin');
      expect(result.attempts[0]?.status).toBe('http_error');
      expect(result.attempts[0]?.detail).toContain('503');
      expect(result.attempts[1]?.tier).toBe('moonshine');
      expect(result.attempts[1]?.status).toBe('ok');

      const data = (await result.response.json()) as ChatCompletionResponse;
      expect(data.choices[0]?.message.content).toBe('moonshine rescued it');
    } finally {
      global.fetch = originalFetch;
      if (previousUrl === undefined) delete process.env.ZEDGE_FORKJOIN_URL;
      else process.env.ZEDGE_FORKJOIN_URL = previousUrl;
      if (previousEnabled === undefined)
        delete process.env.ZEDGE_FORKJOIN_ENABLED;
      else process.env.ZEDGE_FORKJOIN_ENABLED = previousEnabled;
    }
  });

  test('infer skips the Forkjoin tier when ZEDGE_FORKJOIN_ENABLED=0', async () => {
    const originalFetch = global.fetch;
    const previousUrl = process.env.ZEDGE_FORKJOIN_URL;
    const previousEnabled = process.env.ZEDGE_FORKJOIN_ENABLED;
    process.env.ZEDGE_FORKJOIN_URL = 'http://127.0.0.1:9099';
    process.env.ZEDGE_FORKJOIN_ENABLED = '0';

    let forkjoinCalled = false;

    global.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === 'http://127.0.0.1:9099/v1/chat/completions') {
        forkjoinCalled = true;
        return new Response('forkjoin should be skipped', { status: 500 });
      }
      if (url.endsWith('/v1/chat/completions')) {
        return new Response(
          JSON.stringify({
            id: 'chatcmpl-moonshine-direct',
            object: 'chat.completion',
            created: 1000,
            model: 'gnosis-local',
            choices: [
              {
                index: 0,
                message: { role: 'assistant', content: 'straight to moonshine' },
                finish_reason: 'stop',
              },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 3, total_tokens: 4 },
          }),
          { headers: { 'Content-Type': 'application/json' } }
        );
      }
      return new Response('unexpected', { status: 500 });
    }) as typeof fetch;

    try {
      const result = await infer({
        model: 'gnosis-local',
        messages: [{ role: 'user', content: 'no mesh please' }],
        max_tokens: 16,
      });

      expect(forkjoinCalled).toBe(false);
      expect(result.tier).toBe('moonshine');
      expect(result.attempts[0]?.tier).toBe('forkjoin');
      expect(result.attempts[0]?.status).toBe('skipped');
      expect(result.attempts[1]?.tier).toBe('moonshine');
      expect(result.attempts[1]?.status).toBe('ok');
    } finally {
      global.fetch = originalFetch;
      if (previousUrl === undefined) delete process.env.ZEDGE_FORKJOIN_URL;
      else process.env.ZEDGE_FORKJOIN_URL = previousUrl;
      if (previousEnabled === undefined)
        delete process.env.ZEDGE_FORKJOIN_ENABLED;
      else process.env.ZEDGE_FORKJOIN_ENABLED = previousEnabled;
    }
  });

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
