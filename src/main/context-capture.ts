/**
 * 对话内容捕获器 - 从 PTY 输出流中提取 Q&A 对话历史
 * 支持跨 Agent 上下文转移功能
 */

import { CliKind } from './session-resume';
import { ContextHistoryEntry } from './closed-sessions';

/** 从输出中捕获的对话历史结果 */
export interface ContextCaptureResult {
  history: ContextHistoryEntry[];
  hasContent: boolean;
  captureSource: 'output' | 'registry';
}

/** 
 * 不同 CLI 的输出格式模式
 * 每个 CLI 可能有不同的用户输入/AI 回复标记方式
 */
interface CLIPatterns {
  user: RegExp;
  assistant: RegExp;
  separator?: RegExp;  // 对话分隔符（可选）
}

// 为每种 CLI 定义特定的正则模式
const CLI_PATTERNS: Record<CliKind, CLIPatterns> = {
  // Codex: 使用 ❯ 表示用户输入
  codex: {
    user: /\u276f\s+(.*)/,           // ❯ 用户输入
    assistant: /^(?!\u276f).*(?:\n|$)/gm,  // AI 回复（非❯开头的行）
  },
  
  // Claude Code: 可能使用 > 表示用户输入
  claude: {
    user: /^>\s+(.*)/gm,             // > 用户输入
    assistant: /^(?!>).*?(?:\n|$)/gm,  // AI 回复
  },
  
  // Cursor: 可能是纯文本对话形式
  cursor: {
    user: /^\[user\]\s+(.*)/gm,      // [user] 前缀
    assistant: /^\[assistant\]\s+(.*)/gm,  // [assistant] 前缀
  },
  
  // Gemini: 通常没有特殊标记，用位置判断
  gemini: {
    user: /(?:^|\n)(?:>>>|User:)\s+(.*)/gmi,
    assistant: /(?:^|\n)(?:Model:|Gemini:|>\s*)(.*)/gmi,
  },
  
  // Kimi: 类似普通对话
  kimi: {
    user: /(?:^|\n)(?:我：|用户：|User:)\s*(.*)/gmi,
    assistant: /(?:^|\n)(?:Kimi:|模型：|Assistant:|AI:)\s*(.*)/gmi,
  },
  
  // Qoder: 自定义格式
  qoder: {
    user: /(?:^|\n)❯\s+(.*)/gmi,
    assistant: /(?:^|\n)(?!❯)[^\n]+/gm,
  },
  
  // Qodercn: 类似
  qodercn: {
    user: /(?:^|\n)❯\s+(.*)/gmi,
    assistant: /(?:^|\n)(?!❯)[^\n]+/gm,
  },
  
  // OpenCode:
  opencode: {
    user: /(?:^|\n)>>>?\s+(.*)/gm,
    assistant: /(?:^|\n)(?!>>>?)[^\n]+/gm,
  },
  
  // Kiro:
  kiro: {
    user: /(?:^|\n)❯\s+(.*)/gmi,
    assistant: /(?:^|\n)(?!❯)[^\n]+/gm,
  },
  
  // Antigravity (agy):
  agy: {
    user: /(?:^|\n)>?\s*(?:User:|用户：)?\s*(.*)/gmi,
    assistant: /(?:^|\n)(?:Assistant:|助手：|AI:)?\s*(.*)/gmi,
  },
  
  // Devin:
  devin: {
    user: /(?:^|\n)(?:>>|>)\s+(.*)/gm,
    assistant: /(?:^|\n)(?!>>)[^\n]+/gm,
  },
  
  // unknown: 无法识别特定模式
  unknown: {
    user: /.*/m,  // fallback: 假设有换行的都是对话
    assistant: /.*/m,
  },
};

/**
 * 清理 ANSI 转义序列和控制字符
 */
function sanitizeOutput(text: string): string {
  return text
    // 移除 ANSI 颜色码
    .replace(/\x1b\[[0-?]*[ -\/]*[@-~]/g, '')
    // 移除 OSC (Operating System Command) 序列
    .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, '')
    // 移除其他控制字符
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    // 规范化空白
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

/**
 * 按行处理并识别角色
 */
function detectRolesInChunks(
  chunks: string[],
  cli: CliKind
): ContextHistoryEntry[] {
  const combined = chunks.join('');
  const sanitized = sanitizeOutput(combined);
  const lines = sanitized.split('\n');
  const patterns = CLI_PATTERNS[cli] || CLI_PATTERNS.unknown;
  
  const history: ContextHistoryEntry[] = [];
  let currentRole: 'user' | 'assistant' | null = null;
  let currentContent: string[] = [];
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    
    // 检查是否匹配用户模式
    const userMatch = patternMatch(line, patterns.user);
    
    // 检查是否匹配助手模式
    const assistantMatch = patternMatch(line, patterns.assistant);
    
    if (userMatch) {
      // 保存之前的对话块
      if (currentContent.length > 0) {
        history.push({
          role: currentRole || 'assistant',
          content: currentContent.join('\n'),
          timestamp: Date.now(),
        });
      }
      
      // 开始新的用户对话
      currentRole = 'user';
      currentContent = [userMatch[1].trim()];
    } else if (assistantMatch) {
      // 保存之前的对话块
      if (currentContent.length > 0) {
        history.push({
          role: currentRole || 'assistant',
          content: currentContent.join('\n'),
          timestamp: Date.now(),
        });
      }
      
      // 开始新的助手对话
      currentRole = 'assistant';
      currentContent = [assistantMatch[1]?.trim() || line.trim()];
    } else {
      // 没有明确的模式匹配，根据上下文判断
      if (currentRole === null) {
        // 第一条有效内容，假设是助手回复
        currentRole = 'assistant';
        currentContent = [line];
      } else if (history.length > 0 && history[history.length - 1].role === 'user') {
        // 如果上一条是用户，这应该是助手回复
        currentRole = 'assistant';
        currentContent = [line];
      } else {
        // 继续当前角色的内容
        currentContent.push(line);
      }
    }
  }
  
  // 保存最后一个对话块
  if (currentContent.length > 0) {
    history.push({
      role: currentRole || 'assistant',
      content: currentContent.join('\n'),
      timestamp: Date.now(),
    });
  }
  
  return history;
}

/**
 * 尝试将多个对话块合并成连续的对话对
 */
function mergeConversationPairs(history: ContextHistoryEntry[]): ContextHistoryEntry[] {
  const merged: ContextHistoryEntry[] = [];
  let i = 0;
  
  while (i < history.length) {
    const entry = history[i];
    
    // 查找连续的用户 - 助手对
    if (entry.role === 'user' && i + 1 < history.length && history[i + 1].role === 'assistant') {
      // 完整的对话对
      merged.push(entry);
      merged.push(history[i + 1]);
      i += 2;
    } else if (entry.role === 'user') {
      // 只有用户没有助手回复（可能是最后的提问）
      merged.push(entry);
      i++;
    } else if (merged.length > 0 && merged[merged.length - 1].role === 'user') {
      // 接在用户问题后面的助手回复
      merged.push(entry);
      i++;
    } else {
      // 孤立的助手回复（可能是开场白或初始设置）
      if (merged.length === 0) {
        merged.push(entry);
      }
      i++;
    }
  }
  
  return merged;
}

/**
 * 辅助函数：执行正则匹配并返回第二个捕获组（如果有）
 */
function patternMatch(line: string, pattern: RegExp): RegExpMatchArray | null {
  // 重置 lastIndex
  pattern.lastIndex = 0;
  return line.match(pattern);
}

/**
 * 主要的导出函数 - 从输出块中提取对话历史
 * @param chunks PTY 输出的数据块数组
 * @param cli 使用的 CLI 类型
 * @returns 对话历史记录
 */
export function extractContextFromChunks(
  chunks: string[],
  cli: CliKind
): ContextCaptureResult {
  // 步骤 1: 识别每行的角色
  let history = detectRolesInChunks(chunks, cli);
  
  // 步骤 2: 过滤掉过短的内容（可能是系统消息等噪声）
  history = history.filter(entry => {
    const trimmed = entry.content.trim();
    return trimmed.length > 3;  // 至少 3 个字符才算有效内容
  });
  
  // 步骤 3: 合并连续的对话对
  history = mergeConversationPairs(history);
  
  return {
    history,
    hasContent: history.length > 0,
    captureSource: 'output',
  };
}

/**
 * 备用方案：直接从整个输出字符串解析（不依赖分块）
 * @param output 完整的输出字符串
 * @param cli CLI 类型
 */
export function extractContextFromString(
  output: string,
  cli: CliKind
): ContextCaptureResult {
  const sanitized = sanitizeOutput(output);
  const patterns = CLI_PATTERNS[cli] || CLI_PATTERNS.unknown;
  
  const history: ContextHistoryEntry[] = [];
  
  // 分别提取用户和助手的对话
  const userMatches = [...sanitized.matchAll(patterns.user)];
  const assistantMatches = [...sanitized.matchAll(patterns.assistant)];
  
  // 按位置排序所有匹配
  const allMatches: Array<{ position: number; role: 'user' | 'assistant'; match: RegExpMatchArray }> = [];
  
  for (const m of userMatches) {
    allMatches.push({ position: m.index || 0, role: 'user', match: m });
  }
  for (const m of assistantMatches) {
    allMatches.push({ position: m.index || 0, role: 'assistant', match: m });
  }
  
  allMatches.sort((a, b) => a.position - b.position);
  
  // 生成对话历史
  for (const item of allMatches) {
    const content = item.match[1]?.trim() || item.match[0].trim();
    if (content.length > 3) {
      history.push({
        role: item.role,
        content,
        timestamp: Date.now(),
      });
    }
  }
  
  return {
    history,
    hasContent: history.length > 0,
    captureSource: 'output',
  };
}

/**
 * 合并多个片段到内存缓冲区（用于 PTY 运行时累积）
 * @param existingBuffer 现有的缓冲区
 * @param newChunk 新接收的数据块
 * @param maxBufferSize 最大缓冲区大小（字节），超过则截断
 */
export function appendToBuffer(
  existingBuffer: string,
  newChunk: string,
  maxBufferSize: number = 512 * 1024  // 512KB
): string {
  let buffer = existingBuffer + newChunk;
  
  // 防止缓冲区无限增长，保留最新的部分
  if (buffer.length > maxBufferSize) {
    const overflow = buffer.length - maxBufferSize;
    const newlinePos = buffer.lastIndexOf('\n', overflow);
    if (newlinePos !== -1) {
      buffer = buffer.substring(newlinePos + 1);
    }
  }
  
  return buffer;
}

/**
 * 从缓冲区提取最终的对话历史
 */
export function flushContextFromBuffer(
  buffer: string,
  cli: CliKind
): ContextCaptureResult {
  const chunks = buffer.split('\n').filter(Boolean);
  return extractContextFromChunks(chunks, cli);
}
