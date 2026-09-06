import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

// xterm 5.5.0 的 IME 组合逻辑在两次拼音组合重叠时（上一次 compositionend 的 setTimeout
// 还没执行，下一次 compositionstart 已经触发）会用上一次记录的 end 位置去切片。end 是按
// 拼音字母长度记的，上屏成汉字后长度变短，切片就会把上一次已经发出去的文字重新发一遍。
// 上游 6.0.0 已修，这里把修复回植到 esbuild 实际打包的 lib/xterm.js。
const PATCHES = [
  {
    name: '组合重叠时按新组合的起点切片，而不是过期的 end',
    from: 'substring(e.start,e.end)',
    to: 'substring(e.start,this._compositionPosition.start)',
  },
  {
    name: '组合期间按 CapsLock 不中断组合（keyCode 20）',
    from: 'if(229===e.keyCode)return!1',
    to: 'if(20===e.keyCode||229===e.keyCode)return!1',
  },
];

const require = createRequire(import.meta.url);
const pkg = JSON.parse(readFileSync(require.resolve('@xterm/xterm/package.json'), 'utf8'));
const target = path.join(path.dirname(require.resolve('@xterm/xterm/package.json')), 'lib', 'xterm.js');

let src = readFileSync(target, 'utf8');
let patched = 0;
const missed = [];

for (const p of PATCHES) {
  if (src.includes(p.to)) continue;

  const hits = src.split(p.from).length - 1;
  if (hits !== 1) {
    missed.push(`${p.name}（匹配 ${hits} 处）`);
    continue;
  }

  src = src.replace(p.from, p.to);
  patched++;
}

if (patched > 0) writeFileSync(target, src);

if (missed.length > 0) {
  console.error(`[patch-xterm] @xterm/xterm ${pkg.version} 未打上补丁：${missed.join('、')}`);
  console.error('[patch-xterm] 若已升级到 6.0.0 以上，请删除 scripts/patch-xterm.mjs 及 build:renderer 里的调用。');
  process.exit(1);
}

console.log(`[patch-xterm] @xterm/xterm ${pkg.version} IME 补丁就绪`);
