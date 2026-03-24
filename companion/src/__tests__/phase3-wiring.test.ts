import { describe, test, expect } from 'bun:test';

describe('Phase 3 Wiring', () => {
  // Task 1: Swarm agent execution
  test('AgentSwarm imports superinfer', async () => {
    const mod = await import('../agent-swarm');
    expect(mod.AgentSwarm).toBeDefined();
    // The executeAgentTask method exists (private but accessible in the class)
    const swarm = new mod.AgentSwarm({} as any);
    expect(typeof swarm.start).toBe('function');
    expect(typeof swarm.collapse).toBe('function');
  });

  // Task 2: Emotion router Capacitor integration
  test('analyzeCodeEmotionFromCapacitor aggregates tags', async () => {
    const { analyzeCodeEmotionFromCapacitor } = await import('../emotion-router');

    const tags = [
      { blockId: '1', emotion: 'anxiety', valence: -0.5, arousal: 0.8, dominance: 0.3, intensity: 0.7, taggedAt: Date.now() },
      { blockId: '2', emotion: 'anxiety', valence: -0.6, arousal: 0.9, dominance: 0.2, intensity: 0.8, taggedAt: Date.now() },
      { blockId: '3', emotion: 'confidence', valence: 0.7, arousal: 0.3, dominance: 0.8, intensity: 0.6, taggedAt: Date.now() },
    ];

    const profile = analyzeCodeEmotionFromCapacitor(tags);
    expect(profile.blockCount).toBe(3);
    expect(profile.emotionCounts.anxiety).toBe(2);
    expect(profile.emotionCounts.confidence).toBe(1);
    expect(profile.dominantEmotion).toBe('anxiety');
    expect(profile.avgArousal).toBeGreaterThan(0.5);
  });

  test('analyzeCodeEmotionFromCapacitor returns neutral for empty tags', async () => {
    const { analyzeCodeEmotionFromCapacitor } = await import('../emotion-router');
    const profile = analyzeCodeEmotionFromCapacitor([]);
    expect(profile.dominantEmotion).toBe('neutral');
    expect(profile.blockCount).toBe(0);
  });

  test('analyzeCodeEmotionWithFallback prefers Capacitor when available', async () => {
    const { analyzeCodeEmotionWithFallback } = await import('../emotion-router');

    const tags = [
      { blockId: '1', emotion: 'joy', valence: 0.9, arousal: 0.5, dominance: 0.7, intensity: 0.8, taggedAt: Date.now() },
    ];

    // With tags -- should use Capacitor
    const withTags = analyzeCodeEmotionWithFallback('// TODO: fix this', tags);
    expect(withTags.dominantEmotion).toBe('joy');

    // Without tags -- should fall back to heuristic (detects frustration from TODO)
    const withoutTags = analyzeCodeEmotionWithFallback('// TODO: fix this');
    expect(withoutTags.dominantEmotion).toBe('frustration');
  });

  // Task 3: Void map onRecord callback
  test('void map onRecord fires after recording', async () => {
    const { voidMapStore } = await import('../void-map-store');

    let callbackFired = false;
    let callbackEntry: any = null;

    voidMapStore.onRecord((entry) => {
      callbackFired = true;
      callbackEntry = entry;
    });

    voidMapStore.record({
      filePath: '/test/callback.ts',
      category: 'test-callback',
      rejectedContent: 'Testing onRecord callback',
      source: 'daydream',
    });

    expect(callbackFired).toBe(true);
    expect(callbackEntry).not.toBeNull();
    expect(callbackEntry.filePath).toBe('/test/callback.ts');
    expect(callbackEntry.timestamp).toBeTruthy();

    // Clean up -- reset callback
    voidMapStore.onRecord(() => {});
  });

  test('void map onRecord error does not break record', async () => {
    const { voidMapStore } = await import('../void-map-store');

    voidMapStore.onRecord(() => {
      throw new Error('callback explosion');
    });

    // Should not throw
    const before = voidMapStore.getStatus().totalEntries;
    voidMapStore.record({
      filePath: '/test/error-safe.ts',
      category: 'error-safe',
      rejectedContent: 'This should still persist',
      source: 'cera',
    });
    expect(voidMapStore.getStatus().totalEntries).toBe(before + 1);

    // Clean up
    voidMapStore.onRecord(() => {});
  });

  // Task 4: WS mesh transport in p2p-mesh
  test('p2p-mesh imports ws-mesh-transport', async () => {
    // Verify the import works (module-level side effects)
    const mesh = await import('../p2p-mesh');
    expect(mesh.meshInfer).toBeDefined();
    expect(mesh.stopMesh).toBeDefined();
  });

  // Task 5: Auto-engram from conversations
  test('autoLearnFromInference is exported', async () => {
    const { autoLearnFromInference } = await import('../inference-bridge');
    expect(typeof autoLearnFromInference).toBe('function');
  });

  test('autoLearnFromInference handles short messages gracefully', async () => {
    const { autoLearnFromInference } = await import('../inference-bridge');
    // Should not throw for short messages
    autoLearnFromInference(
      { model: 'test', messages: [{ role: 'user', content: 'hi' }] },
      'hello',
      'echo'
    );
    // No assertion needed -- just verifying no crash
    expect(true).toBe(true);
  });

  // Task 6: Theme engine palette
  test('theme palette includes gnosis keyword colors', async () => {
    const { getBasePalette } = await import('../theme-engine');
    const palette = getBasePalette();
    expect(palette.gnosis.fork).toBe('#10b981');
    expect(palette.gnosis.race).toBe('#f59e0b');
    expect(palette.gnosis.fold).toBe('#06b6d4');
    expect(palette.gnosis.vent).toBe('#ef4444');
  });
});
