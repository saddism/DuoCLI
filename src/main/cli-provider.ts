import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getDisplayName } from './pty-manager';
import { matchCustomPreset } from './preset-env';

export interface CustomPreset {
  id: string;
  name: string;
  command: string;
  autoFlag: string;
  env?: Record<string, string>;
}

/** ANTHROPIC_BASE_URL → 模型提供商标签，桌面端与手机端共用同一套判断 */
export function providerFromBaseUrl(baseUrl: string): string | null {
  const url = (baseUrl || '').trim();
  if (!url) return null;
  if (url.includes('minimaxi')) return 'MiniMax';
  if (url.includes('deepseek')) return 'DeepSeek';
  if (url.includes('zhipu') || url.includes('bigmodel')) return 'GLM';
  if (url.includes('cloudflare')) return 'Cloudflare';
  if (url.includes('anthropic')) return 'Anthropic';
  try {
    const label = new URL(url).hostname.replace(/^(api|code)\./, '').split('.')[0];
    return label ? label.charAt(0).toUpperCase() + label.slice(1) : null;
  } catch {
    return null;
  }
}

export function parseShellExports(content: string): Map<string, string> {
  const vars = new Map<string, string>();
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('#')) continue;
    const match = trimmed.match(/^export\s+([A-Z_][A-Z0-9_]*)=["']?([^"'\n]+?)["']?\s*$/);
    if (match) {
      vars.set(match[1], match[2]);
    }
  }
  return vars;
}

/** 根据 preset 命令推断实际使用的模型提供商 */
export function getCliProvider(presetCommand: string): string | null {
  const home = os.homedir();

  if (presetCommand.startsWith('claude')) {
    const settingsPath = path.join(home, '.claude', 'settings.json');
    try {
      if (fs.existsSync(settingsPath)) {
        const env = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')).env || {};
        const baseUrl = typeof env.ANTHROPIC_BASE_URL === 'string' ? env.ANTHROPIC_BASE_URL : '';
        // settings.json 是 Claude 的权威配置：认不出自定义来源时也按官方 Anthropic 处理，
        // 不再退回去读 shell 环境，避免两处配置给出不同的供应商标签。
        return providerFromBaseUrl(baseUrl) || 'Anthropic';
      }
    } catch { /* 配置损坏时退回 shell 环境 */ }

    for (const rcFile of [path.join(home, '.zshrc'), path.join(home, '.bashrc')]) {
      try {
        if (!fs.existsSync(rcFile)) continue;
        const baseUrl = parseShellExports(fs.readFileSync(rcFile, 'utf-8')).get('ANTHROPIC_BASE_URL') || '';
        const provider = providerFromBaseUrl(baseUrl);
        if (provider) return provider;
      } catch { /* ignore */ }
    }

    return 'Anthropic';
  }

  if (presetCommand.startsWith('codex')) return 'OpenAI';
  if (presetCommand.startsWith('kimi')) return 'Moonshot';
  if (presetCommand.startsWith('gemini')) return 'Google';

  if (presetCommand.startsWith('opencode')) {
    const cfgPath = path.join(home, '.config', 'opencode', 'opencode.json');
    try {
      if (fs.existsSync(cfgPath)) {
        const provider = JSON.parse(fs.readFileSync(cfgPath, 'utf-8')).provider || {};
        if (provider.anthropic) return 'Anthropic';
        if (provider.openai) return 'OpenAI';
        if (provider.google) return 'Google';
      }
    } catch { /* ignore */ }
    return 'OpenCode';
  }

  if (presetCommand.startsWith('qoder')) return 'Qoder';
  if (presetCommand.startsWith('devin')) return 'Devin';
  if (presetCommand.startsWith('kiro-cli')) return 'Kiro';
  if (presetCommand.startsWith('agent') || presetCommand.includes('cursor')) return 'Cursor';
  if (presetCommand.startsWith('agy')) return 'Antigravity';

  return null;
}

/** 自定义预设显示用户起的名字，内置命令才走 CLI 显示名 */
export function resolveSessionDisplayName(presetCommand: string, customPresets: CustomPreset[]): string {
  const customPreset = matchCustomPreset(customPresets, presetCommand);
  if (!customPreset) return getDisplayName(presetCommand);
  const autoCommand = customPreset.autoFlag
    ? `${customPreset.command} ${customPreset.autoFlag}`.trim()
    : '';
  const cmd = (presetCommand || '').trim();
  const isAuto = !!autoCommand && (cmd === autoCommand || cmd.startsWith(`${autoCommand} `));
  return isAuto ? `${customPreset.name}全自动` : customPreset.name;
}
