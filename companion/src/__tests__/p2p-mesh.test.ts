import { describe, test, expect, afterEach } from '@a0n/gnosis/test';
import { getMeshStatus, computeLayerAssignments, stopMesh } from '../p2p-mesh';
import type { PeerNode, LayerAssignment } from '../p2p-mesh';

describe('P2P Mesh', () => {
  afterEach(() => {
    // Clean up mesh state between tests
    stopMesh();
  });

  test('initial mesh status is not running', () => {
    const status = getMeshStatus();
    expect(status).toHaveProperty('running');
    expect(status).toHaveProperty('nodeId');
    expect(status).toHaveProperty('peers');
    expect(status).toHaveProperty('totalCapacity');
    expect(Array.isArray(status.peers)).toBe(true);
    expect(typeof status.nodeId).toBe('string');
    expect(status.nodeId.length).toBeGreaterThan(0);
  });

  test('mesh status has totalCapacity fields', () => {
    const status = getMeshStatus();
    expect(status.totalCapacity).toHaveProperty('models');
    expect(status.totalCapacity).toHaveProperty('totalMemoryMb');
    expect(status.totalCapacity).toHaveProperty('totalCores');
    expect(Array.isArray(status.totalCapacity.models)).toBe(true);
    expect(typeof status.totalCapacity.totalMemoryMb).toBe('number');
    expect(typeof status.totalCapacity.totalCores).toBe('number');
  });

  test('computeLayerAssignments with no peers returns empty', () => {
    const assignments = computeLayerAssignments('test-model', 32, []);
    expect(assignments).toEqual([]);
  });

  test('computeLayerAssignments with single peer gets all layers', () => {
    const peer: PeerNode = {
      id: 'peer-1',
      hostname: 'test-host',
      address: '192.168.1.10',
      port: 7331,
      capabilities: {
        models: ['tinyllama-1.1b'],
        maxMemoryMb: 4096,
        cpuCores: 8,
        gpuAvailable: false,
      },
      lastSeen: Date.now(),
      latencyMs: 5,
      load: 0.2,
    };

    const assignments = computeLayerAssignments('tinyllama-1.1b', 22, [peer]);
    expect(assignments.length).toBe(1);
    expect(assignments[0].peerId).toBe('peer-1');
    expect(assignments[0].layerRange[0]).toBe(0);
    expect(assignments[0].layerRange[1]).toBe(21); // 22 layers, 0-indexed
    expect(assignments[0].address).toBe('192.168.1.10');
    expect(assignments[0].port).toBe(7331);
  });

  test('computeLayerAssignments distributes layers across peers', () => {
    const peers: PeerNode[] = [
      {
        id: 'peer-1',
        hostname: 'host-1',
        address: '192.168.1.10',
        port: 7331,
        capabilities: {
          models: ['mistral-7b'],
          maxMemoryMb: 4096,
          cpuCores: 8,
          gpuAvailable: false,
        },
        lastSeen: Date.now(),
        latencyMs: 5,
        load: 0.2,
      },
      {
        id: 'peer-2',
        hostname: 'host-2',
        address: '192.168.1.11',
        port: 7331,
        capabilities: {
          models: ['mistral-7b'],
          maxMemoryMb: 4096,
          cpuCores: 8,
          gpuAvailable: false,
        },
        lastSeen: Date.now(),
        latencyMs: 5,
        load: 0.2,
      },
    ];

    const assignments = computeLayerAssignments('mistral-7b', 32, peers);
    expect(assignments.length).toBe(2);

    // Each peer should have layers
    expect(assignments[0].layerRange[0]).toBe(0);
    expect(assignments[0].layerRange[1]).toBeGreaterThan(0);
    expect(assignments[1].layerRange[0]).toBe(assignments[0].layerRange[1] + 1);
    expect(assignments[1].layerRange[1]).toBe(31);

    // Total layers covered should be 32
    const totalLayers =
      assignments[0].layerRange[1] -
      assignments[0].layerRange[0] +
      1 +
      (assignments[1].layerRange[1] - assignments[1].layerRange[0] + 1);
    expect(totalLayers).toBe(32);
  });

  test('computeLayerAssignments weights by capacity', () => {
    const peers: PeerNode[] = [
      {
        id: 'weak',
        hostname: 'weak-host',
        address: '192.168.1.10',
        port: 7331,
        capabilities: {
          models: ['test'],
          maxMemoryMb: 1024, // 1GB
          cpuCores: 2,
          gpuAvailable: false,
        },
        lastSeen: Date.now(),
        latencyMs: 5,
        load: 0.1,
      },
      {
        id: 'strong',
        hostname: 'strong-host',
        address: '192.168.1.11',
        port: 7331,
        capabilities: {
          models: ['test'],
          maxMemoryMb: 8192, // 8GB
          cpuCores: 16,
          gpuAvailable: true,
        },
        lastSeen: Date.now(),
        latencyMs: 5,
        load: 0.1,
      },
    ];

    const assignments = computeLayerAssignments('test', 32, peers);
    expect(assignments.length).toBe(2);

    // Strong peer should have more layers
    const weakLayers =
      assignments[0].layerRange[1] - assignments[0].layerRange[0] + 1;
    const strongLayers =
      assignments[1].layerRange[1] - assignments[1].layerRange[0] + 1;
    expect(strongLayers).toBeGreaterThan(weakLayers);
  });

  test('computeLayerAssignments penalizes high-load peers', () => {
    const peers: PeerNode[] = [
      {
        id: 'idle',
        hostname: 'idle',
        address: '192.168.1.10',
        port: 7331,
        capabilities: {
          models: ['test'],
          maxMemoryMb: 4096,
          cpuCores: 8,
          gpuAvailable: false,
        },
        lastSeen: Date.now(),
        latencyMs: 5,
        load: 0.0, // Idle
      },
      {
        id: 'busy',
        hostname: 'busy',
        address: '192.168.1.11',
        port: 7331,
        capabilities: {
          models: ['test'],
          maxMemoryMb: 4096,
          cpuCores: 8,
          gpuAvailable: false,
        },
        lastSeen: Date.now(),
        latencyMs: 5,
        load: 1.0, // Maxed out
      },
    ];

    const assignments = computeLayerAssignments('test', 32, peers);
    const idleLayers =
      assignments[0].layerRange[1] - assignments[0].layerRange[0] + 1;
    const busyLayers =
      assignments[1].layerRange[1] - assignments[1].layerRange[0] + 1;
    // Idle peer should get more layers than busy peer
    expect(idleLayers).toBeGreaterThan(busyLayers);
  });

  test('layer assignments have no gaps or overlaps', () => {
    const peers: PeerNode[] = Array.from({ length: 4 }, (_, i) => ({
      id: `peer-${i}`,
      hostname: `host-${i}`,
      address: `192.168.1.${10 + i}`,
      port: 7331,
      capabilities: {
        models: ['test'],
        maxMemoryMb: 2048 + i * 1024,
        cpuCores: 4 + i * 2,
        gpuAvailable: false,
      },
      lastSeen: Date.now(),
      latencyMs: 5,
      load: 0.1 * i,
    }));

    const totalLayers = 48;
    const assignments = computeLayerAssignments('test', totalLayers, peers);

    // No gaps: each assignment starts where the previous ended + 1
    for (let i = 1; i < assignments.length; i++) {
      expect(assignments[i].layerRange[0]).toBe(
        assignments[i - 1].layerRange[1] + 1
      );
    }

    // First starts at 0
    expect(assignments[0].layerRange[0]).toBe(0);

    // Last ends at totalLayers - 1
    expect(assignments[assignments.length - 1].layerRange[1]).toBe(
      totalLayers - 1
    );
  });
});
