/**
 * CLI Logo Map - 各大 AI 编码工具的官方 Logo
 * 品牌 Logo 用 LobeHub Icons 的公开 CDN（jsDelivr，国内比 GitHub raw 稳）；
 * DSH 等没有公开图标的，在文件内内嵌本地图标
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.DuoCliLogos = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {

  // 显示名 / 下拉标签里常见的写法 → LobeHub 图标文件名
  const CLI_LOGO_MAP = {
    'Claude': 'claude-color',
    'Claude全自动': 'claude-color',
    'Claude 全自动': 'claude-color',
    'Claude (全自动)': 'claude-color',
    'Codex': 'codex-color',
    'Codex全自动': 'codex-color',
    'Codex 全自动': 'codex-color',
    'Codex (全自动)': 'codex-color',
    'Devin': 'devin-color',
    'Devin全自动': 'devin-color',
    'Devin 全自动': 'devin-color',
    'Devin (全自动)': 'devin-color',
    'Kimi': 'kimi-color',
    'Kimi全自动': 'kimi-color',
    'Kimi 全自动': 'kimi-color',
    'Kimi (全自动)': 'kimi-color',
    'Gemini': 'gemini-color',
    'Gemini全自动': 'gemini-color',
    'Gemini 全自动': 'gemini-color',
    'Gemini (全自动)': 'gemini-color',
    'OpenCode': 'codex-color',
    'Qoder': 'qwen-color',
    'Qoder全自动': 'qwen-color',
    'Qoder 全自动': 'qwen-color',
    'Qoder (全自动)': 'qwen-color',
    'QoderCN': 'qwen-color',
    'QoderCN全自动': 'qwen-color',
    'QoderCN 全自动': 'qwen-color',
    'QoderCN (全自动)': 'qwen-color',
    'Kiro': 'kiro-color',
    'Kiro全自动': 'kiro-color',
    'Kiro 全自动': 'kiro-color',
    'Kiro (全自动)': 'kiro-color',
    'Cursor': 'cursor',
    'Cursor全自动': 'cursor',
    'Cursor 全自动': 'cursor',
    'Cursor (全自动)': 'cursor',
    'Antigravity': 'antigravity',
    'Antigravity全自动': 'antigravity',
    'Antigravity 全自动': 'antigravity',
    'Antigravity (全自动)': 'antigravity',
  };

  // DSH（DeepSeek Harness）没有 LobeHub 公开图标，本地内嵌应用图标（96px PNG）
  const DSH_LOGO_URL = 'data:image/png;base64,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';

  // 会话显示名经常是「Claude全自动」这种无空格写法，用前缀兜底
  const CLI_FAMILIES = [
    { keys: ['claude'], file: 'claude-color' },
    { keys: ['codex'], file: 'codex-color' },
    { keys: ['devin'], file: 'devin-color' },
    { keys: ['kimi'], file: 'kimi-color' },
    { keys: ['gemini'], file: 'gemini-color' },
    { keys: ['opencode'], file: 'codex-color' },
    { keys: ['qodercn', 'qoder'], file: 'qwen-color' },
    { keys: ['kiro'], file: 'kiro-color' },
    { keys: ['cursor'], file: 'cursor' },
    { keys: ['dsh'], file: DSH_LOGO_URL },
    { keys: ['antigravity'], file: 'antigravity' },
  ];

  function compactCliName(cliName) {
    return String(cliName || '')
      .toLowerCase()
      .replace(/[()（）]/g, '')
      .replace(/全自动/g, '')
      .replace(/[\s_-]+/g, '')
      .trim();
  }

  function resolveLogoFile(cliName) {
    const raw = String(cliName || '').trim();
    if (!raw || raw === '终端' || raw === '空终端') return null;
    if (CLI_LOGO_MAP[raw]) return CLI_LOGO_MAP[raw];
    const compact = compactCliName(raw);
    if (!compact) return null;
    // ds-cc / ollama-cc 这类带 cc 的 CLI 都是 Claude Code 的复刻/兼容实现，统一用 Claude 图标
    if (/cc$/.test(compact)) return 'claude-color';
    for (const family of CLI_FAMILIES) {
      for (const key of family.keys) {
        if (compact === key || compact.startsWith(key)) return family.file;
      }
    }
    return null;
  }

  function logoCdnUrl(file) {
    return `https://cdn.jsdelivr.net/gh/lobehub/lobe-icons@master/packages/static-svg/icons/${file}.svg`;
  }

  // 匹配不到品牌图标时用本地默认图，不依赖 CDN / CSP
  const DEFAULT_LOGO_URL = 'data:image/svg+xml,' + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">'
    + '<rect width="24" height="24" rx="6" fill="#3b82f6"/>'
    + '<path d="M7 8.5L11.5 12 7 15.5" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>'
    + '<path d="M12.5 16.5H18" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round"/>'
    + '</svg>'
  );

  function getDefaultLogoUrl() {
    return DEFAULT_LOGO_URL;
  }

  function getLogoUrl(cliName) {
    const file = resolveLogoFile(cliName);
    if (!file) return DEFAULT_LOGO_URL;
    return isFullLogoUrl(file) ? file : logoCdnUrl(file);
  }

  // DSH 等内嵌图标是完整 data: URI，直接使用，不再拼 LobeHub CDN 路径
  function isFullLogoUrl(file) {
    return file.indexOf('data:') === 0 || /^https?:\/\//i.test(file);
  }

  function hasLogo(cliName) {
    return !!resolveLogoFile(cliName);
  }

  function getCliList() {
    return Object.keys(CLI_LOGO_MAP);
  }

  function getCliLabel(cliName) {
    return {
      name: cliName,
      logo: getLogoUrl(cliName),
      hasLogo: hasLogo(cliName),
    };
  }

  return {
    CLI_LOGO_MAP,
    resolveLogoFile,
    getLogoUrl,
    getDefaultLogoUrl,
    hasLogo,
    getCliList,
    getCliLabel,
  };
});
