/**
 * 上下文导出功能 - 将对话历史保存到本地文件系统
 * 支持跨 Agent 上下文转移
 */

import * as fs from 'fs';
import * as path from 'path';
import { ClosedSession, ContextHistoryEntry } from './closed-sessions';
import { CliKind, identifyCli } from './session-resume';

/** 导出的完整上下文结构（JSON） */
export interface ExportedContext {
  version: string;
  createdAt: number;
  updatedAt: number;
  sourceAgent: CliKind;
  targetAgent?: CliKind;
  cwd: string;
  title: string;
  contextHistory: ContextHistoryEntry[];
  gitState?: {
    commitHash?: string;
    branch?: string;
    hasUncommittedChanges?: boolean;
  };
}

/** 导出目录配置 */
interface ExportConfig {
  /** 基础导出目录 */
  baseDir: string;
  /** 自动清理天数 */
  autoCleanupDays: number;
  /** 最大导出文件数 */
  maxExportFiles: number;
}

// 默认配置
const DEFAULT_CONFIG: ExportConfig = {
  baseDir: path.join(getUserDataDirectory(), 'context-exports'),
  autoCleanupDays: 7,
  maxExportFiles: 50,
};

/** 获取用户数据目录 */
function getUserDataDirectory(): string {
  if (process.env.DUOCLI_USER_DATA) {
    return process.env.DUOCLI_USER_DATA;
  }
  
  const home = require('os').homedir();
  const appData = process.platform === 'win32'
    ? path.join(home, 'AppData', 'Roaming')
    : path.join(home, '.config');
  
  return path.join(appData, 'DuoCLI');
}

/** 确保导出目录存在 */
function ensureExportDirectory(): string {
  const exportDir = DEFAULT_CONFIG.baseDir;
  try {
    if (!fs.existsSync(exportDir)) {
      fs.mkdirSync(exportDir, { recursive: true });
    }
    return exportDir;
  } catch (err) {
    console.error('[ContextExport] 无法创建立导出目录:', err);
    // fallback 到临时目录
    return path.join(require('os').tmpdir(), 'duocli-exports');
  }
}

/** 
 * 从当前进程 PID 推断 Git 状态（简化版）
 * TODO: 集成完整的 Git 快照功能
 */
function getGitState(cwd: string): ExportedContext['gitState'] | undefined {
  // 简化实现：暂时不捕获 Git 状态
  // 可以在未来扩展为调用 `git status` 和 `git rev-parse HEAD`
  return undefined;
}

/**
 * 构建文件名（用于手机端访问）
 */
function buildFileName(
  sessionId: string,
  sourceCli: CliKind,
  targetCli?: CliKind
): string {
  const targetStr = targetCli ? `-to-${targetCli}` : '';
  return `session-${sessionId}-${sourceCli}${targetStr}.json`;
}

/**
 * 导出单个会话的完整上下文
 * @param session 已关闭的会话
 * @param targetAgent 可选的目标 Agent（默认为 null）
 */
export function exportSessionContext(
  session: ClosedSession,
  targetAgent?: CliKind
): ExportedContext {
  const now = Date.now();
  
  const context: ExportedContext = {
    version: '1.0',
    createdAt: now,
    updatedAt: now,
    sourceAgent: identifyCliFromCommand(session.presetCommand),
    targetAgent,
    cwd: session.cwd,
    title: session.title || '未命名会话',
    contextHistory: session.contextHistory || [],
    gitState: getGitState(session.cwd),
  };
  
  return context;
}

/**
 * 将导出的上下文写入文件系统
 * @param context 导出的上下文对象
 * @param session 原始会话 ID
 */
export function writeExportToFile(
  context: ExportedContext,
  session: ClosedSession
): string {
  const exportDir = ensureExportDirectory();
  const fileName = buildFileName(
    session.id.replace('closed-', ''),
    context.sourceAgent,
    context.targetAgent
  );
  const filePath = path.join(exportDir, fileName);
  
  // 写入 JSON 文件（格式化以便人类可读）
  const jsonContent = JSON.stringify(context, null, 2);
  fs.writeFileSync(filePath, jsonContent, 'utf8');
  
  // 记录导出路径到 session
  session.exportPath = filePath;
  
  console.log(`[ContextExport] 上下文已导出：${filePath}`);
  return filePath;
}

/**
 * 生成导入提示模板
 * 用于指导用户如何在新 Agent 中使用导出的上下文
 */
export function generateImportPrompt(context: ExportedContext, contextPath: string): string {
  return `# 如何在其他 AI Agent 中使用此上下文

## 文件位置
此文件保存在：\`${contextPath}\`

## 使用方法

### Option 1: 拖拽导入
直接将此文件拖到新 Agent 的对话框中即可。

### Option 2: 复制粘贴
打开此文件，复制全部内容，然后粘贴到新 Agent 的输入框中。

## 推荐的提示词模板

当你想基于此上下文继续工作时，可以使用以下格式：

---

我已经和另一个 AI 助手完成了以下工作：

{{在此处插入上下文内容}}

请基于这个背景，帮我继续做下一步的工作。

---

## 当前工作环境
- 工作目录：\`\`\`${context.cwd}\`\`\`
- 会话标题：\`\`\`${context.title}\`\`\`
`;
}

/**
 * 从 JSON 文件读取上下文
 */
export function readExportFromFile(filePath: string): ExportedContext | null {
  try {
    if (!fs.existsSync(filePath)) {
      console.error(`[ContextExport] 文件不存在：${filePath}`);
      return null;
    }
    
    const content = fs.readFileSync(filePath, 'utf8');
    const context = JSON.parse(content);
    
    // 验证基本字段
    if (!context.version || !context.contextHistory) {
      console.error('[ContextExport] 文件格式不正确');
      return null;
    }
    
    return context;
  } catch (err) {
    console.error('[ContextExport] 读取文件失败:', err);
    return null;
  }
}

/**
 * 清理过期的导出文件
 */
export function cleanupExpiredExports(config: ExportConfig = DEFAULT_CONFIG): void {
  const exportDir = config.baseDir;
  if (!fs.existsSync(exportDir)) return;
  
  const cutoffTime = Date.now() - config.autoCleanupDays * 24 * 60 * 60 * 1000;
  let deletedCount = 0;
  
  try {
    const files = fs.readdirSync(exportDir);
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      
      const filePath = path.join(exportDir, file);
      const stats = fs.statSync(filePath);
      
      if (stats.mtimeMs < cutoffTime) {
        fs.unlinkSync(filePath);
        deletedCount++;
      }
    }
    
    if (deletedCount > 0) {
      console.log(`[ContextExport] 已删除 ${deletedCount} 个过期文件`);
    }
  } catch (err) {
    console.error('[ContextExport] 清理失败:', err);
  }
}

/**
 * 限制导出文件数量（删除旧的）
 */
export function enforceMaxExportLimit(config: ExportConfig = DEFAULT_CONFIG): void {
  const exportDir = config.baseDir;
  if (!fs.existsSync(exportDir)) return;
  
  try {
    const files = fs.readdirSync(exportDir).filter(f => f.endsWith('.json'));
    
    if (files.length <= config.maxExportFiles) return;
    
    // 按修改时间排序
    const filePaths = files.map(f => ({
      path: path.join(exportDir, f),
      mtime: fs.statSync(path.join(exportDir, f)).mtimeMs,
    })).sort((a, b) => a.mtime - b.mtime);
    
    // 删除最旧的文件
    const toDelete = filePaths.slice(0, files.length - config.maxExportFiles);
    for (const item of toDelete) {
      try {
        fs.unlinkSync(item.path);
      } catch (err) {
        console.error('[ContextExport] 删除文件失败:', item.path, err);
      }
    }
  } catch (err) {
    console.error('[ContextExport] 限制检查失败:', err);
  }
}

/**
 * 列出所有可用的导出文件
 */
export function listExports(): Array<{ path: string; context: ExportedContext }> {
  const exportDir = DEFAULT_CONFIG.baseDir;
  if (!fs.existsSync(exportDir)) return [];
  
  const results: Array<{ path: string; context: ExportedContext }> = [];
  
  try {
    const files = fs.readdirSync(exportDir).filter(f => f.endsWith('.json'));
    
    for (const file of files) {
      const filePath = path.join(exportDir, file);
      const context = readExportFromFile(filePath);
      if (context) {
        results.push({ path: filePath, context });
      }
    }
  } catch (err) {
    console.error('[ContextExport] 列出导出文件失败:', err);
  }
  
  return results;
}

/**
 * 根据 presetCommand 识别 CLI 类型
 */
function identifyCliFromCommand(presetCommand: string): CliKind {
  return identifyCli(presetCommand);
}

/**
 * 导出为 Markdown 格式（备选方案）
 */
export function exportToMarkdown(context: ExportedContext): string {
  const lines = [
    `# 会话上下文导出`,
    ``,
    `## 基本信息`,
    `- **工作目录**: \`${context.cwd}\``,
    `- **标题**: ${context.title}`,
    `- **源 Agent**: \`${context.sourceAgent}\``,
    context.targetAgent && `- **目标 Agent**: \`${context.targetAgent}\``,
    `- **导出时间**: ${new Date(context.createdAt).toLocaleString('zh-CN')}`,
    ``,
    `## 对话历史`,
    ``,
  ];
  
  for (const entry of context.contextHistory) {
    const roleLabel = entry.role === 'user' ? '**用户**' : '**AI**';
    lines.push(`${roleLabel}:`);
    lines.push(entry.content);
    lines.push('');
    lines.push('---');
    lines.push('');
  }
  
  return lines.filter(Boolean).join('\n');
}
