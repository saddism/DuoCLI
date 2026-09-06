/**
 * Small, dependency-free H.264 Annex-B normalizer used by the Android mirror.
 *
 * scrcpy emits codec-config and media access units as separate packets. A
 * browser decoder must never receive the codec-config packet as a video frame;
 * it is only parameter data. A random subscriber also needs a complete IDR
 * (SPS + PPS + IDR) before delta frames can be decoded. Keeping this logic in
 * one module makes the browser and WebRTC sinks consume the same contract.
 */

export interface H264ParameterSets {
  sps: Buffer | null;
  pps: Buffer | null;
}

export interface NormalizedH264Frame {
  payload: Buffer;
  keyFrame: boolean;
  config: boolean;
}

function startCodeLength(data: Uint8Array, offset: number): number {
  if (offset + 3 <= data.length && data[offset] === 0 && data[offset + 1] === 0 && data[offset + 2] === 1) return 3;
  if (offset + 4 <= data.length && data[offset] === 0 && data[offset + 1] === 0 && data[offset + 2] === 0 && data[offset + 3] === 1) return 4;
  return 0;
}

/** Return NAL payloads without start codes. Incomplete trailing NALs are kept. */
export function splitAnnexBNals(data: Uint8Array): Buffer[] {
  const result: Buffer[] = [];
  let cursor = 0;
  while (cursor < data.length) {
    let start = -1;
    let prefix = 0;
    for (let i = cursor; i < data.length - 2; i++) {
      const length = startCodeLength(data, i);
      if (length) { start = i; prefix = length; break; }
    }
    if (start < 0) {
      if (cursor < data.length) result.push(Buffer.from(data.subarray(cursor)));
      break;
    }
    const payloadStart = start + prefix;
    let next = data.length;
    for (let i = payloadStart; i < data.length - 2; i++) {
      if (startCodeLength(data, i)) { next = i; break; }
    }
    if (next > payloadStart) result.push(Buffer.from(data.subarray(payloadStart, next)));
    cursor = next;
  }
  return result.filter((nal) => nal.length > 0);
}

function withStartCode(nal: Uint8Array): Buffer {
  return Buffer.concat([Buffer.from([0, 0, 0, 1]), Buffer.from(nal)]);
}

export function parameterSetsFromAnnexB(data: Uint8Array): H264ParameterSets {
  let sps: Buffer | null = null;
  let pps: Buffer | null = null;
  for (const nal of splitAnnexBNals(data)) {
    const type = nal[0] & 0x1f;
    if (type === 7) sps = withStartCode(nal);
    else if (type === 8) pps = withStartCode(nal);
  }
  return { sps, pps };
}

export function annexBContainsType(data: Uint8Array, type: number): boolean {
  return splitAnnexBNals(data).some((nal) => (nal[0] & 0x1f) === type);
}

export function mergeParameterSets(current: H264ParameterSets, next: H264ParameterSets): H264ParameterSets {
  return { sps: next.sps || current.sps, pps: next.pps || current.pps };
}

export function parameterSetsEqual(a: H264ParameterSets, b: H264ParameterSets): boolean {
  const equal = (left: Buffer | null, right: Buffer | null) => left === right || (!!left && !!right && left.equals(right));
  return equal(a.sps, b.sps) && equal(a.pps, b.pps);
}

/**
 * Convert one scrcpy packet into a decoder-safe frame. Config packets update
 * the cache and return null to the media sinks. Key frames are made
 * independently decodable by prepending the latest SPS/PPS when necessary.
 */
export function normalizeH264Frame(
  payload: Uint8Array,
  flags: { config: boolean; keyFrame: boolean },
  sets: H264ParameterSets,
): NormalizedH264Frame | null {
  const own = parameterSetsFromAnnexB(payload);
  const hasIdr = annexBContainsType(payload, 5);
  const isConfig = flags.config || (!hasIdr && (!!own.sps || !!own.pps));
  if (isConfig && !hasIdr) return null;

  const prefix: Buffer[] = [];
  if ((flags.keyFrame || hasIdr) && !own.sps && sets.sps) prefix.push(sets.sps);
  if ((flags.keyFrame || hasIdr) && !own.pps && sets.pps) prefix.push(sets.pps);
  const normalized = prefix.length ? Buffer.concat([...prefix, Buffer.from(payload)]) : Buffer.from(payload);
  return { payload: normalized, keyFrame: flags.keyFrame || hasIdr, config: false };
}

export function h264CodecFromAnnexB(data: Uint8Array): string {
  for (const nal of splitAnnexBNals(data)) {
    if ((nal[0] & 0x1f) !== 7 || nal.length < 4) continue;
    const hex = (value: number) => value.toString(16).padStart(2, '0').toUpperCase();
    return `avc1.${hex(nal[1])}${hex(nal[2])}${hex(nal[3])}`;
  }
  return 'avc1.42E01E';
}
