/**
 * Binary Protocol v2 — application/x-infer2
 *
 * High-performance tensor wire format for mesh inference.
 * Avoids JSON/base64 overhead for inter-node tensor transfer.
 *
 * Wire format:
 *   [4 bytes] Magic: 0x494E4632 ("INF2")
 *   [2 bytes] Version: 0x0002
 *   [2 bytes] Tensor count
 *   [N x TensorDescriptor] followed by [N x tensor data]
 *
 * TensorDescriptor (32 bytes, 16-byte aligned):
 *   [1 byte]  Architecture type (transformer, ssm, rwkv, diffusion)
 *   [1 byte]  Tensor type (hidden_states, kv_k, kv_v, ssm_state, etc.)
 *   [1 byte]  Data type (f32, f16, bf16, q8, q4)
 *   [1 byte]  Reserved
 *   [4 bytes] Dimension count (1-4)
 *   [4x4 bytes] Dimensions (padded to 4)
 *   [4 bytes] Data offset (from start of data section)
 *   [4 bytes] Data length in bytes
 *
 * Reference: docs/ebooks/25-the-ai-gateway-metametacognition-and-unified-inference-protocols/
 */

// --- Constants ---

const MAGIC = 0x494e4632; // "INF2"
const VERSION = 0x0002;
const DESCRIPTOR_SIZE = 32;
const HEADER_SIZE = 8; // magic(4) + version(2) + count(2)

// --- Tagged numeric constants ---

export const ArchType = {
  Transformer: 0,
  SSM: 1, // Mamba, state-space
  RWKV: 2,
  Diffusion: 3,
  Hybrid: 4, // Jamba
} as const;

export type ArchType = (typeof ArchType)[keyof typeof ArchType];

export const TensorType = {
  HiddenStates: 0,
  KV_K: 1, // Transformer key cache
  KV_V: 2, // Transformer value cache
  SSM_State: 3, // Mamba recurrent state
  ConvState: 4, // Mamba conv buffer
  RWKV_R: 5,
  RWKV_K: 6,
  RWKV_V: 7,
  RWKV_W: 8,
  Latent: 9, // Diffusion latent
  Embeddings: 10,
  Logits: 11,
  Attention: 12,
} as const;

export type TensorType = (typeof TensorType)[keyof typeof TensorType];

export const DataType = {
  F32: 0,
  F16: 1,
  BF16: 2,
  Q8_0: 3,
  Q4_0: 4,
  Q4_K: 5,
  Q6_K: 6,
  I32: 7,
} as const;

export type DataType = (typeof DataType)[keyof typeof DataType];

const DATA_TYPE_BYTES: Record<DataType, number> = {
  [DataType.F32]: 4,
  [DataType.F16]: 2,
  [DataType.BF16]: 2,
  [DataType.Q8_0]: 1,
  [DataType.Q4_0]: 0.5,
  [DataType.Q4_K]: 0.5625,
  [DataType.Q6_K]: 0.6875,
  [DataType.I32]: 4,
};

const DATA_TYPE_NAMES: Record<DataType, string> = {
  [DataType.F32]: 'F32',
  [DataType.F16]: 'F16',
  [DataType.BF16]: 'BF16',
  [DataType.Q8_0]: 'Q8_0',
  [DataType.Q4_0]: 'Q4_0',
  [DataType.Q4_K]: 'Q4_K',
  [DataType.Q6_K]: 'Q6_K',
  [DataType.I32]: 'I32',
};

// --- Types ---

export interface TensorDescriptor {
  archType: ArchType;
  tensorType: TensorType;
  dataType: DataType;
  dimensions: number[];
}

export interface Tensor {
  descriptor: TensorDescriptor;
  data: ArrayBuffer;
}

export interface InferenceFrame {
  tensors: Tensor[];
}

// --- Encoding ---

/**
 * Encode an inference frame into binary protocol v2 format
 */
export function encode(frame: InferenceFrame): ArrayBuffer {
  const tensorCount = frame.tensors.length;

  // Calculate total data size
  let totalDataSize = 0;
  for (const tensor of frame.tensors) {
    totalDataSize += alignTo16(tensor.data.byteLength);
  }

  const totalSize = HEADER_SIZE + tensorCount * DESCRIPTOR_SIZE + totalDataSize;
  const buffer = new ArrayBuffer(totalSize);
  const view = new DataView(buffer);
  let offset = 0;

  // Header
  view.setUint32(offset, MAGIC, false); // big-endian magic
  offset += 4;
  view.setUint16(offset, VERSION, false);
  offset += 2;
  view.setUint16(offset, tensorCount, false);
  offset += 2;

  // Descriptors
  let dataOffset = 0;
  for (const tensor of frame.tensors) {
    const desc = tensor.descriptor;
    const dims = padDimensions(desc.dimensions);
    const dataLen = tensor.data.byteLength;

    view.setUint8(offset, desc.archType);
    view.setUint8(offset + 1, desc.tensorType);
    view.setUint8(offset + 2, desc.dataType);
    view.setUint8(offset + 3, 0); // reserved

    view.setUint32(offset + 4, desc.dimensions.length, false);
    for (let i = 0; i < 4; i++) {
      view.setUint32(offset + 8 + i * 4, dims[i], false);
    }

    view.setUint32(offset + 24, dataOffset, false);
    view.setUint32(offset + 28, dataLen, false);

    offset += DESCRIPTOR_SIZE;
    dataOffset += alignTo16(dataLen);
  }

  // Tensor data (16-byte aligned)
  const dataStart = HEADER_SIZE + tensorCount * DESCRIPTOR_SIZE;
  let dataWriteOffset = dataStart;
  for (const tensor of frame.tensors) {
    const src = new Uint8Array(tensor.data);
    const dst = new Uint8Array(buffer, dataWriteOffset, src.length);
    dst.set(src);
    dataWriteOffset += alignTo16(tensor.data.byteLength);
  }

  return buffer;
}

/**
 * Decode a binary protocol v2 frame
 */
export function decode(buffer: ArrayBuffer): InferenceFrame {
  const view = new DataView(buffer);
  let offset = 0;

  // Validate header
  const magic = view.getUint32(offset, false);
  if (magic !== MAGIC) {
    throw new Error(
      `Invalid magic: expected 0x${MAGIC.toString(16)}, got 0x${magic.toString(
        16
      )}`
    );
  }
  offset += 4;

  const version = view.getUint16(offset, false);
  if (version !== VERSION) {
    throw new Error(`Unsupported protocol version: ${version}`);
  }
  offset += 2;

  const tensorCount = view.getUint16(offset, false);
  offset += 2;

  // Read descriptors
  const descriptors: Array<
    TensorDescriptor & { _dataOffset: number; _dataLen: number }
  > = [];
  for (let i = 0; i < tensorCount; i++) {
    const archType = view.getUint8(offset) as ArchType;
    const tensorType = view.getUint8(offset + 1) as TensorType;
    const dataType = view.getUint8(offset + 2) as DataType;
    // offset+3 is reserved

    const dimCount = view.getUint32(offset + 4, false);
    const dimensions: number[] = [];
    for (let d = 0; d < dimCount; d++) {
      dimensions.push(view.getUint32(offset + 8 + d * 4, false));
    }

    const _dataOffset = view.getUint32(offset + 24, false);
    const _dataLen = view.getUint32(offset + 28, false);

    descriptors.push({
      archType,
      tensorType,
      dataType,
      dimensions,
      _dataOffset,
      _dataLen,
    });

    offset += DESCRIPTOR_SIZE;
  }

  // Read tensor data
  const dataStart = HEADER_SIZE + tensorCount * DESCRIPTOR_SIZE;
  const tensors: Tensor[] = descriptors.map((desc) => ({
    descriptor: {
      archType: desc.archType,
      tensorType: desc.tensorType,
      dataType: desc.dataType,
      dimensions: desc.dimensions,
    },
    data: buffer.slice(
      dataStart + desc._dataOffset,
      dataStart + desc._dataOffset + desc._dataLen
    ),
  }));

  return { tensors };
}

// --- Utilities ---

/**
 * Create a tensor from a Float32Array
 */
export function fromFloat32(
  data: Float32Array,
  archType: ArchType,
  tensorType: TensorType,
  dimensions: number[]
): Tensor {
  return {
    descriptor: {
      archType,
      tensorType,
      dataType: DataType.F32,
      dimensions,
    },
    data: (data.buffer as ArrayBuffer).slice(
      data.byteOffset,
      data.byteOffset + data.byteLength
    ),
  };
}

/**
 * Extract Float32Array from a tensor
 */
export function toFloat32(tensor: Tensor): Float32Array {
  if (tensor.descriptor.dataType !== DataType.F32) {
    throw new Error(
      `Cannot convert ${DATA_TYPE_NAMES[tensor.descriptor.dataType]} to Float32 directly`
    );
  }
  return new Float32Array(tensor.data);
}

/**
 * Calculate the byte size of a tensor given its descriptor
 */
export function tensorByteSize(desc: TensorDescriptor): number {
  const elements = desc.dimensions.reduce((a, b) => a * b, 1);
  return Math.ceil(elements * DATA_TYPE_BYTES[desc.dataType]);
}

/**
 * Check if a buffer looks like a valid binary protocol v2 frame
 */
export function isValidFrame(buffer: ArrayBuffer): boolean {
  if (buffer.byteLength < HEADER_SIZE) return false;
  const view = new DataView(buffer);
  return (
    view.getUint32(0, false) === MAGIC && view.getUint16(4, false) === VERSION
  );
}

/**
 * Content type for binary protocol v2
 */
export const CONTENT_TYPE = 'application/x-infer2';

// --- Internal ---

function alignTo16(n: number): number {
  return (n + 15) & ~15;
}

function padDimensions(dims: number[]): number[] {
  const padded = [0, 0, 0, 0];
  for (let i = 0; i < Math.min(4, dims.length); i++) {
    padded[i] = dims[i];
  }
  return padded;
}
