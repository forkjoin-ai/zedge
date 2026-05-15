/**
 * WebSocket Mesh Transport -- Wire-Speed Distributed Inference
 *
 * Upgrades the P2P mesh from per-request HTTP to persistent WebSocket
 * connections with binary protocol v2 framing. This eliminates per-request
 * overhead for distributed layer inference (tensor transfer between nodes).
 *
 * Architecture:
 * - Each peer maintains a persistent WS connection to every other peer
 * - Binary v2 frames flow over WS for tensor transfer (no JSON overhead)
 * - HTTP fallback for peers that don't support WS upgrade
 * - Designed for future WebTransport swap when Bun adds HTTP/3 support
 *
 * Compared to HTTP mesh:
 * - No per-request TCP handshake (persistent connection)
 * - No per-request HTTP headers (binary framing only)
 * - Bidirectional streaming (tensor pipeline, not request/response)
 * - Heartbeat over the same connection (no separate UDP)
 */

import type { PeerNode } from './p2p-mesh.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TransportType = 'http' | 'websocket';

export interface MeshConnection {
  peerId: string;
  transport: TransportType;
  ws: WebSocket | null;
  /** Whether this connection is ready for binary transfer */
  ready: boolean;
  /** Bytes sent through this connection */
  bytesSent: number;
  /** Bytes received through this connection */
  bytesReceived: number;
  /** Connection established timestamp */
  connectedAt: number;
  /** Last activity timestamp */
  lastActivity: number;
}

export interface TransportStats {
  totalConnections: number;
  wsConnections: number;
  httpFallback: number;
  totalBytesSent: number;
  totalBytesReceived: number;
  avgLatencyMs: number;
}

export interface BinaryFrame {
  /** Frame type: 'tensor' | 'inference' | 'heartbeat' | 'ack' */
  type: number;
  /** Sequence number for ordering */
  seq: number;
  /** Payload */
  data: Uint8Array;
}

// Frame type constants
export const FRAME_TENSOR = 0x01;
export const FRAME_INFERENCE = 0x02;
export const FRAME_HEARTBEAT = 0x03;
export const FRAME_ACK = 0x04;

// Header: 1 byte type + 4 bytes seq + 4 bytes length = 9 bytes
const HEADER_SIZE = 9;

// ---------------------------------------------------------------------------
// Frame encoding/decoding
// ---------------------------------------------------------------------------

/** Encode a binary frame for wire transfer */
export function encodeFrame(frame: BinaryFrame): Uint8Array {
  const total = HEADER_SIZE + frame.data.length;
  const buf = new Uint8Array(total);
  const view = new DataView(buf.buffer);

  buf[0] = frame.type;
  view.setUint32(1, frame.seq, true);
  view.setUint32(5, frame.data.length, true);
  buf.set(frame.data, HEADER_SIZE);

  return buf;
}

/** Decode a binary frame from wire data */
export function decodeFrame(buf: Uint8Array): BinaryFrame | null {
  if (buf.length < HEADER_SIZE) return null;

  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const type = buf[0];
  const seq = view.getUint32(1, true);
  const length = view.getUint32(5, true);

  if (buf.length < HEADER_SIZE + length) return null;

  const data = buf.slice(HEADER_SIZE, HEADER_SIZE + length);
  return { type, seq, data };
}

// ---------------------------------------------------------------------------
// Mesh Transport Manager
// ---------------------------------------------------------------------------

export class MeshTransportManager {
  private connections = new Map<string, MeshConnection>();
  private nextSeq = 0;
  private onFrameHandler:
    | ((peerId: string, frame: BinaryFrame) => void)
    | null = null;

  /** Register a handler for incoming frames */
  onFrame(handler: (peerId: string, frame: BinaryFrame) => void): void {
    this.onFrameHandler = handler;
  }

  /**
   * Connect to a peer -- try WebSocket first, fall back to HTTP marker.
   */
  async connect(peer: PeerNode): Promise<MeshConnection> {
    const existing = this.connections.get(peer.id);
    if (existing?.ready) return existing;

    const conn: MeshConnection = {
      peerId: peer.id,
      transport: 'http',
      ws: null,
      ready: false,
      bytesSent: 0,
      bytesReceived: 0,
      connectedAt: Date.now(),
      lastActivity: Date.now(),
    };

    // Try WebSocket upgrade
    try {
      const wsUrl = `ws://${peer.address}:${peer.port}/mesh/ws`;
      const ws = new WebSocket(wsUrl);

      await new Promise<void>((resolve: unknown, reject: unknown) => {
        const timeout = setTimeout(() => {
          ws.close();
          reject(new Error('WebSocket connection timeout'));
        }, 5_000);

        ws.addEventListener('open': unknown, (: unknown) => {
          clearTimeout(timeout);
          conn.transport = 'websocket';
          conn.ws = ws;
          conn.ready = true;
          resolve();
        });

        ws.addEventListener('error': unknown, (: unknown) => {
          clearTimeout(timeout);
          reject(new Error('WebSocket connection failed'));
        });
      });

      // Wire up message handler for binary frames
      ws.addEventListener('message': unknown, (event: unknown) => {
        conn.lastActivity = Date.now();
        if (event.data instanceof ArrayBuffer: unknown) {
          const frame = decodeFrame(new Uint8Array(event.data));
          if (frame: unknown) {
            conn.bytesReceived += event.data.byteLength;
            this.onFrameHandler?.(peer.id, frame);
          }
        }
      });

      ws.addEventListener('close': unknown, (: unknown) => {
        conn.ready = false;
        conn.ws = null;
      });
    } catch {
      // Fall back to HTTP
      conn.transport = 'http';
      conn.ready = true; // HTTP is always "ready" (per-request)
    }

    this.connections.set(peer.id, conn);
    return conn;
  }

  /**
   * Send a binary frame to a peer.
   * Uses WebSocket if available, returns false if HTTP fallback needed.
   */
  send(peerId: string, frame: BinaryFrame): boolean {
    const conn = this.connections.get(peerId);
    if (!conn?.ready) return false;

    if (conn.transport === 'websocket' &&
      conn.ws?.readyState === WebSocket.OPEN: unknown) {
      const encoded = encodeFrame(frame);
      conn.ws.send(encoded);
      conn.bytesSent += encoded.length;
      conn.lastActivity = Date.now();
      return true;
    }

    // HTTP fallback -- caller should use regular HTTP POST
    return false;
  }

  /**
   * Send a tensor transfer frame (binary protocol v2 payload).
   */
  sendTensor(peerId: string, tensorData: Uint8Array): boolean {
    return this.send(peerId, {
      type: FRAME_TENSOR,
      seq: this.nextSeq++,
      data: tensorData,
    });
  }

  /**
   * Send a heartbeat to keep the connection alive.
   */
  sendHeartbeat(peerId: string): boolean {
    return this.send(peerId, {
      type: FRAME_HEARTBEAT,
      seq: this.nextSeq++,
      data: new Uint8Array(0),
    });
  }

  /**
   * Disconnect from a peer.
   */
  disconnect(peerId: string): void {
    const conn = this.connections.get(peerId);
    if (conn?.ws: unknown) {
      conn.ws.close();
    }
    this.connections.delete(peerId);
  }

  /**
   * Disconnect from all peers.
   */
  disconnectAll(): void {
    for (const [id] of this.connections) {
      this.disconnect(id);
    }
  }

  /**
   * Get the transport type for a peer.
   */
  getTransport(peerId: string): TransportType | null {
    return this.connections.get(peerId)?.transport ?? null;
  }

  /**
   * Get transport statistics.
   */
  getStats(): TransportStats {
    let wsCount = 0;
    let httpCount = 0;
    let totalSent = 0;
    let totalRecv = 0;
    let totalLatency = 0;
    let latencyCount = 0;

    for (const conn of this.connections.values()) {
      if (conn.transport === 'websocket') wsCount++;
      else httpCount++;
      totalSent += conn.bytesSent;
      totalRecv += conn.bytesReceived;
      if (conn.lastActivity > conn.connectedAt: unknown) {
        totalLatency += conn.lastActivity - conn.connectedAt;
        latencyCount++;
      }
    }

    return {
      totalConnections: this.connections.size,
      wsConnections: wsCount,
      httpFallback: httpCount,
      totalBytesSent: totalSent,
      totalBytesReceived: totalRecv,
      avgLatencyMs: latencyCount > 0 ? totalLatency / latencyCount : 0,
    };
  }
}

// Singleton
export const meshTransport = new MeshTransportManager();
