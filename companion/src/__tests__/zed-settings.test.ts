import { describe, expect, test } from '@a0n/gnosis/test';
import {
  ensureLocalZedgeProviderBlock,
  parseZedSettings,
  syncZedgeLocalProviderCredentials,
  updateZedSettingsModelCatalog,
} from '../zed-settings.ts';
import { syncZedgeKeychainCredentials } from '../zed-credentials.ts';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

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
      available_models: Array<{ name: string }>;
    };
    const defaultModel = (parsed.agent as Record<string, unknown>)
      .default_model as { model: string };

    expect(zedge.available_models.map((model) => model.name)).toEqual([
      'gnosis-local',
    ]);
    expect(defaultModel.model).toBe('gnosis-local');
  });

  test('rewrites localhost:7331 to 127.0.0.1 so Zed does not hit ::1', () => {
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

  test('creates a local Zedge provider block when settings omit it', () => {
    const settingsText = JSON.stringify({
      theme: 'One Dark',
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

    expect(zedge.api_url).toBe('http://127.0.0.1:7331/v1');
  });

  test('ensureLocalZedgeProviderBlock preserves remote Edgework URLs', () => {
    const settings = parseZedSettings(
      JSON.stringify({
        language_models: {
          openai_compatible: {
            Zedge: {
              api_url: 'https://api.edgework.ai/v1',
            },
          },
        },
      })
    );

    ensureLocalZedgeProviderBlock(settings, 7331);

    const zedge = (
      (settings.language_models as Record<string, unknown>)
        .openai_compatible as Record<string, unknown>
    ).Zedge as { api_url: string };

    expect(zedge.api_url).toBe('https://api.edgework.ai/v1');
  });

  test('syncZedgeLocalProviderCredentials writes provider URL to discovered settings files', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'zedge-zed-settings-'));
    const settingsPath = join(tempDir, 'settings.json');
    writeFileSync(
      settingsPath,
      JSON.stringify(
        {
          language_models: {
            openai_compatible: {
              Zedge: {
                api_url: 'http://127.0.0.1:7331/v1',
              },
            },
          },
        },
        null,
        2
      ) + '\n'
    );

    const originalPaths = process.env.ZEDGE_ZED_SETTINGS_PATHS;
    process.env.ZEDGE_ZED_SETTINGS_PATHS = settingsPath;

    try {
      const result = syncZedgeLocalProviderCredentials(7331);
      expect(result.matchedPaths).toEqual([settingsPath]);

      const parsed = parseZedSettings(readFileSync(settingsPath, 'utf-8'));
      const zedge = (
        (parsed.language_models as Record<string, unknown>)
          .openai_compatible as Record<string, unknown>
      ).Zedge as { api_url: string };
      expect(zedge.api_url).toBe('http://127.0.0.1:7331/v1');
    } finally {
      if (originalPaths === undefined) {
        delete process.env.ZEDGE_ZED_SETTINGS_PATHS;
      } else {
        process.env.ZEDGE_ZED_SETTINGS_PATHS = originalPaths;
      }
      rmSync(tempDir, { recursive: true, force: true });
    }
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

describe('Zed keychain credentials', () => {
  test('syncZedgeKeychainCredentials seeds macOS internet password for api_url', () => {
    if (process.platform !== 'darwin') {
      return;
    }

    const result = syncZedgeKeychainCredentials(7331, 'zedge-local-test-key');
    expect(result.updated).toBe(true);
    expect(result.apiUrl).toBe('http://127.0.0.1:7331/v1');

    // Restore the production placeholder for Zed.
    syncZedgeKeychainCredentials(7331, 'zedge-local');
  });
});
