import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface BuiltinPreset {
  value: string;
  label: string;
}

/** 内置预制 CLI（空终端始终保留；其余按本机是否安装过滤） */
export const BUILTIN_PRESETS: BuiltinPreset[] = [
  { value: '', label: '空终端' },
  { value: 'claude --dangerously-skip-permissions', label: 'Claude (全自动)' },
  { value: 'codex -c sandbox_mode="danger-full-access" -c approval="never" -c network="enabled"', label: 'Codex (全自动)' },
  { value: 'devin --permission-mode bypass', label: 'Devin (全自动)' },
  { value: 'kimi --auto', label: 'Kimi (全自动)' },
  { value: 'gemini --yolo', label: 'Gemini (全自动)' },
  { value: 'qodercn --dangerously-skip-permissions', label: 'QoderCN (全自动)' },
  { value: 'opencode', label: 'OpenCode' },
  { value: 'kiro-cli chat --trust-all-tools', label: 'Kiro (全自动)' },
  { value: 'agent --force --approve-mcps', label: 'Cursor (全自动)' },
  { value: 'agy --dangerously-skip-permissions', label: '反重力 (全自动)' },
];

const existsCache = new Map<string, boolean>();

function candidatePaths(bin: string): string[] {
  const home = os.homedir();
  return [
    path.join(home, '.local', 'bin', bin),
    path.join(home, '.opencode', 'bin', bin),
    path.join(home, '.kimi-code', 'bin', bin),
    path.join(home, '.qoder-cn', 'entry', bin),
    path.join('/opt/homebrew/bin', bin),
    path.join('/usr/local/bin', bin),
    path.join('/usr/bin', bin),
  ];
}

/** 检测可执行文件是否在 PATH / 常见安装目录中（兼容 Dock 启动 PATH 不全） */
export function commandExists(bin: string): boolean {
  if (!bin) return true;
  if (existsCache.has(bin)) return existsCache.get(bin)!;

  let found = false;

  try {
    execFileSync('/usr/bin/which', [bin], { stdio: 'ignore' });
    found = true;
  } catch { /* continue */ }

  if (!found) {
    for (const p of candidatePaths(bin)) {
      try {
        if (fs.existsSync(p)) {
          found = true;
          break;
        }
      } catch { /* continue */ }
    }
  }

  if (!found) {
    try {
      const shell = process.env.SHELL || '/bin/zsh';
      const out = execFileSync(shell, ['-lc', 'command -v -- "$1"', 'duocli-cli-detect', bin], {
        encoding: 'utf8',
        timeout: 4000,
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      if (out) found = true;
    } catch { /* continue */ }
  }

  existsCache.set(bin, found);
  return found;
}

export function extractCommandBin(presetCommand: string): string {
  const trimmed = presetCommand.trim();
  if (!trimmed) return '';
  return trimmed.split(/\s+/)[0] || '';
}

export function isPresetCliAvailable(presetCommand: string): boolean {
  const bin = extractCommandBin(presetCommand);
  return commandExists(bin);
}

/** 返回本机可用的内置预制（空终端始终包含） */
export function getAvailableBuiltinPresets(): BuiltinPreset[] {
  return BUILTIN_PRESETS.filter((p) => isPresetCliAvailable(p.value));
}

export function clearCliExistsCache(): void {
  existsCache.clear();
}
