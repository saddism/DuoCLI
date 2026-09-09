# 跨 AI Agent 上下文转移功能设计方案

## 目标

允许用户将某个 AI Agent（如 Codex）上开发的任务无缝转移到另一个 Agent（如 Cursor）继续工作。

## 核心设计原则

1. **极简优先** - 只保留最基础的对话历史（提问和回复），避免复杂的元数据依赖
2. **跨平台兼容** - 使用纯文本 + JSON，任何 Agent 都能读取和理解
3. **可编辑性** - 用户可以手动修改导出的文件
4. **向后兼容** - 不影响现有会话恢复功能

## 数据结构

### ClosedSession 扩展

在现有的 `ClosedSession` 接口中添加两个可选字段：

```typescript
interface ClosedSession {
  id: string;
  title: string;
  cwd: string;
  presetCommand: string;
  resumeId: string;
  resumeCommand: string;
  displayName: string;
  closedAt: number;
  
  // 新增：简单的对话历史记录
  contextHistory?: Array<{
    role: 'user' | 'assistant';
    content: string;
  }>;
  
  // 新增：导出的上下文文件路径
  exportPath?: string;
  
  // ... 其他现有字段保持不变
}
```

### 上下文导出格式

单个会话的完整结构：

```json
{
  "version": "1.0",
  "createdAt": 1725800000000,
  "sourceAgent": "codex",
  "targetAgent": "cursor",
  "cwd": "/Users/dev/projects/myapp",
  "title": "Express.js Hello World 项目",
  
  "contextHistory": [
    {
      "role": "user",
      "content": "帮我创建一个 Express.js 的 Hello World 项目"
    },
    {
      "role": "assistant",
      "content": "好的，我来帮你创建...\n\n首先初始化 npm 项目..."
    },
    {
      "role": "user",
      "content": "现在添加一个 GET /api/user 端点"
    },
    {
      "role": "assistant",
      "content": "没问题，这是代码..."
    }
  ],
  
  "gitState": {
    "commitHash": "abc123def",
    "branch": "main",
    "hasUncommittedChanges": false
  }
}
```

## 实现步骤

### 阶段一：基础框架（本次实现）

#### 1. 扩展数据结构
- 修改 `src/main/closed-sessions.ts` 中的 `ClosedSession` 接口
- 添加 `contextHistory` 和 `exportPath` 字段

#### 2. 对话内容捕获器
创建新文件 `src/main/context-capture.ts`：

```typescript
interface ContextCaptureResult {
  history: Array<{ role: 'user' | 'assistant'; content: string }>;
  hasContent: boolean;
}

/**
 * 从 PTY 输出流中提取对话内容
 * 支持不同 CLI 的格式差异
 */
export function extractContextFromOutput(
  output: string,
  cli: CliKind
): ContextCaptureResult;

/**
 * 合并多个输出块的内容
 */
export function mergeContextChunks(chunks: string[]): string;
```

#### 3. 集成到 PTY Manager
修改 `src/main/pty-manager.ts`：
- 在 PTY 数据处理器中添加 `contextCapture` 调用
- 收集所有输出块到内存缓冲区
- PTY 关闭时触发最终提取

#### 4. 导出功能
创建新文件 `src/main/context-export.ts`：

```typescript
/**
 * 将对话历史导出为 JSON 文件
 */
export function exportContextToFiles(session: ClosedSession, outputDir: string): string;

/**
 * 生成用于粘贴到其他 Agent 的提示模板
 */
export function generateImportPrompt(contextPath: string): string;
```

#### 5. UI 界面更新
- 在 `src/renderer/app.tsx` 中添加"导出上下文"按钮
- 提供两种选项：
  - 🔵 **恢复原会话** - 用同样的 CLI 继续
  - 🟢 **导出并转移** - 生成 JSON 供其他 Agent 使用

### 阶段二：辅助工具（可选）

#### 6. Import Helper（未来可能）
提供一键导入命令，例如：
```bash
cursor --import-context ./session-context.json
```

但这依赖于每个 Agent 是否支持这样的命令行参数。

## 对话内容提取策略

### 正则模式匹配

针对不同 CLI 的输出格式定义正则：

```typescript
const CONTEXT_PATTERNS: Record<CliKind, { user: RegExp; assistant: RegExp }> = {
  codex: {
    user: /\u276f\s+(.*)/g,          // ❯ 用户输入
    assistant: /^(?!\u276f).*(?:\n|$)/gm  // AI 回复
  },
  claude: {
    user: /^>\s+(.*)/gm,             // > 用户输入
    assistant: /^(?!>).*?(?:\n|$)/gm  // AI 回复
  },
  cursor: {
    user: /^\[user\]\s+(.*)/gm,      // [user] 用户输入
    assistant: /^\[assistant\]\s+(.*)/gm  // [assistant] AI 回复
  },
  // ... 其他 CLI
};
```

### 解析流程

1. **按行处理输出流**
2. **识别每行的角色**（user 或 assistant）
3. **配对连续的 user-assistant 对**
4. **清理 ANSI 转义序列**
5. **存入 `contextHistory` 数组**

## 文件存储位置

### 临时导出目录
```
~/Library/Application Support/DuoCLI/context-exports/
├── session-abc123-codex-to-cursor.json
└── session-def456-claude-to-gemini.json
```

文件名格式：`session-{id}-{from}-to-{to}.json`

### 自动清理
- 导出文件默认保留 7 天
- 用户确认转移成功后可选择删除
- 通过定期清理任务移除过期文件

## UI 交互设计

### 场景一：关闭会话时的选择

当用户按下 Ctrl+C 关闭一个活跃的会话时，显示：

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  会话已暂停

  • 当前工作目录：/path/to/project
  • 已完成对话：12 条
  
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  下一步操作？
  
  [🔄 恢复此会话]     (用同样的 AI 继续)
  
  [📤 导出上下文]     (转移到其他 AI)
    ├─ 导出到 Codex
    ├─ 导出到 Cursor
    ├─ 导出到 Claude
    └─ 导出到...更多
  
  [✕ 取消]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

### 场景二：已关闭会话列表

在已关闭会话卡片上增加操作按钮：

```
┌─────────────────────────────────────┐
│ 🤖 Codex                           │
│ 标题：Express.js Hello World       │
│ 时间：2 小时前                      │
│                                     │
│ [🔄 恢复]   [📤 导出]              │
└─────────────────────────────────────┘
```

### 场景三：导出成功提示

```
✅ 上下文已导出！

文件保存在：
  ~/DuoCLI-exports/session-abc123.json

如何在 Cursor 中使用？
1. 打开 Cursor
2. 拖拽此文件到对话框
3. 或运行：cursor --import-context xxx.json

[✓ 我知道了]  [删除此记录]
```

## 技术难点与解决方案

### 难点 1：不同 CLI 的输出格式差异

**解决方案**：
- 建立统一的输出归一化层
- 为每种 CLI 配置特定的正则模式
- 支持自适应检测（如果没有明确标记）

### 难点 2：对话角色识别不准

**解决方案**：
- 先尝试基于固定模式识别
- fallback 到基于位置的启发式规则
- 提供手动修正界面（用户标错时可以修正）

### 难点 3：长对话导致的数据丢失

**解决方案**：
- 在 PTY 运行时持续累积输出到内存
- 设置合理的内存上限（如 1MB）
- 超出限制时截断最早的对话，保留最近的

### 难点 4：某些 CLI 不输出完整的对话历史

**解决方案**：
- 如果无法提取完整历史，仍然保存现有信息
- 标记为 partial_capture: true
- 用户可以选择跳过导出或使用 resumeId 恢复

## 测试计划

### 单元测试
- `tests/context-capture.test.mjs` - 提取逻辑
- `tests/context-export.test.mjs` - 导出功能
- `tests/cli-patterns.test.mjs` - 各种 CLI 格式

### 集成测试
- 测试 Codex → Cursor 的完整转移流程
- 测试 Claude → Gemini 的转移
- 测试边界情况（空对话、超长对话等）

### E2E 测试
模拟真实用户使用场景进行端到端测试

## 兼容性说明

### 向前兼容
- `contextHistory` 是可选字段，旧版本的 DuoCLI 仍能正常读取
- 没有此字段的会话不会受影响

### 向后兼容
- 导出的 JSON 文件格式保持简单，无版本锁定
- 未来可以添加 `version` 字段进行格式升级

## 后续优化方向

1. **智能摘要** - 对超长对话自动生成摘要而非全量保存
2. **Git 状态快照** - 记录当前的 commit 和文件变更
3. **环境变量同步** - 保存 `.env` 文件内容
4. **依赖列表** - 记录已安装的 npm 包等依赖信息
5. **自动化导入** - 为支持的 Agent 提供专用导入命令
6. **多轮协商** - 允许多个 Agent 参与同一个任务的接力开发

---

*本文档作为功能设计和实现参考，具体细节可在实施过程中调整。*
