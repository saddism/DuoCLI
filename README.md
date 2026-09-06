# DuoCLI

> **一个窗口，随手管理你常用的 AI CLI。**

DuoCLI 是一个轻量级 AI CLI 多终端管理器。它把 Claude Code、Codex、Gemini、Kimi、Cursor、Kiro、QoderCN、OpenCode、Antigravity 等工具放进同一个清爽的桌面工作区。

你不用再在一排相似的终端窗口里寻找“刚才跑部署的是哪一个”，也不用为了换一个 CLI 重复切换目录、输入长命令。选好工作目录和预设，点一下就能开始。

## 它解决的事情很简单

多个 AI 编程工具都很好用，但一起使用时很容易变成窗口地狱：窗口越开越多，标题分不清，工作目录要重复切，重要会话也容易被找丢。

DuoCLI 把这些琐事收进一个侧边栏：

- 普通会话可以继续创建，不受可见分屏数量限制
- 侧边栏切换会话像切换标签一样简单
- 需要同时对照时，再把会话放进最多 4 个清晰分屏
- 每个会话保留工作目录、标题、颜色和运行状态
- 关闭的 CLI 会话可以从列表中恢复
- 手机可远程查看和操控桌面端终端，支持局域网或互联网连接

核心原则只有一句话：**不强迫你学习新的终端工作流，只让原本麻烦的操作少一点。**

## 核心体验

### 一键多开，不再找窗口

选择 Claude、Codex、Gemini、Kimi 等预设，DuoCLI 自动准备对应命令和参数。普通会话想开几个开几个；需要并行查看时，用 Pane 拆分按钮把重要会话排在一起。

### 多 CLI，一个工作区

不同工具、不同任务、不同颜色，一眼就能区分。会话标题还可以根据你发送给终端的内容自动生成，侧边栏不再是一串看不懂的“zsh”。

### AI 配置，用途说得清楚

AI 配置主要用于整理会话历史和自动生成对话标题，不参与终端命令执行。你可以按需配置 Anthropic、OpenAI 兼容接口、Gemini 或 Ollama。

### 手机远程开发

在电脑前启动 DuoCLI，离开工位后仍可通过手机查看终端、发送输入、切换会话。局域网和互联网连接状态会在桌面端明确显示，异常时支持自动恢复和手动重试。

## 下载

前往 [GitHub Releases](https://github.com/saddism/DuoCLI/releases) 下载最新安装包：

- **macOS**：下载 `.dmg`，拖入 Applications
- **Windows**：下载 `.exe`，按安装向导操作

## 从源码运行

```bash
git clone https://github.com/saddism/DuoCLI.git
cd DuoCLI
npm install
npm run rebuild
npm start
```

启动后只需要：

1. 选择工作目录
2. 选择 CLI 预设和配色
3. 点击「新建终端」

就这么简单。

## 开发与测试

```bash
npm run build:ts
npm run test:unit
```

项目使用 Electron、node-pty、xterm.js、TypeScript 和 esbuild 构建。欢迎提交 Issue 或 PR。

## English

DuoCLI is a lightweight desktop workspace for the AI CLI tools you already use. Keep Claude Code, Codex, Gemini, Kimi, Cursor, and more in one place, switch sessions from a clear sidebar, and split only when side-by-side visibility is useful.

Ordinary sessions are not blocked by the four-pane readability limit. Fewer terminal windows to search through, fewer commands to repeat, and a simpler way to keep your AI coding work moving.
