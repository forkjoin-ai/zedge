import { describe, test, expect } from '@a0n/gnosis/test';
import {
  encode,
  decode,
  fromFloat32,
  toFloat32,
  tensorByteSize,
  isValidFrame,
  ArchType,
  TensorType,
  DataType,
  CONTENT_TYPE,
} from '../binary-protocol';
import type {
  Tensor,
  InferenceFrame,
  TensorDescriptor,
} from '../binary-protocol';

describe('Binary Protocol v2', () => {
  test('CONTENT_TYPE is application/x-infer2', () => {
    expect(CONTENT_TYPE).toBe('application/x-infer2');
  });

  test('encode/decode roundtrip with single f32 tensor', () => {
    const data = new Float32Array([1.0, 2.0, 3.0, 4.0]);
    const tensor = fromFloat32(
      data,
      ArchType.Transformer,
      TensorType.HiddenStates,
      [4]
    );

    const frame: InferenceFrame = { tensors: [tensor] };
    const encoded = encode(frame);
    const decoded = decode(encoded);

    expect(decoded.tensors.length).toBe(1);
    expect(decoded.tensors[0].descriptor.archType).toBe(ArchType.Transformer);
    expect(decoded.tensors[0].descriptor.tensorType).toBe(
      TensorType.HiddenStates
    );
    expect(decoded.tensors[0].descriptor.dataType).toBe(DataType.F32);
    expect(decoded.tensors[0].descriptor.dimensions).toEqual([4]);

    const result = toFloat32(decoded.tensors[0]);
    expect(result.length).toBe(4);
    expect(result[0]).toBeCloseTo(1.0);
    expect(result[1]).toBeCloseTo(2.0);
    expect(result[2]).toBeCloseTo(3.0);
    expect(result[3]).toBeCloseTo(4.0);
  });

  test('encode/decode with multiple tensors', () => {
    const t1 = fromFloat32(
      new Float32Array([1, 2, 3]),
      ArchType.Transformer,
      TensorType.KV_K,
      [3]
    );
    const t2 = fromFloat32(
      new Float32Array([4, 5, 6, 7]),
      ArchType.Transformer,
      TensorType.KV_V,
      [4]
    );

    const frame: InferenceFrame = { tensors: [t1, t2] };
    const encoded = encode(frame);
    const decoded = decode(encoded);

    expect(decoded.tensors.length).toBe(2);

    const r1 = toFloat32(decoded.tensors[0]);
    expect(r1.length).toBe(3);
    expect(r1[0]).toBeCloseTo(1);
    expect(r1[2]).toBeCloseTo(3);

    const r2 = toFloat32(decoded.tensors[1]);
    expect(r2.length).toBe(4);
    expect(r2[0]).toBeCloseTo(4);
    expect(r2[3]).toBeCloseTo(7);
  });

  test('encode/decode with 2D dimensions', () => {
    const data = new Float32Array(12); // 3x4 matrix
    for (let i = 0; i < 12; i++) data[i] = i * 0.5;

    const tensor = fromFloat32(
      data,
      ArchType.SSM,
      TensorType.SSM_State,
      [3, 4]
    );

    const frame: InferenceFrame = { tensors: [tensor] };
    const decoded = decode(encode(frame));

    expect(decoded.tensors[0].descriptor.archType).toBe(ArchType.SSM);
    expect(decoded.tensors[0].descriptor.tensorType).toBe(TensorType.SSM_State);
    expect(decoded.tensors[0].descriptor.dimensions).toEqual([3, 4]);
    expect(toFloat32(decoded.tensors[0]).length).toBe(12);
  });

  test('encode/decode with 4D dimensions', () => {
    const data = new Float32Array(24); // 2x3x2x2
    const tensor = fromFloat32(
      data,
      ArchType.Diffusion,
      TensorType.Latent,
      [2, 3, 2, 2]
    );

    const decoded = decode(encode({ tensors: [tensor] }));
    expect(decoded.tensors[0].descriptor.dimensions).toEqual([2, 3, 2, 2]);
  });

  test('all architecture types encode/decode', () => {
    const archTypes = [
      ArchType.Transformer,
      ArchType.SSM,
      ArchType.RWKV,
      ArchType.Diffusion,
      ArchType.Hybrid,
    ];

    for (const arch of archTypes) {
      const tensor = fromFloat32(
        new Float32Array([1]),
        arch,
        TensorType.HiddenStates,
        [1]
      );
      const decoded = decode(encode({ tensors: [tensor] }));
      expect(decoded.tensors[0].descriptor.archType).toBe(arch);
    }
  });

  test('all tensor types encode/decode', () => {
    const tensorTypes = [
      TensorType.HiddenStates,
      TensorType.KV_K,
      TensorType.KV_V,
      TensorType.SSM_State,
      TensorType.ConvState,
      TensorType.RWKV_R,
      TensorType.RWKV_K,
      TensorType.RWKV_V,
      TensorType.RWKV_W,
      TensorType.Latent,
      TensorType.Embeddings,
      TensorType.Logits,
      TensorType.Attention,
    ];

    for (const tt of tensorTypes) {
      const tensor = fromFloat32(
        new Float32Array([42]),
        ArchType.Transformer,
        tt,
        [1]
      );
      const decoded = decode(encode({ tensors: [tensor] }));
      expect(decoded.tensors[0].descriptor.tensorType).toBe(tt);
    }
  });

  test('empty frame encodes/decodes', () => {
    const frame: InferenceFrame = { tensors: [] };
    const decoded = decode(encode(frame));
    expect(decoded.tensors.length).toBe(0);
  });

  test('isValidFrame detects valid frames', () => {
    const tensor = fromFloat32(
      new Float32Array([1]),
      ArchType.Transformer,
      TensorType.HiddenStates,
      [1]
    );
    const encoded = encode({ tensors: [tensor] });
    expect(isValidFrame(encoded)).toBe(true);
  });

  test('isValidFrame rejects invalid data', () => {
    expect(isValidFrame(new ArrayBuffer(0))).toBe(false);
    expect(isValidFrame(new ArrayBuffer(4))).toBe(false);
    expect(isValidFrame(new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0]).buffer)).toBe(
      false
    );
  });

  test('decode rejects wrong magic', () => {
    const buf = new ArrayBuffer(8);
    const view = new DataView(buf);
    view.setUint32(0, 0xdeadbeef, false);
    view.setUint16(4, 0x0002, false);
    view.setUint16(6, 0, false);

    expect(() => decode(buf)).toThrow('Invalid magic');
  });

  test('decode rejects wrong version', () => {
    const buf = new ArrayBuffer(8);
    const view = new DataView(buf);
    view.setUint32(0, 0x494e4632, false); // "INF2"
    view.setUint16(4, 0x0099, false); // wrong version
    view.setUint16(6, 0, false);

    expect(() => decode(buf)).toThrow('Unsupported protocol version');
  });

  test('tensorByteSize calculates correctly', () => {
    const f32Desc: TensorDescriptor = {
      archType: ArchType.Transformer,
      tensorType: TensorType.HiddenStates,
      dataType: DataType.F32,
      dimensions: [4096],
    };
    expect(tensorByteSize(f32Desc)).toBe(4096 * 4);

    const f16Desc: TensorDescriptor = {
      archType: ArchType.Transformer,
      tensorType: TensorType.KV_K,
      dataType: DataType.F16,
      dimensions: [32, 128],
    };
    expect(tensorByteSize(f16Desc)).toBe(32 * 128 * 2);
  });

  test('toFloat32 rejects non-f32 tensors', () => {
    const tensor: Tensor = {
      descriptor: {
        archType: ArchType.Transformer,
        tensorType: TensorType.HiddenStates,
        dataType: DataType.F16,
        dimensions: [4],
      },
      data: new ArrayBuffer(8),
    };
    expect(() => toFloat32(tensor)).toThrow('Cannot convert');
  });

  test('large tensor roundtrip preserves precision', () => {
    const size = 4096;
    const data = new Float32Array(size);
    for (let i = 0; i < size; i++) {
      data[i] = Math.sin(i * 0.01) * 100;
    }

    const tensor = fromFloat32(
      data,
      ArchType.Transformer,
      TensorType.Embeddings,
      [size]
    );
    const decoded = decode(encode({ tensors: [tensor] }));
    const result = toFloat32(decoded.tensors[0]);

    expect(result.length).toBe(size);
    for (let i = 0; i < size; i++) {
      expect(result[i]).toBeCloseTo(data[i], 5);
    }
  });
});
