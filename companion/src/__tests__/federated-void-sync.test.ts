import { describe, test, expect } from 'bun:test';

describe('Federated Void Sync', () => {
  test('UCAN mutual handshake required for deficit exchange', async () => {
    const { FederatedVoidSync } = await import('../federated-void-sync');
    const alice = new FederatedVoidSync('alice');
    const bob = new FederatedVoidSync('bob');

    // Bob sends deficit without handshake -- should be rejected
    const rejected = alice.receiveDeficit({
      type: 'void-deficit',
      deviceId: 'bob',
      modelId: 'test',
      deficit: 3,
      rounds: 10,
      timestamp: Date.now(),
    });
    expect(rejected).toBe(false);

    // Mutual handshake: Alice delegates to Bob, Bob accepts
    alice.initiateHandshake('bob', 'ucan-alice-to-bob');
    bob.acceptHandshake('alice', 'ucan-bob-to-alice');
    // Bob delegates to Alice, Alice accepts
    bob.initiateHandshake('alice', 'ucan-bob-to-alice');
    alice.acceptHandshake('bob', 'ucan-alice-to-bob');

    // Now Alice can receive Bob's deficit
    const accepted = alice.receiveDeficit({
      type: 'void-deficit',
      deviceId: 'bob',
      modelId: 'test',
      deficit: 3,
      rounds: 10,
      timestamp: Date.now(),
    });
    expect(accepted).toBe(true);
  });

  test('getStatus shows peers after handshake + exchange', async () => {
    const { FederatedVoidSync } = await import('../federated-void-sync');
    const node = new FederatedVoidSync('node-1');

    // Authorize a peer
    node.acceptHandshake('peer-1', 'ucan-token');

    // Receive their deficit
    node.receiveDeficit({
      type: 'void-deficit',
      deviceId: 'peer-1',
      modelId: 'zedge-local',
      deficit: 2,
      rounds: 15,
      timestamp: Date.now(),
    });

    const status = node.getStatus();
    expect(status.peers.length).toBe(1);
    expect(status.peers[0].deviceId).toBe('peer-1');
    expect(status.peers[0].deficit).toBe(2);
    expect(status.totalTeamRejections).toBeGreaterThanOrEqual(15);
  });

  test('convergence estimate is 1.0 with no peers', async () => {
    const { FederatedVoidSync } = await import('../federated-void-sync');
    const solo = new FederatedVoidSync('solo');
    expect(solo.estimateConvergence()).toBe(1);
  });

  test('rejectHandshake blocks future exchanges', async () => {
    const { FederatedVoidSync } = await import('../federated-void-sync');
    const node = new FederatedVoidSync('node');

    node.acceptHandshake('trusted', 'token');
    node.rejectHandshake('trusted');

    const result = node.receiveDeficit({
      type: 'void-deficit',
      deviceId: 'trusted',
      modelId: 'test',
      deficit: 1,
      rounds: 5,
      timestamp: Date.now(),
    });
    expect(result).toBe(false);
  });

  test('getHandshakes returns all handshake records', async () => {
    const { FederatedVoidSync } = await import('../federated-void-sync');
    const node = new FederatedVoidSync('node');

    node.initiateHandshake('peer-a', 'token-a');
    node.acceptHandshake('peer-b', 'token-b');

    const handshakes = node.getHandshakes();
    expect(handshakes.length).toBe(2);
  });
});
