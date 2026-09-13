import fs from 'fs';
import path from 'path';
import os from 'os';
import net from 'net';
import { execFileSync } from 'child_process';
import type { ChildProcess } from 'child_process';
import { runAdb, spawnAdb } from './android-devices';
import {
  H264ParameterSets,
  mergeParameterSets,
  normalizeH264Frame,
  parameterSetsEqual,
  parameterSetsFromAnnexB,
} from './android-h264';

const REMOTE_SERVER_PATH = '/data/local/tmp/duocli-scrcpy-server.jar';
const VIDEO_MAGIC = Buffer.from('DVM1');
const VIDEO_HEADER_SIZE = 24;
const MAX_VIDEO_PACKET_BYTES = 16 * 1024 * 1024;
const MAX_VIDEO_BUFFER_BYTES = MAX_VIDEO_PACKET_BYTES + 1024 * 1024;
const CONTROL_TEXT_MAX_BYTES = 300;
// Phone/iPad preview does not need a desktop-sized encode. 800px long-edge at
// 20fps / 1.5Mbps is sharp enough on Retina and much lighter on Wi-Fi / tunnels.
const DEFAULT_MAX_SIZE = 800;
const DEFAULT_MAX_FPS = 30;
const DEFAULT_VIDEO_BIT_RATE = '1500000';
const MIRROR_IDLE_TIMEOUT_MS = 30_000;
const CONTROL_LEASE_MS = 6_000;
// 交互式抢占等待窗口：owner 活跃指针在手时，挑战方需等它响应或超时。
const CONTROL_CHALLENGE_MS = 1500;
const CONTROL_QUEUE_LIMIT = 128;
const CONTROL_WRITE_TIMEOUT_MS = 2000;
const CONTROL_RESULT_CACHE_SIZE = 256;

function controlError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

export type AndroidMirrorStatus = 'starting' | 'ready' | 'error' | 'stopped';

export interface AndroidMirrorClient {
  id: string;
  sendJson(message: Record<string, unknown>): void;
  sendBinary(data: Buffer): void;
  close?: () => void;
}

export interface AndroidMirrorInput {
  action?: 'down' | 'up' | 'move' | 'cancel';
  x?: number;
  y?: number;
  pointerId?: number;
  pressure?: number;
  keyCode?: number;
  keyAction?: 'down' | 'up';
  repeat?: number;
  metastate?: number;
  text?: string;
  hscroll?: number;
  vscroll?: number;
  type?: 'touch' | 'text' | 'key' | 'back' | 'scroll' | 'tap';
}

/** Validate untrusted browser input before it enters the serial control queue. */
export function validateAndroidMirrorInput(input: unknown): input is AndroidMirrorInput {
  if (!input || typeof input !== 'object') return false;
  const value = input as AndroidMirrorInput;
  const type = value.type || (value.text !== undefined ? 'text' : 'touch');
  if (!['touch', 'text', 'key', 'back', 'scroll', 'tap'].includes(type)) return false;
  if (type === 'text') return typeof value.text === 'string' && Buffer.byteLength(value.text, 'utf8') <= 16 * 1024;
  if (type === 'touch' || type === 'tap' || type === 'scroll') {
    if (value.action !== undefined && !['down', 'up', 'move', 'cancel'].includes(value.action)) return false;
    if (value.x === undefined || value.y === undefined || !Number.isFinite(Number(value.x)) || !Number.isFinite(Number(value.y))) return false;
    // Some browsers (WebKit mouse, pending touches) report pointerId -1 or a
    // float. scrcpy already encodes signed IDs as unsigned 64-bit values.
    if (value.pointerId !== undefined) {
      const pointerId = Math.trunc(Number(value.pointerId));
      if (!Number.isFinite(Number(value.pointerId)) || !Number.isSafeInteger(pointerId)) return false;
    }
    if (value.pressure !== undefined && !Number.isFinite(Number(value.pressure))) return false;
    if (type === 'scroll' && (value.hscroll !== undefined && !Number.isFinite(Number(value.hscroll)) || value.vscroll !== undefined && !Number.isFinite(Number(value.vscroll)))) return false;
  }
  if (type === 'key') {
    if (value.keyCode !== undefined && (!Number.isSafeInteger(Number(value.keyCode)) || Number(value.keyCode) < 0 || Number(value.keyCode) > 0xffffffff)) return false;
    if (value.keyAction !== undefined && !['down', 'up'].includes(value.keyAction)) return false;
    if (value.repeat !== undefined && (!Number.isSafeInteger(Number(value.repeat)) || Number(value.repeat) < 0)) return false;
    if (value.metastate !== undefined && (!Number.isSafeInteger(Number(value.metastate)) || Number(value.metastate) < 0)) return false;
  }
  if (type === 'back' && value.keyAction !== undefined && !['down', 'up'].includes(value.keyAction)) return false;
  return true;
}

interface ScrcpyRuntime {
  serverPath: string;
  version: string;
}

interface VideoFrame {
  payload: Buffer<ArrayBufferLike>;
  pts: bigint;
  keyFrame: boolean;
  config: boolean;
  width: number;
  height: number;
}

function writeBigUInt64BE(buffer: Buffer, value: bigint, offset: number): void {
  buffer.writeBigUInt64BE(value >= 0n ? value : (1n << 64n) + value, offset);
}

function pointerIdToUnsigned(value: number | undefined): bigint {
  const id = Number.isFinite(value) ? BigInt(Math.trunc(value as number)) : -2n;
  return id >= 0n ? id : (1n << 64n) + id;
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.round(number)));
}

function clampFloat(value: unknown, min: number, max: number, fallback: number): number {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, number));
}

function mirrorErrorDetails(error: Error, status: AndroidMirrorStatus): { code: string; stage: 'capture' | 'transport' | 'decode'; retryable: boolean } {
  const message = error.message.toLowerCase();
  if (message.includes('scrcpy') || message.includes('server')) return { code: 'SCRCPY_START_FAILED', stage: 'capture', retryable: true };
  if (message.includes('device') || message.includes('adb') || message.includes('授权') || message.includes('offline')) return { code: 'DEVICE_OFFLINE', stage: 'capture', retryable: true };
  if (status === 'starting') return { code: 'SCRCPY_START_FAILED', stage: 'capture', retryable: true };
  return { code: 'MEDIA_SOCKET_ERROR', stage: 'transport', retryable: true };
}

function writePosition(buffer: Buffer, offset: number, x: number, y: number, width: number, height: number): void {
  buffer.writeInt32BE(clampInt(x, -0x80000000, 0x7fffffff, 0), offset);
  buffer.writeInt32BE(clampInt(y, -0x80000000, 0x7fffffff, 0), offset + 4);
  buffer.writeUInt16BE(clampInt(width, 1, 0xffff, 1), offset + 8);
  buffer.writeUInt16BE(clampInt(height, 1, 0xffff, 1), offset + 10);
}

/** Serialize the scrcpy control protocol used by the pinned server runtime. */
export function serializeTouchControl(input: AndroidMirrorInput, width: number, height: number): Buffer {
  const actionMap: Record<string, number> = { down: 0, up: 1, move: 2, cancel: 3 };
  const action = actionMap[input.action || 'move'] ?? 2;
  const buffer = Buffer.alloc(32);
  buffer[0] = 2; // SC_CONTROL_MSG_TYPE_INJECT_TOUCH_EVENT
  buffer[1] = action;
  writeBigUInt64BE(buffer, pointerIdToUnsigned(input.pointerId), 2);
  writePosition(buffer, 10, Number(input.x), Number(input.y), width, height);
  const pressure = Math.round(clampFloat(input.pressure, 0, 1, action === 1 || action === 3 ? 0 : 1) * 0xffff);
  buffer.writeUInt16BE(pressure, 22);
  buffer.writeUInt32BE(action === 0 ? 1 : 0, 24); // primary action button on DOWN
  buffer.writeUInt32BE(action === 1 || action === 3 ? 0 : 1, 28); // primary button held during MOVE
  return buffer;
}

function splitUtf8(text: string, maxBytes: number): string[] {
  const result: string[] = [];
  let current = '';
  let currentBytes = 0;
  for (const character of text) {
    const bytes = Buffer.byteLength(character, 'utf8');
    if (current && currentBytes + bytes > maxBytes) {
      result.push(current);
      current = '';
      currentBytes = 0;
    }
    current += character;
    currentBytes += bytes;
  }
  if (current) result.push(current);
  return result;
}

export function serializeTextControls(text: string): Buffer[] {
  return splitUtf8(String(text), CONTROL_TEXT_MAX_BYTES).map((part) => {
    const payload = Buffer.from(part, 'utf8');
    const buffer = Buffer.alloc(5 + payload.length);
    buffer[0] = 1; // SC_CONTROL_MSG_TYPE_INJECT_TEXT
    buffer.writeUInt32BE(payload.length, 1);
    payload.copy(buffer, 5);
    return buffer;
  });
}

export function serializeKeyControl(input: AndroidMirrorInput): Buffer {
  const buffer = Buffer.alloc(14);
  buffer[0] = 0; // SC_CONTROL_MSG_TYPE_INJECT_KEYCODE
  buffer[1] = input.keyAction === 'up' ? 1 : 0;
  buffer.writeUInt32BE(clampInt(input.keyCode, 0, 0xffffffff, 66), 2);
  buffer.writeUInt32BE(clampInt(input.repeat, 0, 0xffffffff, 0), 6);
  buffer.writeUInt32BE(clampInt(input.metastate, 0, 0xffffffff, 0), 10);
  return buffer;
}

export function serializeBackControl(action: 'down' | 'up' = 'down'): Buffer {
  return Buffer.from([4, action === 'up' ? 1 : 0]);
}

export function serializeScrollControl(input: AndroidMirrorInput, width: number, height: number): Buffer {
  const buffer = Buffer.alloc(21);
  buffer[0] = 3; // SC_CONTROL_MSG_TYPE_INJECT_SCROLL_EVENT
  writePosition(buffer, 1, Number(input.x), Number(input.y), width, height);
  const horizontal = Math.round(clampFloat(input.hscroll, -16, 16, 0) / 16 * 0x7fff);
  const vertical = Math.round(clampFloat(input.vscroll, -16, 16, 0) / 16 * 0x7fff);
  buffer.writeInt16BE(horizontal, 13);
  buffer.writeInt16BE(vertical, 15);
  buffer.writeUInt32BE(0, 17);
  return buffer;
}

export interface MirrorReplayCache {
  config: Buffer | null;
  key: Buffer | null;
}

export function emptyReplayCache(): MirrorReplayCache {
  return { config: null, key: null };
}

/** Keep the latest SPS/PPS and IDR so a late subscriber can paint immediately. */
export function rememberReplayFrame(
  cache: MirrorReplayCache,
  packet: Buffer,
  frame: Pick<VideoFrame, 'config' | 'keyFrame'>,
): MirrorReplayCache {
  const copy = Buffer.from(packet);
  if (frame.config && frame.keyFrame) return { config: copy, key: copy };
  if (frame.config) return { config: copy, key: cache.key };
  if (frame.keyFrame) return { config: cache.config, key: copy };
  return cache;
}

export function packetsForNewSubscriber(cache: MirrorReplayCache): Buffer[] {
  const packets: Buffer[] = [];
  if (cache.config) packets.push(cache.config);
  if (cache.key && cache.key !== cache.config) packets.push(cache.key);
  return packets;
}

/** Convert a scrcpy media packet into a DuoCLI browser frame envelope. */
export function encodeVideoFrame(frame: VideoFrame): Buffer {
  if (!frame.payload.length || frame.payload.length > MAX_VIDEO_PACKET_BYTES) {
    throw new Error(`Android 视频帧过大: ${frame.payload.length}`);
  }
  const output = Buffer.alloc(VIDEO_HEADER_SIZE + frame.payload.length);
  VIDEO_MAGIC.copy(output, 0);
  output[4] = 1;
  output[5] = (frame.keyFrame ? 1 : 0) | (frame.config ? 2 : 0);
  output.writeUInt16BE(clampInt(frame.width, 1, 0xffff, 1), 6);
  output.writeUInt16BE(clampInt(frame.height, 1, 0xffff, 1), 8);
  writeBigUInt64BE(output, frame.pts, 10);
  output.writeUInt32BE(frame.payload.length, 18);
  output.writeUInt16BE(0, 22);
  frame.payload.copy(output, VIDEO_HEADER_SIZE);
  return output;
}

type VideoParserCallbacks = {
  onCodec: (codec: string) => void;
  onSession: (width: number, height: number) => void;
  onFrame: (frame: VideoFrame) => void;
  onError: (error: Error) => void;
};

export class ScrcpyVideoParser {
  private buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  private codec: string | null = null;
  private width = 0;
  private height = 0;

  constructor(private readonly callbacks: VideoParserCallbacks) {}

  reset(): void {
    this.buffer = Buffer.alloc(0);
    this.codec = null;
    this.width = 0;
    this.height = 0;
  }

  push(chunk: Buffer): void {
    if (!chunk.length) return;
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    if (this.buffer.length > MAX_VIDEO_BUFFER_BYTES) {
      this.callbacks.onError(new Error('Android 视频缓冲区过大'));
      this.buffer = Buffer.alloc(0);
      return;
    }
    try {
      this.parse();
    } catch (error) {
      this.callbacks.onError(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private parse(): void {
    if (!this.codec) {
      if (this.buffer.length < 4) return;
      const codec = this.buffer.subarray(0, 4).toString('ascii').replace(/\0/g, '');
      if (!['h264', 'h265', 'av1', 'vp8', 'vp9'].includes(codec)) {
        throw new Error(`不支持的 Android 视频编码: ${codec || 'unknown'}`);
      }
      this.codec = codec;
      this.buffer = this.buffer.subarray(4);
      this.callbacks.onCodec(codec);
    }

    while (this.buffer.length >= 12) {
      const header = this.buffer.readBigUInt64BE(0);
      if ((header & (1n << 63n)) !== 0n) {
        this.width = this.buffer.readUInt32BE(4);
        this.height = this.buffer.readUInt32BE(8);
        this.buffer = this.buffer.subarray(12);
        this.callbacks.onSession(this.width, this.height);
        continue;
      }

      const packetSize = this.buffer.readUInt32BE(8);
      if (packetSize > MAX_VIDEO_PACKET_BYTES) {
        throw new Error(`Android 视频帧过大: ${packetSize}`);
      }
      if (this.buffer.length < 12 + packetSize) return;
      const frame: VideoFrame = {
        payload: this.buffer.subarray(12, 12 + packetSize),
        pts: header & ((1n << 61n) - 1n),
        config: (header & (1n << 62n)) !== 0n,
        keyFrame: (header & (1n << 61n)) !== 0n,
        width: this.width,
        height: this.height,
      };
      this.buffer = this.buffer.subarray(12 + packetSize);
      if (!frame.width || !frame.height) continue;
      this.callbacks.onFrame(frame);
    }
  }
}

function fileIsExecutable(filePath: string): boolean {
  try {
    fs.accessSync(filePath, fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

function findScrcpyBinary(): string | null {
  const bin = process.platform === 'win32' ? 'scrcpy.exe' : 'scrcpy';
  const candidates = [
    ...(process.env.PATH || '').split(path.delimiter).filter(Boolean).map((dir) => path.join(dir, bin)),
    '/opt/homebrew/bin/scrcpy',
    '/usr/local/bin/scrcpy',
    '/usr/bin/scrcpy',
    path.join(os.homedir(), 'scoop', 'shims', bin),
  ];
  return candidates.find(fileIsExecutable) || null;
}

function resolveScrcpyRuntime(): ScrcpyRuntime {
  const explicitServer = process.env.DUOCLI_SCRCPY_SERVER?.trim();
  const binary = findScrcpyBinary();
  let version = process.env.DUOCLI_SCRCPY_VERSION?.trim() || '';
  const resources = typeof process.resourcesPath === 'string' ? process.resourcesPath : '';
  const bundledServer = resources ? path.join(resources, 'scrcpy', 'scrcpy-server') : '';
  const binaryRealPath = binary ? (() => {
    try { return fs.realpathSync(binary); } catch { return binary; }
  })() : '';
  const binaryDir = binaryRealPath ? path.dirname(binaryRealPath) : '';
  const candidates = [
    explicitServer,
    bundledServer,
    resources && path.join(resources, 'scrcpy-server'),
    path.join(process.cwd(), 'vendor', 'scrcpy-server'),
    binaryDir && path.join(binaryDir, '..', 'share', 'scrcpy', 'scrcpy-server'),
    '/opt/homebrew/share/scrcpy/scrcpy-server',
    '/usr/local/share/scrcpy/scrcpy-server',
    '/usr/share/scrcpy/scrcpy-server',
  ].filter((candidate): candidate is string => Boolean(candidate));
  const serverPath = candidates.find(fileIsExecutable);
  if (!serverPath) {
    throw new Error('未找到 scrcpy-server.jar。请安装 scrcpy，或设置 DUOCLI_SCRCPY_SERVER 指向匹配版本的服务器文件');
  }

  // A packaged app must use the version that was copied alongside its server
  // jar. Do not let a different scrcpy binary on PATH silently mismatch it.
  if (!version && bundledServer && path.resolve(serverPath) === path.resolve(bundledServer)) {
    try {
      version = fs.readFileSync(path.join(resources, 'scrcpy', 'scrcpy-version.txt'), 'utf8').trim();
    } catch { /* use the binary/fallback below */ }
  }
  if (!version && binary) {
    try {
      const output = execFileSync(binary, ['--version'], { encoding: 'utf8', timeout: 3000 });
      version = output.match(/scrcpy\s+([0-9]+(?:\.[0-9]+){1,2})/i)?.[1] || '';
    } catch { /* use the configured fallback below */ }
  }
  return { serverPath, version: version || '4.1' };
}

function connectTcp(port: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    socket.setNoDelay(true);
    const onError = (error: Error) => {
      socket.removeListener('connect', onConnect);
      socket.destroy();
      reject(error);
    };
    const onConnect = () => {
      socket.removeListener('error', onError);
      resolve(socket);
    };
    socket.once('error', onError);
    socket.once('connect', onConnect);
  });
}

function waitForSocketData(socket: net.Socket, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      socket.removeListener('data', onData);
      socket.removeListener('error', onError);
      socket.removeListener('close', onClose);
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('Android 视频通道握手超时'));
    }, timeoutMs);
    const onData = () => {
      cleanup();
      resolve();
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onClose = () => {
      cleanup();
      reject(new Error('Android 视频通道已关闭'));
    };
    socket.once('data', onData);
    socket.once('error', onError);
    socket.once('close', onClose);
  });
}

function parseForwardPort(output: Buffer): number {
  const port = Number(output.toString('utf8').trim().split(/\s+/).pop());
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error('ADB forward 未返回有效端口');
  return port;
}

class BootstrapCancelledError extends Error {
  constructor() {
    super('Android 镜像启动已取消');
    this.name = 'BootstrapCancelledError';
  }
}

export class AndroidMirrorSession {
  private readonly clients = new Map<string, AndroidMirrorClient>();
  private process: ChildProcess | null = null;
  private videoSocket: net.Socket | null = null;
  private controlSocket: net.Socket | null = null;
  private forwardPort: number | null = null;
  private startPromise: Promise<void> | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private retryAttempt = 0;
  private lifecycleGeneration = 0;
  private controlQueue: Promise<void> = Promise.resolve();
  private ownerId: string | null = null;
  private controlEpoch = 1;
  private leaseTimer: NodeJS.Timeout | null = null;
  private leaseExpiresAt = 0;
  private controlQueueDepth = 0;
  private challengeTimer: NodeJS.Timeout | null = null;
  private pendingClaim: { owner: string; challenger: string } | null = null;
  private readonly activePointers = new Set<number>();
  private readonly commandResults = new Map<string, { epoch: number; highest: number; entries: Map<number, Promise<void>> }>();
  private status: AndroidMirrorStatus = 'stopped';
  private codec = '';
  private width = 0;
  private height = 0;
  private lastError = '';
  private replayCache: MirrorReplayCache = emptyReplayCache();
  private h264Sets: H264ParameterSets = { sps: null, pps: null };
  private captureGeneration = 0;
  private geometryVersion = 0;
  private configVersion = 0;
  private readonly parser = new ScrcpyVideoParser({
    onCodec: (codec) => {
      this.codec = codec;
      this.broadcastJson({ type: 'android:meta', deviceId: this.deviceId, codec, width: this.width, height: this.height, configVersion: this.configVersion });
    },
    onSession: (width, height) => {
      this.width = width;
      this.height = height;
      this.captureGeneration = (this.captureGeneration + 1) >>> 0;
      this.geometryVersion = (this.geometryVersion + 1) >>> 0;
      this.h264Sets = { sps: null, pps: null };
      this.configVersion = 0;
      this.replayCache = emptyReplayCache();
      this.broadcastJson({
        type: 'android:meta', deviceId: this.deviceId, codec: this.codec, width, height,
        captureGeneration: this.captureGeneration, geometryVersion: this.geometryVersion, configVersion: this.configVersion,
      });
    },
    onFrame: (frame) => {
      // scrcpy sends codec-config (SPS/PPS) as a separate packet. It is not a
      // decodable video frame and must never be sent to VideoDecoder as one.
      // Keep it in the session cache and prefix it to the next IDR instead.
      const mergedSets = mergeParameterSets(this.h264Sets, parameterSetsFromAnnexB(frame.payload));
      if (!parameterSetsEqual(this.h264Sets, mergedSets)) {
        this.h264Sets = mergedSets;
        this.configVersion = (this.configVersion + 1) >>> 0 || 1;
        this.broadcastJson({ type: 'android:meta', deviceId: this.deviceId, codec: this.codec, width: this.width, height: this.height, configVersion: this.configVersion });
      } else {
        this.h264Sets = mergedSets;
      }
      const normalized = normalizeH264Frame(frame.payload, frame, this.h264Sets);
      if (!normalized) return;
      const packet = encodeVideoFrame({ ...frame, ...normalized, config: false });
      this.replayCache = rememberReplayFrame(this.replayCache, packet, normalized);
      this.broadcastBinary(packet);
    },
    onError: (error) => this.fail(error),
  });

  constructor(public readonly deviceId: string) {}

  addClient(client: AndroidMirrorClient): boolean {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    this.clients.set(client.id, client);
    if (!this.ownerId) {
      this.ownerId = client.id;
      this.touchLease();
    }
    client.sendJson({ type: 'android:status', status: this.status, deviceId: this.deviceId, controller: this.ownerId === client.id, controlEpoch: this.controlEpoch, error: this.lastError || undefined });
    if (this.codec && this.width && this.height) {
      client.sendJson({
        type: 'android:meta', deviceId: this.deviceId, codec: this.codec, width: this.width, height: this.height,
        captureGeneration: this.captureGeneration, geometryVersion: this.geometryVersion, configVersion: this.configVersion,
      });
    }
    for (const packet of packetsForNewSubscriber(this.replayCache)) {
      try { client.sendBinary(packet); } catch { /* the remote layer removes closed clients */ }
    }
    if (this.status === 'stopped' || this.status === 'error') void this.start();
    return this.ownerId === client.id;
  }

  removeClient(clientId: string): void {
    this.clients.delete(clientId);
    if (this.pendingClaim?.owner === clientId || this.pendingClaim?.challenger === clientId) this.clearChallenge();
    if (this.ownerId === clientId) {
      if (this.challengeTimer) { clearTimeout(this.challengeTimer); this.challengeTimer = null; }
      this.queuePointerCleanup();
      this.ownerId = this.clients.keys().next().value || null;
      this.controlEpoch = (this.controlEpoch + 1) >>> 0 || 1;
      this.commandResults.clear();
      if (this.ownerId) this.touchLease(); else this.clearLease();
      this.broadcastJson({ type: 'android:control-owner', deviceId: this.deviceId, owner: this.ownerId, controlEpoch: this.controlEpoch });
    }
    if (this.clients.size === 0 && !this.idleTimer) {
      this.idleTimer = setTimeout(() => {
        this.idleTimer = null;
        void this.stop();
      }, MIRROR_IDLE_TIMEOUT_MS);
    }
  }

  claim(clientId: string, takeover = true): boolean {
    if (!this.clients.has(clientId)) return false;
    if (this.ownerId === clientId) {
      this.touchLease();
      this.broadcastJson({ type: 'android:control-owner', deviceId: this.deviceId, owner: clientId, controlEpoch: this.controlEpoch });
      return true;
    }
    if (this.ownerId && !takeover) return false;
    // 交互式抢占：持有一方正持有活跃指针（手指按在屏幕上）时不立即夺走，
    // 先下发 challenge，等待其无响应或释放后再转移，否则两端互相抢租约会
    // 把每一次点击都变成静默丢失。挑战窗口内 owner 继续输入则撤销转移。
    if (this.pendingClaim) {
      // 已有未决挑战：本请求只能排队，不能插队抢走挑战权。
      return false;
    }
    if (this.ownerId && this.activePointers.size > 0) {
      const currentOwner = this.ownerId;
      const claim = { owner: currentOwner, challenger: clientId };
      this.pendingClaim = claim;
      this.broadcastJson({ type: 'android:control-challenge', deviceId: this.deviceId, owner: currentOwner, challenger: clientId, controlEpoch: this.controlEpoch });
      this.challengeTimer = setTimeout(() => {
        if (this.pendingClaim !== claim) return;
        this.clearChallenge();
        if (this.ownerId !== currentOwner) return;
        // 窗口内 owner 无新输入也无释放：让位。
        this.forceTransfer(clientId);
      }, CONTROL_CHALLENGE_MS);
      return false;
    }
    this.forceTransfer(clientId);
    return true;
  }

  private forceTransfer(clientId: string): boolean {
    if (!this.clients.has(clientId)) return false;
    this.clearChallenge();
    if (this.ownerId !== clientId) {
      this.queuePointerCleanup();
      // A takeover starts a fresh epoch. Queued commands from the old owner
      // are intentionally discarded before the new owner is announced.
      this.controlEpoch = (this.controlEpoch + 1) >>> 0 || 1;
      this.commandResults.clear();
    }
    this.ownerId = clientId;
    this.touchLease();
    this.broadcastJson({ type: 'android:control-owner', deviceId: this.deviceId, owner: clientId, controlEpoch: this.controlEpoch });
    return true;
  }

  canControl(clientId: string): boolean {
    if (this.ownerId !== clientId) return false;
    if (this.leaseExpiresAt && this.leaseExpiresAt <= Date.now()) {
      this.expireLease();
      return false;
    }
    return true;
  }

  /** 挑战中收到 owner 的真实输入：撤销未决挑战，保持现 owner。 */
  private resolveChallengeIfAny(): void {
    if (!this.pendingClaim) return;
    this.clearChallenge();
    const owner = this.ownerId;
    if (owner) {
      this.broadcastJson({ type: 'android:control-owner', deviceId: this.deviceId, owner, controlEpoch: this.controlEpoch, challenged: false });
    }
  }

  private clearChallenge(): void {
    if (this.challengeTimer) clearTimeout(this.challengeTimer);
    this.challengeTimer = null;
    this.pendingClaim = null;
  }

  private finishInput(input: AndroidMirrorInput, clientId: string, epoch: number): void {
    // An old socket callback must not resurrect a contact after a handoff.
    if (this.ownerId !== clientId || this.controlEpoch !== epoch) return;
    this.trackCommittedInput(input);
    const claim = this.pendingClaim;
    if (claim?.owner === clientId && this.activePointers.size === 0) {
      this.forceTransfer(claim.challenger);
    }
  }

  /** Re-check ownership immediately before every queued socket write. */
  private assertQueuedControl(clientId: string, epoch: number, geometryVersion?: number): void {
    if (epoch !== this.controlEpoch) throw controlError('CONTROL_EPOCH_STALE', '控制租约已更新');
    if (!this.canControl(clientId)) throw controlError('CONTROL_NOT_OWNER', '控制租约已失效');
    if (geometryVersion !== undefined && geometryVersion !== this.geometryVersion) {
      throw controlError('GEOMETRY_STALE', '画面几何版本已更新');
    }
  }

  getControlEpoch(): number { return this.controlEpoch; }

  getControlOwner(): string | null { return this.ownerId; }

  renew(clientId: string): boolean {
    if (!this.canControl(clientId)) return false;
    this.touchLease();
    return true;
  }

  release(clientId: string): boolean {
    if (this.ownerId !== clientId) return false;
    const challenger = this.pendingClaim?.challenger;
    this.clearChallenge();
    if (challenger && this.clients.has(challenger)) return this.forceTransfer(challenger);
    this.queuePointerCleanup();
    this.ownerId = null;
    this.controlEpoch = (this.controlEpoch + 1) >>> 0 || 1;
    this.commandResults.clear();
    this.clearLease();
    this.broadcastJson({ type: 'android:control-owner', deviceId: this.deviceId, owner: null, controlEpoch: this.controlEpoch });
    return true;
  }

  async start(): Promise<void> {
    if (this.status === 'ready' || this.status === 'starting') return this.startPromise || Promise.resolve();
    const generation = ++this.lifecycleGeneration;
    this.startPromise = this.bootstrap(generation);
    try {
      await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }


  async stop(): Promise<void> {
    // Invalidate every in-flight ADB/bootstrap continuation before tearing down
    // resources. Otherwise a slow `adb forward` can finish after stopAll and
    // resurrect a mirror that the user just closed.
    this.lifecycleGeneration++;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.retryAttempt = 0;
    this.cleanupResources();
    this.clearLease();
    this.commandResults.clear();
    this.status = 'stopped';
    this.broadcastJson({ type: 'android:status', status: 'stopped', deviceId: this.deviceId });
  }

  private assertBootstrapCurrent(generation: number): void {
    if (generation !== this.lifecycleGeneration || this.status !== 'starting') {
      throw new BootstrapCancelledError();
    }
  }

  private async bootstrap(generation: number): Promise<void> {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.status = 'starting';
    this.lastError = '';
    this.codec = '';
    this.width = 0;
    this.height = 0;
    this.h264Sets = { sps: null, pps: null };
    this.configVersion = 0;
    this.parser.reset();
    this.replayCache = emptyReplayCache();
    this.broadcastJson({ type: 'android:status', status: 'starting', deviceId: this.deviceId });
    let videoSocket: net.Socket | null = null;
    let controlSocket: net.Socket | null = null;
    try {
      const runtime = resolveScrcpyRuntime();
      this.assertBootstrapCurrent(generation);
      await runAdb(['-s', this.deviceId, 'push', runtime.serverPath, REMOTE_SERVER_PATH], { timeout: 30000, maxBuffer: 2 * 1024 * 1024 });
      this.assertBootstrapCurrent(generation);
      const scid = Math.floor(Math.random() * 0x7fffffff).toString(16);
      const socketName = `scrcpy_${scid}`;
      const forward = await runAdb(['-s', this.deviceId, 'forward', 'tcp:0', `localabstract:${socketName}`], { timeout: 8000 });
      this.assertBootstrapCurrent(generation);
      this.forwardPort = parseForwardPort(forward);
      this.process = await spawnAdb([
        '-s', this.deviceId,
        'shell',
        `CLASSPATH=${REMOTE_SERVER_PATH}`,
        'app_process', '/', 'com.genymobile.scrcpy.Server', runtime.version,
        `scid=${scid}`,
        'tunnel_forward=true',
        'audio=false',
        'control=true',
        'cleanup=false',
        'send_device_meta=false',
        'send_dummy_byte=false',
        `max_size=${DEFAULT_MAX_SIZE}`,
        `max_fps=${DEFAULT_MAX_FPS}`,
        `video_bit_rate=${DEFAULT_VIDEO_BIT_RATE}`,
        'video_codec=h264',
        'log_level=warn',
      ], { stdio: ['ignore', 'pipe', 'pipe'] });
      this.assertBootstrapCurrent(generation);
      // The server normally stays silent; drain both pipes so a verbose
      // Android build cannot block the ADB process on a full pipe buffer.
      this.process.stdout?.resume();
      this.process.stderr?.resume();
      this.process.once('error', (error) => {
        if (generation === this.lifecycleGeneration && (this.status === 'ready' || this.status === 'starting')) this.fail(error);
      });
      this.process.once('exit', () => {
        if (generation === this.lifecycleGeneration && (this.status === 'ready' || this.status === 'starting')) this.fail(new Error('scrcpy Android 镜像进程已退出'));
      });

      // adb forward 接受本地连接的时机早于 Android server 启动；连接失败时
      // 重试，而不是把一次启动竞态误报成设备断线。
      // Java startup on a cold Android runtime can take close to a second. The
      // ADB forward listener accepts early TCP connects but cannot attach them
      // to the server yet, so wait before the first attempt.
      await new Promise((resolve) => setTimeout(resolve, 1000));
      this.assertBootstrapCurrent(generation);
      let connected = false;
      let lastVideoError: Error | null = null;
      for (let attempt = 0; attempt < 16 && !connected; attempt++) {
        try {
          videoSocket = await connectTcp(this.forwardPort);
          this.assertBootstrapCurrent(generation);
          this.videoSocket = videoSocket;
          videoSocket.on('data', (data) => {
            if (generation === this.lifecycleGeneration) this.parser.push(data);
          });
          videoSocket.on('error', (error) => {
            if (generation === this.lifecycleGeneration && (this.status === 'ready' || this.status === 'starting')) this.fail(error);
          });
          connected = true;
        } catch (error) {
          if (generation !== this.lifecycleGeneration) throw new BootstrapCancelledError();
          lastVideoError = error instanceof Error ? error : new Error(String(error));
          videoSocket?.destroy();
          videoSocket = null;
          this.videoSocket = null;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }
      if (!connected) throw lastVideoError || new Error('Android 视频通道连接失败');
      videoSocket!.once('close', () => {
        if (generation === this.lifecycleGeneration && (this.status === 'ready' || this.status === 'starting')) this.fail(new Error('Android 视频流已断开'));
      });

      // scrcpy 在视频 socket 后建立 control socket；逐个连接可避免 ADB tunnel 把两者顺序打乱。
      controlSocket = await connectTcp(this.forwardPort);
      this.assertBootstrapCurrent(generation);
      this.controlSocket = controlSocket;
      controlSocket.on('data', () => { /* clipboard/device messages are optional for this bridge */ });
      controlSocket.on('error', (error) => {
        if (generation === this.lifecycleGeneration && (this.status === 'ready' || this.status === 'starting')) this.fail(error);
      });
      controlSocket.once('close', () => {
        if (generation === this.lifecycleGeneration && (this.status === 'ready' || this.status === 'starting')) this.fail(new Error('Android 控制通道已断开'));
      });

      // 服务端会等视频和控制 socket 都建立后才开始编码；握手等待必须放在
      // 第二条连接之后，否则视频 socket 会因控制通道尚未建立而空等退出。
      await waitForSocketData(videoSocket!, 5000);
      this.assertBootstrapCurrent(generation);

      const deadline = Date.now() + 8000;
      while ((!this.codec || !this.width || !this.height) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        this.assertBootstrapCurrent(generation);
      }
      this.assertBootstrapCurrent(generation);
      if (!this.codec || !this.width || !this.height) throw new Error('Android 视频流未返回有效画面尺寸');

      this.status = 'ready';
      this.retryAttempt = 0;
      this.broadcastJson({ type: 'android:status', status: 'ready', deviceId: this.deviceId, codec: this.codec, width: this.width, height: this.height, controller: this.ownerId });
    } catch (error) {
      videoSocket?.destroy();
      controlSocket?.destroy();
      if (error instanceof BootstrapCancelledError || generation !== this.lifecycleGeneration) {
        this.cleanupResources();
        return;
      }
      this.fail(error instanceof Error ? error : new Error(String(error)));
    }
  }

  async sendInput(input: AndroidMirrorInput, sequence?: number, clientId?: string, expectedEpoch?: number, expectedGeometryVersion?: number): Promise<void> {
    if (this.status !== 'ready' || !this.controlSocket || !this.width || !this.height) {
      throw controlError('DEVICE_OFFLINE', 'Android 镜像尚未就绪');
    }
    if (!validateAndroidMirrorInput(input)) throw controlError('INVALID_INPUT', 'Android 控制参数无效');
    const senderId = clientId || this.ownerId || '';
    if (!this.canControl(senderId)) throw controlError('CONTROL_NOT_OWNER', '控制租约已失效');
    const epoch = Number.isSafeInteger(expectedEpoch) && (expectedEpoch as number) > 0
      ? expectedEpoch as number : this.controlEpoch;
    if (epoch !== this.controlEpoch) throw controlError('CONTROL_EPOCH_STALE', '控制租约已更新');
    if (expectedGeometryVersion !== undefined && expectedGeometryVersion !== this.geometryVersion) {
      throw controlError('GEOMETRY_STALE', '画面几何版本已更新');
    }
    const messages = this.serializeInput(input);
    if (this.controlQueueDepth + messages.length > CONTROL_QUEUE_LIMIT) {
      throw controlError('CONTROL_OVERLOADED', 'Android 控制队列已满');
    }
    if (Number.isSafeInteger(sequence)) {
      const key = senderId;
      let state = this.commandResults.get(key);
      if (!state || state.epoch !== this.controlEpoch) {
        state = { epoch: this.controlEpoch, highest: 0, entries: new Map() };
        this.commandResults.set(key, state);
      }
      const previous = state.entries.get(sequence as number);
      if (previous) return previous;
      if ((sequence as number) <= state.highest) {
        throw controlError('CONTROL_SEQ_STALE', '控制序号已过期');
      }
      state.highest = sequence as number;
      this.acceptControlActivity(input);
      this.trackQueuedInput(input);
      const operation = this.enqueueControl(messages, senderId, epoch, expectedGeometryVersion);
      state.entries.set(sequence as number, operation);
      while (state.entries.size > CONTROL_RESULT_CACHE_SIZE) {
        const oldest = state.entries.keys().next().value;
        if (oldest === undefined) break;
        state.entries.delete(oldest);
      }
      await operation;
      this.finishInput(input, senderId, epoch);
      return;
    }
    this.acceptControlActivity(input);
    this.trackQueuedInput(input);
    await this.enqueueControl(messages, senderId, epoch, expectedGeometryVersion);
    this.finishInput(input, senderId, epoch);
  }

  private acceptControlActivity(input: AndroidMirrorInput): void {
    // Invalid/stale/duplicate requests cannot cancel a pending takeover.
    // UP/CANCEL completes the current gesture and hands off after its write.
    const releasing = (!input.type || input.type === 'touch')
      && (input.action === 'up' || input.action === 'cancel');
    if (!releasing) this.resolveChallengeIfAny();
    this.touchLease();
  }

  private serializeInput(input: AndroidMirrorInput): Buffer[] {
    const type = input.type || (input.text !== undefined ? 'text' : 'touch');
    if (type === 'text') return serializeTextControls(String(input.text || ''));
    if (type === 'key') return [serializeKeyControl(input)];
    if (type === 'back') return [serializeBackControl(input.keyAction || 'down')];
    if (type === 'scroll') return [serializeScrollControl(input, this.width, this.height)];
    if (type === 'tap') {
      return [
        serializeTouchControl({ ...input, action: 'down', pressure: 1 }, this.width, this.height),
        serializeTouchControl({ ...input, action: 'up', pressure: 0 }, this.width, this.height),
      ];
    }
    if (type === 'touch' && input.action === 'cancel') {
      // scrcpy's CANCEL handling varies across Android versions. Follow it
      // with an explicit UP in the same queue batch so a lost pointer cannot
      // remain pressed after a browser cancel/blur or control handoff.
      return [
        serializeTouchControl(input, this.width, this.height),
        serializeTouchControl({ ...input, action: 'up', pressure: 0 }, this.width, this.height),
      ];
    }
    return [serializeTouchControl(input, this.width, this.height)];
  }

  private pointerIdForInput(input: AndroidMirrorInput): number | null {
    const type = input.type || (input.text !== undefined ? 'text' : 'touch');
    if (type !== 'touch' && type !== 'tap') return null;
    return Number.isSafeInteger(input.pointerId) && Number(input.pointerId) >= 0 ? Number(input.pointerId) : -2;
  }

  private trackQueuedInput(input: AndroidMirrorInput): void {
    const pointer = this.pointerIdForInput(input);
    if (pointer === null) return;
    const type = input.type || 'touch';
    if (type === 'tap' || input.action === 'down') this.activePointers.add(pointer);
  }

  private trackCommittedInput(input: AndroidMirrorInput): void {
    const pointer = this.pointerIdForInput(input);
    if (pointer === null) return;
    if (input.type === 'tap' || input.action === 'up' || input.action === 'cancel') this.activePointers.delete(pointer);
    else if (input.action === 'down') this.activePointers.add(pointer);
  }

  /** Queue UP cleanup behind already-written bytes, but ahead of new owner input. */
  private queuePointerCleanup(): void {
    const pointers = Array.from(this.activePointers);
    this.activePointers.clear();
    if (!pointers.length) return;
    const messages = pointers.map((pointerId) => serializeTouchControl({
      type: 'touch', action: 'up', pointerId, x: 0, y: 0, pressure: 0,
    }, this.width || 1, this.height || 1));
    this.controlQueueDepth += messages.length;
    const socket = this.controlSocket;
    const operation = this.controlQueue.then(() => {
      if (!socket || socket.destroyed || socket !== this.controlSocket) throw controlError('DEVICE_OFFLINE', 'Android 控制通道不可用');
      return this.writeControls(socket, messages);
    }).finally(() => { this.controlQueueDepth = Math.max(0, this.controlQueueDepth - messages.length); });
    this.controlQueue = operation.catch(() => {});
  }

  private enqueueControl(messages: Buffer[], clientId: string, epoch: number, geometryVersion?: number): Promise<void> {
    if (this.controlQueueDepth + messages.length > CONTROL_QUEUE_LIMIT) {
      return Promise.reject(Object.assign(new Error('Android 控制队列已满'), { code: 'CONTROL_OVERLOADED' }));
    }
    this.controlQueueDepth += messages.length;
    const socket = this.controlSocket;
    const operation = this.controlQueue.then(() => {
      if (!socket || socket.destroyed || socket !== this.controlSocket) throw controlError('DEVICE_OFFLINE', 'Android 控制通道不可用');
      return this.writeControls(socket, messages, () => this.assertQueuedControl(clientId, epoch, geometryVersion));
    }).finally(() => { this.controlQueueDepth = Math.max(0, this.controlQueueDepth - messages.length); });
    this.controlQueue = operation.catch(() => {});
    return operation;
  }

  private writeControls(socket: net.Socket, messages: Buffer[], beforeWrite?: () => void): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let index = 0;
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.removeListener('close', onClose);
        socket.removeListener('error', onError);
        if (error) reject(error); else resolve();
      };
      const onClose = () => finish(controlError('DEVICE_OFFLINE', 'Android 控制通道已关闭'));
      const onError = (error: Error) => finish(error);
      const timer = setTimeout(() => {
        const error = controlError('CONTROL_WRITE_TIMEOUT', 'Android 控制通道超时，正在重新连接');
        finish(error);
        if (this.controlSocket === socket) this.fail(error);
      }, CONTROL_WRITE_TIMEOUT_MS);
      socket.once('close', onClose);
      socket.once('error', onError);
      const writeNext = (error?: Error | null) => {
        if (settled) return;
        if (error) { finish(error); return; }
        try {
          if (this.controlSocket !== socket) { onClose(); return; }
          beforeWrite?.();
          if (index >= messages.length) { finish(); return; }
          socket.write(messages[index++], writeNext);
        } catch (assertionError) {
          finish(assertionError instanceof Error ? assertionError : new Error(String(assertionError)));
        }
      };
      writeNext();
    });
  }

  private touchLease(): void {
    // Background heartbeats prove connectivity, not an active gesture. They
    // must not prevent another client from recovering a stuck contact.
    this.leaseExpiresAt = Date.now() + CONTROL_LEASE_MS;
    if (this.leaseTimer) clearTimeout(this.leaseTimer);
    this.leaseTimer = setTimeout(() => this.expireLease(), CONTROL_LEASE_MS + 50);
  }

  private clearLease(): void {
    if (this.leaseTimer) clearTimeout(this.leaseTimer);
    this.leaseTimer = null;
    this.leaseExpiresAt = 0;
  }

  private expireLease(): void {
    if (!this.ownerId || !this.leaseExpiresAt || this.leaseExpiresAt > Date.now()) return;
    const owner = this.ownerId;
    this.clearChallenge();
    this.queuePointerCleanup();
    this.ownerId = null;
    this.controlEpoch = (this.controlEpoch + 1) >>> 0 || 1;
    this.commandResults.clear();
    this.clearLease();
    this.broadcastJson({ type: 'android:control-owner', deviceId: this.deviceId, owner: null, controlEpoch: this.controlEpoch, expired: owner });
  }

  private fail(error: Error): void {
    if (this.status === 'error' && this.lastError === error.message) return;
    const previousStatus = this.status;
    this.cleanupResources();
    this.lastError = error.message;
    this.status = 'error';
    const details = mirrorErrorDetails(error, previousStatus);
    this.broadcastJson({ type: 'android:status', status: 'error', deviceId: this.deviceId, error: error.message, ...details });
    this.scheduleRetry();
  }

  private scheduleRetry(): void {
    if (this.retryTimer || this.clients.size === 0) return;
    const delay = Math.min(15000, 1000 * (2 ** Math.min(this.retryAttempt++, 5)));
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (this.clients.size === 0 || this.status !== 'error') return;
      void this.start();
    }, delay);
  }

  private cleanupResources(): void {
    this.clearChallenge();
    const videoSocket = this.videoSocket;
    const controlSocket = this.controlSocket;
    this.videoSocket = null;
    this.controlSocket = null;
    videoSocket?.destroy();
    controlSocket?.destroy();
    this.replayCache = emptyReplayCache();
    if (this.process && !this.process.killed) this.process.kill('SIGTERM');
    this.process = null;
    this.activePointers.clear();
    if (this.forwardPort) {
      const port = this.forwardPort;
      this.forwardPort = null;
      void runAdb(['-s', this.deviceId, 'forward', '--remove', `tcp:${port}`], { timeout: 3000 }).catch(() => {});
    }
  }

  private broadcastJson(message: Record<string, unknown>): void {
    for (const client of this.clients.values()) {
      try { client.sendJson(message); } catch { /* the remote layer removes closed clients */ }
    }
  }

  private broadcastBinary(data: Buffer): void {
    for (const client of this.clients.values()) {
      try { client.sendBinary(data); } catch { /* ignore a closing socket */ }
    }
  }
}

export class AndroidMirrorManager {
  private readonly sessions = new Map<string, AndroidMirrorSession>();

  subscribe(deviceId: string, client: AndroidMirrorClient): boolean {
    let session = this.sessions.get(deviceId);
    if (!session) {
      session = new AndroidMirrorSession(deviceId);
      this.sessions.set(deviceId, session);
    }
    const controller = session.addClient(client);
    return controller;
  }

  unsubscribe(deviceId: string, clientId: string): void {
    const session = this.sessions.get(deviceId);
    if (!session) return;
    session.removeClient(clientId);
    // The session remains in the map during its short idle grace period, avoiding
    // an ADB restart when the browser changes orientation or reconnects briefly.
  }

  claim(deviceId: string, clientId: string, takeover = true): boolean {
    return this.sessions.get(deviceId)?.claim(clientId, takeover) || false;
  }

  async sendInput(deviceId: string, clientId: string, input: AndroidMirrorInput, sequence?: number, expectedEpoch?: number, expectedGeometryVersion?: number): Promise<void> {
    const session = this.sessions.get(deviceId);
    if (!session) throw controlError('DEVICE_OFFLINE', 'Android 镜像会话不存在');
    if (!session.canControl(clientId)) throw controlError('CONTROL_NOT_OWNER', '当前设备由其他客户端控制');
    await session.sendInput(input, sequence, clientId, expectedEpoch, expectedGeometryVersion);
  }

  renew(deviceId: string, clientId: string): boolean {
    return this.sessions.get(deviceId)?.renew(clientId) || false;
  }

  release(deviceId: string, clientId: string): boolean {
    return this.sessions.get(deviceId)?.release(clientId) || false;
  }

  controlEpoch(deviceId: string): number {
    return this.sessions.get(deviceId)?.getControlEpoch() || 0;
  }

  controlOwner(deviceId: string): string | null {
    return this.sessions.get(deviceId)?.getControlOwner() || null;
  }

  async stopAll(): Promise<void> {
    await Promise.all(Array.from(this.sessions.values(), (session) => session.stop()));
    this.sessions.clear();
  }
}
