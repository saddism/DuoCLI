import * as http from 'http';
import * as https from 'https';
import * as fs from 'fs';

import * as os from 'os';
import * as path from 'path';

const LOG_PATH = path.join(os.tmpdir(), 'duocli-ai.log');

function aiLog(msg: string): void {
  const ts = new Date().toISOString();
  fs.appendFileSync(LOG_PATH, `[${ts}] ${msg}\n`);
}

export interface AIClientConfig {
  apiFormat: 'anthropic' | 'openai' | 'gemini' | 'ollama';
  baseUrl: string;
  apiKey: string;
  model: string;
}

const SUMMARIZE_PROMPT = '你是终端会话总结助手。根据以下终端输出，用中文生成一个简短标题（不超过10个字）。忽略ASCII art、欢迎语、logo等装饰内容，只关注用户实际执行的命令和操作。只输出标题文字，不要引号和解释。';

const DIFF_SUMMARY_PROMPT = '你是代码变更总结助手。根据以下 git diff 内容，用中文简要总结修改了什么（不超过50个字）。只关注实际的代码逻辑变化，忽略空行和格式变化。只输出总结文字，不要引号和解释。';

// 当前选中的 provider 配置
let currentConfig: AIClientConfig | null = null;

export function setAIConfig(config: AIClientConfig | null): void {
  currentConfig = config;
  aiLog(`setAIConfig: ${JSON.stringify(config)}`);
}

export function getAIConfig(): AIClientConfig | null {
  return currentConfig;
}

// 过滤终端输出中的 ASCII art、ANSI 转义序列和装饰性内容
function cleanTerminalOutput(raw: string): string {
  const lines = raw.split('\n');
  const cleaned: string[] = [];
  for (const line of lines) {
    // 去掉 ANSI 转义序列
    const plain = line.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '').trim();
    if (!plain) continue;
    // 跳过 ASCII art 行：主要由非字母数字字符组成（如 ╭╰│─═╗╔║▓░▒█ 等）
    const alphanumCount = (plain.match(/[a-zA-Z0-9\u4e00-\u9fff]/g) || []).length;
    if (plain.length > 5 && alphanumCount / plain.length < 0.3) continue;
    // 跳过纯重复字符行（如 ====、----、****）
    if (/^(.)\1{4,}$/.test(plain)) continue;
    cleaned.push(plain);
  }
  return cleaned.join('\n');
}

export async function aiSummarize(buffer: string): Promise<string> {
  const raw = buffer.slice(-1000);
  const text = cleanTerminalOutput(raw);

  aiLog('========== aiSummarize 开始 ==========');
  aiLog(`输入文本长度: ${text.length}`);
  aiLog(`输入文本内容:\n${text}`);

  if (!currentConfig) {
    aiLog('无配置，fallback ollama');
    return ollamaCall(text);
  }

  aiLog(`当前配置: ${JSON.stringify(currentConfig)}`);

  try {
    let result: string;
    switch (currentConfig.apiFormat) {
      case 'anthropic':
        result = await anthropicCall(`终端内容：\n${text}`, currentConfig);
        break;
      case 'openai':
        result = await openaiCall(`终端内容：\n${text}`, currentConfig);
        break;
      case 'gemini':
        result = await geminiCall(`终端内容：\n${text}`, currentConfig);
        break;
      case 'ollama':
        result = await ollamaCall(text);
        break;
      default:
        result = await ollamaCall(text);
        break;
    }
    aiLog(`最终返回标题: "${result}"`);
    aiLog('========== aiSummarize 结束 ==========\n');
    return result;
  } catch (e: any) {
    aiLog(`调用异常: ${e.message}, fallback ollama`);
    try {
      const fallback = await ollamaCall(text);
      aiLog(`ollama fallback 返回: "${fallback}"`);
      return fallback;
    } catch { return '终端会话'; }
  }
}

// AI 总结 diff 变更内容
export async function aiDiffSummary(diff: string): Promise<string> {
  const text = diff.slice(-3000);

  if (!currentConfig) {
    return fallbackDiffSummary(diff);
  }

  try {
    let result: string;
    switch (currentConfig.apiFormat) {
      case 'anthropic':
        result = await anthropicCall(text, currentConfig, DIFF_SUMMARY_PROMPT, 100);
        break;
      case 'openai':
        result = await openaiCall(text, currentConfig, DIFF_SUMMARY_PROMPT, 100);
        break;
      case 'gemini':
        result = await geminiCall(text, currentConfig, DIFF_SUMMARY_PROMPT, 100);
        break;
      default:
        return fallbackDiffSummary(diff);
    }
    return result || fallbackDiffSummary(diff);
  } catch {
    return fallbackDiffSummary(diff);
  }
}

// 无 AI 时的统计型 fallback
function fallbackDiffSummary(diff: string): string {
  const lines = diff.split('\n');
  const files: Map<string, { added: number; removed: number }> = new Map();
  let currentFile = '';
  for (const line of lines) {
    if (line.startsWith('diff --git')) {
      const match = line.match(/b\/(.+)$/);
      currentFile = match ? match[1] : '';
      if (currentFile && !files.has(currentFile)) {
        files.set(currentFile, { added: 0, removed: 0 });
      }
    } else if (currentFile) {
      if (line.startsWith('+') && !line.startsWith('+++')) {
        files.get(currentFile)!.added++;
      } else if (line.startsWith('-') && !line.startsWith('---')) {
        files.get(currentFile)!.removed++;
      }
    }
  }
  if (files.size === 0) return '无变更内容';
  let totalAdded = 0, totalRemoved = 0;
  const parts: string[] = [];
  files.forEach((stats, filePath) => {
    totalAdded += stats.added;
    totalRemoved += stats.removed;
    const name = filePath.split('/').pop() || filePath;
    const changes: string[] = [];
    if (stats.added > 0) changes.push(`+${stats.added}`);
    if (stats.removed > 0) changes.push(`-${stats.removed}`);
    parts.push(`${name}(${changes.join('/')})`);
  });
  return `${files.size} 个文件 | +${totalAdded} -${totalRemoved} 行 | ${parts.join(', ')}`;
}

// Anthropic 格式调用
function anthropicCall(text: string, config: AIClientConfig, prompt: string = SUMMARIZE_PROMPT, maxTokens: number = 50): Promise<string> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: config.model,
      max_tokens: maxTokens,
      messages: [
        { role: 'user', content: `${prompt}\n\n${text}` },
      ],
    });

    const url = new URL(config.baseUrl);
    const isHttps = url.protocol === 'https:';
    const lib = isHttps ? https : http;

    let apiPath = url.pathname.replace(/\/+$/, '');
    if (!apiPath.endsWith('/v1')) {
      apiPath += '/v1';
    }
    apiPath += '/messages';

    const reqHeaders = {
      'Content-Type': 'application/json',
      'x-api-key': config.apiKey,
      'anthropic-version': '2023-06-01',
    };

    aiLog(`--- anthropic 请求 ---`);
    aiLog(`URL: ${url.protocol}//${url.hostname}:${url.port || (isHttps ? 443 : 80)}${apiPath}`);
    aiLog(`Method: POST`);
    aiLog(`Headers: ${JSON.stringify({ ...reqHeaders, 'x-api-key': reqHeaders['x-api-key'].slice(0, 8) + '...' })}`);
    aiLog(`Body: ${body}`);

    const req = lib.request({
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: apiPath,
      method: 'POST',
      timeout: 15000,
      headers: reqHeaders,
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        aiLog(`--- anthropic 响应 ---`);
        aiLog(`Status: ${res.statusCode}`);
        aiLog(`Response Headers: ${JSON.stringify(res.headers)}`);
        aiLog(`Response Body: ${data}`);
        const code = res.statusCode || 0;
        if (code < 200 || code >= 300) {
          aiLog(`anthropic 非 2xx，reject`);
          reject(new Error(`HTTP ${code}: ${data.slice(0, 200)}`));
          return;
        }
        try {
          const json = JSON.parse(data);
          const content = json.content?.[0]?.text || '';
          const result = content.trim().replace(/["""]/g, '').slice(0, 30) || '终端会话';
          aiLog(`解析结果: "${result}"`);
          resolve(result);
        } catch (e: any) {
          aiLog(`JSON 解析失败: ${e.message}`);
          reject(new Error(`JSON parse: ${e.message}`));
        }
      });
    });

    req.on('error', (e) => { aiLog(`anthropic 网络错误: ${e.message}`); reject(e); });
    req.on('timeout', () => { req.destroy(); aiLog('anthropic 超时'); reject(new Error('timeout')); });
    req.write(body);
    req.end();
  });
}

// OpenAI 格式调用
function openaiCall(text: string, config: AIClientConfig, prompt: string = SUMMARIZE_PROMPT, maxTokens: number = 50): Promise<string> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: config.model,
      max_tokens: maxTokens,
      messages: [
        { role: 'system', content: prompt },
        { role: 'user', content: text },
      ],
    });

    const url = new URL(config.baseUrl);
    const isHttps = url.protocol === 'https:';
    const lib = isHttps ? https : http;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (config.apiKey) {
      headers['Authorization'] = `Bearer ${config.apiKey}`;
    }

    let apiPath = url.pathname.replace(/\/+$/, '');
    if (!apiPath.endsWith('/v1')) {
      apiPath += '/v1';
    }
    apiPath += '/chat/completions';

    aiLog(`--- openai 请求 ---`);
    aiLog(`URL: ${url.protocol}//${url.hostname}:${url.port || (isHttps ? 443 : 80)}${apiPath}`);
    aiLog(`Method: POST`);
    aiLog(`Headers: ${JSON.stringify({ ...headers, Authorization: headers.Authorization ? headers.Authorization.slice(0, 15) + '...' : '(none)' })}`);
    aiLog(`Body: ${body}`);

    const req = lib.request({
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: apiPath,
      method: 'POST',
      timeout: 15000,
      headers,
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        aiLog(`--- openai 响应 ---`);
        aiLog(`Status: ${res.statusCode}`);
        aiLog(`Response Headers: ${JSON.stringify(res.headers)}`);
        aiLog(`Response Body: ${data}`);
        const code = res.statusCode || 0;
        if (code < 200 || code >= 300) {
          aiLog(`openai 非 2xx，reject`);
          reject(new Error(`HTTP ${code}: ${data.slice(0, 200)}`));
          return;
        }
        try {
          const json = JSON.parse(data);
          const content = json.choices?.[0]?.message?.content || '';
          const result = content.trim().replace(/["""]/g, '').slice(0, 30) || '终端会话';
          aiLog(`解析结果: "${result}"`);
          resolve(result);
        } catch (e: any) {
          aiLog(`JSON 解析失败: ${e.message}`);
          reject(new Error(`JSON parse: ${e.message}`));
        }
      });
    });

    req.on('error', (e) => { aiLog(`openai 网络错误: ${e.message}`); reject(e); });
    req.on('timeout', () => { req.destroy(); aiLog('openai 超时'); reject(new Error('timeout')); });
    req.write(body);
    req.end();
  });
}

// Gemini 原生格式调用
function geminiCall(text: string, config: AIClientConfig, prompt: string = SUMMARIZE_PROMPT, maxTokens: number = 50): Promise<string> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      contents: [{ parts: [{ text: `${prompt}\n\n${text}` }] }],
      generationConfig: { maxOutputTokens: maxTokens },
    });

    const url = new URL(config.baseUrl);
    const isHttps = url.protocol === 'https:';
    const lib = isHttps ? https : http;

    let apiPath = url.pathname.replace(/\/+$/, '');
    apiPath += `/v1beta/models/${config.model}:generateContent`;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (config.apiKey) {
      headers['Authorization'] = `Bearer ${config.apiKey}`;
    }

    aiLog(`--- gemini 请求 ---`);
    aiLog(`URL: ${url.protocol}//${url.hostname}:${url.port || (isHttps ? 443 : 80)}${apiPath}`);
    aiLog(`Method: POST`);
    aiLog(`Body: ${body}`);

    const req = lib.request({
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: apiPath,
      method: 'POST',
      timeout: 15000,
      headers,
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        aiLog(`--- gemini 响应 ---`);
        aiLog(`Status: ${res.statusCode}`);
        aiLog(`Response Body: ${data.slice(0, 500)}`);
        const code = res.statusCode || 0;
        if (code < 200 || code >= 300) {
          aiLog(`gemini 非 2xx，reject`);
          reject(new Error(`HTTP ${code}: ${data.slice(0, 200)}`));
          return;
        }
        try {
          const json = JSON.parse(data);
          const parts = json.candidates?.[0]?.content?.parts || [];
          const textParts = parts.filter((p: any) => p.text && !p.thought);
          const content = textParts.map((p: any) => p.text).join('') || '';
          const result = content.trim().replace(/["""]/g, '').slice(0, 30) || '终端会话';
          aiLog(`解析结果: "${result}"`);
          resolve(result);
        } catch (e: any) {
          aiLog(`JSON 解析失败: ${e.message}`);
          reject(new Error(`JSON parse: ${e.message}`));
        }
      });
    });

    req.on('error', (e) => { aiLog(`gemini 网络错误: ${e.message}`); reject(e); });
    req.on('timeout', () => { req.destroy(); aiLog('gemini 超时'); reject(new Error('timeout')); });
    req.write(body);
    req.end();
  });
}

// Ollama 本地调用
function ollamaCall(text: string): Promise<string> {
  return new Promise((resolve) => {
    const prompt = `${SUMMARIZE_PROMPT}\n\n终端内容：\n${text}`;
    const postData = JSON.stringify({
      model: 'gemma3:4b',
      prompt,
      stream: false,
    });

    aiLog(`--- ollama 请求 ---`);
    aiLog(`URL: http://127.0.0.1:11434/api/generate`);
    aiLog(`Body: ${postData}`);

    const req = http.request({
      hostname: '127.0.0.1',
      port: 11434,
      path: '/api/generate',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData),
      },
      timeout: 15000,
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        aiLog(`--- ollama 响应 ---`);
        aiLog(`Status: ${res.statusCode}`);
        aiLog(`Response Body: ${data}`);
        try {
          const json = JSON.parse(data);
          const title = (json.response || '').trim().replace(/["""]/g, '').slice(0, 30);
          const result = title || '终端会话';
          aiLog(`解析结果: "${result}"`);
          resolve(result);
        } catch (e: any) {
          aiLog(`JSON 解析失败: ${e.message}`);
          resolve('终端会话');
        }
      });
    });

    req.on('error', (e) => { aiLog(`ollama 网络错误: ${e.message}`); resolve('终端会话'); });
    req.on('timeout', () => { req.destroy(); aiLog('ollama 超时'); resolve('终端会话'); });
    req.write(postData);
    req.end();
  });
}
