import { describe, expect, test } from '@a0n/gnosis/test';
import {
  buildZedAvailableModels,
  getKnownZedgeModel,
} from '../model-catalog.ts';

describe('Zedge model catalog', () => {
  test('wasm-local metadata reflects the verified TinyLlama fallback', () => {
    const model = getKnownZedgeModel('wasm-local');
    expect(model).toBeDefined();
    expect(model?.displayName).toBe('Local WASM (TinyLlama 1.1B)');
    expect(model?.maxTokens).toBe(2048);
  });

  test('includes llama-70b metadata', () => {
    const model = getKnownZedgeModel('llama-70b');
    expect(model).toBeDefined();
    expect(model?.displayName).toBe('LLaMA 2 70B');
    expect(model?.maxTokens).toBe(4096);
  });

  test('buildZedAvailableModels prepends wasm-local for localhost companion catalogs', () => {
    const models = buildZedAvailableModels(['qwen-2.5-coder-7b', 'llama-70b'], {
      includeLocalWasm: true,
    });

    expect(models.map((model) => model.name)).toEqual([
      'wasm-local',
      'qwen-2.5-coder-7b',
      'llama-70b',
    ]);
  });
});
