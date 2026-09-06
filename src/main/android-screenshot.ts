import { runAdb } from './android-devices';

interface CachedScreenshot {
  promise: Promise<Buffer>;
  startedAt: number;
}

/** Coalesce screenshot requests from the preview and fullscreen surfaces. */
export class AndroidScreenshotManager {
  private readonly inFlight = new Map<string, CachedScreenshot>();

  async capture(deviceId: string, capture: () => Promise<Buffer> = () => runAdb([
    '-s', deviceId, 'exec-out', 'screencap', '-p',
  ], { maxBuffer: 8 * 1024 * 1024 })): Promise<Buffer> {
    const id = String(deviceId || '').trim();
    if (!id) throw new Error('请先选择 Android 设备');
    const existing = this.inFlight.get(id);
    if (existing) return existing.promise;
    const promise = capture().finally(() => {
      const current = this.inFlight.get(id);
      if (current?.promise === promise) this.inFlight.delete(id);
    });
    this.inFlight.set(id, { promise, startedAt: Date.now() });
    return promise;
  }

  clear(deviceId?: string): void {
    if (deviceId) this.inFlight.delete(String(deviceId).trim());
    else this.inFlight.clear();
  }
}

