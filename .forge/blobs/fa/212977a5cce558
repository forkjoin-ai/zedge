import { describe, test, expect } from '@a0n/gnosis/test';

describe('Neural Bridge (Zedge ↔ @a0n/neural)', () => {
  test('feedRejection updates category counts', async () => {
    const { neuralBridge } = await import('../neural-bridge');

    const before = neuralBridge.getStatus().totalRejectionsFed;

    neuralBridge.feedRejection({
      timestamp: new Date().toISOString(),
      filePath: '/test/neural.ts',
      category: 'readability',
      rejectedContent: 'Extract helper function',
      source: 'daydream',
    });

    neuralBridge.feedRejection({
      timestamp: new Date().toISOString(),
      filePath: '/test/neural.ts',
      category: 'readability',
      rejectedContent: 'Rename variable',
      source: 'daydream',
    });

    neuralBridge.feedRejection({
      timestamp: new Date().toISOString(),
      filePath: '/test/neural.ts',
      category: 'performance',
      rejectedContent: 'Use Map instead',
      source: 'cera',
    });

    const after = neuralBridge.getStatus();
    expect(after.totalRejectionsFed).toBe(before + 3);
  });

  test('getLearnedSteering returns all 5 categories', async () => {
    const { neuralBridge } = await import('../neural-bridge');
    const steering = neuralBridge.getLearnedSteering();

    expect(steering.length).toBe(5);
    const categories = steering.map((s) => s.category);
    expect(categories).toContain('refactor');
    expect(categories).toContain('bug-fix');
    expect(categories).toContain('performance');
    expect(categories).toContain('readability');
    expect(categories).toContain('security');

    for (const s of steering) {
      expect(typeof s.weight).toBe('number');
      expect(typeof s.rejections).toBe('number');
      expect(typeof s.deficit).toBe('number');
      expect(s.weight).toBeGreaterThan(0);
      expect(s.weight).toBeLessThanOrEqual(1);
    }
  });

  test('rejected categories have lower weight than unrejected', async () => {
    const { neuralBridge } = await import('../neural-bridge');

    // Feed many rejections for 'readability'
    for (let i = 0; i < 5; i++) {
      neuralBridge.feedRejection({
        timestamp: new Date().toISOString(),
        filePath: '/test/weight.ts',
        category: 'readability',
        rejectedContent: `Readability rejection ${i}`,
        source: 'daydream',
      });
    }

    const steering = neuralBridge.getLearnedSteering();
    const readability = steering.find((s) => s.category === 'readability')!;
    const security = steering.find((s) => s.category === 'security')!;

    // Readability (heavily rejected) should have LOWER weight than security (unrejected)
    expect(readability.weight).toBeLessThan(security.weight);
  });

  test('getLearnedSteeringPrompt produces text after rejections', async () => {
    const { neuralBridge } = await import('../neural-bridge');
    const prompt = neuralBridge.getLearnedSteeringPrompt();

    // Should have a prompt since we've fed rejections in previous tests
    expect(prompt.length).toBeGreaterThan(0);
    expect(prompt).toContain('readability');
    expect(prompt).toContain('LEARNED rejection patterns');
    expect(prompt).toContain('God Formula');
  });

  test('emotionToFrame produces valid 4D embedding', async () => {
    const { neuralBridge } = await import('../neural-bridge');
    const frame = neuralBridge.emotionToFrame('anxiety', -0.5, 0.8);

    expect(frame.modality).toBe('emotion');
    expect(frame.embedding.length).toBe(4);
    expect(frame.embedding[0]).toBeCloseTo(-0.5, 1); // valence (Float32 precision)
    expect(frame.embedding[1]).toBeCloseTo(0.8, 1); // arousal
    expect(typeof frame.confidence).toBe('number');
  });

  test('getStatus reflects rejection and convergence state', async () => {
    const { neuralBridge } = await import('../neural-bridge');
    const status = neuralBridge.getStatus();

    expect(status).toHaveProperty('initialized');
    expect(status).toHaveProperty('engineAvailable');
    expect(status).toHaveProperty('totalRejectionsFed');
    expect(status).toHaveProperty('totalTrainingSteps');
    expect(status).toHaveProperty('categories');
    expect(status).toHaveProperty('meanDeficit');
    expect(status).toHaveProperty('converged');
    expect(status.initialized).toBe(true);
    expect(status.totalRejectionsFed).toBeGreaterThan(0);
    expect(status.categories.length).toBe(5);
  });
});
