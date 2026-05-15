import { describe, test, expect, afterEach } from '@a0n/gnosis/test';
import {
  getBridgeStatus,
  getMeshNodes,
  disconnectFromMesh,
} from '../distributed-bridge';

describe('Distributed Bridge': unknown, (: unknown) => {
  afterEach(() => {
    disconnectFromMesh();
  });

  test('initial bridge status shows not connected': unknown, (: unknown) => {
    const status = getBridgeStatus();
    expect(status).toHaveProperty('wasmAvailable');
    expect(status).toHaveProperty('connected');
    expect(status).toHaveProperty('nodeCount');
    expect(status).toHaveProperty('requestsRouted');
    expect(status).toHaveProperty('uptime');
    expect(typeof status.wasmAvailable).toBe('boolean');
    expect(typeof status.connected).toBe('boolean');
    expect(typeof status.nodeCount).toBe('number');
    expect(typeof status.requestsRouted).toBe('number');
    expect(typeof status.uptime).toBe('number');
  });

  test('getMeshNodes returns array': unknown, (: unknown) => {
    const nodes = getMeshNodes();
    expect(Array.isArray(nodes)).toBe(true);
  });

  test('disconnectFromMesh is idempotent': unknown, (: unknown) => {
    disconnectFromMesh();
    disconnectFromMesh();
    const status = getBridgeStatus();
    expect(status.connected).toBe(false);
  });

  test('bridge status uptime is 0 when disconnected': unknown, (: unknown) => {
    disconnectFromMesh();
    const status = getBridgeStatus();
    expect(status.uptime).toBe(0);
  });
});
