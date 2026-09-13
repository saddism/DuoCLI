(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.DuoCliTagColors = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  // ========== CLI 标签颜色配置 ==========
  // 已知 CLI → 固定颜色 [文字色，背景色]。
  // 桌面端与手机端共用这一份：各写一份的话，新增 CLI 时很容易只改一处，
  // 同一个会话在两端就会显示成不同颜色。
  const CLI_TAG_COLORS = {
    'Claude':       ['#d4a574', '#3d2e1e'],
    'Claude 全自动':  ['#e5a100', '#3d3010'],
    'Codex':        ['#73c991', '#1e3328'],
    'Codex 全自动':   ['#56d4a0', '#1a3d2e'],
    'Devin':        ['#7ec699', '#1e3328'],
    'Devin 全自动':   ['#7ec699', '#1e3328'],
    'Kimi':         ['#c678dd', '#2e1e3d'],
    'Kimi 全自动':    ['#d19ae8', '#33204a'],
    'Gemini':       ['#82aaff', '#1e2540'],
    'Gemini 全自动':  ['#99bbff', '#222d4a'],
    'OpenCode':     ['#61afef', '#1e2e3d'],
    'Qoder':        ['#e5c07b', '#3d3520'],
    'Qoder 全自动':   ['#d4a020', '#3d3520'],
    'QoderCN':      ['#e5c07b', '#3d3520'],
    'QoderCN 全自动': ['#d4a020', '#3d3520'],
    'Kiro':         ['#f78c6c', '#3d2518'],
    'Kiro 全自动':    ['#ff9e7a', '#4a2a1a'],
    'Cursor':       ['#56b6c2', '#1e3338'],
    'Cursor 全自动':  ['#56b6c2', '#1e3338'],
    'Antigravity':       ['#c792ea', '#2e1e3d'],
    'Antigravity 全自动':  ['#c792ea', '#2e1e3d'],
    'DSH':               ['#4cc2ff', '#102433'],
  };

  // ========== 用户会话主题配色 ==========
  // 这些配色用于用户手动选择的会话主题，支持多种风格
  const USER_THEMES = [
    // 经典 IDE 配色
    { name: 'VS Code Dark', text: '#ffffff', bg: '#0078d4' },
    { name: 'Monokai', text: '#f8f8f2', bg: '#a6e22e' },
    { name: 'Dracula', text: '#f8f8f2', bg: '#bd93f9' },
    { name: 'Solarized Dark', text: '#fff', bg: '#268bd2' },
    { name: 'One Dark', text: '#abb2bf', bg: '#61afef' },
    { name: 'Nord', text: '#eceff4', bg: '#88c0d0' },
    
    // CRT 复古终端配色
    { name: 'CRT 荧光绿', text: '#0a0a0a', bg: '#39ff14' },
    { name: 'CRT 琥珀色', text: '#0a0a0a', bg: '#ffb000' },
    { name: 'CRT 蓝色', text: '#0a0a0a', bg: '#00ffff' },
    { name: '老式显示器', text: '#0a0a0a', bg: '#00ff00' },
    
    // 鲜艳配色
    { name: '霓虹粉', text: '#0a0a0a', bg: '#ff00ff' },
    { name: '赛博青', text: '#0a0a0a', bg: '#00ffff' },
    { name: '电光紫', text: '#0a0a0a', bg: '#bf00ff' },
    { name: '火焰橙', text: '#0a0a0a', bg: '#ff4500' },
    
    // 柔和配色
    { name: '淡蓝', text: '#0a0a0a', bg: '#6cb2eb' },
    { name: '薄荷绿', text: '#0a0a0a', bg: '#7fffd4' },
    { name: '薰衣草紫', text: '#0a0a0a', bg: '#b39eb5' },
    { name: '珊瑚粉', text: '#0a0a0a', bg: '#ff7f50' },
    
    // 专业配色
    { name: '海洋蓝', text: '#0a0a0a', bg: '#1e90ff' },
    { name: '森林绿', text: '#0a0a0a', bg: '#228b22' },
    { name: '日落橙', text: '#0a0a0a', bg: '#ff8c00' },
    { name: '午夜紫', text: '#0a0a0a', bg: '#9370db' },
    
    // 高对比度
    { name: '极简白', text: '#000000', bg: '#ffffff' },
    { name: '极简黑', text: '#ffffff', bg: '#000000' },
    { name: '红黑', text: '#ff0000', bg: '#1a1a1a' },
    { name: '黄黑', text: '#ffd700', bg: '#1a1a1a' },
  ];

  // ========== 随机生成配色工具 ==========
  function generateRandomTheme(seed) {
    const colors = [
      '#e06c75', '#e5c07b', '#98c379', '#e5c07b',
      '#56b6c2', '#61afef', '#c678dd', '#d19ae8',
      '#f78c6c', '#ff5370', '#c792ea', '#be95ff',
      '#73c991', '#56d4a0', '#7ec699', '#99bbff',
      '#82aaff', '#61afef', '#88c0d0', '#66ccff',
    ];
    let h = 0;
    for (let i = 0; i < seed.length; i++) {
      h = ((h << 5) - h + seed.charCodeAt(i)) | 0;
    }
    const colorIndex = Math.abs(h) % colors.length;
    return colors[colorIndex];
  }

  // 未知 CLI 名时按字符串哈希落到这组稳定配色，避免每次刷新颜色乱跳。
  // 每一项都是 [文字色, 背景色]，和 CLI_TAG_COLORS 的值结构一致。
  const FALLBACK_PALETTE = [
    ['#94a3b8', '#1e293b'],
    ['#f9a8d4', '#3b1d36'],
    ['#86efac', '#14532d'],
    ['#93c5fd', '#1e3a5f'],
    ['#fcd34d', '#3b2f0b'],
    ['#c4b5fd', '#2e1065'],
    ['#fdba74', '#431407'],
    ['#67e8f9', '#164e63'],
  ];

  // ========== API ==========
  function getCliTagColors(displayName) {
    const name = String(displayName || '').trim();
    if (!name) return FALLBACK_PALETTE[0];
    if (CLI_TAG_COLORS[name]) return CLI_TAG_COLORS[name];
    // 前缀匹配，覆盖"XX 全自动”这类变体
    for (const key of Object.keys(CLI_TAG_COLORS)) {
      if (name.startsWith(key)) return CLI_TAG_COLORS[key];
    }
    let h = 0;
    for (let i = 0; i < name.length; i++) {
      h = ((h << 5) - h + name.charCodeAt(i)) | 0;
    }
    return FALLBACK_PALETTE[Math.abs(h) % FALLBACK_PALETTE.length];
  }

  function getUserThemes() {
    return USER_THEMES.map((t, index) => ({
      ...t,
      id: `theme-${index}`,
      random: false
    }));
  }

  function getRandomThemes(count = 10) {
    const themes = [];
    for (let i = 0; i < count; i++) {
      const seed = `random-${i}-${Date.now()}`;
      const bg = generateRandomTheme(seed);
      const text = Math.random() > 0.7 ? '#0a0a0a' : '#ffffff';
      themes.push({
        id: `random-theme-${i}`,
        name: `随机配色 ${i + 1}`,
        text: text,
        bg: bg,
        random: true
      });
    }
    return themes;
  }

  return { 
    CLI_TAG_COLORS, 
    getCliTagColors,
    getUserThemes,
    getRandomThemes
  };
});
