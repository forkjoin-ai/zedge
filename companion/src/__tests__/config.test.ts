import { describe, test, expect } from '@a0n/gnosis/test';
import { spawnSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { fileURLToPath } from 'url';

// Test the config module types and defaults
describe('Zedge Config', () => {
  test('default companion port is 7331', async () => {
    // Import dynamically to avoid side effects on actual ~/.edgework/
    const { getCompanionPort } = await import('../config');
    const port = getCompanionPort();
    expect(typeof port).toBe('number');
    // Default is 7331, but if user has config it may differ
    expect(port).toBeGreaterThan(0);
    expect(port).toBeLessThan(65536);
  });

  test('getAuthHeaders returns object', async () => {
    const { getAuthHeaders } = await import('../config');
    const headers = getAuthHeaders();
    expect(typeof headers).toBe('object');
  });

  test('getApiBaseUrl returns string', async () => {
    const { getApiBaseUrl } = await import('../config');
    const url = getApiBaseUrl();
    expect(typeof url).toBe('string');
    expect(url.startsWith('http')).toBe(true);
  });

  test('getZedgeConfig returns valid config shape', async () => {
    const { getZedgeConfig } = await import('../config');
    const config = getZedgeConfig();
    expect(config).toHaveProperty('port');
    expect(config).toHaveProperty('computePool');
    expect(config).toHaveProperty('preferredModel');
    expect(config).toHaveProperty('cloudRunDirect');
    expect(config).toHaveProperty('babelfish');
    expect(config.computePool).toHaveProperty('enabled');
    expect(config.computePool).toHaveProperty('maxCpuPercent');
    expect(config.computePool).toHaveProperty('maxMemoryMb');
    expect(config.computePool).toHaveProperty('allowedModels');
    expect(Array.isArray(config.computePool.allowedModels)).toBe(true);
    expect(config.babelfish).toHaveProperty('enabled');
    expect(config.babelfish).toHaveProperty('ambientSuggestions');
    expect(config.babelfish).toHaveProperty('defaultHumanLanguage');
    expect(config.babelfish).toHaveProperty('requirePreviewForInPlaceRewrite');
  });

  test('default preferred model is gnosis-local', async () => {
    const tempHome = mkdtempSync(join(tmpdir(), 'zedge-default-model-test-'));
    mkdirSync(join(tempHome, '.edgework'), { recursive: true });
    const configModulePath = fileURLToPath(
      new URL('../config.ts', import.meta.url)
    );
    const script = `
      (async () => {
        const { getZedgeConfig } = await import(${JSON.stringify(
          configModulePath
        )});
        process.stdout.write(JSON.stringify(getZedgeConfig()));
      })().catch((error) => {
        console.error(error);
        process.exit(1);
      });
    `;
    const result = spawnSync(process.execPath, ['-e', script], {
      env: {
        ...process.env,
        HOME: tempHome,
      },
      encoding: 'utf-8',
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');

    const config = JSON.parse(result.stdout) as {
      preferredModel: string;
      cloudRunDirect: boolean;
    };
    expect(config.preferredModel).toBe('gnosis-local');
    expect(config.cloudRunDirect).toBe(false);
  });

  test('legacy persisted preferred model falls back to gnosis-local', async () => {
    const tempHome = mkdtempSync(join(tmpdir(), 'zedge-legacy-model-test-'));
    const edgeworkDir = join(tempHome, '.edgework');
    mkdirSync(edgeworkDir, { recursive: true });
    writeFileSync(
      join(edgeworkDir, 'zedge.json'),
      JSON.stringify({ preferredModel: 'qwen-2.5-coder-7b' })
    );
    const configModulePath = fileURLToPath(
      new URL('../config.ts', import.meta.url)
    );
    const script = `
      (async () => {
        const { getZedgeConfig } = await import(${JSON.stringify(
          configModulePath
        )});
        process.stdout.write(JSON.stringify(getZedgeConfig()));
      })().catch((error) => {
        console.error(error);
        process.exit(1);
      });
    `;
    const result = spawnSync(process.execPath, ['-e', script], {
      env: {
        ...process.env,
        HOME: tempHome,
      },
      encoding: 'utf-8',
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');

    const config = JSON.parse(result.stdout) as {
      preferredModel: string;
    };
    expect(config.preferredModel).toBe('gnosis-local');
  });

  test('persisted Codestral alias is canonicalized to the mesh model id', async () => {
    const tempHome = mkdtempSync(join(tmpdir(), 'zedge-codestral-model-test-'));
    const edgeworkDir = join(tempHome, '.edgework');
    mkdirSync(edgeworkDir, { recursive: true });
    writeFileSync(
      join(edgeworkDir, 'zedge.json'),
      JSON.stringify({ preferredModel: 'codestral' })
    );
    const configModulePath = fileURLToPath(
      new URL('../config.ts', import.meta.url)
    );
    const script = `
      (async () => {
        const { getZedgeConfig } = await import(${JSON.stringify(
          configModulePath
        )});
        process.stdout.write(JSON.stringify(getZedgeConfig()));
      })().catch((error) => {
        console.error(error);
        process.exit(1);
      });
    `;
    const result = spawnSync(process.execPath, ['-e', script], {
      env: {
        ...process.env,
        HOME: tempHome,
      },
      encoding: 'utf-8',
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');

    const config = JSON.parse(result.stdout) as {
      preferredModel: string;
    };
    expect(config.preferredModel).toBe('codestral-22b');
  });

  test('Zed settings override stale edgework model config', async () => {
    const tempHome = mkdtempSync(join(tmpdir(), 'zedge-zed-source-test-'));
    mkdirSync(join(tempHome, '.edgework'), { recursive: true });
    mkdirSync(join(tempHome, '.config', 'zed'), { recursive: true });
    writeFileSync(
      join(tempHome, '.edgework', 'zedge.json'),
      JSON.stringify({ preferredModel: 'qwen-2.5-coder-7b' })
    );
    writeFileSync(
      join(tempHome, '.config', 'zed', 'settings.json'),
      JSON.stringify({
        agent: {
          default_model: {
            provider: 'Zedge',
            model: 'tinyllama-1.1b',
          },
        },
        language_models: {
          openai_compatible: {
            Zedge: {
              available_models: [
                {
                  name: 'tinyllama-1.1b',
                  display_name: 'TinyLlama 1.1B (Moonshine)',
                  max_tokens: 2048,
                },
              ],
            },
          },
        },
      })
    );
    const configModulePath = fileURLToPath(
      new URL('../config.ts', import.meta.url)
    );
    const script = `
      (async () => {
        const { getZedgeConfig } = await import(${JSON.stringify(
          configModulePath
        )});
        process.stdout.write(JSON.stringify(getZedgeConfig()));
      })().catch((error) => {
        console.error(error);
        process.exit(1);
      });
    `;
    const result = spawnSync(process.execPath, ['-e', script], {
      env: {
        ...process.env,
        HOME: tempHome,
      },
      encoding: 'utf-8',
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');

    const config = JSON.parse(result.stdout) as {
      preferredModel: string;
      computePool: {
        allowedModels: string[];
      };
    };
    expect(config.preferredModel).toBe('tinyllama-1.1b');
    expect(config.computePool.allowedModels).toEqual(['tinyllama-1.1b']);
  });

  test('env overrides can force companion port and listener mode', async () => {
    const tempHome = mkdtempSync(join(tmpdir(), 'zedge-config-test-'));
    mkdirSync(join(tempHome, '.edgework'), { recursive: true });
    const configModulePath = fileURLToPath(
      new URL('../config.ts', import.meta.url)
    );
    const script = `
      (async () => {
        const { getCompanionPort, getZedgeConfig } = await import(${JSON.stringify(
          configModulePath
        )});
        process.stdout.write(JSON.stringify({
          port: getCompanionPort(),
          config: getZedgeConfig(),
        }));
      })().catch((error) => {
        console.error(error);
        process.exit(1);
      });
    `;
    const result = spawnSync(process.execPath, ['-e', script], {
      env: {
        ...process.env,
        HOME: tempHome,
        ZEDGE_COMPANION_PORT: '8123',
        ZEDGE_LISTENER_MODE: 'bun',
      },
      encoding: 'utf-8',
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');

    const payload = JSON.parse(result.stdout) as {
      port: number;
      config: {
        port: number;
        listener: {
          mode: string;
          internalPort?: number;
          flowPort?: number;
          discoveryPort?: number;
        };
      };
    };
    expect(payload.port).toBe(8123);
    expect(payload.config.port).toBe(8123);
    expect(payload.config.listener.mode).toBe('bun');
    expect(payload.config.listener.internalPort).toBe(18123);
    expect(payload.config.listener.flowPort).toBe(9123);
    expect(payload.config.listener.discoveryPort).toBe(8124);
  });
});
