import sharp from 'sharp';

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

function isValidPngSignature(buf: Buffer, offset = 0): boolean {
  return buf.length >= offset + 8
    && buf[offset] === 0x89
    && buf[offset + 1] === 0x50
    && buf[offset + 2] === 0x4e
    && buf[offset + 3] === 0x47
    && buf[offset + 4] === 0x0d
    && buf[offset + 5] === 0x0a
    && buf[offset + 6] === 0x1a
    && buf[offset + 7] === 0x0a;
}

function isCrlfCorruptedPngSignature(buf: Buffer, offset = 0): boolean {
  // adb on some hosts turns every LF into CRLF, so the PNG signature becomes
  // 89 50 4E 47 0D 0D 0A 1A 0D 0A instead of 89 50 4E 47 0D 0A 1A 0A.
  return buf.length >= offset + 10
    && buf[offset] === 0x89
    && buf[offset + 1] === 0x50
    && buf[offset + 2] === 0x4e
    && buf[offset + 3] === 0x47
    && buf[offset + 4] === 0x0d
    && buf[offset + 5] === 0x0d
    && buf[offset + 6] === 0x0a
    && buf[offset + 7] === 0x1a
    && buf[offset + 8] === 0x0d
    && buf[offset + 9] === 0x0a;
}

/** Classic ADB screencap repair: undo LF→CRLF rewriting in the binary stream. */
export function stripAdbCrlf(buf: Buffer): Buffer {
  const out = Buffer.allocUnsafe(buf.length);
  let j = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x0d && i + 1 < buf.length && buf[i + 1] === 0x0a) {
      out[j++] = 0x0a;
      i++;
    } else {
      out[j++] = buf[i];
    }
  }
  return out.subarray(0, j);
}

function lookLikeAdbErrorText(buf: Buffer): string | null {
  const text = buf.subarray(0, Math.min(buf.length, 240)).toString('utf8').trim();
  if (!text) return null;
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text)) return null;
  if (/error:|device |unauthorized|offline|not found|no devices|closed/i.test(text)) {
    return text.replace(/\s+/g, ' ').slice(0, 120);
  }
  return null;
}

/**
 * Turn `adb exec-out screencap -p` bytes into a buffer sharp can decode.
 * Handles leading noise, Windows-style CRLF corruption, and empty captures.
 */
export function normalizeAdbScreencapPng(input: Buffer): Buffer {
  if (!input || input.length < 8) {
    throw new Error('截图数据为空，请检查 USB 调试或重新插拔设备');
  }

  let offset = input.indexOf(PNG_MAGIC);
  let buf = input;
  if (offset < 0) {
    const fixed = stripAdbCrlf(input);
    offset = fixed.indexOf(PNG_MAGIC);
    if (offset < 0) {
      const adbError = lookLikeAdbErrorText(input);
      if (adbError) throw new Error(adbError);
      throw new Error('截图不是有效 PNG');
    }
    buf = fixed;
  }

  if (offset > 0) buf = buf.subarray(offset);

  if (!isValidPngSignature(buf)) {
    if (isCrlfCorruptedPngSignature(buf)) {
      buf = stripAdbCrlf(buf);
    } else {
      // Last resort: some hosts only partially rewrite line endings.
      const fixed = stripAdbCrlf(buf);
      if (isValidPngSignature(fixed)) buf = fixed;
    }
  }

  if (!isValidPngSignature(buf)) {
    const adbError = lookLikeAdbErrorText(input);
    if (adbError) throw new Error(adbError);
    throw new Error('截图格式损坏');
  }

  // A real phone PNG is always larger than the signature + IHDR; tiny buffers
  // are almost always truncated adb output.
  if (buf.length < 64) throw new Error('截图数据过短，可能被截断');
  return Buffer.from(buf);
}

/** Some OEM builds ignore `-p` and return raw RGBA framebuffer headers. */
export async function tryConvertRawScreencap(input: Buffer): Promise<Buffer | null> {
  if (!input || input.length < 12) return null;
  const width = input.readUInt32LE(0);
  const height = input.readUInt32LE(4);
  const format = input.readUInt32LE(8);
  if (width < 1 || height < 1 || width > 8192 || height > 8192) return null;
  const channels = format === 3 ? 3 : 4;
  if (format !== 1 && format !== 2 && format !== 3) return null;
  const expected = width * height * channels;
  const pixels = input.subarray(12);
  if (pixels.length < expected) return null;
  try {
    return await sharp(pixels.subarray(0, expected), {
      raw: { width, height, channels },
    }).png().toBuffer();
  } catch {
    return null;
  }
}

export async function prepareAdbScreenshot(input: Buffer): Promise<Buffer> {
  try {
    return normalizeAdbScreencapPng(input);
  } catch (error) {
    const raw = await tryConvertRawScreencap(input);
    if (raw) return raw;
    throw error;
  }
}

/** Map libvips/sharp noise into a short Chinese hint for the device drawer. */
export function humanizeAndroidImageError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error || '');
  if (!raw) return '截图失败';
  if (/unsupported image format|Input buffer contains/i.test(raw)) return '截图格式异常';
  if (/VipsJpeg|VipsPng|libvips|\bsharp\b/i.test(raw)) return '截图处理失败';
  return raw;
}
