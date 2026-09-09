export interface PresetEnvSource {
  command: string;
  autoFlag?: string;
  env?: Record<string, string>;
}

function stripQuotes(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"'))
    || (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

/** 解析自定义预设里的环境变量文本，兼容插件弹窗的 export / set / $env: 粘贴。 */
export function parsePresetEnv(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  if (!text) return env;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const ps = line.match(/^\$env:([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/i);
    if (ps) {
      env[ps[1]] = stripQuotes(ps[2].trim());
      continue;
    }
    const rest = line.replace(/^(export|set)\s+/i, '');
    const kv = rest.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!kv) continue;
    env[kv[1]] = stripQuotes(kv[2].trim());
  }
  return env;
}

export function formatPresetEnv(env?: Record<string, string> | null): string {
  if (!env) return '';
  return Object.entries(env)
    .filter(([key, value]) => key && value !== undefined && value !== '')
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
}

/** HTTP 代理类变量同时补齐大小写，避免 Node / curl 只认其中一种。 */
export function normalizePresetEnv(env?: Record<string, string> | null): Record<string, string> {
  const out: Record<string, string> = { ...(env || {}) };
  const aliases: Array<[string, string]> = [
    ['HTTP_PROXY', 'http_proxy'],
    ['HTTPS_PROXY', 'https_proxy'],
    ['ALL_PROXY', 'all_proxy'],
    ['NO_PROXY', 'no_proxy'],
  ];
  for (const [upper, lower] of aliases) {
    if (out[upper] && !out[lower]) out[lower] = out[upper];
    else if (out[lower] && !out[upper]) out[upper] = out[lower];
  }
  return out;
}

export function matchCustomPreset<T extends PresetEnvSource>(
  presets: T[] | null | undefined,
  presetCommand: string,
): T | null {
  const cmd = (presetCommand || '').trim();
  if (!cmd) return null;
  let best: T | null = null;
  let bestLen = -1;
  for (const preset of presets || []) {
    const base = (preset.command || '').trim();
    if (!base) continue;
    const variants = [base];
    if (preset.autoFlag) variants.push(`${base} ${preset.autoFlag}`.trim());
    for (const variant of variants) {
      if (cmd === variant || cmd.startsWith(`${variant} `)) {
        if (variant.length > bestLen) {
          best = preset;
          bestLen = variant.length;
        }
      }
    }
  }
  return best;
}

export function resolvePresetEnv(
  presets: PresetEnvSource[] | null | undefined,
  presetCommand: string,
): Record<string, string> {
  const preset = matchCustomPreset(presets, presetCommand);
  if (!preset?.env || typeof preset.env !== 'object') return {};
  return normalizePresetEnv(preset.env);
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_.:/=+@%-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function visibleEnvEntries(env?: Record<string, string> | null): Array<[string, string]> {
  if (!env) return [];
  const skip = new Set<string>();
  const aliases: Array<[string, string]> = [
    ['HTTP_PROXY', 'http_proxy'],
    ['HTTPS_PROXY', 'https_proxy'],
    ['ALL_PROXY', 'all_proxy'],
    ['NO_PROXY', 'no_proxy'],
  ];
  for (const [upper, lower] of aliases) {
    if (env[upper] && env[lower] === env[upper]) skip.add(lower);
  }
  return Object.entries(env).filter(([key, value]) => !!key && value !== '' && !skip.has(key));
}

/** 在同一终端里先执行的 export/set，再跟上 CLI。 */
export function formatShellEnvCommands(
  env?: Record<string, string> | null,
  platform: NodeJS.Platform = process.platform,
): string {
  const entries = visibleEnvEntries(env);
  if (!entries.length) return '';
  if (platform === 'win32') {
    return entries.map(([key, value]) => `set ${key}=${value}`).join('\r') + '\r';
  }
  return entries.map(([key, value]) => `export ${key}=${shellQuote(value)}`).join('\r') + '\r';
}

export function buildLaunchWrite(
  launchCommand: string,
  env?: Record<string, string> | null,
  platform: NodeJS.Platform = process.platform,
): string {
  return `${formatShellEnvCommands(env, platform)}${launchCommand}\r`;
}
