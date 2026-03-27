import { describe, test, expect } from '@a0n/gnosis/test';
import {
  encodeFrame,
  decodeFrame,
  FRAME_TENSOR,
  FRAME_HEARTBEAT,
  FRAME_INFERENCE,
  FRAME_ACK,
  MeshTransportManager,
  type BinaryFrame,
} from '../ws-mesh-transport';

describe('WS Mesh Transport', () => {
  describe('Binary framing', () => {
    test('encode/decode roundtrip for tensor frame', () => {
      const frame: BinaryFrame = {
        type: FRAME_TENSOR,
        seq: 42,
        data: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]),
      };

      const encoded = encodeFrame(frame);
      expect(encoded.length).toBe(9 + 8); // 9 header + 8 data

      const decoded = decodeFrame(encoded);
      expect(decoded).not.toBeNull();
      expect(decoded!.type).toBe(FRAME_TENSOR);
      expect(decoded!.seq).toBe(42);
      expect(decoded!.data).toEqual(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]));
    });

    test('encode/decode roundtrip for empty heartbeat', () => {
      const frame: BinaryFrame = {
        type: FRAME_HEARTBEAT,
        seq: 0,
        data: new Uint8Array(0),
      };

      const encoded = encodeFrame(frame);
      expect(encoded.length).toBe(9); // header only

      const decoded = decodeFrame(encoded);
      expect(decoded).not.toBeNull();
      expect(decoded!.type).toBe(FRAME_HEARTBEAT);
      expect(decoded!.seq).toBe(0);
      expect(decoded!.data.length).toBe(0);
    });

    test('encode/decode with large payload', () => {
      const data = new Uint8Array(4096);
      for (let i = 0; i < data.length; i++) data[i] = i % 256;

      const frame: BinaryFrame = {
        type: FRAME_INFERENCE,
        seq: 999999,
        data,
      };

      const encoded = encodeFrame(frame);
      const decoded = decodeFrame(encoded);

      expect(decoded).not.toBeNull();
      expect(decoded!.type).toBe(FRAME_INFERENCE);
      expect(decoded!.seq).toBe(999999);
      expect(decoded!.data.length).toBe(4096);
      expect(decoded!.data[0]).toBe(0);
      expect(decoded!.data[255]).toBe(255);
      expect(decoded!.data[256]).toBe(0);
    });

    test('decode returns null for truncated header', () => {
      const buf = new Uint8Array(5); // Less than 9-byte header
      expect(decodeFrame(buf)).toBeNull();
    });

    test('decode returns null for truncated payload', () => {
      const buf = new Uint8Array(9);
      const view = new DataView(buf.buffer);
      buf[0] = FRAME_TENSOR;
      view.setUint32(1, 0, true);
      view.setUint32(5, 100, true); // Claims 100 bytes but buffer is only 9

      expect(decodeFrame(buf)).toBeNull();
    });

    test('frame types are distinct constants', () => {
      expect(FRAME_TENSOR).toBe(0x01);
      expect(FRAME_INFERENCE).toBe(0x02);
      expect(FRAME_HEARTBEAT).toBe(0x03);
      expect(FRAME_ACK).toBe(0x04);
      const types = [FRAME_TENSOR, FRAME_INFERENCE, FRAME_HEARTBEAT, FRAME_ACK];
      expect(new Set(types).size).toBe(4);
    });
  });

  describe('Transport Manager', () => {
    test('getStats returns zeros when no connections', () => {
      const mgr = new MeshTransportManager();
      const stats = mgr.getStats();

      expect(stats.totalConnections).toBe(0);
      expect(stats.wsConnections).toBe(0);
      expect(stats.httpFallback).toBe(0);
      expect(stats.totalBytesSent).toBe(0);
      expect(stats.totalBytesReceived).toBe(0);
    });

    test('getTransport returns null for unknown peer', () => {
      const mgr = new MeshTransportManager();
      expect(mgr.getTransport('unknown-peer')).toBeNull();
    });

    test('send returns false for unknown peer', () => {
      const mgr = new MeshTransportManager();
      const result = mgr.send('unknown-peer', {
        type: FRAME_HEARTBEAT,
        seq: 0,
        data: new Uint8Array(0),
      });
      expect(result).toBe(false);
    });

    test('sendTensor returns false for unknown peer', () => {
      const mgr = new MeshTransportManager();
      expect(mgr.sendTensor('unknown', new Uint8Array(8))).toBe(false);
    });

    test('disconnect is safe for unknown peer', () => {
      const mgr = new MeshTransportManager();
      mgr.disconnect('nonexistent'); // Should not throw
      expect(mgr.getStats().totalConnections).toBe(0);
    });

    test('disconnectAll is safe when empty', () => {
      const mgr = new MeshTransportManager();
      mgr.disconnectAll(); // Should not throw
      expect(mgr.getStats().totalConnections).toBe(0);
    });
  });
});
