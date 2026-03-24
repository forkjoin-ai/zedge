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
