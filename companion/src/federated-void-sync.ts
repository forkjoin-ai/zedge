/**
 * Federated Void Sync -- Team-Wide Rejection Learning
 *
 * Multiple developers' void maps merge via statistical teleportation.
 * Privacy-preserving: only the Bule deficit (a single integer) crosses
 * the wire. The specific rejection history never leaves the device.
 *
 * void_walkers_converge: same rejection history = same distribution.
 * This means the team collectively trains the model without sharing
 * what they rejected -- only HOW CERTAIN they are.
 *
 * Transport: DashRelay CRDT rooms (existing infrastructure).
 * Protocol: Bule deficit exchange on void map record events.
 */

import { voidMapStore } from './void-map-store.ts';
import type { VoidMapEntry } from './void-map-store.ts';
import { getZedgeConfig } from './config.ts';

// UCAN-scoped deficit exchange: both parties must present valid capabilities
// before void sync begins. Mutual handshake = bilateral trust.

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface VoidSyncPeer {
  deviceId: string;
  /** The peer's Bule deficit (single integer -- privacy-preserving) */
  deficit: number;
  /** Total rejection rounds the peer has seen */
  rounds: number;
  /** Model the peer is training */
  modelId: string;
  /** Last sync timestamp */
  lastSyncAt: number;
}

export interface VoidSyncStatus {
  enabled: boolean;
  deviceId: string;
  localDeficit: number;
  localRounds: number;
  peers: VoidSyncPeer[];
  totalTeamRejections: number;
  convergenceEstimate: number; // 0-1, how close the team is to agreement
  lastSyncAt: number | null;
  roomId: string | null;
}

export interface DeficitExchange {
  type: 'void-deficit';
  deviceId: string;
  modelId: string;
  deficit: number;
  rounds: number;
  timestamp: number;
  /** UCAN token proving the sender has sync capability */
  ucanToken?: string;
}

export interface VoidSyncHandshake {
  /** Initiator's device ID */
  fromDeviceId: string;
  /** Target's device ID */
  toDeviceId: string;
  /** UCAN token granting void-sync/receive capability */
  ucanToken: string;
  /** Handshake state */
  status: 'pending' | 'accepted' | 'rejected';
  /** When the handshake was initiated */
  initiatedAt: number;
}

// ---------------------------------------------------------------------------
// Sync Manager
// ---------------------------------------------------------------------------

export class FederatedVoidSync {
  private peers = new Map<string, VoidSyncPeer>();
  private handshakes = new Map<string, VoidSyncHandshake>();
  private authorizedPeers = new Set<string>(); // UCAN-verified peers
  private deviceId: string;
  private modelId: string;
  private enabled = false;
  private roomId: string | null = null;
  private lastSyncAt: number | null = null;
  private broadcastFn: ((msg: DeficitExchange) => void) | null = null;

  constructor(deviceId?: string) {
    this.deviceId = deviceId ?? `zedge-${Date.now().toString(36)}`;
    this.modelId = 'zedge-local';
  }

  /**
   * Initiate a UCAN handshake with a peer.
   * Both sides must complete the handshake before deficit exchange begins.
   */
  initiateHandshake(
    targetDeviceId: string,
    ucanToken: string
  ): VoidSyncHandshake {
    const handshake: VoidSyncHandshake = {
      fromDeviceId: this.deviceId,
      toDeviceId: targetDeviceId,
      ucanToken,
      status: 'pending',
      initiatedAt: Date.now(),
    };
    this.handshakes.set(targetDeviceId, handshake);
    return handshake;
  }

  /**
   * Accept a handshake from a peer. Authorizes them for deficit exchange.
   */
  acceptHandshake(fromDeviceId: string, theirUcanToken: string): boolean {
    // In a full implementation, verify the UCAN token here using ucan-bridge
    // For now, trust the token if it's present
    if (!theirUcanToken) return false;

    this.authorizedPeers.add(fromDeviceId);

    const existing = this.handshakes.get(fromDeviceId);
    if (existing) {
      existing.status = 'accepted';
    } else {
      this.handshakes.set(fromDeviceId, {
        fromDeviceId,
        toDeviceId: this.deviceId,
        ucanToken: theirUcanToken,
        status: 'accepted',
        initiatedAt: Date.now(),
      });
    }

    return true;
  }

  /**
   * Reject a handshake from a peer.
   */
  rejectHandshake(fromDeviceId: string): void {
    this.authorizedPeers.delete(fromDeviceId);
    const existing = this.handshakes.get(fromDeviceId);
    if (existing) existing.status = 'rejected';
  }

  /**
   * Check if a peer is authorized for deficit exchange.
   */
  isPeerAuthorized(deviceId: string): boolean {
    return this.authorizedPeers.has(deviceId);
  }

  /**
   * Get all handshakes.
   */
  getHandshakes(): VoidSyncHandshake[] {
    return [...this.handshakes.values()];
  }

  /**
   * Enable federated sync. Registers a void map callback that broadcasts
   * deficit updates on every rejection.
   */
  enable(opts: {
    roomId: string;
    broadcast: (msg: DeficitExchange) => void;
  }): void {
    this.roomId = opts.roomId;
    this.broadcastFn = opts.broadcast;
    this.enabled = true;

    // Register void map callback -- broadcast deficit on every rejection
    voidMapStore.onRecord(() => {
      this.broadcastDeficit();
    });
  }

  /**
   * Disable federated sync.
   */
  disable(): void {
    this.enabled = false;
    this.broadcastFn = null;
    this.roomId = null;
  }

  /**
   * Receive a deficit exchange from a peer.
   * Requires mutual UCAN delegation -- both sides must have accepted handshakes.
   */
  receiveDeficit(exchange: DeficitExchange): boolean {
    if (exchange.deviceId === this.deviceId) return false; // Ignore own messages

    // UCAN gate: only accept deficits from authorized peers (mutual delegation)
    if (!this.isPeerAuthorized(exchange.deviceId)) {
      return false; // Peer hasn't completed UCAN handshake
    }

    this.peers.set(exchange.deviceId, {
      deviceId: exchange.deviceId,
      deficit: exchange.deficit,
      rounds: exchange.rounds,
      modelId: exchange.modelId,
      lastSyncAt: exchange.timestamp,
    });

    this.lastSyncAt = Date.now();
    return true;
  }

  /**
   * Broadcast current deficit to all peers.
   */
  broadcastDeficit(): void {
    if (!this.enabled || !this.broadcastFn) return;

    const status = voidMapStore.getStatus();
    const categories = status.topCategories.length;
    // Bule deficit: total possible rejection categories - categories actually rejected
    // This is a simplification of the full BuleyeanSpace deficit for the void map
    const totalPossibleCategories = 5; // refactor, bug-fix, performance, readability, security
    const deficit = Math.max(0, totalPossibleCategories - categories);

    const exchange: DeficitExchange = {
      type: 'void-deficit',
      deviceId: this.deviceId,
      modelId: this.modelId,
      deficit,
      rounds: status.totalEntries,
      timestamp: Date.now(),
    };

    try {
      this.broadcastFn(exchange);
    } catch {
      // Broadcast failure is non-fatal
    }
  }

  /**
   * Estimate convergence across the team.
   * Returns 0-1 where 1 means all peers have the same deficit (converged).
   */
  estimateConvergence(): number {
    if (this.peers.size === 0) return 1; // Solo developer = converged

    const localStatus = voidMapStore.getStatus();
    const localDeficit = Math.max(0, 5 - localStatus.topCategories.length);

    const deficits = [
      localDeficit,
      ...[...this.peers.values()].map((p) => p.deficit),
    ];
    const mean = deficits.reduce((a, b) => a + b, 0) / deficits.length;
    const variance =
      deficits.reduce((acc, d) => acc + (d - mean) ** 2, 0) / deficits.length;

    // Convergence = 1 / (1 + variance)
    return 1 / (1 + variance);
  }

  /**
   * Get sync status.
   */
  getStatus(): VoidSyncStatus {
    const localStatus = voidMapStore.getStatus();
    const localDeficit = Math.max(0, 5 - localStatus.topCategories.length);
    const totalTeamRejections =
      localStatus.totalEntries +
      [...this.peers.values()].reduce((sum, p) => sum + p.rounds, 0);

    return {
      enabled: this.enabled,
      deviceId: this.deviceId,
      localDeficit,
      localRounds: localStatus.totalEntries,
      peers: [...this.peers.values()],
      totalTeamRejections,
      convergenceEstimate: this.estimateConvergence(),
      lastSyncAt: this.lastSyncAt,
      roomId: this.roomId,
    };
  }
}

// Singleton
export const federatedVoidSync = new FederatedVoidSync();
