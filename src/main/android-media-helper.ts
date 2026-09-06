import net from 'net';
import fs from 'fs';
import path from 'path';
import { spawn, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import { DVM2_KIND_H264, DVM2_MAX_H264_BYTES, decodeDvm2Frame } from './android-mirror-protocol';

export interface AndroidMediaHelperHandshake {
  version: number;
  controlAddr: string;
  mediaAddr: string;
  token: string;
  pid: number;
  buildId?: string;
}

export interface AndroidMediaHelperOptions {
  binary?: string;
  resourcesPath?: string;
  maxRestarts?: number;
  onMessage?: (message: any) => void;
  onError?: (error: Error) => void;
}

const MAX_CONTROL_BYTES = 64 * 1024;
const MAX_MEDIA_BYTES = 16 * 1024 * 1024;

export function resolveAndroidMediaHelper(options: Pick<AndroidMediaHelperOptions, 'binary' | 'resourcesPath'> = {}): string | null {
  const executable = process.platform === 'win32' ? 'android-media.exe' : 'android-media';
  const resources = options.resourcesPath || (typeof process.resourcesPath === 'string' ? process.resourcesPath : '');
  const candidates = [
    options.binary,
    process.env.DUOCLI_ANDROID_MEDIA_HELPER,
    resources && path.join(resources, 'android-media', executable),
    resources && path.join(resources, executable),
    path.join(process.cwd(), 'native', 'android-media', executable),
  ].filter((candidate): candidate is string => Boolean(candidate));
  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate).isFile() && (process.platform === 'win32' || (fs.statSync(candidate).mode & 0o111))) return candidate;
    } catch { /* try next candidate */ }
  }
  return null;
}

function framePayload(payload: Buffer): Buffer {
  if (payload.length > MAX_CONTROL_BYTES) throw new Error('helper 控制消息过大');
  const header = Buffer.alloc(4);
  header.writeUInt32BE(payload.length, 0);
  return Buffer.concat([header, payload]);
}

function writeLengthPrefixed(socket: net.Socket, value: unknown): void {
  const payload = Buffer.from(JSON.stringify(value));
  socket.write(framePayload(payload));
}

/** Parent-side lifecycle and IPC wrapper for the optional Pion helper. */
export class AndroidMediaHelper extends EventEmitter {
  private process: ChildProcess | null = null;
  private control: net.Socket | null = null;
  private media: net.Socket | null = null;
  private handshake: AndroidMediaHelperHandshake | null = null;
  private stopping = false;
  private restartTimes: number[] = [];
  private controlBuffer = Buffer.alloc(0);
  private readonly binary: string | null;
  private readonly maxRestarts: number;

  constructor(private readonly options: AndroidMediaHelperOptions = {}) {
    super();
    this.binary = resolveAndroidMediaHelper(options);
    this.maxRestarts = Math.max(0, options.maxRestarts ?? 3);
  }

  get available(): boolean { return Boolean(this.binary); }
  get running(): boolean { return Boolean(this.process && !this.process.killed && this.handshake); }
  get info(): AndroidMediaHelperHandshake | null { return this.handshake; }

  async start(): Promise<AndroidMediaHelperHandshake> {
    if (this.handshake && this.process && this.control && this.media
      && !this.control.destroyed && !this.media.destroyed) return this.handshake;
    if (!this.binary) throw new Error('未找到 DuoCLI Android media helper');
    this.stopping = false;
    const child = spawn(this.binary, [], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, DUOCLI_PARENT_PID: String(process.pid) },
    });
    this.process = child;
    child.stderr?.on('data', data => process.stderr.write(`[android-media] ${data}`));
    try {
      const handshake = await this.readHandshake(child);
      this.handshake = handshake;
      this.control = await this.connect(handshake.controlAddr);
      this.media = await this.connect(handshake.mediaAddr);
      writeLengthPrefixed(this.control, { type: 'hello', token: handshake.token });
      child.once('exit', (code, signal) => {
        this.closeSockets();
        this.handshake = null;
        this.emit('exit', { code, signal });
        if (!this.stopping) this.scheduleRestart();
      });
      this.attachControlReader(this.control);
      return handshake;
    } catch (error) {
      // A malformed handshake or a half-open loopback socket must not leave a
      // helper process behind when startup fails.
      this.stopping = true;
      this.closeSockets();
      this.handshake = null;
      if (child && !child.killed) child.kill('SIGTERM');
      this.process = null;
      throw error;
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.closeSockets();
    const child = this.process;
    this.process = null;
    this.handshake = null;
    if (child && !child.killed) child.kill('SIGTERM');
  }

  async createPeer(peerId: string, sourceId: number, negotiationId = ''): Promise<void> {
    this.requireControl();
    writeLengthPrefixed(this.control!, { type: 'peer.create', peerId, sourceId, negotiationId, requestId: cryptoRandomId() });
  }

  async answer(peerId: string, sdp: string, negotiationId = ''): Promise<void> {
    if (Buffer.byteLength(sdp, 'utf8') > MAX_CONTROL_BYTES) throw new Error('SDP 过大');
    this.requireControl();
    writeLengthPrefixed(this.control!, { type: 'peer.answer', peerId, sdp, negotiationId, requestId: cryptoRandomId() });
  }

  async addIce(peerId: string, candidate: unknown, negotiationId = ''): Promise<void> {
    this.requireControl();
    writeLengthPrefixed(this.control!, { type: 'peer.ice', peerId, candidate, negotiationId, requestId: cryptoRandomId() });
  }

  async closePeer(peerId: string): Promise<void> {
    this.requireControl();
    writeLengthPrefixed(this.control!, { type: 'peer.close', peerId });
  }

  sendVideoPacket(sourceId: number, packet: Buffer): void {
    if (!this.media) throw new Error('helper 媒体通道未连接');
    if (!Buffer.isBuffer(packet) || packet.length > MAX_MEDIA_BYTES) throw new Error('helper 媒体帧过大');
    const decoded = decodeDvm2Frame(packet);
    if (decoded.kind !== DVM2_KIND_H264 || decoded.payload.length > DVM2_MAX_H264_BYTES) throw new Error('helper 只接受 DVM2 H.264');
    const header = Buffer.alloc(8);
    header.writeUInt32BE(sourceId >>> 0, 0);
    header.writeUInt32BE(packet.length, 4);
    this.media.write(Buffer.concat([header, packet]));
  }

  private requireControl(): void { if (!this.control || this.control.destroyed) throw new Error('helper 控制通道未连接'); }

  private readHandshake(child: ChildProcess): Promise<AndroidMediaHelperHandshake> {
    return new Promise((resolve, reject) => {
      let buffer = '';
      const timer = setTimeout(() => { cleanup(); reject(new Error('helper 启动握手超时')); }, 5000);
      const cleanup = () => { clearTimeout(timer); child.stdout?.removeListener('data', onData); child.removeListener('error', onError); };
      const onError = (error: Error) => { cleanup(); reject(error); };
      const onData = (chunk: Buffer) => {
        buffer += chunk.toString('utf8');
        const lineEnd = buffer.indexOf('\n');
        if (lineEnd < 0 || buffer.length > MAX_CONTROL_BYTES) return;
        const line = buffer.slice(0, lineEnd).trim();
        try {
          const value = JSON.parse(line) as AndroidMediaHelperHandshake;
          if (!value.controlAddr || !value.mediaAddr || !value.token) throw new Error('helper 握手字段缺失');
          cleanup(); resolve(value);
        } catch (error) { cleanup(); reject(error); }
      };
      child.stdout?.on('data', onData);
      child.once('error', onError);
    });
  }

  private connect(address: string): Promise<net.Socket> {
    const [host, portText] = address.startsWith('[') ? (() => { const i = address.lastIndexOf(']:'); return [address.slice(1, i), address.slice(i + 2)]; })() : address.split(':');
    const port = Number(portText);
    if (!host || !Number.isInteger(port) || port <= 0 || port > 65535) return Promise.reject(new Error('helper 地址无效'));
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ host, port });
      const onError = (error: Error) => { socket.destroy(); reject(error); };
      socket.once('error', onError);
      socket.once('connect', () => { socket.removeListener('error', onError); socket.setNoDelay(true); resolve(socket); });
    });
  }

  private attachControlReader(socket: net.Socket): void {
    socket.on('data', chunk => {
      this.controlBuffer = Buffer.concat([this.controlBuffer, chunk]);
      while (this.controlBuffer.length >= 4) {
        const length = this.controlBuffer.readUInt32BE(0);
        if (!length || length > MAX_CONTROL_BYTES) { this.options.onError?.(new Error('helper 控制消息长度无效')); socket.destroy(); return; }
        if (this.controlBuffer.length < length + 4) return;
        const payload = this.controlBuffer.subarray(4, length + 4);
        this.controlBuffer = this.controlBuffer.subarray(length + 4);
        try { const message = JSON.parse(payload.toString('utf8')); this.options.onMessage?.(message); this.emit('message', message); } catch (error) { this.options.onError?.(error instanceof Error ? error : new Error(String(error))); }
      }
    });
  }

  private closeSockets(): void { this.control?.destroy(); this.media?.destroy(); this.control = null; this.media = null; this.controlBuffer = Buffer.alloc(0); }

  private scheduleRestart(): void {
    const now = Date.now();
    this.restartTimes = this.restartTimes.filter(time => now - time < 5 * 60 * 1000);
    if (this.restartTimes.length >= this.maxRestarts) { this.options.onError?.(new Error('helper 在 5 分钟内重启次数已达上限')); return; }
    this.restartTimes.push(now);
    const delay = Math.min(15000, 500 * (2 ** Math.min(this.restartTimes.length - 1, 5)));
    setTimeout(() => { if (!this.stopping) void this.start().catch(error => this.options.onError?.(error)); }, delay);
  }
}

function cryptoRandomId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}
