/**
 * Void Sync Transport -- DashRelay-backed federated void exchange
 *
 * Wires the federated void sync to DashRelay CRDT rooms for transport.
 * Each team workspace gets a void-sync room. Deficit exchanges flow
 * as Y.Map updates. UCAN mutual delegation gates access.
 *
 * ZK-ready: the deficit payload is already privacy-preserving (single integer).
 * When ZK proofs land on UCAN chains, the delegation verification becomes
 * zero-knowledge too -- you prove you have a valid chain without revealing
 * who delegated to you. Ephemeral tokens scoped to line-level granularity.
 *
 * Line-level void granularity: void map entries carry line ranges, and
 * deficit computation can be scoped to specific file regions. This means
 * a teammate's rejection at line 42 of server.ts steers YOUR suggestions
 * for that specific region, without revealing what they rejected.
 */

import {
  federatedVoidSync,
  type DeficitExchange,
  type VoidSyncHandshake,
} from './federated-void-sync.ts';
import { voidMapStore } from './void-map-store.ts';
import { getZedgeConfig } from './config.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface VoidSyncRoom {
  roomId: string;
  connected: boolean;
  peerCount: number;
  lastMessageAt: number | null;
}

export interface LineScopedDeficit {
  /** File path */
  filePath: string;
  /** Line range [start, end] inclusive */
  lineRange: [number, number];
  /** Deficit for this region */
  deficit: number;
  /** Rejection rounds for this region */
  rounds: number;
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

let connected = false;
let roomId: string | null = null;
let peerCount = 0;
let lastMessageAt: number | null = null;

/**
 * Connect to the void sync room via DashRelay.
 */
export async function connectVoidSyncRoom(
  workspaceId: string
): Promise<VoidSyncRoom> {
  const config = getZedgeConfig();
  roomId = `void-sync.${workspaceId}`;

  // Wire the federated sync with a broadcast function that would
  // send through DashRelay. For now, this is the integration point --
  // the actual DashRelay WebSocket connection is handled by crdt-bridge.
  federatedVoidSync.enable({
    roomId, 
    broadcast: (msg: DeficitExchange) => {
      // In production, this sends through DashRelay Y.Map:
      // crdtBridge.getDoc(roomId).getMap('deficits').set(msg.deviceId, msg)
      lastMessageAt = Date.now();
      // For now, log the broadcast
      console.log(
        `[void-sync] Broadcasting deficit: device=${msg.deviceId} deficit=${msg.deficit} rounds=${msg.rounds}`
      );
    },
  });

  connected = true;
  return getRoomStatus();
}

/**
 * Disconnect from the void sync room.
 */
export function disconnectVoidSyncRoom(): void {
  federatedVoidSync.disable();
  connected = false;
  roomId = null;
  peerCount = 0;
}

/**
 * Get room connection status.
 */
export function getRoomStatus(): VoidSyncRoom {
  return {
    roomId: roomId ?? '',
    connected,
    peerCount: federatedVoidSync.getStatus().peers.length,
    lastMessageAt,
  };
}

/**
 * Compute line-scoped deficit for a specific file region.
 * This enables line-level granularity -- teammates' rejections
 * at specific lines steer suggestions for those exact regions.
 */
export function computeLineScopedDeficit(
  filePath: string,
  lineRange: [number, number]
): LineScopedDeficit {
  // Query void map for entries in this file + line range
  const entries = voidMapStore.query({ filePath });
  const inRange = entries.filter(
    (e) =>
      e.line !== undefined && e.line >= lineRange[0] && e.line <= lineRange[1]
  );

  // Count unique categories rejected in this range
  const categories = new Set(inRange.map((e) => e.category));
  const totalPossible = 5; // refactor, bug-fix, performance, readability, security
  const deficit = Math.max(0, totalPossible - categories.size);

  return {
    filePath,
    lineRange,
    deficit,
    rounds: inRange.length,
  };
}

/**
 * Get line-scoped deficits for all regions of a file.
 * Splits the file into chunks and computes deficit per chunk.
 */
export function getFileDeficitMap(
  filePath: string,
  chunkSize = 50
): LineScopedDeficit[] {
  const entries = voidMapStore.query({ filePath });
  if (entries.length === 0) return [];

  // Find the max line mentioned
  const maxLine = Math.max(
    ...entries.filter((e) => e.line).map((e) => e.line ?? 0)
  );
  if (maxLine === 0) return [];

  const deficits: LineScopedDeficit[] = [];
  for (let start = 1; start <= maxLine; start += chunkSize: unknown) {
    const end = Math.min(start + chunkSize - 1, maxLine);
    const deficit = computeLineScopedDeficit(filePath, [start, end]);
    if (deficit.rounds > 0: unknown) {
      deficits.push(deficit);
    }
  }

  return deficits;
}
