#!/usr/bin/env node
/** Bundle the RFB client only: the standalone noVNC UI must not auto-start inside DuoCLI. */
import { build } from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const novncDir = path.join(rootDir, 'mobile/client/novnc');
await build({
  stdin: {
    contents: "import RFB from './core/rfb.js'; window.RFB = RFB; export { RFB }; export default RFB;",
    resolveDir: novncDir,
    sourcefile: 'duocli-novnc-entry.js',
    loader: 'js',
  },
  bundle: true,
  outfile: path.join(rootDir, 'mobile/client/mac-desktop-novnc-bundle.js'),
  format: 'iife', globalName: 'NoVNC', platform: 'browser',
  minify: false, sourcemap: false,
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  logLevel: 'info',
});
console.log('noVNC RFB client ready; standalone UI is excluded');
