import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as https from 'https';
import * as http from 'http';

export interface AIProvider {
  id: string;          // 唯一标识
  name: string;        // 显示名称
  apiKey: string;      // API key
  baseUrl: string;     // endpoint
  model: string;       // 当前选中模型
  availableModels: string[];  // 可选模型列表
  source: string;      // 配置来源
  apiFormat: 'anthropic' | 'openai' | 'gemini' | 'ollama';  // API 格式
  status: 'pending' | 'ok' | 'fail';
  errorMsg?: string;
}

interface TestDef {
  testPath: string;
  testMethod: string;
  authStyle: 'anthropic' | 'bearer' | 'gemini-query' | 'none';
}

// 各 provider 的测试定义
const TEST_DEFS: Record<string, TestDef> = {
  anthropic: { testPath: '/v1/messages', testMethod: 'POST', authStyle: 'anthropic' },
  codex:     { testPath: '/v1/models', testMethod: 'GET', authStyle: 'bearer' },
  gemini:    { testPath: '/v1beta/models', testMethod: 'GET', authStyle: 'gemini-query' },
  deepseek:  { testPath: '/v1/models', testMethod: 'GET', authStyle: 'bearer' },
  minimax:   { testPath: '/v1/models', testMethod: 'GET', authStyle: 'bearer' },
  zhipu:     { testPath: '/v1/models', testMethod: 'GET', authStyle: 'bearer' },
  opencode:  { testPath: '/v1/messages', testMethod: 'POST', authStyle: 'anthropic' },
  ollama:    { testPath: '/api/tags', testMethod: 'GET', authStyle: 'none' },
};

export class AIConfigManager {
  private providers: AIProvider[] = [];

  async scan(): Promise<AIProvider[]> {
    this.providers = [];
    const home = os.homedir();

    // 从各工具配置文件直接扫描
    this.scanClaude(home);
    this.scanCodex(home);
    this.scanGemini(home);
    this.scanDeepSeek(home);
    this.scanMiniMax(home);
    this.scanZhipu(home);
    this.scanOpenCode(home);
    this.scanAider(home);
    this.scanOllama();
    this.scanShellRC(home);

    // 去重：同 id 只保留第一个
    const seen = new Set<string>();
    this.providers = this.providers.filter(p => {
      if (seen.has(p.id)) return false;
      seen.add(p.id);
      return true;
    });

    return this.providers;
  }

  // ========== Claude ==========
  private scanClaude(home: string): void {
    const settingsPath = path.join(home, '.claude', 'settings.json');
    try {
      if (!fs.existsSync(settingsPath)) return;
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
      const env = settings.env || {};
      const apiKey = env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_API_KEY || '';
      const baseUrl = env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com';
      const model = settings.model || 'claude-sonnet-4-20250514';
      if (!apiKey) return;
      this.providers.push({
        id: 'anthropic', name: 'Claude (Anthropic)',
        apiKey, baseUrl: baseUrl.replace(/\/+$/, ''), model,
        availableModels: [model, 'claude-sonnet-4-20250514', 'claude-haiku-4-20250414'].filter((v, i, a) => a.indexOf(v) === i),
        apiFormat: 'anthropic',
        source: '~/.claude/settings.json', status: 'pending',
      });
    } catch { /* ignore */ }
  }

  // ========== Codex ==========
  private scanCodex(home: string): void {
    // 先读 config.json（apiKey + apiBaseUrl）
    const jsonPath = path.join(home, '.codex', 'config.json');
    try {
      if (!fs.existsSync(jsonPath)) return;
      const cfg = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
      const apiKey = cfg.apiKey || '';
      let baseUrl = cfg.apiBaseUrl || '';
      if (!apiKey || !baseUrl) return;
      baseUrl = baseUrl.replace(/\/+$/, '');

      // 从 config.toml 读模型名
      let model = 'codex';
      const tomlPath = path.join(home, '.codex', 'config.toml');
      if (fs.existsSync(tomlPath)) {
        const toml = fs.readFileSync(tomlPath, 'utf-8');
        const m = toml.match(/^model\s*=\s*"([^"]+)"/m);
        if (m) model = m[1];
      }

      this.providers.push({
        id: 'codex', name: 'Codex (OpenAI)',
        apiKey, baseUrl, model,
        availableModels: [model, 'gpt-4.1-mini', 'gpt-4.1-nano', 'o4-mini'].filter((v, i, a) => a.indexOf(v) === i),
        apiFormat: 'openai',
        source: '~/.codex/config.json', status: 'pending',
      });
    } catch { /* ignore */ }
  }

  // ========== Gemini ==========
  private scanGemini(home: string): void {
    const envPath = path.join(home, '.gemini', '.env');
    try {
      if (!fs.existsSync(envPath)) return;
      const content = fs.readFileSync(envPath, 'utf-8');
      const vars = this.parseShellExports(content);
      const apiKey = vars.get('GEMINI_API_KEY') || vars.get('GOOGLE_API_KEY') || '';
      const baseUrl = vars.get('GOOGLE_GEMINI_BASE_URL') || 'https://generativelanguage.googleapis.com';
      const model = vars.get('GEMINI_MODEL') || 'gemini-2.0-flash';
      if (!apiKey) return;
      this.providers.push({
        id: 'gemini', name: 'Google Gemini',
        apiKey, baseUrl: baseUrl.replace(/\/+$/, ''), model,
        availableModels: [model, 'gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-2.0-flash-lite'].filter((v, i, a) => a.indexOf(v) === i),
        apiFormat: 'gemini',
        source: '~/.gemini/.env', status: 'pending',
      });
    } catch { /* ignore */ }
  }

  // ========== DeepSeek ==========
  private scanDeepSeek(home: string): void {
    // 从 shell 环境变量扫描
    const rcFiles = [path.join(home, '.zshrc'), path.join(home, '.bashrc')];
    for (const rcFile of rcFiles) {
      try {
        if (!fs.existsSync(rcFile)) continue;
        const vars = this.parseShellExports(fs.readFileSync(rcFile, 'utf-8'));
        const apiKey = vars.get('DEEPSEEK_API_KEY') || '';
        if (!apiKey) continue;
        const baseUrl = vars.get('DEEPSEEK_BASE_URL') || 'https://api.deepseek.com';
        this.providers.push({
          id: 'deepseek', name: 'DeepSeek',
          apiKey, baseUrl: baseUrl.replace(/\/+$/, ''), model: 'deepseek-chat',
          availableModels: ['deepseek-chat', 'deepseek-reasoner'],
          apiFormat: 'openai',
          source: `~/${path.basename(rcFile)}`, status: 'pending',
        });
        return;
      } catch { /* ignore */ }
    }
  }

  // ========== MiniMax ==========
  private scanMiniMax(home: string): void {
    const rcFiles = [path.join(home, '.zshrc'), path.join(home, '.bashrc')];
    for (const rcFile of rcFiles) {
      try {
        if (!fs.existsSync(rcFile)) continue;
        const vars = this.parseShellExports(fs.readFileSync(rcFile, 'utf-8'));
        const apiKey = vars.get('MINIMAX_API_KEY') || '';
        if (!apiKey) continue;
        const baseUrl = vars.get('MINIMAX_BASE_URL') || 'https://api.minimaxi.com/v1';
        this.providers.push({
          id: 'minimax', name: 'MiniMax',
          apiKey, baseUrl: baseUrl.replace(/\/+$/, ''), model: 'MiniMax-M2.1',
          availableModels: ['MiniMax-M2.1', 'MiniMax-M2.1-lightning', 'MiniMax-M2'],
          apiFormat: 'openai',
          source: `~/${path.basename(rcFile)}`, status: 'pending',
        });
        return;
      } catch { /* ignore */ }
    }
  }

  // ========== ZhipuAI (GLM) ==========
  private scanZhipu(home: string): void {
    const rcFiles = [path.join(home, '.zshrc'), path.join(home, '.bashrc')];
    for (const rcFile of rcFiles) {
      try {
        if (!fs.existsSync(rcFile)) continue;
        const vars = this.parseShellExports(fs.readFileSync(rcFile, 'utf-8'));
        const apiKey = vars.get('ZHIPUAI_API_KEY') || '';
        if (!apiKey) continue;
        const baseUrl = vars.get('ZHIPUAI_BASE_URL') || 'https://open.bigmodel.cn/api/paas/v4';
        this.providers.push({
          id: 'zhipu', name: 'ZhipuAI (GLM)',
          apiKey, baseUrl: baseUrl.replace(/\/+$/, ''), model: 'glm-4.7',
          availableModels: ['glm-4.7', 'glm-4.5', 'glm-4.5-air'],
          apiFormat: 'openai',
          source: `~/${path.basename(rcFile)}`, status: 'pending',
        });
        return;
      } catch { /* ignore */ }
    }
  }

  // ========== OpenCode ==========
  private scanOpenCode(home: string): void {
    const cfgPath = path.join(home, '.config', 'opencode', 'opencode.json');
    try {
      if (!fs.existsSync(cfgPath)) return;
      const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
      const model = cfg.model || '';
      const providers = cfg.provider || {};

      // 扫描 opencode 中配置的各 provider（跳过已有的）
      for (const [key, val] of Object.entries(providers) as [string, any][]) {
        if (key === 'ollama') continue; // ollama 单独处理
        const opts = val.options || {};
        const apiKey = opts.apiKey || '';
        const baseUrl = opts.baseURL || '';
        if (!apiKey || !baseUrl) continue;

        // 如果已有同类 provider 就跳过
        const existingId = key === 'google' ? 'gemini' : key;
        if (this.providers.some(p => p.id === existingId)) continue;

        this.providers.push({
          id: `opencode-${key}`,
          name: `${(val as any).name || key} (OpenCode)`,
          apiKey, baseUrl: baseUrl.replace(/\/+$/, ''),
          model: model.includes(key) ? model : key,
          availableModels: [model.includes(key) ? model : key],
          apiFormat: (key === 'anthropic') ? 'anthropic' : 'openai',
          source: '~/.config/opencode/opencode.json', status: 'pending',
        });
      }

      // 提取 ollama 模型列表
      if (providers.ollama?.models) {
        // 后面 scanOllama 会处理
      }
    } catch { /* ignore */ }
  }

  // ========== Aider ==========
  private scanAider(home: string): void {
    const envPath = path.join(home, '.aider', 'env.sh');
    try {
      if (!fs.existsSync(envPath)) return;
      const content = fs.readFileSync(envPath, 'utf-8');
      const vars = this.parseShellExports(content);
      const apiKey = vars.get('ANTHROPIC_API_KEY') || '';
      const baseUrl = vars.get('ANTHROPIC_BASE_URL') || '';
      if (!apiKey) return;
      // 如果已有 anthropic 就跳过
      if (this.providers.some(p => p.id === 'anthropic')) return;
      this.providers.push({
        id: 'anthropic', name: 'Claude (Aider)',
        apiKey, baseUrl: (baseUrl || 'https://api.anthropic.com').replace(/\/+$/, ''),
        model: 'claude-sonnet-4-20250514',
        availableModels: ['claude-sonnet-4-20250514', 'claude-haiku-4-20250414'],
        apiFormat: 'anthropic',
        source: '~/.aider/env.sh', status: 'pending',
      });
    } catch { /* ignore */ }
  }

  // ========== Ollama ==========
  private scanOllama(): void {
    this.providers.push({
      id: 'ollama', name: 'Ollama (本地)',
      apiKey: '', baseUrl: 'http://127.0.0.1:11434',
      model: 'gemma3:4b',
      availableModels: ['gemma3:4b'],
      apiFormat: 'ollama',
      source: '默认', status: 'pending',
    });
  }

  // ========== Shell RC 补充 ==========
  private scanShellRC(home: string): void {
    const rcFiles = [
      path.join(home, '.zshrc'),
      path.join(home, '.bashrc'),
    ];
    const vars = new Map<string, string>();
    for (const rcFile of rcFiles) {
      try {
        if (!fs.existsSync(rcFile)) continue;
        const content = fs.readFileSync(rcFile, 'utf-8');
        const parsed = this.parseShellExports(content);
        parsed.forEach((v, k) => { if (!vars.has(k)) vars.set(k, v); });
      } catch { /* ignore */ }
    }

    // 如果还没有 anthropic，从 shell 补充
    if (!this.providers.some(p => p.id === 'anthropic')) {
      const key = vars.get('ANTHROPIC_API_KEY') || '';
      if (key) {
        this.providers.push({
          id: 'anthropic', name: 'Claude (Shell)',
          apiKey: key,
          baseUrl: (vars.get('ANTHROPIC_BASE_URL') || 'https://api.anthropic.com').replace(/\/+$/, ''),
          model: 'claude-sonnet-4-20250514',
          availableModels: ['claude-sonnet-4-20250514', 'claude-haiku-4-20250414'],
          apiFormat: 'anthropic',
          source: '~/.zshrc', status: 'pending',
        });
      }
    }

    // 如果还没有 gemini，从 shell 补充
    if (!this.providers.some(p => p.id === 'gemini')) {
      const key = vars.get('GOOGLE_API_KEY') || vars.get('GEMINI_API_KEY') || '';
      if (key) {
        this.providers.push({
          id: 'gemini', name: 'Gemini (Shell)',
          apiKey: key,
          baseUrl: (vars.get('GOOGLE_GEMINI_BASE_URL') || 'https://generativelanguage.googleapis.com').replace(/\/+$/, ''),
          model: 'gemini-2.0-flash',
          availableModels: ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-2.0-flash-lite'],
          apiFormat: 'gemini',
          source: '~/.zshrc', status: 'pending',
        });
      }
    }

    // 如果还没有 deepseek，从 shell 补充
    if (!this.providers.some(p => p.id === 'deepseek')) {
      const key = vars.get('DEEPSEEK_API_KEY') || '';
      if (key) {
        this.providers.push({
          id: 'deepseek', name: 'DeepSeek (Shell)',
          apiKey: key,
          baseUrl: (vars.get('DEEPSEEK_BASE_URL') || 'https://api.deepseek.com').replace(/\/+$/, ''),
          model: 'deepseek-chat',
          availableModels: ['deepseek-chat', 'deepseek-reasoner'],
          apiFormat: 'openai',
          source: '~/.zshrc', status: 'pending',
        });
      }
    }

    // 如果还没有 minimax，从 shell 补充
    if (!this.providers.some(p => p.id === 'minimax')) {
      const key = vars.get('MINIMAX_API_KEY') || '';
      if (key) {
        this.providers.push({
          id: 'minimax', name: 'MiniMax (Shell)',
          apiKey: key,
          baseUrl: (vars.get('MINIMAX_BASE_URL') || 'https://api.minimaxi.com/v1').replace(/\/+$/, ''),
          model: 'MiniMax-M2.1',
          availableModels: ['MiniMax-M2.1', 'MiniMax-M2.1-lightning', 'MiniMax-M2'],
          apiFormat: 'openai',
          source: '~/.zshrc', status: 'pending',
        });
      }
    }

    // 如果还没有 zhipu，从 shell 补充
    if (!this.providers.some(p => p.id === 'zhipu')) {
      const key = vars.get('ZHIPUAI_API_KEY') || '';
      if (key) {
        this.providers.push({
          id: 'zhipu', name: 'ZhipuAI (Shell)',
          apiKey: key,
          baseUrl: (vars.get('ZHIPUAI_BASE_URL') || 'https://open.bigmodel.cn/api/paas/v4').replace(/\/+$/, ''),
          model: 'glm-4.7',
          availableModels: ['glm-4.7', 'glm-4.5', 'glm-4.5-air'],
          apiFormat: 'openai',
          source: '~/.zshrc', status: 'pending',
        });
      }
    }
  }

  // ========== 工具方法 ==========

  private parseShellExports(content: string): Map<string, string> {
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

  // ========== 测试连通性 ==========

  async testProvider(provider: AIProvider): Promise<AIProvider> {
    // 没有有效 apiKey 的直接标记失败（OAuth 类型、空 key），Ollama 除外
    if (provider.apiFormat !== 'ollama' && (!provider.apiKey || provider.apiKey === '(OAuth)')) {
      provider.status = 'fail';
      provider.errorMsg = '无有效 API Key';
      return provider;
    }

    // 根据 id 找测试定义，fallback 到通用
    let def = TEST_DEFS[provider.id];
    if (!def) {
      // opencode-xxx 类型，根据 baseUrl 猜测
      if (provider.baseUrl.includes('anthropic') || provider.baseUrl.includes('claude')) {
        def = TEST_DEFS.anthropic;
      } else {
        def = { testPath: '/v1/models', testMethod: 'GET', authStyle: 'bearer' };
      }
    }

    try {
      const result = await this.httpTest(provider, def);
      provider.status = result.ok ? 'ok' : 'fail';
      provider.errorMsg = result.ok ? undefined : result.error;
    } catch (e: any) {
      provider.status = 'fail';
      provider.errorMsg = e.message || '连接失败';
    }
    return provider;
  }

  async testAll(): Promise<AIProvider[]> {
    await Promise.all(this.providers.map(p => this.testProvider(p)));
    return this.providers;
  }

  private httpTest(
    provider: AIProvider,
    def: TestDef
  ): Promise<{ ok: boolean; error?: string }> {
    return new Promise((resolve) => {
      let baseUrl = provider.baseUrl;
      // 确保 baseUrl 是合法 URL
      if (!baseUrl.startsWith('http')) baseUrl = 'https://' + baseUrl;

      const url = new URL(baseUrl);
      const isHttps = url.protocol === 'https:';
      const lib = isHttps ? https : http;

      let testPath = def.testPath;
      if (def.authStyle === 'gemini-query' && provider.apiKey) {
        testPath += `?key=${provider.apiKey}`;
      }

      const headers: Record<string, string> = {};
      if (def.authStyle === 'anthropic' && provider.apiKey) {
        headers['x-api-key'] = provider.apiKey;
        headers['anthropic-version'] = '2023-06-01';
        headers['content-type'] = 'application/json';
      } else if (def.authStyle === 'bearer' && provider.apiKey) {
        headers['Authorization'] = `Bearer ${provider.apiKey}`;
      }

      const options: http.RequestOptions = {
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: (url.pathname === '/' ? '' : url.pathname) + testPath,
        method: def.testMethod,
        timeout: 10000,
        headers,
      };

      const req = lib.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          const code = res.statusCode || 0;
          if (code >= 200 && code < 500) {
            resolve({ ok: true });
          } else {
            resolve({ ok: false, error: `HTTP ${code}` });
          }
        });
      });

      req.on('error', (e) => resolve({ ok: false, error: e.message }));
      req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: '连接超时' }); });

      if (def.authStyle === 'anthropic' && def.testMethod === 'POST') {
        req.write(JSON.stringify({
          model: provider.model,
          max_tokens: 1,
          messages: [{ role: 'user', content: 'hi' }],
        }));
      }

      req.end();
    });
  }

  getProviders(): AIProvider[] {
    return this.providers;
  }

  static maskKey(key: string): string {
    if (!key || key === '(OAuth)') return key || '(无)';
    if (key.length <= 8) return '****';
    return key.substring(0, 4) + '****' + key.substring(key.length - 4);
  }
}
