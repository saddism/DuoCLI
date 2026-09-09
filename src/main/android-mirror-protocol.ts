/**
 * Versioned Android media envelope shared by the JPEG fallback and future
 * media transports.  The legacy DVM1 envelope remains available for old
 * clients; new consumers can validate DVM2 without guessing packet layout.
 */

export const DVM2_MAGIC = Buffer.from('DVM2');
export const DVM2_VERSION = 2;
export const DVM2_HEADER_SIZE = 56;
export const DVM2_KIND_H264 = 1;
export const DVM2_KIND_JPEG = 2;
export const DVM2_FLAG_IDR = 1;
export const DVM2_FLAG_DISCONTINUITY = 2;
export const DVM2_MAX_H264_BYTES = 16 * 1024 * 1024;
export const DVM2_MAX_JPEG_BYTES = 4 * 1024 * 1024;

export interface Dvm2Frame {
  kind: number;
  flags?: number;
  captureGeneration?: number;
  geometryVersion?: number;
  configVersion?: number;
  frameId?: number;
  ptsUs?: bigint | number;
  hostFrameReceivedUs?: bigint | number;
  width: number;
  height: number;
  mediaEpoch?: number;
  payload: Buffer;
}

function uint32(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? (Math.trunc(n) >>> 0) : 0;
}

function uint16(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.min(0xffff, Math.trunc(n))) : 0;
}

function uint64(value: bigint | number | undefined): bigint {
  const max = (1n << 64n) - 1n;
  if (typeof value === 'bigint') return value < 0n ? 0n : value > max ? max : value;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0n;
  return BigInt(Math.min(Number.MAX_SAFE_INTEGER, Math.trunc(n)));
}

/** Encode exactly one complete DVM2 media frame. */
export function encodeDvm2Frame(frame: Dvm2Frame): Buffer {
  const payload = Buffer.isBuffer(frame.payload) ? frame.payload : Buffer.from(frame.payload || []);
  const kind = uint16(frame.kind);
  const flags = uint16(frame.flags);
  const max = kind === DVM2_KIND_JPEG ? DVM2_MAX_JPEG_BYTES : DVM2_MAX_H264_BYTES;
  if (![DVM2_KIND_H264, DVM2_KIND_JPEG].includes(kind)) throw new Error(`未知 DVM2 媒体类型: ${kind}`);
  if (flags & ~(DVM2_FLAG_IDR | DVM2_FLAG_DISCONTINUITY)) throw new Error('DVM2 flags 无效');
  if (kind === DVM2_KIND_JPEG && (flags & DVM2_FLAG_IDR)) throw new Error('JPEG 不支持 IDR 标志');
  if (!uint16(frame.width) || !uint16(frame.height)) throw new Error('DVM2 画面尺寸无效');
  if (!payload.length || payload.length > max) throw new Error(`DVM2 媒体帧过大: ${payload.length}`);
  const output = Buffer.alloc(DVM2_HEADER_SIZE + payload.length);
  DVM2_MAGIC.copy(output, 0);
  output[4] = DVM2_VERSION;
  output[5] = kind;
  output.writeUInt16BE(flags, 6);
  output.writeUInt32BE(uint32(frame.captureGeneration), 8);
  output.writeUInt32BE(uint32(frame.geometryVersion), 12);
  output.writeUInt32BE(uint32(frame.configVersion), 16);
  output.writeUInt32BE(uint32(frame.frameId), 20);
  output.writeBigUInt64BE(uint64(frame.ptsUs), 24);
  output.writeBigUInt64BE(uint64(frame.hostFrameReceivedUs), 32);
  output.writeUInt16BE(uint16(frame.width), 40);
  output.writeUInt16BE(uint16(frame.height), 42);
  output.writeUInt32BE(payload.length, 44);
  output.writeUInt32BE(uint32(frame.mediaEpoch), 48);
  output.writeUInt32BE(0, 52);
  payload.copy(output, DVM2_HEADER_SIZE);
  return output;
}

export interface ParsedDvm2Frame {
  version: number;
  kind: number;
  flags: number;
  captureGeneration: number;
  geometryVersion: number;
  configVersion: number;
  frameId: number;
  ptsUs: bigint;
  hostFrameReceivedUs: bigint;
  width: number;
  height: number;
  payload: Buffer;
  mediaEpoch: number;
}

/** Strict parser used by protocol tests and Node-side integrations. */
export function decodeDvm2Frame(packet: Buffer): ParsedDvm2Frame {
  if (!Buffer.isBuffer(packet) || packet.length < DVM2_HEADER_SIZE) throw new Error('DVM2 帧头不完整');
  if (!packet.subarray(0, 4).equals(DVM2_MAGIC) || packet[4] !== DVM2_VERSION) throw new Error('DVM2 版本不支持');
  const kind = packet[5];
  if (kind !== DVM2_KIND_H264 && kind !== DVM2_KIND_JPEG) throw new Error('DVM2 媒体类型无效');
  const flags = packet.readUInt16BE(6);
  if (flags & ~(DVM2_FLAG_IDR | DVM2_FLAG_DISCONTINUITY)) throw new Error('DVM2 flags 无效');
  if (kind === DVM2_KIND_JPEG && (flags & DVM2_FLAG_IDR)) throw new Error('JPEG 不支持 IDR 标志');
  const payloadLength = packet.readUInt32BE(44);
  const max = kind === DVM2_KIND_JPEG ? DVM2_MAX_JPEG_BYTES : DVM2_MAX_H264_BYTES;
  if (!payloadLength || payloadLength > max || packet.length !== DVM2_HEADER_SIZE + payloadLength) {
    throw new Error('DVM2 帧长度无效');
  }
  if (packet.readUInt32BE(52) !== 0) throw new Error('DVM2 保留字段非零');
  const width = packet.readUInt16BE(40);
  const height = packet.readUInt16BE(42);
  if (!width || !height) throw new Error('DVM2 画面尺寸无效');
  return {
    version: packet[4],
    kind,
    flags,
    captureGeneration: packet.readUInt32BE(8),
    geometryVersion: packet.readUInt32BE(12),
    configVersion: packet.readUInt32BE(16),
    frameId: packet.readUInt32BE(20),
    ptsUs: packet.readBigUInt64BE(24),
    hostFrameReceivedUs: packet.readBigUInt64BE(32),
    width,
    height,
    payload: packet.subarray(DVM2_HEADER_SIZE),
    mediaEpoch: packet.readUInt32BE(48),
  };
}

/**
 * Copy the encoded frame size onto the WebSocket envelope without minting a
 * new geometryVersion. control.input is checked against the scrcpy session
 * version; bumping here on the first packet that reveals width/height makes
 * desktop WebCodecs clients send GEOMETRY_STALE forever.
 */
export function syncMediaEnvelopeSize(
  envelope: { width: number; height: number; geometryVersion: number },
  frameWidth: number,
  frameHeight: number,
): void {
  envelope.width = frameWidth;
  envelope.height = frameHeight;
}
