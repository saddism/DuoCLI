import fs from 'fs';
import path from 'path';
import type { Response } from 'express';

export const DOWNLOAD_EXTENSIONS = new Set([
  '.zip', '.rar', '.7z', '.tar', '.gz', '.tgz', '.bz2', '.tbz2', '.xz', '.txz',
  '.zst', '.cab', '.iso', '.dmg', '.doc', '.docx', '.docm', '.dot', '.dotx', '.xls',
  '.xlsx', '.xlsm', '.xlsb', '.xlt', '.xltx', '.ppt', '.pptx', '.pptm', '.pps', '.ppsx',
  '.pot', '.potx', '.odt', '.ods', '.odp', '.pages', '.numbers', '.key', '.epub', '.mobi',
  '.azw', '.azw3', '.psd', '.psb', '.ai', '.eps', '.sketch', '.fig', '.xd', '.indd',
  '.blend', '.obj', '.stl', '.glb', '.gltf', '.fbx', '.ttf', '.otf', '.woff', '.woff2',
  '.apk', '.aab', '.ipa', '.exe', '.msi', '.deb', '.rpm', '.pkg', '.appimage', '.wasm',
  '.db', '.sqlite', '.sqlite3', '.parquet', '.arrow', '.feather', '.npy', '.npz', '.pkl', '.pickle',
  '.tiff', '.tif', '.raw', '.cr2', '.nef', '.avi', '.wmv', '.flv', '.mpeg', '.mpg',
  '.m4b', '.opus', '.aiff', '.aif',
]);

export function attachmentDisposition(filename: string): string {
  const fallback = filename.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

export function sendFileDownload(
  cwd: string,
  requestedPath: string,
  res: Response,
  extraExtensions: Iterable<string> = [],
): void {
  let filePath: string;
  let fileStat: fs.Stats;
  try {
    const root = fs.realpathSync(cwd);
    const raw = requestedPath.trim().replace(/^['"`]|['"`]$/g, '');
    const expanded = raw.startsWith('@/') ? raw.slice(2) : raw;
    filePath = fs.realpathSync(path.resolve(root, expanded));
    const relative = path.relative(root, filePath);
    const name = path.basename(filePath).toLowerCase();
    const allowed = new Set([...DOWNLOAD_EXTENSIONS, ...extraExtensions]);
    fileStat = fs.statSync(filePath);
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)
      || name === '.env' || name.startsWith('.env.')
      || !allowed.has(path.extname(filePath).toLowerCase()) || !fileStat.isFile()) {
      res.status(400).json({ error: '只支持工作目录内的可下载文件' });
      return;
    }
  } catch {
    res.status(404).json({ error: '文件不存在或无法读取' });
    return;
  }
  // 不要按扩展名发 video/mp4：Safari/微信会当成网页打开，保存成 xxx.mp4.html。
  const filename = path.basename(filePath);
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', attachmentDisposition(filename));
  res.setHeader('Content-Length', String(fileStat.size));
  fs.createReadStream(filePath)
    .on('error', () => {
      if (!res.headersSent) res.status(500).json({ error: '文件下载失败' });
      else res.end();
    })
    .pipe(res);
}
