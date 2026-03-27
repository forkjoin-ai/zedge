import { describe, test, expect } from '@a0n/gnosis/test';

describe('Phase 3 Wiring (wire-phase3.ts)', () => {
  test('wirePhase3 initializes and returns status', async () => {
    const { wirePhase3, getPhase3Status } = await import('../wire-phase3');

    const status = await wirePhase3();

    expect(status.wired).toBe(true);
    expect(status.wiredAt).not.toBeNull();
    expect(status.voidMapCallbackRegistered).toBe(true);
    expect(typeof status.totalRejectionsProcessed).toBe('number');
    expect(typeof status.totalEngramsStored).toBe('number');
  });

  test('wirePhase3 is idempotent (calling twice returns same status)', async () => {
    const { wirePhase3 } = await import('../wire-phase3');

    const first = await wirePhase3();
    const second = await wirePhase3();

    expect(first.wiredAt).toBe(second.wiredAt);
  });

  test('void map rejection increments processed count', async () => {
    const { wirePhase3, getPhase3Status } = await import('../wire-phase3');
    const { voidMapStore } = await import('../void-map-store');

    await wirePhase3();
    const before = getPhase3Status().totalRejectionsProcessed;

    voidMapStore.record({
      filePath: '/test/phase3.ts',
      category: 'test',
      rejectedContent: 'phase3 integration test rejection',
      source: 'daydream',
    });

    const after = getPhase3Status().totalRejectionsProcessed;
    expect(after).toBe(before + 1);
  });

  test('getPhase3Status returns valid shape', async () => {
    const { getPhase3Status } = await import('../wire-phase3');
    const status = getPhase3Status();

    expect(status).toHaveProperty('wired');
    expect(status).toHaveProperty('buleyeanTrainerActive');
    expect(status).toHaveProperty('voidMapCallbackRegistered');
    expect(status).toHaveProperty('engramStoreInitialized');
    expect(status).toHaveProperty('totalRejectionsProcessed');
    expect(status).toHaveProperty('totalEngramsStored');
    expect(status).toHaveProperty('wiredAt');
  });

  test('end-to-end: rejection flows through training pipeline', async () => {
    const { wirePhase3, getPhase3Status } = await import('../wire-phase3');
    const { voidMapStore } = await import('../void-map-store');

    await wirePhase3();

    // Record multiple rejections
    for (let i = 0; i < 3; i++) {
      voidMapStore.record({
        filePath: '/test/e2e.ts',
        category: 'readability',
        rejectedContent: `Rejected suggestion ${i}`,
        source: 'daydream',
      });
    }

    const status = getPhase3Status();
    expect(status.totalRejectionsProcessed).toBeGreaterThanOrEqual(3);

    // Verify steering vector updated from new rejections
    const steering = voidMapStore.getSteeringVector('/test/e2e.ts');
    expect(steering.rejectedCategories.length).toBeGreaterThan(0);
  });
});
