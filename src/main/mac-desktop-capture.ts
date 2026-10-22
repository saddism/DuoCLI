import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import os from 'os';
import path from 'path';
import sharp from 'sharp';

const execFileAsync = promisify(execFile);

const MAC_INPUT_SOURCE = `
#include <ApplicationServices/ApplicationServices.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

static void post_mouse(CGEventType type, CGFloat x, CGFloat y) {
  CGEventRef ev = CGEventCreateMouseEvent(NULL, type, CGPointMake(x, y), kCGMouseButtonLeft);
  if (!ev) return;
  CGEventPost(kCGHIDEventTap, ev);
  CFRelease(ev);
}

int main(int argc, char **argv) {
  if (argc < 2) return 1;
  if (strcmp(argv[1], "click") == 0 && argc >= 4) {
    post_mouse(kCGEventLeftMouseDown, atof(argv[2]), atof(argv[3]));
    usleep(20000);
    post_mouse(kCGEventLeftMouseUp, atof(argv[2]), atof(argv[3]));
    return 0;
  }
  if (strcmp(argv[1], "drag") == 0 && argc >= 6) {
    double x1 = atof(argv[2]), y1 = atof(argv[3]);
    double x2 = atof(argv[4]), y2 = atof(argv[5]);
    int steps = argc >= 7 ? atoi(argv[6]) : 8;
    if (steps < 4) steps = 4;
    if (steps > 16) steps = 16;
    post_mouse(kCGEventLeftMouseDown, x1, y1);
    for (int i = 1; i <= steps; i++) {
      double t = (double)i / steps;
      post_mouse(kCGEventLeftMouseDragged, x1 + (x2 - x1) * t, y1 + (y2 - y1) * t);
      usleep(15000);
    }
    post_mouse(kCGEventLeftMouseUp, x2, y2);
    return 0;
  }
  return 1;
}
`;

let inputHelperPath: string | null = null;
let inputHelperPromise: Promise<string | null> | null = null;

export function isMacDesktopHost(): boolean {
  return process.platform === 'darwin';
}

export function normalizeDesktopPoint(value: unknown): number | null {
  const n = Math.round(Number(value));
  return Number.isFinite(n) && n >= 0 && n < 100000 ? n : null;
}

/** CGEvent 原点在主屏左下角，网页截图坐标是左上角。 */
export function toQuartzPoint(x: number, y: number, screenHeight: number): { x: number; y: number } {
  return { x, y: Math.max(0, screenHeight - y) };
}

function tryElectron(): typeof import('electron') | null {
  try {
    return require('electron') as typeof import('electron');
  } catch {
    return null;
  }
}

export async function getMacDisplaySize(): Promise<{ width: number; height: number }> {
  const electron = tryElectron();
  const display = electron?.screen?.getPrimaryDisplay?.();
  if (display?.size?.width && display.size.height) {
    return { width: Math.round(display.size.width), height: Math.round(display.size.height) };
  }
  throw new Error('无法读取显示器尺寸');
}

function describeCaptureError(error: any): string {
  const message = String(error?.stderr || error?.message || error);
  if (/not authorized|TCC|screen capture|Screen Recording|empty thumbnail|无法截取/i.test(message)) {
    return '请在系统设置 › 隐私与安全性 › 屏幕录制 中允许 DuoCLI，然后重启 DuoCLI';
  }
  return message || '截取桌面失败';
}

function describeInputError(error: any): string {
  const message = String(error?.stderr || error?.message || error);
  if (/not allowed|assistive|Accessibility|1002|not trusted/i.test(message)) {
    return '请在系统设置 › 隐私与安全性 › 辅助功能 中允许 DuoCLI';
  }
  return message || '电脑操作失败';
}

let captureInFlight: Promise<{ jpeg: Buffer; width: number; height: number }> | null = null;

export function captureMacDesktop(options: { quality?: number; scale?: number } = {}): Promise<{
  jpeg: Buffer;
  width: number;
  height: number;
}> {
  if (captureInFlight) return captureInFlight;
  captureInFlight = captureMacDesktopNow(options).finally(() => {
    captureInFlight = null;
  });
  return captureInFlight;
}

async function captureViaDesktopCapturer(options: {
  quality: number;
  scale: number;
  width: number;
  height: number;
}): Promise<Buffer | null> {
  const electron = tryElectron();
  const display = electron?.screen?.getPrimaryDisplay?.();
  const getSources = electron?.desktopCapturer?.getSources;
  if (!display || !getSources) return null;
  const scaleFactor = display.scaleFactor || 1;
  const targetW = Math.max(1, Math.round(options.width * scaleFactor * options.scale));
  const targetH = Math.max(1, Math.round(options.height * scaleFactor * options.scale));
  const sources = await getSources({
    types: ['screen'],
    thumbnailSize: { width: targetW, height: targetH },
  });
  const displayId = String(display.id);
  const source = sources.find((item) => item.display_id === displayId) || sources[0];
  if (!source || source.thumbnail.isEmpty()) {
    throw new Error('empty thumbnail');
  }
  return source.thumbnail.toJPEG(options.quality);
}

async function captureMacDesktopNow(options: { quality?: number; scale?: number }): Promise<{
  jpeg: Buffer;
  width: number;
  height: number;
}> {
  if (!isMacDesktopHost()) throw new Error('仅支持在 Mac 上采集桌面');
  const quality = Math.min(80, Math.max(30, options.quality ?? 55));
  const scale = Math.min(1, Math.max(0.2, options.scale ?? 0.4));
  const metrics = await getMacDisplaySize();
  try {
    const jpeg = await captureViaDesktopCapturer({
      quality,
      scale,
      width: metrics.width,
      height: metrics.height,
    });
    if (jpeg?.length) return { jpeg, width: metrics.width, height: metrics.height };
  } catch { /* child screencapture still inherits DuoCLI TCC */ }
  try {
    return await captureViaScreencapture(quality, scale, metrics);
  } catch (error: any) {
    throw new Error(describeCaptureError(error));
  }
}

async function captureViaScreencapture(
  quality: number,
  scale: number,
  metrics: { width: number; height: number },
): Promise<{ jpeg: Buffer; width: number; height: number }> {
  const tmp = path.join(os.tmpdir(), `duocli-mac-desk-${process.pid}.png`);
  try {
    await execFileAsync('screencapture', ['-x', '-t', 'png', tmp], { timeout: 6000 });
    const png = await fs.promises.readFile(tmp);
    const meta = await sharp(png).metadata();
    const sourceWidth = meta.width || metrics.width;
    const targetW = Math.max(1, Math.round(sourceWidth * scale));
    const jpeg = await sharp(png).resize(targetW).jpeg({ quality }).toBuffer();
    return { jpeg, width: metrics.width, height: metrics.height };
  } finally {
    void fs.promises.unlink(tmp).catch(() => {});
  }
}

async function compileInputHelper(dest: string): Promise<string> {
  const src = `${dest}.c`;
  await fs.promises.writeFile(src, MAC_INPUT_SOURCE);
  await execFileAsync('clang', ['-O2', '-framework', 'ApplicationServices', '-o', dest, src], {
    timeout: 20000,
  });
  await fs.promises.chmod(dest, 0o755);
  return dest;
}

async function ensureInputHelper(): Promise<string | null> {
  if (inputHelperPath) return inputHelperPath;
  if (inputHelperPromise) return inputHelperPromise;
  inputHelperPromise = (async () => {
    const dest = path.join(os.tmpdir(), `duocli-mac-input-${process.arch}`);
    try {
      await fs.promises.access(dest, fs.constants.X_OK);
      inputHelperPath = dest;
      return dest;
    } catch { /* compile */ }
    try {
      inputHelperPath = await compileInputHelper(dest);
      return inputHelperPath;
    } catch {
      return null;
    }
  })();
  try {
    return await inputHelperPromise;
  } finally {
    inputHelperPromise = null;
  }
}

async function runHostInput(args: string[]): Promise<boolean> {
  const helper = await ensureInputHelper();
  if (!helper) return false;
  await execFileAsync(helper, args, { timeout: 4000 });
  return true;
}

async function clickViaSystemEvents(x: number, y: number): Promise<void> {
  await execFileAsync('osascript', [
    '-e', `tell application "System Events" to click at {${x}, ${y}}`,
  ], { timeout: 3000 });
}

export async function tapMacDesktop(x: number, y: number): Promise<void> {
  const cx = normalizeDesktopPoint(x);
  const cy = normalizeDesktopPoint(y);
  if (cx == null || cy == null) throw new Error('点击坐标无效');
  try {
    const { height } = await getMacDisplaySize();
    const quartz = toQuartzPoint(cx, cy, height);
    if (await runHostInput(['click', String(quartz.x), String(quartz.y)])) return;
    await clickViaSystemEvents(cx, cy);
  } catch (error) {
    throw new Error(describeInputError(error));
  }
}

export async function swipeMacDesktop(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  durationMs = 300,
): Promise<void> {
  const a = normalizeDesktopPoint(x1);
  const b = normalizeDesktopPoint(y1);
  const c = normalizeDesktopPoint(x2);
  const d = normalizeDesktopPoint(y2);
  if (a == null || b == null || c == null || d == null) throw new Error('滑动坐标无效');
  const steps = Math.max(4, Math.min(16, Math.round(Number(durationMs) / 40) || 8));
  try {
    const { height } = await getMacDisplaySize();
    const from = toQuartzPoint(a, b, height);
    const to = toQuartzPoint(c, d, height);
    if (await runHostInput([
      'drag',
      String(from.x),
      String(from.y),
      String(to.x),
      String(to.y),
      String(steps),
    ])) return;
    await clickViaSystemEvents(c, d);
  } catch (error) {
    throw new Error(describeInputError(error));
  }
}
