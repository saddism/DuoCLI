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

export function sendFileDownload(cwd: string, requestedPath: string, res: Response): void {
  let filePath: string;
  try {
    const root = fs.realpathSync(cwd);
    const raw = requestedPath.trim().replace(/^['"`]|['"`]$/g, '');
    const expanded = raw.startsWith('@/') ? raw.slice(2) : raw;
    filePath = fs.realpathSync(path.resolve(root, expanded));
    const relative = path.relative(root, filePath);
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)
      || !DOWNLOAD_EXTENSIONS.has(path.extname(filePath).toLowerCase()) || !fs.statSync(filePath).isFile()) {
      res.status(400).json({ error: '只支持工作目录内的可下载文件' });
      return;
    }
  } catch {
    res.status(404).json({ error: '文件不存在或无法读取' });
    return;
  }
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.download(filePath, path.basename(filePath), (error) => {
    if (error && !res.headersSent) res.status(500).json({ error: '文件下载失败' });
  });
}
