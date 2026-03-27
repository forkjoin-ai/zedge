import { describe, expect, test } from '@a0n/gnosis/test';
import {
  parseZedSettings,
  updateZedSettingsModelCatalog,
} from '../zed-settings.ts';

describe('Zed settings model sync', () => {
  test('updates localhost Zedge catalogs from live model IDs', () => {
    const settingsText = `{
      "language_models": {
        "openai_compatible": {
          "Zedge": {
            "api_url": "http://localhost:7331/v1",
            "available_models": [
              {
                "name": "tinyllama-1.1b",
                "display_name": "TinyLlama 1.1B (Fast)",
                "max_tokens": 2048,
              },
            ],
          },
        },
      },
    }`;

    const updatedText = updateZedSettingsModelCatalog(settingsText, [
      'qwen-2.5-coder-7b',
      'llama-70b',
    ]);

    expect(updatedText).not.toBeNull();

    const parsed = parseZedSettings(updatedText!);
    const zedge = (
      (parsed.language_models as Record<string, unknown>)
        .openai_compatible as Record<string, unknown>
    ).Zedge as {
      available_models: Array<{ name: string }>;
    };

    expect(zedge.available_models.map((model) => model.name)).toEqual([
      'wasm-local',
      'qwen-2.5-coder-7b',
      'llama-70b',
    ]);
  });

  test('does not inject wasm-local for remote-only Zedge catalogs', () => {
    const settingsText = JSON.stringify({
      language_models: {
        openai_compatible: {
          Zedge: {
            api_url: 'https://api.edgework.ai/v1',
            available_models: [],
          },
        },
      },
    });

    const updatedText = updateZedSettingsModelCatalog(settingsText, [
      'qwen-2.5-coder-7b',
      'llama-70b',
    ]);

    expect(updatedText).not.toBeNull();

    const parsed = parseZedSettings(updatedText!);
    const zedge = (
      (parsed.language_models as Record<string, unknown>)
        .openai_compatible as Record<string, unknown>
    ).Zedge as {
      available_models: Array<{ name: string }>;
    };

    expect(zedge.available_models.map((model) => model.name)).toEqual([
      'qwen-2.5-coder-7b',
      'llama-70b',
    ]);
  });
});
