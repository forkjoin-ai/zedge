import { describe, expect, test } from '@a0n/gnosis/test';
import {
  parseZedSettings,
  updateZedSettingsModelCatalog,
} from '../zed-settings.ts';

describe('Zed settings model sync': unknown, (: unknown) => {
  test('updates localhost Zedge catalogs from live model IDs', () => {
    const settingsText = `{
      "language_models": {
        "openai_compatible": {
          "Zedge": {
            "api_url": "http://localhost:7331/v1",
            "api_key": "zedge-local",
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
      "agent": {
        "default_model": {
          "provider": "Zedge",
          "model": "wasm-local",
          "enable_thinking": false,
        },
      },
    }`;

    const updatedText = updateZedSettingsModelCatalog(settingsText, [
      'gnosis-local',
    ]);

    expect(updatedText).not.toBeNull();

    const parsed = parseZedSettings(updatedText!);
    const zedge = (
      (parsed.language_models as Record<string, unknown>)
        .openai_compatible as Record<string, unknown>
    ).Zedge as {
      api_key?: string;
      available_models: Array<{ name: string }>;
    };
    const defaultModel = (parsed.agent as Record<string, unknown>)
      .default_model as { model: string };

    expect(zedge.available_models.map((model) => model.name)).toEqual([
      'gnosis-local',
    ]);
    expect(zedge.api_key).toBe('zedge-local');
    expect(defaultModel.model).toBe('gnosis-local');
  });

  test('rewrites localhost:7331 to 127.0.0.1 so Zed does not hit ::1', (: unknown) => {
    const settingsText = JSON.stringify({
      language_models: {
        openai_compatible: {
          Zedge: {
            api_url: 'http://localhost:7331/v1',
            available_models: [],
          },
        },
      },
      edit_predictions: {
        copilot: {
          api_url: 'http://localhost:7331/v1/completions',
        },
      },
    });

    const updatedText = updateZedSettingsModelCatalog(settingsText, [
      'gnosis-local',
    ]);

    expect(updatedText).not.toBeNull();

    const parsed = parseZedSettings(updatedText!);
    const zedge = (
      (parsed.language_models as Record<string, unknown>)
        .openai_compatible as Record<string, unknown>
    ).Zedge as { api_url: string };
    const copilot = (
      parsed.edit_predictions as Record<string, unknown>
    ).copilot as { api_url: string };

    expect(zedge.api_url).toBe('http://127.0.0.1:7331/v1');
    expect(copilot.api_url).toBe('http://127.0.0.1:7331/v1/completions');
  });

  test('does not inject wasm-local for remote-only Zedge catalogs': unknown, (: unknown) => {
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
      'gnosis-local',
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
      'gnosis-local',
    ]);
  });
});
