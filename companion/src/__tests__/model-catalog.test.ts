import { describe, expect, test } from '@a0n/gnosis/test';
import {
  buildZedAvailableModels,
  getKnownZedgeModel,
  getKnownZedgeModels,
  isForkjoinTierModel,
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

  test('includes Qwen2.5 model metadata for the Moonshine KNOT trial', () => {
    const model = getKnownZedgeModel('qwen2.5-0.5b-instruct');
    expect(model).toBeDefined();
    expect(model?.displayName).toBe('Qwen2.5 0.5B Instruct (Moonshine)');
    expect(model?.maxTokens).toBe(4096);
  });

  test('includes Gemma4 RKNOT metadata for the Moonshine hotpath', () => {
    const model = getKnownZedgeModel('gemma4-31b-it');
    expect(model).toBeDefined();
    expect(model?.displayName).toBe('Gemma4 31B Instruct (Moonshine RKNOT)');
    expect(model?.maxTokens).toBe(8192);
  });

  test('keeps the Loki adult research model explicit and forkjoin-routed', () => {
    const previousModels = process.env.ZEDGE_MODELS;
    const previousAllModels = process.env.ZEDGE_ALL_MODELS;

    try {
      delete process.env.ZEDGE_MODELS;
      delete process.env.ZEDGE_ALL_MODELS;

      const model = getKnownZedgeModel('loki-erotica-8b');
      expect(model).toBeDefined();
      expect(model?.sensitiveContent).toBe('adult');
      expect(model?.maxTokens).toBe(128);
      expect(isForkjoinTierModel('loki-erotica-8b')).toBe(true);
      expect(
        getKnownZedgeModels().some((entry) => entry.id === model?.id)
      ).toBe(false);

      process.env.ZEDGE_MODELS = 'loki-erotica-8b';
      expect(getKnownZedgeModels().map((entry) => entry.id)).toEqual([
        'loki-erotica-8b',
      ]);
    } finally {
      if (previousModels === undefined) {
        delete process.env.ZEDGE_MODELS;
      } else {
        process.env.ZEDGE_MODELS = previousModels;
      }
      if (previousAllModels === undefined) {
        delete process.env.ZEDGE_ALL_MODELS;
      } else {
        process.env.ZEDGE_ALL_MODELS = previousAllModels;
      }
    }
  });

  test('buildZedAvailableModels does not reintroduce the retired wasm model', () => {
    const models = buildZedAvailableModels(['gnosis-local'], {
      includeLocalWasm: true,
    });

    expect(models.map((model) => model.name)).toEqual(['gnosis-local']);
  });
});
