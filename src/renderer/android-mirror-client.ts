// Browser-side Android mirror client used by the desktop renderer.
// Video and control use a dedicated WebSocket so neither is queued behind the
// terminal's ANSI replay/output stream.

const HEADER_SIZE = 24;
const MAX_DECODE_QUEUE = 3;
const MAX_PACKET_BYTES = 16 * 1024 * 1024;

export interface AndroidMirrorServerInfo {
  port: number;
  token: string;
}

export interface AndroidMirrorInput {
  type?: 'touch' | 'text' | 'key' | 'back' | 'scroll' | 'tap';
  action?: 'down' | 'up' | 'move' | 'cancel';
  x?: number;
  y?: number;
  pointerId?: number;
  pressure?: number;
  text?: string;
  keyCode?: number;
  keyAction?: 'down' | 'up';
  repeat?: number;
  metastate?: number;
  hscroll?: number;
  vscroll?: number;
}

export interface AndroidMirrorClientOptions {
  getServerInfo: () => Promise<AndroidMirrorServerInfo | null>;
  getTicket?: (deviceId: string, purpose: 'control' | 'video') => Promise<string>;
  protocolVersion?: 1 | 2;
  onStatus?: (message: any) => void;
  onMeta?: (message: any) => void;
  onFrame?: (message: any) => void;
  onError?: (error: Error) => void;
}

function avcCodecFromAnnexB(data: Uint8Array): string {
  for (let i = 0; i + 4 < data.length; i++) {
    let start = 0;
    if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1) start = i + 3;
    else if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 0 && data[i + 3] === 1) start = i + 4;
    if (!start || start >= data.length) continue;
    const nalType = data[start] & 0x1f;
    if (nalType !== 7 || start + 3 >= data.length) continue;
    const hex = (value: number) => value.toString(16).padStart(2, '0').toUpperCase();
    return `avc1.${hex(data[start + 1])}${hex(data[start + 2])}${hex(data[start + 3])}`;
  }
  return 'avc1.42E01E';
}

export class AndroidMirrorClient {
  private socket: WebSocket | null = null;
  private deviceId = '';
  private sequence = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private resubscribeTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private resubscribeAttempt = 0;
  private shouldReconnect = false;
  private generation = 0;
  private lastError = '';
  private decoder: any = null;
  private codec = '';
  private width = 0;
  private height = 0;
  private captureGeneration = 0;
  private configVersion = 0;
  private mediaEpoch = 0;
  private geometryVersion = 0;
  private lastFrameId = 0;
  private lastPresentedFrameId = 0;
  private lastReceivedAt = 0;
  private readonly canvases = new Set<HTMLCanvasElement>();
  private readonly contexts = new Map<HTMLCanvasElement, CanvasRenderingContext2D | null>();
  private lastStatus = 'stopped';
  private decoderErrorReported = false;
  public hasFrame = false;
  public waitingForKeyFrame = true;
  public lastPresentedAt = 0;
  public decodeErrorCount = 0;
  private readonly pendingAcks = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  private readonly recentAcks = new Map<number, any>();
  private leaseTimer: ReturnType<typeof setInterval> | null = null;
  private feedbackTimer: ReturnType<typeof setInterval> | null = null;
  private controlEpoch = 1;
  private readonly protocolVersion: 1 | 2;
  public isController = false;

  private readonly onStatus: (message: any) => void;
  private readonly onMeta: (message: any) => void;
  private readonly onFrame: (message: any) => void;
  private readonly onError: (error: Error) => void;

  constructor(private readonly options: AndroidMirrorClientOptions) {
    this.protocolVersion = options.protocolVersion === 2 ? 2 : 1;
    this.onStatus = options.onStatus || (() => {});
    this.onMeta = options.onMeta || (() => {});
    this.onFrame = options.onFrame || (() => {});
    this.onError = options.onError || (() => {});
  }

  connect(deviceId: string): void {
    const nextDevice = String(deviceId || '').trim();
    if (!nextDevice) return;
    if (this.deviceId === nextDevice && this.shouldReconnect
      && (this.socket || this.reconnectTimer)) return;
    if (this.deviceId !== nextDevice) this.close();
    this.deviceId = nextDevice;
    this.shouldReconnect = true;
    this.reconnectAttempt = 0;
    this.resubscribeAttempt = 0;
    this.clearReconnectTimer();
    this.clearResubscribeTimer();
    if (this.leaseTimer) clearInterval(this.leaseTimer);
    this.leaseTimer = null;
    if (this.feedbackTimer) clearInterval(this.feedbackTimer);
    this.feedbackTimer = null;
    this.open(this.generation);
  }

  close(): void {
    this.shouldReconnect = false;
    this.generation++;
    this.clearReconnectTimer();
    this.clearResubscribeTimer();
    if (this.leaseTimer) clearInterval(this.leaseTimer);
    this.leaseTimer = null;
    if (this.feedbackTimer) clearInterval(this.feedbackTimer);
    this.feedbackTimer = null;
    this.closeDecoder();
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      socket.onclose = null;
      socket.onerror = null;
      socket.onopen = null;
      socket.onmessage = null;
      try { socket.close(1000, 'client closed'); } catch { /* ignore */ }
    }
    this.deviceId = '';
    this.hasFrame = false;
    this.decoderErrorReported = false;
    this.lastStatus = 'stopped';
    this.lastError = '';
    this.waitingForKeyFrame = true;
    this.captureGeneration = 0;
    this.configVersion = 0;
    this.mediaEpoch = 0;
    this.lastFrameId = 0;
    this.lastPresentedFrameId = 0;
    this.lastReceivedAt = 0;
    this.geometryVersion = 0;
    this.controlEpoch = 1;
    this.isController = false;
    for (const pending of this.pendingAcks.values()) pending.reject(new Error('Android 镜像连接已关闭'));
    this.pendingAcks.clear();
    this.recentAcks.clear();
  }

  attachCanvas(canvas: HTMLCanvasElement): void {
    this.canvases.add(canvas);
    this.syncCanvas(canvas);
    this.contexts.set(canvas, canvas.getContext('2d', { alpha: false, desynchronized: true }));
  }

  isReady(): boolean {
    return !!this.socket && this.socket.readyState === WebSocket.OPEN && this.lastStatus === 'ready';
  }

  getControlEpoch(): number {
    return this.controlEpoch;
  }

  getGeometryVersion(): number {
    return this.geometryVersion;
  }

  private reportError(error: unknown, code = 'DECODE_FAILED', stage = 'decode'): void {
    const value = (error instanceof Error ? error : new Error(String(error))) as Error & {
      code?: string;
      stage?: string;
    };
    value.code = code;
    value.stage = stage;
    this.lastError = value.message;
    this.onError(value);
  }

  sendInput(input: AndroidMirrorInput, allowWithoutController = false): number | null {
    if (!this.isReady() || (!this.isController && !allowWithoutController)) return null;
    if (this.protocolVersion === 2 && this.geometryVersion <= 0) return null;
    const sequence = ++this.sequence;
    try {
      this.socket!.send(JSON.stringify({
        ...(this.protocolVersion === 2
          ? { v: 2, type: 'control.input', deviceId: this.deviceId, seq: sequence, controlEpoch: this.controlEpoch, geometryVersion: this.geometryVersion, input }
          : { type: 'android:input', deviceId: this.deviceId, sequence, input }),
      }));
      return sequence;
    } catch (error) {
      this.onError(error instanceof Error ? error : new Error(String(error)));
      return null;
    }
  }

  // Release a pointer that was already pressed even when the browser has not
  // processed the newest control-owner notification. The server still enforces
  // the lease and rejects the message if another client owns the device.
  sendEmergencyInput(input: AndroidMirrorInput): number | null {
    if (input.type !== 'touch' || !['up', 'cancel'].includes(input.action || '')) return null;
    return this.sendInput(input, true);
  }

  waitForAck(sequence: number, timeoutMs = 1200): Promise<any> {
    if (!Number.isSafeInteger(sequence)) return Promise.reject(new Error('无效的输入序号'));
    const cached = this.recentAcks.get(sequence);
    if (cached) {
      this.recentAcks.delete(sequence);
      return Promise.resolve(cached);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingAcks.delete(sequence);
        const error = Object.assign(new Error('输入回执超时，结果未知'), { code: 'INPUT_RESULT_UNKNOWN', stage: 'control' });
        reject(error);
      }, timeoutMs);
      this.pendingAcks.set(sequence, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
    });
  }

  claimControl(takeover = true): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(this.protocolVersion === 2 ? { v: 2, type: 'control.claim', takeover } : { type: 'android:claim' }));
  }

  private async open(generation: number): Promise<void> {
    if (!this.shouldReconnect || !this.deviceId || generation !== this.generation) return;
    this.clearReconnectTimer();
    this.clearResubscribeTimer();
    let info: AndroidMirrorServerInfo | null;
    try {
      info = await this.options.getServerInfo();
    } catch (error) {
      this.onError(error instanceof Error ? error : new Error(String(error)));
      this.scheduleReconnect();
      return;
    }
    if (!info || generation !== this.generation || !this.shouldReconnect || !this.deviceId) {
      this.scheduleReconnect();
      return;
    }

    let socket: WebSocket;
    try {
      let authQuery = `token=${encodeURIComponent(String(info.token || ''))}`;
      if (this.protocolVersion === 2 && this.options.getTicket) {
        try {
          const ticket = await this.options.getTicket(this.deviceId, 'video');
          if (ticket) authQuery = `ticket=${encodeURIComponent(ticket)}`;
        } catch (error) {
          this.reportError(error instanceof Error ? error : new Error(String(error)), 'AUTH_EXPIRED', 'auth');
        }
      }
      if (!this.shouldReconnect || generation !== this.generation || !this.deviceId) return;
      const endpoint = this.protocolVersion === 2 ? '/android-video-ws' : '/android-ws';
      socket = new WebSocket(`ws://127.0.0.1:${info.port}${endpoint}?${authQuery}`);
    } catch (error) {
      this.onError(error instanceof Error ? error : new Error(String(error)));
      this.scheduleReconnect();
      return;
    }
    socket.binaryType = 'arraybuffer';
    this.socket = socket;
    socket.onopen = () => {
      this.reconnectAttempt = 0;
      this.resubscribeAttempt = 0;
      try {
        socket.send(JSON.stringify(this.protocolVersion === 2
          ? { v: 2, type: 'video.subscribe', deviceId: this.deviceId, preference: 'balanced', mediaEpoch: 1 }
          : { type: 'android:subscribe', deviceId: this.deviceId }));
        if (this.leaseTimer) clearInterval(this.leaseTimer);
      this.leaseTimer = setInterval(() => {
          if (this.socket === socket && socket.readyState === WebSocket.OPEN) {
            try { socket.send(JSON.stringify(this.protocolVersion === 2 ? { v: 2, type: 'control.renew', controlEpoch: this.controlEpoch } : { type: 'android:renew' })); } catch { /* reconnect handles it */ }
          }
      }, 2000);
      if (this.protocolVersion === 2) {
        this.feedbackTimer = setInterval(() => this.sendFeedback(socket), 500);
      }
      } catch (error) {
        this.onError(error instanceof Error ? error : new Error(String(error)));
        socket.close();
      }
    };
    socket.onmessage = (event) => this.handleMessage(event.data);
    socket.onerror = () => this.reportError(new Error('Android 实时镜像网络连接失败'), 'MEDIA_SOCKET_ERROR', 'transport');
    socket.onclose = () => {
      if (this.socket === socket) this.socket = null;
      if (this.leaseTimer) clearInterval(this.leaseTimer);
      this.leaseTimer = null;
      if (this.feedbackTimer) clearInterval(this.feedbackTimer);
      this.feedbackTimer = null;
      this.closeDecoder();
      this.decoderErrorReported = false;
      if (!this.shouldReconnect || generation !== this.generation) return;
      this.lastStatus = 'disconnected';
      this.onStatus({ type: 'android:status', status: 'disconnected', deviceId: this.deviceId });
      this.scheduleReconnect();
    };
  }

  private handleMessage(data: any): void {
    if (typeof data === 'string') {
      let message: any;
      try { message = JSON.parse(data); } catch { return; }
      if (message.type === 'session.state') {
        message = { ...message, type: 'android:status', status: message.capture || message.status || 'unknown', error: message.error };
      } else if (message.type === 'video.meta') {
        message = { ...message, type: 'android:meta' };
      } else if (message.type === 'control.ack') {
        message = { ...message, type: 'android:ack', sequence: message.seq, ok: message.status === 'ok' };
      } else if (message.type === 'control.owner') {
        message = { ...message, type: 'android:control-owner', controller: Boolean(message.isController), owner: message.ownerClientId };
      } else if (message.type === 'control.granted') {
        message = { ...message, type: 'android:control-owner', status: 'control-owner', controller: Boolean(message.isController) };
      }
      if (Number.isSafeInteger(message.controlEpoch) && message.controlEpoch > 0) this.controlEpoch = message.controlEpoch;
      if (message.type === 'android:status') {
        this.lastStatus = message.status || 'unknown';
        if (typeof message.controller === 'boolean') this.isController = message.controller;
        if (message.status === 'ready') {
          this.lastError = '';
          this.resubscribeAttempt = 0;
          this.reconnectAttempt = 0;
        } else if (message.error) this.lastError = String(message.error);
        if (message.status === 'ready' && message.width && message.height) this.setMeta(message);
        this.onStatus(message);
        if (message.status === 'error') this.scheduleResubscribe(this.generation);
        return;
      }
      if (message.type === 'android:meta') {
        this.setMeta(message);
        return;
      }
      if (message.type === 'android:control-owner') {
        if (typeof message.controller === 'boolean') this.isController = message.controller;
        this.onStatus({ ...message, status: 'control-owner' });
      }
      if (message.type === 'android:ack') {
        if (Number.isSafeInteger(message.sequence)) {
          const pending = this.pendingAcks.get(message.sequence);
          if (pending) {
            this.pendingAcks.delete(message.sequence);
            pending.resolve(message);
          } else {
            this.recentAcks.set(message.sequence, message);
            if (this.recentAcks.size > 64) this.recentAcks.delete(this.recentAcks.keys().next().value!);
          }
        }
        return;
      }
      return;
    }
    if (data instanceof ArrayBuffer) {
      this.decodePacket(new Uint8Array(data));
      return;
    }
    if (typeof Blob !== 'undefined' && data instanceof Blob) {
      void data.arrayBuffer().then((buffer) => this.decodePacket(new Uint8Array(buffer)));
    }
  }

  private setMeta(meta: any): void {
    const width = Number(meta.width) || 0;
    const height = Number(meta.height) || 0;
    if (!width || !height) return;
    const changed = width !== this.width || height !== this.height;
    const nextCaptureGeneration = Number(meta.captureGeneration);
    const nextConfigVersion = Number(meta.configVersion);
    const streamChanged = (Number.isInteger(nextCaptureGeneration) && nextCaptureGeneration > 0
      && this.captureGeneration > 0 && nextCaptureGeneration !== this.captureGeneration)
      || (Number.isInteger(nextConfigVersion) && nextConfigVersion > 0
        && this.configVersion > 0 && nextConfigVersion !== this.configVersion);
    this.codec = meta.codec || this.codec || 'h264';
    if (Number.isInteger(nextCaptureGeneration) && nextCaptureGeneration > 0) this.captureGeneration = nextCaptureGeneration >>> 0;
    if (Number.isInteger(nextConfigVersion) && nextConfigVersion > 0) this.configVersion = nextConfigVersion >>> 0;
    const nextMediaEpoch = Number(meta.mediaEpoch);
    if (Number.isInteger(nextMediaEpoch) && nextMediaEpoch > 0) this.mediaEpoch = nextMediaEpoch >>> 0;
    if (Number.isInteger(Number(meta.geometryVersion)) && Number(meta.geometryVersion) > 0) this.geometryVersion = Number(meta.geometryVersion) >>> 0;
    this.width = width;
    this.height = height;
    if (changed) for (const canvas of this.canvases) this.syncCanvas(canvas);
    if (changed || streamChanged) this.closeDecoder();
    this.onMeta({ ...meta, width, height, codec: this.codec });
  }

  private syncCanvas(canvas: HTMLCanvasElement): void {
    if (this.width && this.height && (canvas.width !== this.width || canvas.height !== this.height)) {
      canvas.width = this.width;
      canvas.height = this.height;
    }
  }

  private decodePacket(packet: Uint8Array): void {
    const dvm2 = packet.byteLength >= 56 && packet[0] === 0x44 && packet[1] === 0x56
      && packet[2] === 0x4d && packet[3] === 0x32;
    const headerSize = dvm2 ? 56 : HEADER_SIZE;
    if (packet.byteLength < headerSize || packet[0] !== 0x44 || packet[1] !== 0x56 || packet[2] !== 0x4d
      || (dvm2 ? packet[4] !== 2 || packet[5] !== 1 : packet[3] !== 0x31 || packet[4] !== 1)) return;
    const view = new DataView(packet.buffer, packet.byteOffset, packet.byteLength);
    if (dvm2 && (packet[5] !== 1 || view.getUint32(52) !== 0)) return;
    if (!dvm2 && view.getUint16(22) !== 0) return;
    const flags = dvm2 ? view.getUint16(6) : packet[5];
    if (flags & ~3) return;
    const width = view.getUint16(dvm2 ? 40 : 6);
    const height = view.getUint16(dvm2 ? 42 : 8);
    const timestamp = dvm2
      ? Math.min(Number.MAX_SAFE_INTEGER, view.getUint32(24) * 0x100000000 + view.getUint32(28))
      : view.getUint32(10) * 0x100000000 + view.getUint32(14);
    const payloadLength = view.getUint32(dvm2 ? 44 : 18);
    if (payloadLength <= 0 || payloadLength > MAX_PACKET_BYTES || headerSize + payloadLength !== packet.byteLength) return;
    const payload = packet.subarray(headerSize, headerSize + payloadLength);
    this.lastReceivedAt = Date.now();
    if (dvm2) this.lastFrameId = view.getUint32(20);
    if (dvm2) {
      const packetCaptureGeneration = view.getUint32(8);
      const packetGeometryVersion = view.getUint32(12);
      const packetConfigVersion = view.getUint32(16);
      if (packetCaptureGeneration && this.captureGeneration && packetCaptureGeneration < this.captureGeneration) return;
      if (packetGeometryVersion || packetCaptureGeneration || packetConfigVersion) {
        this.setMeta({
          width,
          height,
          codec: this.codec || 'h264',
          captureGeneration: packetCaptureGeneration,
          geometryVersion: packetGeometryVersion,
          configVersion: packetConfigVersion,
        });
      }
      const packetEpoch = view.getUint32(48);
      if (packetEpoch && this.mediaEpoch && packetEpoch !== this.mediaEpoch) {
        this.closeDecoder();
        this.waitingForKeyFrame = true;
      }
      if (packetEpoch) this.mediaEpoch = packetEpoch;
    }
    if (dvm2 && (flags & 2)) {
      this.closeDecoder();
      this.waitingForKeyFrame = true;
    }
    if (!this.width || width !== this.width || height !== this.height) {
      this.setMeta({ width, height, codec: this.codec || 'h264' });
    }
    const configPacket = !dvm2 && !!(flags & 2);
    if (configPacket && !(flags & 1)) {
      this.waitingForKeyFrame = true;
      return;
    }
    if (typeof (globalThis as any).VideoDecoder !== 'function'
      || typeof (globalThis as any).EncodedVideoChunk !== 'function') {
      if (!this.decoderErrorReported) {
        this.decoderErrorReported = true;
        const secure = typeof (globalThis as any).isSecureContext === 'boolean'
          ? Boolean((globalThis as any).isSecureContext) : true;
        this.reportError(
          new Error(secure ? '当前 Electron 没有可用的 WebCodecs 视频解码器' : '当前页面不是安全上下文，WebCodecs 不可用'),
          secure ? 'WEBCODECS_UNAVAILABLE' : 'INSECURE_CONTEXT',
          'capability',
        );
      }
      return;
    }
    const keyFrame = !!(flags & 1);
    if (this.waitingForKeyFrame && !keyFrame) return;
    if (!this.decoder && !this.createDecoder(payload)) return;
    if (!this.decoder || this.decoder.state === 'closed') return;
    if (this.decoder.decodeQueueSize > MAX_DECODE_QUEUE) {
      this.closeDecoder();
      this.waitingForKeyFrame = true;
      this.reportError(new Error('视频解码队列积压，正在等待关键帧恢复'), 'MEDIA_CONGESTED', 'transport');
      this.requestResync('decode-queue');
      return;
    }
    try {
      const Chunk = (globalThis as any).EncodedVideoChunk;
      this.decoder.decode(new Chunk({
        type: keyFrame ? 'key' : 'delta',
        timestamp,
        data: payload,
      }));
      if (keyFrame) this.waitingForKeyFrame = false;
    } catch (error) {
      this.reportError(error, 'DECODE_FAILED', 'decode');
      this.closeDecoder();
      this.waitingForKeyFrame = true;
    }
  }

  private createDecoder(configPayload: Uint8Array): boolean {
    this.closeDecoder();
    this.codec = avcCodecFromAnnexB(configPayload);
    try {
      const Decoder = (globalThis as any).VideoDecoder;
      this.decoder = new Decoder({
        output: (frame: VideoFrame) => {
          for (const canvas of this.canvases) {
            if (canvas.hidden) continue;
            const context = this.contexts.get(canvas);
            if (!context) continue;
            try { context.drawImage(frame, 0, 0, canvas.width, canvas.height); } catch { /* surface may be detached */ }
          }
          this.hasFrame = true;
          this.lastPresentedAt = Date.now();
          this.lastPresentedFrameId = this.lastFrameId;
          this.decodeErrorCount = 0;
          this.onFrame({ width: this.width, height: this.height, geometryVersion: this.geometryVersion });
          frame.close();
        },
        error: (error: Error) => {
          this.decodeErrorCount++;
          this.reportError(error, 'DECODE_FAILED', 'decode');
          this.waitingForKeyFrame = true;
          this.requestResync('decode-error');
          this.closeDecoder();
        },
      });
      const config = { codec: this.codec, optimizeForLatency: true, hardwareAcceleration: 'prefer-hardware' };
      try { this.decoder.configure(config); } catch {
        this.decoder.configure({ codec: this.codec, optimizeForLatency: true });
      }
    } catch (error) {
      this.decoder = null;
      this.reportError(error, 'CODEC_UNSUPPORTED', 'capability');
      this.waitingForKeyFrame = true;
      return false;
    }
    return true;
  }

  private closeDecoder(): void {
    if (this.decoder) {
      try { this.decoder.close(); } catch { /* ignore */ }
      this.decoder = null;
    }
    this.waitingForKeyFrame = true;
  }

  private requestResync(reason: string): void {
    if (this.protocolVersion !== 2 || this.socket?.readyState !== WebSocket.OPEN) return;
    try {
      this.socket.send(JSON.stringify({ v: 2, type: 'video.resync', deviceId: this.deviceId, mediaEpoch: this.mediaEpoch, reason, lastFrameId: this.lastFrameId }));
    } catch { /* reconnect handles it */ }
  }

  private sendFeedback(socket: WebSocket): void {
    if (this.protocolVersion !== 2 || this.socket !== socket || socket.readyState !== WebSocket.OPEN) return;
    try {
      socket.send(JSON.stringify({
        v: 2,
        type: 'video.feedback',
        deviceId: this.deviceId,
        mediaEpoch: this.mediaEpoch,
        receivedFrameId: this.lastFrameId,
        presentedFrameId: this.lastPresentedFrameId,
        decodeQueue: this.decoder?.decodeQueueSize || 0,
        receiveToPresentMs: this.lastReceivedAt && this.lastPresentedAt ? Math.max(0, this.lastPresentedAt - this.lastReceivedAt) : undefined,
        visibility: typeof document === 'undefined' ? 'unknown' : document.visibilityState,
      }));
    } catch { /* reconnect handles it */ }
  }

  private scheduleReconnect(): void {
    if (!this.shouldReconnect || this.reconnectTimer || !this.deviceId) return;
    const delay = Math.min(15000, 500 * (2 ** Math.min(this.reconnectAttempt++, 5)));
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.open(this.generation);
    }, delay);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private clearResubscribeTimer(): void {
    if (this.resubscribeTimer) clearTimeout(this.resubscribeTimer);
    this.resubscribeTimer = null;
  }

  private scheduleResubscribe(generation: number): void {
    if (!this.shouldReconnect || !this.deviceId || this.resubscribeTimer) return;
    const delay = Math.min(15000, 1000 * (2 ** Math.min(this.resubscribeAttempt++, 5)));
    this.resubscribeTimer = setTimeout(() => {
      this.resubscribeTimer = null;
      if (!this.shouldReconnect || generation !== this.generation || !this.deviceId) return;
      const socket = this.socket;
      if (socket?.readyState === WebSocket.OPEN) {
        try {
            socket.send(JSON.stringify(this.protocolVersion === 2
              ? { v: 2, type: 'video.subscribe', deviceId: this.deviceId, preference: 'balanced', mediaEpoch: 1 }
              : { type: 'android:subscribe', deviceId: this.deviceId }));
          return;
        } catch (error) {
          this.onError(error instanceof Error ? error : new Error(String(error)));
        }
      }
      this.scheduleReconnect();
    }, delay);
  }
}
