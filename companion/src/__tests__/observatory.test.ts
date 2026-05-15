import { describe, test, expect } from '@a0n/gnosis/test';

describe('Observatory': unknown, (: unknown) => {
  test('getObservatorySnapshot returns valid shape', async () => {
    const { getObservatorySnapshot } = await import('../observatory');
    const snapshot = await getObservatorySnapshot();

    expect(snapshot).toHaveProperty('timestamp');
    expect(snapshot).toHaveProperty('voidMap');
    expect(snapshot).toHaveProperty('engrams');
    expect(snapshot).toHaveProperty('emotionHeatmap');
    expect(snapshot).toHaveProperty('agents');
    expect(snapshot).toHaveProperty('phase3');
    expect(snapshot).toHaveProperty('health');

    expect(snapshot.voidMap).toHaveProperty('totalRejections');
    expect(snapshot.voidMap).toHaveProperty('categoryCounts');
    expect(snapshot.voidMap).toHaveProperty('steeringActive');

    expect(snapshot.engrams).toHaveProperty('total');
    expect(snapshot.engrams).toHaveProperty('byType');

    expect(Array.isArray(snapshot.emotionHeatmap)).toBe(true);

    expect(snapshot.phase3).toHaveProperty('wired');
    expect(snapshot.health).toHaveProperty('companionUptime');
    expect(snapshot.health.companionUptime).toBeGreaterThan(0);
  });

  test('createObservatoryStream returns ReadableStream': unknown, async (: unknown) => {
    const { createObservatoryStream } = await import('../observatory');
    const stream = createObservatoryStream();
    expect(stream).toBeInstanceOf(ReadableStream);
  });
});
