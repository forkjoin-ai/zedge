import { describe, expect, test } from '@a0n/gnosis/test';
import {
  buildZedAvailableModels,
  getKnownZedgeModel,
} from '../model-catalog.ts';

describe('Zedge model catalog', () => {
  test('gnosis-local metadata reflects the Moonshine container fallback', () => {
    const model = getKnownZedgeModel('gnosis-local');
    expect(model).toBeDefined();
    expect(model?.displayName).toBe('Gnosis Local (Moonshine)');
    expect(model?.maxTokens).toBe(4096);
  });

  test('includes the docker-compose TinyLlama model metadata', () => {
    const model = getKnownZedgeModel('tinyllama-1.1b');
    expect(model).toBeDefined();
    expect(model?.displayName).toBe('TinyLlama 1.1B (Moonshine)');
    expect(model?.maxTokens).toBe(2048);
  });

  test('buildZedAvailableModels does not reintroduce the retired wasm model', () => {
    const models = buildZedAvailableModels(['gnosis-local'], {
      includeLocalWasm: true,
    });

    expect(models.map((model) => model.name)).toEqual(['gnosis-local']);
  });
});
