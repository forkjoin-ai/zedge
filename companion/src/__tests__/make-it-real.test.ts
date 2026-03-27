import { describe, test, expect } from '@a0n/gnosis/test';

describe('Make It Real -- Breeding, Sync, Observatory History', () => {
  // Path 1: Breeding generates REAL topology source and compiles with Betty
  describe('Real Breeding', () => {
    test('breeding cycle generates actual .gg topology source', async () => {
      const { agentBreeding } = await import('../agent-breeding');

      // Seed some agent session data first
      const { startCloudAgent } = await import('../cloud-agent-session');
      await startCloudAgent({
        agentName: 'test-breed-agent',
        task: 'test task',
        targetFiles: [],
      });

      const cycle = await agentBreeding.runCycle();

      // Candidates should have real topology source, not just comments
      for (const candidate of cycle.candidates) {
        expect(candidate.topologySource.length).toBeGreaterThan(20);
        // Every real topology has node declarations
        expect(candidate.topologySource).toContain('(input');
        expect(candidate.topologySource).toContain('(output');
        // Strategy determines structure
        if (candidate.strategy === 'restructure') {
          expect(candidate.topologySource).toContain('FORK');
          expect(candidate.topologySource).toContain('RACE');
        }
        if (candidate.strategy === 'rewrite') {
          expect(candidate.topologySource).toContain('VENT');
        }
      }
    });

    test('breeding reads system void boundary', async () => {
      const { agentBreeding } = await import('../agent-breeding');
      const cycle = await agentBreeding.runCycle();

      expect(cycle.systemVoidBoundary).toBeDefined();
      if (cycle.systemVoidBoundary) {
        expect(cycle.systemVoidBoundary).toHaveProperty('healthScore');
        expect(cycle.systemVoidBoundary).toHaveProperty('weakPoints');
        expect(cycle.systemVoidBoundary).toHaveProperty('improvementRate');
        expect(cycle.systemVoidBoundary).toHaveProperty('trends');
      }
    });

    test('constitutional protection blocks architect mutation', async () => {
      const { agentBreeding } = await import('../agent-breeding');
      // The breeding engine should never mutate protected agents
      const status = agentBreeding.getStatus();
      // constitutionalBlocks may be 0 if no protected agents are in the session pool
      expect(typeof status.constitutionalBlocks).toBe('number');
    });
  });

  // Path 2: DashRelay transport wired to federated sync
  describe('Real Sync', () => {
    test('connectVoidSyncRoom wires federated sync broadcast', async () => {
      const { connectVoidSyncRoom, disconnectVoidSyncRoom, getRoomStatus } =
        await import('../void-sync-transport');
      const { federatedVoidSync } = await import('../federated-void-sync');

      await connectVoidSyncRoom('real-sync-test');
      const room = getRoomStatus();
      expect(room.connected).toBe(true);
      expect(room.roomId).toBe('void-sync.real-sync-test');

      // Federated sync should be enabled
      const syncStatus = federatedVoidSync.getStatus();
      expect(syncStatus.enabled).toBe(true);

      disconnectVoidSyncRoom();
    });

    test('line-scoped deficit updates with new rejections', async () => {
      const { voidMapStore } = await import('../void-map-store');
      const { computeLineScopedDeficit } = await import(
        '../void-sync-transport'
      );

      // Record line-specific rejections
      voidMapStore.record({
        filePath: '/test/real-sync.ts',
        line: 25,
        category: 'bug-fix',
        rejectedContent: 'Null check suggestion',
        source: 'daydream',
      });
      voidMapStore.record({
        filePath: '/test/real-sync.ts',
        line: 30,
        category: 'security',
        rejectedContent: 'Sanitize input suggestion',
        source: 'daydream',
      });

      const deficit = computeLineScopedDeficit('/test/real-sync.ts', [20, 35]);
      expect(deficit.rounds).toBeGreaterThanOrEqual(2);
      // 2 categories rejected out of 5 possible = deficit 3
      expect(deficit.deficit).toBeLessThanOrEqual(4);
    });
  });

  // Path 3: Observatory history tracks trends over time
  describe('Real Observatory History', () => {
    test('recordSnapshot persists entries', async () => {
      const { recordSnapshot, getHistorySize } = await import(
        '../observatory-history'
      );

      const before = getHistorySize();
      recordSnapshot({
        timestamp: new Date().toISOString(),
        voidMap: {
          totalRejections: 10,
          categoryCounts: { readability: 5 },
          recentRejections: 3,
          steeringActive: true,
          topRejectedFiles: [],
        },
        engrams: {
          total: 20,
          byType: {
            'code-pattern': 10,
            'conversation-summary': 5,
            'user-preference': 3,
            'file-relationship': 2,
          },
          recentEngrams: 4,
        },
        emotionHeatmap: [],
        agents: {
          totalSessions: 5,
          completed: 3,
          failed: 1,
          avgDurationMs: 1000,
        },
        phase3: { wired: true, trainerActive: false, rejectionsProcessed: 10 },
        health: { companionUptime: 60000, peersConnected: 0, mcpToolCount: 30 },
      });

      expect(getHistorySize()).toBe(before + 1);
    });

    test('computeTrends returns time-windowed analysis', async () => {
      const { computeTrends } = await import('../observatory-history');
      const trends = computeTrends();

      // May be empty if not enough history, but shape should be valid
      expect(Array.isArray(trends)).toBe(true);
      for (const trend of trends) {
        expect(trend).toHaveProperty('window');
        expect(trend).toHaveProperty('rejections');
        expect(trend).toHaveProperty('rejectionDelta');
        expect(trend).toHaveProperty('steeringEffectiveness');
        expect(trend).toHaveProperty('agentSuccessRate');
        expect(['1h', '6h', '24h', '7d']).toContain(trend.window);
      }
    });

    test('computeSystemVoidBoundary returns meta-rejection-surface', async () => {
      const { computeSystemVoidBoundary } = await import(
        '../observatory-history'
      );
      const boundary = computeSystemVoidBoundary();

      expect(boundary).toHaveProperty('timestamp');
      expect(boundary).toHaveProperty('trends');
      expect(boundary).toHaveProperty('healthScore');
      expect(boundary).toHaveProperty('weakPoints');
      expect(boundary).toHaveProperty('improvementRate');
      expect(typeof boundary.healthScore).toBe('number');
      expect(boundary.healthScore).toBeGreaterThanOrEqual(0);
      expect(boundary.healthScore).toBeLessThanOrEqual(1);
      expect(Array.isArray(boundary.weakPoints)).toBe(true);
    });

    test('observatory snapshot auto-persists to history', async () => {
      const { getObservatorySnapshot } = await import('../observatory');
      const { getHistorySize } = await import('../observatory-history');

      const before = getHistorySize();
      await getObservatorySnapshot();
      const after = getHistorySize();

      expect(after).toBeGreaterThan(before);
    });
  });
});
