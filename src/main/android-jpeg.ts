import sharp from 'sharp';
import { runAdb } from './android-devices';
import { AndroidScreenshotManager } from './android-screenshot';
import {
  DVM2_FLAG_DISCONTINUITY,
  DVM2_KIND_JPEG,
  encodeDvm2Frame,
} from './android-mirror-protocol';

export interface AndroidJpegClient {
  id: string;
  sendJson(message: Record<string, unknown>): void;
  sendBinary(data: Buffer): void;
}

interface JpegSubscription {
  client: AndroidJpegClient;
  fps: number;
  quality: number;
  scale: number;
  lastSentAt: number;
}

interface JpegSource {
  deviceId: string;
  clients: Map<string, JpegSubscription>;
  timer: NodeJS.Timeout | null;
  running: boolean;
  frameId: number;
  captureGeneration: number;
  geometryVersion: number;
  width: number;
  height: number;
  lastJpeg: Buffer | null;
  lastJpegAt: number;
}

const MAX_CLIENTS_PER_DEVICE = 16;
const MIN_FPS = 1;
const MAX_FPS = 8;
const MAX_QUALITY = 95;
const MAX_SCALE = 1;
const MIN_SCALE = 0.1;
const IDLE_GRACE_MS = 5000;

function clamp(value: unknown, min: number, max: number, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
}

function monotonicUs(): bigint {
  return process.hrtime.bigint() / 1000n;
}

/**
 * Shared, bounded JPEG fallback.  It deliberately uses ADB screenshots as a
 * portable R1/R3 fallback: one capture task is shared by all subscribers and
 * a slow client never creates a queue of stale images.
 */
export class AndroidJpegManager {
  private readonly sources = new Map<string, JpegSource>();

  constructor(private readonly screenshots = new AndroidScreenshotManager()) {}

  subscribe(deviceId: string, client: AndroidJpegClient, options: { fps?: unknown; quality?: unknown; scale?: unknown } = {}): void {
    const id = String(deviceId || '').trim();
    if (!id) throw new Error('请先选择 Android 设备');
    let source = this.sources.get(id);
    if (!source) {
      source = {
        deviceId: id,
        clients: new Map(),
        timer: null,
        running: false,
        frameId: 0,
        captureGeneration: 0,
        geometryVersion: 0,
        width: 0,
        height: 0,
        lastJpeg: null,
        lastJpegAt: 0,
      };
      this.sources.set(id, source);
    }
    if (!source.clients.has(client.id) && source.clients.size >= MAX_CLIENTS_PER_DEVICE) {
      throw new Error('JPEG 观看人数已达到上限');
    }
    if (source.timer) {
      clearTimeout(source.timer);
      source.timer = null;
    }
    const subscription: JpegSubscription = {
      client,
      fps: clamp(options.fps, MIN_FPS, MAX_FPS, 8),
      quality: clamp(options.quality, 30, MAX_QUALITY, 72),
      scale: clamp(options.scale, MIN_SCALE, MAX_SCALE, 0.75),
      lastSentAt: 0,
    };
    source.clients.set(client.id, subscription);
    client.sendJson({ type: 'android:jpeg-status', status: 'starting', deviceId: id, transport: 'jpeg-ws' });
    if (source.width && source.height) {
      client.sendJson(this.metaMessage(source));
    }
    this.ensureRunning(source);
  }

  unsubscribe(deviceId: string, clientId: string): void {
    const source = this.sources.get(String(deviceId || '').trim());
    if (!source) return;
    source.clients.delete(clientId);
    if (!source.clients.size) {
      if (source.timer) clearTimeout(source.timer);
      source.timer = setTimeout(() => {
        if (!source!.clients.size) this.sources.delete(source!.deviceId);
      }, IDLE_GRACE_MS);
    }
  }

  clear(deviceId?: string): void {
    const ids = deviceId ? [String(deviceId).trim()] : Array.from(this.sources.keys());
    for (const id of ids) {
      const source = this.sources.get(id);
      if (!source) continue;
      if (source.timer) clearTimeout(source.timer);
      source.clients.clear();
      this.sources.delete(id);
    }
  }

  private ensureRunning(source: JpegSource): void {
    if (source.running) return;
    source.running = true;
    void this.captureLoop(source);
  }

  private async captureLoop(source: JpegSource): Promise<void> {
    while (source.clients.size) {
      const started = Date.now();
      try {
        const png = await this.screenshots.capture(source.deviceId, () => runAdb([
          '-s', source.deviceId, 'exec-out', 'screencap', '-p',
        ], { timeout: 4000, maxBuffer: 8 * 1024 * 1024 }));
        const metadata = await sharp(png).metadata();
        const width = Number(metadata.width) || 0;
        const height = Number(metadata.height) || 0;
        if (!width || !height) throw new Error('截图没有有效尺寸');
        if (source.width !== width || source.height !== height) {
          source.width = width;
          source.height = height;
          source.captureGeneration = (source.captureGeneration + 1) >>> 0 || 1;
          source.geometryVersion = (source.geometryVersion + 1) >>> 0 || 1;
          source.lastJpeg = null;
          for (const { client } of source.clients.values()) client.sendJson(this.metaMessage(source));
        }
        const fastest = Math.max(...Array.from(source.clients.values(), ({ fps }) => fps), MIN_FPS);
        const maxScale = Math.max(...Array.from(source.clients.values(), ({ scale }) => scale), MIN_SCALE);
        const quality = Math.max(...Array.from(source.clients.values(), ({ quality }) => quality), 30);
        let pipeline = sharp(png);
        if (maxScale < 1) {
          pipeline = pipeline.resize({
            width: Math.max(1, Math.round(width * maxScale)),
            height: Math.max(1, Math.round(height * maxScale)),
            fit: 'fill',
          });
        }
        const jpeg = await pipeline.jpeg({ quality: Math.round(quality), progressive: false }).toBuffer();
        if (jpeg.length > 4 * 1024 * 1024) throw new Error('JPEG 帧过大');
        source.lastJpeg = jpeg;
        source.lastJpegAt = Date.now();
        source.frameId = (source.frameId + 1) >>> 0 || 1;
        const packet = encodeDvm2Frame({
          kind: DVM2_KIND_JPEG,
          flags: source.frameId === 1 ? DVM2_FLAG_DISCONTINUITY : 0,
          captureGeneration: source.captureGeneration,
          geometryVersion: source.geometryVersion,
          frameId: source.frameId,
          ptsUs: 0n,
          hostFrameReceivedUs: monotonicUs(),
          width: Math.max(1, Math.round(width * maxScale)),
          height: Math.max(1, Math.round(height * maxScale)),
          payload: jpeg,
        });
        const now = Date.now();
        for (const subscription of source.clients.values()) {
          if (subscription.lastSentAt && now - subscription.lastSentAt < 1000 / subscription.fps) continue;
          subscription.lastSentAt = now;
          // ws.bufferedAmount is intentionally checked by the route adapter;
          // this manager only emits one current frame to each subscriber.
          try { subscription.client.sendBinary(packet); } catch { /* client is removed on close */ }
        }
        for (const { client } of source.clients.values()) {
          client.sendJson({ type: 'android:jpeg-status', status: 'ready', deviceId: source.deviceId, transport: 'jpeg-ws', width, height, frameId: source.frameId });
        }
        const interval = Math.max(40, Math.round(1000 / fastest));
        const delay = Math.max(0, interval - (Date.now() - started));
        await new Promise((resolve) => setTimeout(resolve, delay));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        for (const { client } of source.clients.values()) {
          client.sendJson({ type: 'android:jpeg-status', status: 'error', deviceId: source.deviceId, transport: 'jpeg-ws', error: message });
        }
        await new Promise((resolve) => setTimeout(resolve, 700));
      }
    }
    source.running = false;
    source.timer = null;
  }

  private metaMessage(source: JpegSource): Record<string, unknown> {
    return {
      type: 'android:jpeg-meta',
      deviceId: source.deviceId,
      transport: 'jpeg-ws',
      width: source.width,
      height: source.height,
      captureGeneration: source.captureGeneration,
      geometryVersion: source.geometryVersion,
    };
  }
}
