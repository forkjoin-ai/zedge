import { describe, test, expect, beforeEach, afterEach, mock } from '@a0n/gnosis/test';
import type { SuperinferenceResult, CollapseStrategy } from '../superinference';

// Mock fetch to prevent real HTTP requests to Cloud Run coordinators
const originalFetch = globalThis.fetch;

function mockFetch() {
  globalThis.fetch = mock(
    async (_url: string | URL | Request, _init?: RequestInit) => {
      // Return a fake OpenAI-compatible chat completion response
      return new Response(
        JSON.stringify({
          id: 'mock-completion',
          object: 'chat.completion',
          created: Date.now(),
          model: 'mock-model',
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: 'Mock inference response',
              },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }
  ) as typeof fetch;
}

describe('Superinference', () => {
  beforeEach(() => {
    mockFetch();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  // Import dynamically to avoid module-level side effects
  async function loadModule() {
    return import('../superinference');
  }

  test('superinfer with single model returns result', async () => {
    const { superinfer } = await loadModule();
    const result = await superinfer({
      request: {
        model: 'tinyllama-1.1b',
        messages: [{ role: 'user', content: 'hello' }],
      },
      models: ['tinyllama-1.1b'],
      strategy: 'fastest',
      timeoutMs: 20_000,
    });

    expect(result).toHaveProperty('content');
    expect(result).toHaveProperty('winningModel');
    expect(result).toHaveProperty('strategy');
    expect(result).toHaveProperty('modelResults');
    expect(result).toHaveProperty('durationMs');
    expect(result).toHaveProperty('confidence');
    expect(result.strategy).toBe('fastest');
    expect(typeof result.durationMs).toBe('number');
    expect(result.durationMs).toBeGreaterThan(0);
    expect(result.modelResults.length).toBe(1);
  }, 25_000);

  test('superinfer throws with zero models', async () => {
    const { superinfer } = await loadModule();
    await expect(
      superinfer({
        request: {
          model: 'test',
          messages: [{ role: 'user', content: 'hello' }],
        },
        models: [],
        strategy: 'fastest',
      })
    ).rejects.toThrow('At least one model required');
  });

  test('superinferenceResult has correct shape', async () => {
    const { superinfer } = await loadModule();
    const strategies: CollapseStrategy[] = [
      'fastest',
      'consensus',
      'constructive',
    ];

    for (const strategy of strategies) {
      const result = await superinfer({
        request: {
          model: 'tinyllama-1.1b',
          messages: [{ role: 'user', content: 'test' }],
        },
        models: ['tinyllama-1.1b'],
        strategy,
        timeoutMs: 20_000,
      });

      expect(result.strategy).toBe(strategy);
      expect(typeof result.content).toBe('string');
      expect(typeof result.confidence).toBe('number');
      expect(result.confidence).toBeGreaterThanOrEqual(0);
      expect(result.confidence).toBeLessThanOrEqual(1);
    }
  }, 60_000);

  test('modelResult has required fields', async () => {
    const { superinfer } = await loadModule();
    const result = await superinfer({
      request: {
        model: 'tinyllama-1.1b',
        messages: [{ role: 'user', content: 'hello' }],
      },
      models: ['tinyllama-1.1b'],
      strategy: 'fastest',
      timeoutMs: 20_000,
    });

    for (const mr of result.modelResults) {
      expect(mr).toHaveProperty('model');
      expect(mr).toHaveProperty('content');
      expect(mr).toHaveProperty('tier');
      expect(mr).toHaveProperty('durationMs');
      expect(mr).toHaveProperty('finished');
      expect(typeof mr.model).toBe('string');
      expect(typeof mr.durationMs).toBe('number');
      expect(typeof mr.finished).toBe('boolean');
    }
  }, 25_000);
});
