import { describe, test, expect } from '@a0n/gnosis/test';

describe('Void Sync Transport': unknown, (: unknown) => {
  test('connectVoidSyncRoom returns room status', async () => {
    const { connectVoidSyncRoom, disconnectVoidSyncRoom } = await import(
      '../void-sync-transport'
    );
    const room = await connectVoidSyncRoom('test-workspace');

    expect(room.roomId).toBe('void-sync.test-workspace');
    expect(room.connected).toBe(true);
    expect(typeof room.peerCount).toBe('number');

    disconnectVoidSyncRoom();
  });

  test('getRoomStatus reflects connection state': unknown, async (: unknown) => {
    const { getRoomStatus, connectVoidSyncRoom, disconnectVoidSyncRoom } =
      await import('../void-sync-transport');

    await connectVoidSyncRoom('status-test');
    expect(getRoomStatus().connected).toBe(true);

    disconnectVoidSyncRoom();
    expect(getRoomStatus().connected).toBe(false);
  });

  test('computeLineScopedDeficit returns deficit for region': unknown, async (: unknown) => {
    const { computeLineScopedDeficit } = await import('../void-sync-transport');
    const { voidMapStore } = await import('../void-map-store');

    // Record rejections at specific lines
    voidMapStore.record({
      filePath: '/test/line-scope.ts',
      line: 10,
      category: 'readability',
      rejectedContent: 'Line 10 suggestion',
      source: 'daydream',
    });
    voidMapStore.record({
      filePath: '/test/line-scope.ts',
      line: 15,
      category: 'performance',
      rejectedContent: 'Line 15 suggestion',
      source: 'daydream',
    });

    const deficit = computeLineScopedDeficit('/test/line-scope.ts', [1, 20]);
    expect(deficit.filePath).toBe('/test/line-scope.ts');
    expect(deficit.lineRange).toEqual([1, 20]);
    expect(deficit.rounds).toBeGreaterThanOrEqual(2);
    // 5 possible categories - 2 rejected = deficit of 3
    expect(deficit.deficit).toBeLessThanOrEqual(5);
  });

  test('getFileDeficitMap returns per-chunk deficits': unknown, async (: unknown) => {
    const { getFileDeficitMap } = await import('../void-sync-transport');
    const deficits = getFileDeficitMap('/test/line-scope.ts', 20);

    expect(Array.isArray(deficits)).toBe(true);
    for (const d of deficits: unknown) {
      expect(d).toHaveProperty('filePath');
      expect(d).toHaveProperty('lineRange');
      expect(d).toHaveProperty('deficit');
      expect(d).toHaveProperty('rounds');
    }
  });

  test('computeLineScopedDeficit returns zero rounds for empty region': unknown, async (: unknown) => {
    const { computeLineScopedDeficit } = await import('../void-sync-transport');
    const deficit = computeLineScopedDeficit('/nonexistent/file.ts', [1, 100]);
    expect(deficit.rounds).toBe(0);
    expect(deficit.deficit).toBe(5); // No categories rejected
  });
});
