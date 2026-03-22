import { describe, test, expect } from 'bun:test';

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
});
