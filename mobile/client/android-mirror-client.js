// DuoCLI Android mirror client.
// The server sends a small DuoCLI envelope around each Annex-B H.264 packet;
// WebCodecs decodes it directly without an image/JPEG round trip.
(function (global) {
  'use strict';

  const HEADER_SIZE = 24;
  const MAX_DECODE_QUEUE = 3;
  const MAX_PACKET_BYTES = 16 * 1024 * 1024;

  function avcCodecFromAnnexB(data) {
    for (let i = 0; i + 4 < data.length; i++) {
      let start = 0;
      if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1) start = i + 3;
      else if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 0 && data[i + 3] === 1) start = i + 4;
      if (!start || start >= data.length) continue;
      const nalType = data[start] & 0x1f;
      if (nalType !== 7 || start + 3 >= data.length) continue;
      const hex = (value) => value.toString(16).padStart(2, '0').toUpperCase();
      return `avc1.${hex(data[start + 1])}${hex(data[start + 2])}${hex(data[start + 3])}`;
    }
    return 'avc1.42E01E';
  }

  class AndroidMirrorClient {
    constructor(options) {
      this.getToken = options.getToken || (() => '');
      this.getTicket = options.getTicket || null;
      this.protocolVersion = Number(options.protocolVersion) === 2 ? 2 : 1;
      this.onStatus = options.onStatus || (() => {});
      this.onMeta = options.onMeta || (() => {});
      this.onFrame = options.onFrame || (() => {});
      this.onAck = options.onAck || (() => {});
      this.onError = options.onError || (() => {});
      this.socket = null;
      this.deviceId = '';
      this.sequence = 0;
      this.reconnectTimer = null;
      this.resubscribeTimer = null;
      this.reconnectAttempt = 0;
      this.resubscribeAttempt = 0;
      this.lastError = '';
      this.decoder = null;
      this.codec = '';
      this.width = 0;
      this.height = 0;
      this.captureGeneration = 0;
      this.configVersion = 0;
      this.mediaEpoch = 0;
      this.geometryVersion = 0;
      this.lastFrameId = 0;
      this.lastPresentedFrameId = 0;
      this.lastReceivedAt = 0;
      this.canvases = new Set();
      this.contexts = new Map();
      this.hasFrame = false;
      this.lastStatus = 'stopped';
      this.decoderErrorReported = false;
      this.connectionGeneration = 0;
      this.controlEpoch = 1;
      this.waitingForKeyFrame = true;
      this.lastPresentedAt = 0;
      this.decodeErrorCount = 0;
      this.pendingAcks = new Map();
      this.recentAcks = new Map();
      this.leaseTimer = null;
      this.feedbackTimer = null;
      this.isController = false;
    }

    connect(deviceId) {
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
      this.open(this.connectionGeneration);
    }

    close() {
      this.connectionGeneration++;
      this.shouldReconnect = false;
      this.clearReconnectTimer();
      this.clearResubscribeTimer();
      this.closeDecoder();
      const socket = this.socket;
      this.socket = null;
      if (socket) {
        socket.onopen = null;
        socket.onmessage = null;
        socket.onclose = null;
        socket.onerror = null;
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
      this.geometryVersion = 0;
      this.lastFrameId = 0;
      this.lastPresentedFrameId = 0;
      this.lastReceivedAt = 0;
      this.controlEpoch = 1;
      this.isController = false;
      if (this.feedbackTimer) clearInterval(this.feedbackTimer);
      this.feedbackTimer = null;
      for (const pending of this.pendingAcks.values()) pending.reject(new Error('Android 镜像连接已关闭'));
      this.pendingAcks.clear();
      this.recentAcks.clear();
    }

    attachCanvas(canvas) {
      if (!canvas) return;
      this.canvases.add(canvas);
      this.syncCanvas(canvas);
      this.contexts.set(canvas, canvas.getContext('2d', { alpha: false, desynchronized: true }));
    }

    detachCanvas(canvas) {
      this.canvases.delete(canvas);
      this.contexts.delete(canvas);
    }

    isReady() {
      return !!this.socket && this.socket.readyState === WebSocket.OPEN && this.lastStatus === 'ready';
    }

    getControlEpoch() {
      return this.controlEpoch;
    }

    reportError(error, code = 'DECODE_FAILED', stage = 'decode') {
      const value = error instanceof Error ? error : new Error(String(error));
      value.code = code;
      value.stage = stage;
      this.lastError = value.message;
      this.onError(value);
    }

    sendInput(input, allowWithoutController = false) {
      if (!this.isReady() || (!this.isController && !allowWithoutController)) return null;
      if (this.protocolVersion === 2 && this.geometryVersion <= 0) return null;
      const sequence = ++this.sequence;
      try {
        this.socket.send(JSON.stringify(this.protocolVersion === 2
          ? { v: 2, type: 'control.input', deviceId: this.deviceId, seq: sequence, controlEpoch: this.controlEpoch, geometryVersion: this.geometryVersion, input }
          : { type: 'android:input', deviceId: this.deviceId, sequence, input }));
        return sequence;
      } catch (error) {
        this.onError(error);
        return null;
      }
    }

    // A pointer that was already pressed must be released even if the browser
    // has not processed the latest control-owner notification yet. The server
    // still checks the lease and rejects this when another client owns it.
    sendEmergencyInput(input) {
      if (input?.type !== 'touch' || !['up', 'cancel'].includes(input.action)) return null;
      return this.sendInput(input, true);
    }

    waitForAck(sequence, timeoutMs = 1200) {
      if (!Number.isSafeInteger(sequence)) return Promise.reject(new Error('无效的输入序号'));
      const cached = this.recentAcks.get(sequence);
      if (cached) {
        this.recentAcks.delete(sequence);
        return Promise.resolve(cached);
      }
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          this.pendingAcks.delete(sequence);
          reject(Object.assign(new Error('输入回执超时，结果未知'), { code: 'INPUT_RESULT_UNKNOWN', stage: 'control' }));
        }, timeoutMs);
        this.pendingAcks.set(sequence, { resolve: (value) => { clearTimeout(timer); resolve(value); }, reject: (error) => { clearTimeout(timer); reject(error); } });
      });
    }

    claimControl(takeover = true) {
      if (this.socket && this.socket.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(this.protocolVersion === 2 ? { v: 2, type: 'control.claim', takeover } : { type: 'android:claim' }));
    }

    async open(generation = this.connectionGeneration) {
      if (!this.shouldReconnect || !this.deviceId || generation !== this.connectionGeneration) return;
      this.clearReconnectTimer();
      const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
      let authQuery = `token=${encodeURIComponent(String(this.getToken() || ''))}`;
      if (this.protocolVersion === 2 && this.getTicket) {
        try {
          const ticket = await this.getTicket(this.deviceId, 'video');
          if (ticket) authQuery = `ticket=${encodeURIComponent(String(ticket))}`;
        } catch (error) {
          this.reportError(error, 'AUTH_EXPIRED', 'auth');
        }
      }
      if (!this.shouldReconnect || !this.deviceId || generation !== this.connectionGeneration) return;
      const endpoint = this.protocolVersion === 2 ? '/android-video-ws' : '/android-ws';
      const url = `${scheme}//${location.host}${endpoint}?${authQuery}`;
      let socket;
      try {
        socket = new WebSocket(url);
        socket.binaryType = 'arraybuffer';
      } catch (error) {
        this.onError(error);
        this.scheduleReconnect();
        return;
      }
      this.socket = socket;
      const socketGeneration = this.connectionGeneration;
      const isCurrentSocket = () => this.socket === socket && this.connectionGeneration === socketGeneration;
      socket.onopen = () => {
        if (!isCurrentSocket()) return;
        this.reconnectAttempt = 0;
        this.resubscribeAttempt = 0;
        try {
          socket.send(JSON.stringify(this.protocolVersion === 2
            ? { v: 2, type: 'video.subscribe', deviceId: this.deviceId, preference: 'balanced', mediaEpoch: 1 }
            : { type: 'android:subscribe', deviceId: this.deviceId }));
          if (this.leaseTimer) clearInterval(this.leaseTimer);
          this.leaseTimer = setInterval(() => {
            if (isCurrentSocket() && socket.readyState === WebSocket.OPEN) {
              try { socket.send(JSON.stringify(this.protocolVersion === 2 ? { v: 2, type: 'control.renew', controlEpoch: this.controlEpoch } : { type: 'android:renew' })); } catch { /* reconnect handles it */ }
            }
          }, 2000);
          if (this.protocolVersion === 2) this.feedbackTimer = setInterval(() => this.sendFeedback(socket), 500);
        } catch (error) {
          this.onError(error);
          socket.close();
        }
      };
      socket.onmessage = (event) => {
        if (isCurrentSocket()) this.handleMessage(event.data, socketGeneration);
      };
      socket.onerror = () => {
        if (!isCurrentSocket()) return;
        this.reportError(new Error('Android 实时镜像网络连接失败'), 'MEDIA_SOCKET_ERROR', 'transport');
      };
      socket.onclose = () => {
        if (!isCurrentSocket()) return;
        if (this.leaseTimer) clearInterval(this.leaseTimer);
        this.leaseTimer = null;
        if (this.feedbackTimer) clearInterval(this.feedbackTimer);
        this.feedbackTimer = null;
        this.connectionGeneration++;
        this.socket = null;
        this.closeDecoder();
        this.decoderErrorReported = false;
        this.lastStatus = 'disconnected';
        this.onStatus({ type: 'android:status', status: 'disconnected', deviceId: this.deviceId });
        this.scheduleReconnect();
      };
    }

    handleMessage(data, generation = this.connectionGeneration) {
      if (generation !== this.connectionGeneration) return;
      if (typeof data === 'string') {
        let message;
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
          if (typeof message.controller === 'boolean') this.isController = message.controller;
          this.lastStatus = message.status || 'unknown';
          if (message.status === 'ready') {
            this.lastError = '';
            this.resubscribeAttempt = 0;
            this.reconnectAttempt = 0;
          } else if (message.error) this.lastError = String(message.error);
          if (message.status === 'ready' && message.width && message.height) {
            this.setMeta(message);
          }
          this.onStatus(message);
          if (message.status === 'error') this.scheduleResubscribe();
          return;
        }
        if (message.type === 'android:meta') {
          this.setMeta(message);
          return;
        }
        if (message.type === 'android:ack') {
          if (Number.isSafeInteger(message.sequence)) {
            const pending = this.pendingAcks.get(message.sequence);
            if (pending) {
              this.pendingAcks.delete(message.sequence);
              pending.resolve(message);
            } else {
              this.recentAcks.set(message.sequence, message);
              if (this.recentAcks.size > 64) this.recentAcks.delete(this.recentAcks.keys().next().value);
            }
          }
          this.onAck(message);
          return;
        }
        if (message.type === 'android:control-owner') {
          if (typeof message.controller === 'boolean') this.isController = message.controller;
          this.onStatus({ ...message, status: 'control-owner' });
        }
        return;
      }
      if (data instanceof ArrayBuffer) {
        this.decodePacket(new Uint8Array(data), generation);
        return;
      }
      if (global.Blob && data instanceof Blob) {
        void data.arrayBuffer().then((buffer) => this.decodePacket(new Uint8Array(buffer), generation));
      }
    }

    setMeta(meta) {
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

    syncCanvas(canvas) {
      if (this.width && this.height && (canvas.width !== this.width || canvas.height !== this.height)) {
        canvas.width = this.width;
        canvas.height = this.height;
      }
    }

    decodePacket(packet, generation = this.connectionGeneration) {
      if (generation !== this.connectionGeneration) return;
      const view = new DataView(packet.buffer, packet.byteOffset, packet.byteLength);
      const dvm2 = packet.byteLength >= 56 && packet[0] === 0x44 && packet[1] === 0x56 && packet[2] === 0x4d && packet[3] === 0x32;
      const headerSize = dvm2 ? 56 : HEADER_SIZE;
      if (packet.byteLength < headerSize) return;
      if (!dvm2 && (packet[0] !== 0x44 || packet[1] !== 0x56 || packet[2] !== 0x4d || packet[3] !== 0x31)) return;
      if (dvm2 && (packet[4] !== 2 || packet[5] !== 1)) return;
      if (!dvm2 && packet[4] !== 1) return;
      if (dvm2 && (packet[5] !== 1 || view.getUint32(52) !== 0)) return;
      if (!dvm2 && view.getUint16(22) !== 0) return;
      const flags = dvm2 ? view.getUint16(6) : packet[5];
      if (flags & ~3) return;
      const width = view.getUint16(6 + (dvm2 ? 34 : 0));
      const height = view.getUint16(8 + (dvm2 ? 34 : 0));
      const timestamp = dvm2
        ? Math.min(Number.MAX_SAFE_INTEGER, view.getUint32(24) * 0x100000000 + view.getUint32(28))
        : view.getUint32(10) * 0x100000000 + view.getUint32(14);
      const payloadLength = view.getUint32(dvm2 ? 44 : 18);
      const maxPayload = dvm2 ? MAX_PACKET_BYTES : MAX_PACKET_BYTES;
      if (payloadLength <= 0 || payloadLength > maxPayload || headerSize + payloadLength !== packet.byteLength) return;
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
      if (!this.width || width !== this.width || height !== this.height) this.setMeta({ width, height, codec: this.codec || 'h264' });
      // CONFIG is parameter data, not a decodable access unit. Older servers
      // may still send it; consume it only to refresh the metadata and wait
      // for a real IDR before configuring the decoder.
      const configPacket = !dvm2 && !!(flags & 2);
      if (configPacket && !(flags & 1)) {
        this.waitingForKeyFrame = true;
        return;
      }
      if (typeof global.VideoDecoder !== 'function' || typeof global.EncodedVideoChunk !== 'function') {
        if (!this.decoderErrorReported) {
          this.decoderErrorReported = true;
          const secure = typeof global.isSecureContext === 'boolean' ? global.isSecureContext : true;
          this.reportError(
            new Error(secure ? '当前浏览器没有可用的 WebCodecs 视频解码器' : '当前页面不是安全上下文，WebCodecs 不可用'),
            secure ? 'WEBCODECS_UNAVAILABLE' : 'INSECURE_CONTEXT',
            'capability',
          );
        }
        return;
      }
      const keyFrame = !!(flags & 1);
      if (this.waitingForKeyFrame && !keyFrame) return;
      if (!this.decoder && !this.createDecoder(payload, generation)) return;
      if (!this.decoder || this.decoder.state === 'closed') return;
      if (this.decoder.decodeQueueSize > MAX_DECODE_QUEUE) {
        this.closeDecoder();
        this.waitingForKeyFrame = true;
        this.reportError(new Error('视频解码队列积压，正在等待关键帧恢复'), 'MEDIA_CONGESTED', 'transport');
        this.requestResync('decode-queue');
        return;
      }
      try {
        this.decoder.decode(new EncodedVideoChunk({
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

    createDecoder(configPayload, generation = this.connectionGeneration) {
      this.closeDecoder();
      const codec = avcCodecFromAnnexB(configPayload);
      this.codec = codec;
      try {
        this.decoder = new VideoDecoder({
          output: (frame) => {
            if (generation !== this.connectionGeneration) {
              frame.close();
              return;
            }
            for (const canvas of this.canvases) {
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
          error: (error) => {
            if (generation !== this.connectionGeneration) return;
            this.decodeErrorCount++;
            this.reportError(error, 'DECODE_FAILED', 'decode');
            this.waitingForKeyFrame = true;
            this.requestResync('decode-error');
            this.closeDecoder();
          },
        });
        const config = { codec, optimizeForLatency: true, hardwareAcceleration: 'prefer-hardware' };
        try {
          this.decoder.configure(config);
        } catch {
          this.decoder.configure({ codec, optimizeForLatency: true });
        }
      } catch (error) {
        this.decoder = null;
        this.reportError(error, 'CODEC_UNSUPPORTED', 'capability');
        this.waitingForKeyFrame = true;
        return false;
      }
      return true;
    }

    closeDecoder() {
      if (this.decoder) {
        try { this.decoder.close(); } catch { /* ignore */ }
        this.decoder = null;
      }
      this.waitingForKeyFrame = true;
    }

    requestResync(reason) {
      if (this.protocolVersion !== 2 || !this.socket || this.socket.readyState !== WebSocket.OPEN) return;
      try { this.socket.send(JSON.stringify({ v: 2, type: 'video.resync', deviceId: this.deviceId, mediaEpoch: this.mediaEpoch, reason, lastFrameId: this.lastFrameId })); } catch { /* reconnect handles it */ }
    }

    sendFeedback(socket) {
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

    scheduleReconnect() {
      if (!this.shouldReconnect || this.reconnectTimer || !this.deviceId) return;
      const generation = this.connectionGeneration;
      const delay = Math.min(15000, 500 * (2 ** Math.min(this.reconnectAttempt++, 5)));
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        if (generation !== this.connectionGeneration) return;
        this.open(generation);
      }, delay);
    }

    clearReconnectTimer() {
      if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    clearResubscribeTimer() {
      if (this.resubscribeTimer) clearTimeout(this.resubscribeTimer);
      this.resubscribeTimer = null;
    }

    scheduleResubscribe() {
      if (!this.shouldReconnect || !this.deviceId || this.resubscribeTimer) return;
      const generation = this.connectionGeneration;
      const delay = Math.min(15000, 1000 * (2 ** Math.min(this.resubscribeAttempt++, 5)));
      this.resubscribeTimer = setTimeout(() => {
        this.resubscribeTimer = null;
        if (generation !== this.connectionGeneration) return;
        const socket = this.socket;
        if (socket && socket.readyState === WebSocket.OPEN) {
          try {
            socket.send(JSON.stringify(this.protocolVersion === 2
              ? { v: 2, type: 'video.subscribe', deviceId: this.deviceId, preference: 'balanced', mediaEpoch: 1 }
              : { type: 'android:subscribe', deviceId: this.deviceId }));
            return;
          } catch (error) {
            this.onError(error);
          }
        }
        this.scheduleReconnect();
      }, delay);
    }
  }

  // JPEG fallback receiver for browsers without WebCodecs or when the H.264
  // media socket is recovering. It consumes strict DVM2 JPEG envelopes and
  // keeps at most one decode plus one newest pending frame per client.
  class AndroidJpegMirrorClient {
    constructor(options) {
      this.getToken = options.getToken || (() => '');
      this.getTicket = options.getTicket || null;
      this.onStatus = options.onStatus || (() => {});
      this.onMeta = options.onMeta || (() => {});
      this.onFrame = options.onFrame || (() => {});
      this.onError = options.onError || (() => {});
      this.socket = null;
      this.deviceId = '';
      this.shouldReconnect = false;
      this.reconnectTimer = null;
      this.reconnectAttempt = 0;
      this.generation = 0;
      this.status = 'stopped';
      this.width = 0;
      this.height = 0;
      this.deviceWidth = 0;
      this.deviceHeight = 0;
      this.captureGeneration = 0;
      this.geometryVersion = 0;
      this.canvases = new Set();
      this.contexts = new Map();
      this.pendingPacket = null;
      this.decoding = false;
      this.hasFrame = false;
      this.lastPresentedAt = 0;
      this.fps = 8;
      this.quality = 72;
      this.scale = 0.75;
    }

    connect(deviceId, options = {}) {
      const next = String(deviceId || '').trim();
      if (!next) return;
      if (this.deviceId !== next) this.close();
      this.deviceId = next;
      this.fps = Math.max(1, Math.min(8, Number(options.fps) || 8));
      this.quality = Math.max(30, Math.min(95, Number(options.quality) || 72));
      this.scale = Math.max(0.1, Math.min(1, Number(options.scale) || 0.75));
      this.shouldReconnect = true;
      this.reconnectAttempt = 0;
      this.clearReconnectTimer();
      this.open(this.generation);
    }

    close() {
      this.shouldReconnect = false;
      this.generation++;
      this.clearReconnectTimer();
      const socket = this.socket;
      this.socket = null;
      if (socket) {
        socket.onopen = null; socket.onmessage = null; socket.onerror = null; socket.onclose = null;
        try { socket.close(1000, 'client closed'); } catch { /* ignore */ }
      }
      this.deviceId = '';
      this.status = 'stopped';
      this.pendingPacket = null;
      this.decoding = false;
      this.hasFrame = false;
      this.width = 0;
      this.height = 0;
      this.deviceWidth = 0;
      this.deviceHeight = 0;
      this.captureGeneration = 0;
      this.geometryVersion = 0;
      this.onStatus({ type: 'android:jpeg-status', status: 'stopped' });
    }

    attachCanvas(canvas) {
      if (!canvas) return;
      this.canvases.add(canvas);
      this.contexts.set(canvas, canvas.getContext('2d', { alpha: false, desynchronized: true }));
      if (this.width && this.height) this.syncCanvas(canvas);
    }

    detachCanvas(canvas) {
      this.canvases.delete(canvas);
      this.contexts.delete(canvas);
    }

    isReady() {
      return !!this.socket && this.socket.readyState === WebSocket.OPEN && this.status === 'ready';
    }

    async open(generation) {
      if (!this.shouldReconnect || !this.deviceId || generation !== this.generation) return;
      const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
      let authQuery = `token=${encodeURIComponent(String(this.getToken() || ''))}`;
      if (this.getTicket) {
        try {
          const ticket = await this.getTicket(this.deviceId, 'video');
          if (ticket) authQuery = `ticket=${encodeURIComponent(String(ticket))}`;
        } catch (error) {
          this.reportError(error, 'AUTH_EXPIRED', 'auth');
        }
      }
      if (!this.shouldReconnect || !this.deviceId || generation !== this.generation) return;
      let socket;
      try { socket = new WebSocket(`${scheme}//${location.host}/android-jpeg-ws?${authQuery}`); }
      catch (error) { this.onError(Object.assign(error instanceof Error ? error : new Error(String(error)), { code: 'MEDIA_SOCKET_ERROR', stage: 'transport' })); this.scheduleReconnect(); return; }
      socket.binaryType = 'arraybuffer';
      this.socket = socket;
      const current = () => this.socket === socket && this.generation === generation;
      socket.onopen = () => {
        if (!current()) return;
        this.reconnectAttempt = 0;
        try { socket.send(JSON.stringify({ type: 'android:jpeg-subscribe', deviceId: this.deviceId, fps: this.fps, quality: this.quality, scale: this.scale })); }
        catch (error) { this.onError(error); try { socket.close(); } catch {} }
      };
      socket.onmessage = (event) => { if (current()) this.handleMessage(event.data, generation); };
      socket.onerror = () => { if (current()) this.reportError(new Error('JPEG 兼容画面连接失败'), 'MEDIA_SOCKET_ERROR', 'transport'); };
      socket.onclose = () => {
        if (!current()) return;
        this.socket = null;
        this.status = 'disconnected';
        this.onStatus({ type: 'android:jpeg-status', status: 'disconnected', deviceId: this.deviceId });
        this.scheduleReconnect();
      };
    }

    handleMessage(data, generation) {
      if (typeof data === 'string') {
        let message;
        try { message = JSON.parse(data); } catch { return; }
      if (message.type === 'android:jpeg-meta') {
          this.deviceWidth = Number(message.width) || this.deviceWidth;
          this.deviceHeight = Number(message.height) || this.deviceHeight;
          if (Number.isInteger(Number(message.captureGeneration)) && Number(message.captureGeneration) > 0) this.captureGeneration = Number(message.captureGeneration) >>> 0;
          if (Number.isInteger(Number(message.geometryVersion)) && Number(message.geometryVersion) > 0) this.geometryVersion = Number(message.geometryVersion) >>> 0;
          this.onMeta({ ...message, width: this.deviceWidth, height: this.deviceHeight });
        } else if (message.type === 'android:jpeg-status') {
          this.status = message.status || 'unknown';
          if (message.width && message.height) {
            this.deviceWidth = Number(message.width) || this.deviceWidth;
            this.deviceHeight = Number(message.height) || this.deviceHeight;
          }
          this.onStatus(message);
        }
        return;
      }
      if (data instanceof ArrayBuffer) this.enqueuePacket(new Uint8Array(data), generation);
      else if (global.Blob && data instanceof Blob) void data.arrayBuffer().then((buffer) => this.enqueuePacket(new Uint8Array(buffer), generation));
    }

    enqueuePacket(packet, generation) {
      if (generation !== this.generation || packet.byteLength < 56) return;
      const view = new DataView(packet.buffer, packet.byteOffset, packet.byteLength);
      const magic = String.fromCharCode(packet[0], packet[1], packet[2], packet[3]);
      const kind = packet[5];
      const payloadLength = view.getUint32(44);
      const flags = view.getUint16(6);
      if (magic !== 'DVM2' || packet[4] !== 2 || kind !== 2 || (flags & ~2) !== 0 || view.getUint32(52) !== 0
        || !payloadLength || payloadLength > 4 * 1024 * 1024 || packet.byteLength !== 56 + payloadLength) return;
      const width = view.getUint16(40);
      const height = view.getUint16(42);
      if (!width || !height) return;
      const packetCaptureGeneration = view.getUint32(8);
      const packetGeometryVersion = view.getUint32(12);
      if (packetCaptureGeneration && this.captureGeneration && packetCaptureGeneration < this.captureGeneration) return;
      const geometryChanged = packetGeometryVersion > 0 && packetGeometryVersion !== this.geometryVersion;
      if (packetCaptureGeneration) this.captureGeneration = packetCaptureGeneration;
      if (packetGeometryVersion) this.geometryVersion = packetGeometryVersion;
      this.width = width; this.height = height;
      for (const canvas of this.canvases) this.syncCanvas(canvas);
      if (geometryChanged) this.onMeta({
        type: 'android:jpeg-meta',
        deviceId: this.deviceId,
        transport: 'jpeg-ws',
        width: this.deviceWidth || width,
        height: this.deviceHeight || height,
        captureGeneration: this.captureGeneration,
        geometryVersion: this.geometryVersion,
      });
      this.pendingPacket = packet.slice(0);
      void this.pumpDecode(generation);
    }

    async pumpDecode(generation) {
      if (this.decoding || !this.pendingPacket) return;
      this.decoding = true;
      const packet = this.pendingPacket;
      this.pendingPacket = null;
      try {
        const payload = packet.slice(56);
        const blob = new Blob([payload], { type: 'image/jpeg' });
        let bitmap = null;
        if (typeof global.createImageBitmap === 'function') bitmap = await global.createImageBitmap(blob);
        if (generation !== this.generation) { bitmap?.close?.(); return; }
        for (const canvas of this.canvases) {
          const context = this.contexts.get(canvas);
          if (!context) continue;
          try {
            if (bitmap) context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
            else await this.drawBlobWithImage(context, canvas, blob);
          } catch { /* detached surface */ }
        }
        bitmap?.close?.();
        this.hasFrame = true;
        this.lastPresentedAt = Date.now();
        this.status = 'ready';
        const packetView = new DataView(packet.buffer, packet.byteOffset, packet.byteLength);
        this.onFrame({
          width: this.deviceWidth || this.width,
          height: this.deviceHeight || this.height,
          frameId: packetView.getUint32(20),
          captureGeneration: packetView.getUint32(8),
          geometryVersion: packetView.getUint32(12),
        });
      } catch (error) {
        this.reportError(error, 'DECODE_FAILED', 'decode');
      } finally {
        this.decoding = false;
        if (this.pendingPacket) void this.pumpDecode(generation);
      }
    }

    drawBlobWithImage(context, canvas, blob) {
      return new Promise((resolve, reject) => {
        const image = new Image();
        const url = URL.createObjectURL(blob);
        image.onload = () => { try { context.drawImage(image, 0, 0, canvas.width, canvas.height); resolve(); } catch (error) { reject(error); } finally { URL.revokeObjectURL(url); } };
        image.onerror = (error) => { URL.revokeObjectURL(url); reject(error); };
        image.src = url;
      });
    }

    syncCanvas(canvas) { if (this.width && this.height && (canvas.width !== this.width || canvas.height !== this.height)) { canvas.width = this.width; canvas.height = this.height; } }
    reportError(error, code, stage) { const value = error instanceof Error ? error : new Error(String(error)); value.code = code; value.stage = stage; this.onError(value); }
    scheduleReconnect() { if (!this.shouldReconnect || this.reconnectTimer || !this.deviceId) return; const generation = this.generation; const delay = Math.min(15000, 500 * (2 ** Math.min(this.reconnectAttempt++, 5))); this.reconnectTimer = setTimeout(() => { this.reconnectTimer = null; if (generation === this.generation) this.open(generation); }, delay); }
    clearReconnectTimer() { if (this.reconnectTimer) clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
  }

  global.DuoAndroidMirrorClient = AndroidMirrorClient;
  global.DuoAndroidJpegClient = AndroidJpegMirrorClient;
})(globalThis);
