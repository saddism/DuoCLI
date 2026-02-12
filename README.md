# DuoCLI — 手机电脑实时同步的 AI 编程终端 | Use Claude Code on Your Phone, Sync with Desktop in Real-time

> 躺在床上写代码，蹲在马桶上 debug，洗着澡还能看 AI 跑任务  
> Code from your bed, debug from the bathroom, monitor AI tasks while showering

<p align="center">
  <img src="docs/images/main-ui.png" alt="DuoCLI Main Interface" width="800"/>
</p>

<p align="center">
  <a href="https://github.com/saddism/DuoCLI/releases"><img src="https://img.shields.io/github/v/release/saddism/DuoCLI?style=flat-square" alt="Release"></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/saddism/DuoCLI?style=flat-square" alt="License"></a>
  <a href="https://github.com/saddism/DuoCLI/stargazers"><img src="https://img.shields.io/github/stars/saddism/DuoCLI?style=flat-square" alt="Stars"></a>
</p>

---

**[中文](#中文介绍) | [English](#english-introduction)**

---

<a name="中文介绍"></a>
## 中文介绍

### 一句话描述

一个为 AI 编程时代设计的多终端管理器。基于 Electron，专为 Claude Code、Codex CLI、Gemini CLI、Kimi 等 AI 编程助手的多开工作流而打造。

### 核心卖点

**手机和电脑共享同一个终端。** 连上同一个 WiFi，手机上打的每一个字电脑上实时出现，电脑上 Claude Code 的每一行输出手机上同步滚动。不是远程桌面，不是屏幕投射——是真正的同一个终端会话，双向实时同步。

### 为什么需要 DuoCLI

**离开电脑 ≠ 停止编程**

AI 编程助手跑一个任务经常要好几分钟。以前你只能干坐在电脑前等，或者走开了就不知道进度。现在：

- 让 Claude Code 重构一个模块 → 去沙发上躺着，手机上看它实时输出
- AI 跑完了问你 "要不要继续？" → 手机上直接打 `y` 回车，不用跑回电脑前
- 半夜想到一个 bug → 床上掏出手机，直接在运行中的终端里操作
- 上厕所的时候 → 手机上继续盯着 AI 干活，顺便给它下一步指令

**不需要重开终端，不需要重启上下文。** 你的手机就是电脑终端的延伸，走到哪带到哪。

**同时，DuoCLI 也解决了终端跑 AI 的老痛点：**

- **窗口混乱** — 同时开着 Claude、Codex、Gemini，一堆 "zsh" 标签根本分不清谁是谁
- **回滚困难** — AI 改了一堆代码，效果不对想回退，但已经搞不清改了哪些文件
- **对话丢失** — 终端关了就没了，之前 AI 说了什么、改了什么，全部消失
- **重复配置** — 每个 AI 工具都要单独配 API Key，明明机器上已经有了

### 手机同步功能

#### 工作原理

```
┌──────────┐     WiFi / 局域网      ┌──────────┐
│  手机浏览器  │ ◄──── WebSocket ────► │  电脑桌面端  │
│  (PWA)    │     实时双向同步       │ (Electron) │
└──────────┘                       └──────────┘
                同一个终端会话
           手机输入 ⟷ 电脑输入 完全等价
```

- **零配置连接** — 电脑启动 DuoCLI 后自动开启局域网服务，手机浏览器输入地址即可连接
- **真正的双向同步** — 不是投屏，是共享同一个 PTY 进程。手机上按 `Ctrl+C`，电脑上的进程也会中断
- **断线自动重连** — WiFi 切换、手机锁屏后重新打开，2 秒内自动恢复连接，终端历史完整保留
- **手机端完整功能** — 创建/切换/删除会话、上传文件（最大 50MB）、快捷键栏（方向键、Tab、Ctrl+C 等）
- **Web Push 通知** — AI 任务完成时手机收到推送，不用一直盯着屏幕
- **iOS 深度适配** — 全屏模式、键盘自适应、触摸滚动，原生 App 般的体验
- **PWA 离线支持** — 添加到主屏幕后像原生 App 一样使用，静态资源自动缓存

#### 使用方式

1. 电脑启动 DuoCLI，底部状态栏会显示局域网地址（如 `http://192.168.1.100:9800`）
2. 手机浏览器打开该地址
3. 输入 Token 登录（Token 在电脑端首次启动时自动生成，存储在 `~/.duocli-mobile/config.json`）
4. 开始使用 — 手机上看到的就是电脑上的终端，打字、滚动、切换会话，一切实时同步

### 截图

<p align="center">
  <img src="docs/images/main-ui.png" alt="主界面" width="700"/>
</p>

<p align="center">
  <img src="docs/images/snapshot.png" alt="历史与 Diff" width="700"/>
</p>

<p align="center">
  <img src="docs/images/ai-config.png" alt="AI 配置" width="700"/>
</p>

### 安装

#### 源码构建

```bash
git clone https://github.com/saddism/DuoCLI.git
cd DuoCLI

# 安装依赖
npm install

# 编译原生模块（node-pty）
npm run rebuild

# 开发模式运行
npm start

# 构建安装包
npm run build:mac   # macOS
npm run build:win   # Windows（需在 Windows 上执行）
npm run build:linux # Linux
```

#### 系统要求

- macOS / Windows / Linux
- Node.js >= 18
- Git（历史功能需要）
- Windows 需安装 [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/)（编译 node-pty）

### 全部功能

#### 手机实时同步

- 局域网 WebSocket 双向同步，手机和电脑共享同一个终端进程
- 手机端支持创建/切换/删除会话、上传文件、快捷键操作
- Web Push 通知，AI 任务完成时手机推送提醒
- PWA 支持，添加到主屏幕后像原生 App 使用
- Token 认证，保障安全性
- 断线自动重连，历史缓冲区完整回放
- iOS 全屏适配、键盘自适应、触摸滚动

#### 多终端会话管理

- 创建多个独立终端，每个可指定预设命令（Claude、Codex、Gemini、Kimi 等）
- 支持普通模式和全自动模式（Claude `--dangerously-skip-permissions`、Codex `--full-auto`、Gemini/Kimi `--yolo`）
- 会话列表实时显示标题、最后活跃时间和工作目录
- 会话置顶、归档/恢复、手动重命名、未读标记
- 关闭应用时自动检测运行中的终端并弹出确认提示

#### AI 智能标题

- 自动调用 AI 分析终端输出，生成简短的中文标题
- 支持多种 AI 后端：Anthropic Claude、OpenAI、Google Gemini、DeepSeek、MiniMax、ZhipuAI、本地 Ollama
- 自动扫描本机已有的 AI 工具配置，零配置即用

#### Git 历史与回滚

- 检测到 AI 输入时自动创建 Git 快照（独立孤儿分支 `_duocli_snapshots`，不污染项目历史）
- 逐文件 diff 查看、撤销变更、时间机器还原
- AI 自动生成快照变更总结

#### 其他

- 终端输出中的文件路径自动识别为可点击链接，点击用编辑器打开
- 实时监听工作目录文件变化，底部状态栏显示最近修改
- 会话历史自动保存为 TXT，支持全文查看、复制和 AI 总结
- 内置 6 套配色方案：VS Code Dark、Monokai、Dracula、Solarized Dark、One Dark、Nord

### 使用方法

1. 启动后在顶部设置**工作目录**
2. 选择**预设命令**（Claude、Codex、Gemini 等，或留空打开普通终端）
3. 选择**配色方案**
4. 点击 **"+ 新建终端"**

#### AI 配置

DuoCLI 不提供任何 AI 服务，也不需要额外配置 API Key — 只是读取你本机已有的 AI 工具配置。你原来能用什么，这里就能用什么。

切换到右侧 **"AI"** 标签页，点击 **"扫描并测试"**，自动检测并验证本机可用的 AI 服务。

支持自动扫描的配置来源：

| AI 工具 | 配置文件路径 |
|---------|-------------|
| Claude Code | `~/.claude/settings.json` |
| Codex CLI | `~/.codex/config.json`、`~/.codex/config.toml` |
| Gemini CLI | `~/.gemini/.env` |
| OpenCode | `~/.config/opencode/opencode.json` |
| Aider | `~/.aider/env.sh` |
| DeepSeek | Shell 环境变量 `DEEPSEEK_API_KEY` |
| MiniMax | Shell 环境变量 `MINIMAX_API_KEY` |
| ZhipuAI | Shell 环境变量 `ZHIPUAI_API_KEY` |
| Ollama | 本地 `http://127.0.0.1:11434` |
| Shell 环境变量 | `~/.zshrc`、`~/.bashrc` 中的 `ANTHROPIC_API_KEY`、`OPENAI_API_KEY`、`GEMINI_API_KEY` 等 |

---

<a name="english-introduction"></a>
## English Introduction

### One-liner

A multi-terminal manager designed for the AI coding era. Built on Electron, crafted for multi-session workflows with Claude Code, Codex CLI, Gemini CLI, Kimi, and other AI coding assistants.

### Core Selling Point

**Your phone and computer share the same terminal.** Connect to the same WiFi, and every keystroke on your phone appears on your computer in real-time. Every line of output from Claude Code on your computer scrolls simultaneously on your phone. Not remote desktop, not screen mirroring — it's a true shared terminal session with bidirectional real-time sync.

### Why You Need DuoCLI

**Leaving your computer ≠ Stopping coding**

AI coding assistants often take several minutes to run a task. Previously, you'd either sit idly waiting or walk away and lose track of progress. Now:

- Let Claude Code refactor a module → Lie on the couch and watch it output in real-time on your phone
- AI finishes and asks "Continue?" → Type `y` and hit enter on your phone, no need to run back to your desk
- Think of a bug at midnight → Pull out your phone in bed and operate directly in the running terminal
- While in the bathroom → Keep monitoring AI's work on your phone and give it the next command

**No need to reopen terminals, no need to restart contexts.** Your phone is an extension of your computer terminal, take it wherever you go.

**Meanwhile, DuoCLI also solves the old pain points of running AI in terminals:**

- **Window chaos** — Running Claude, Codex, Gemini simultaneously, a bunch of "zsh" tabs that you can't tell apart
- **Rollback difficulty** — AI changed a bunch of code, effects aren't right and you want to revert, but can't figure out what files were changed
- **Conversation loss** — Terminal closes and it's gone. What the AI said and changed before, all disappears
- **Repeated configuration** — Every AI tool needs its own API Key configuration, even though your machine already has them

### Mobile Sync Features

#### How It Works

```
┌─────────────┐     WiFi / LAN       ┌─────────────┐
│ Mobile      │ ◄─── WebSocket ─────►│ Desktop     │
│ Browser     │    Real-time Sync    │ (Electron)  │
│ (PWA)       │                      │             │
└─────────────┘                      └─────────────┘
              Shared Terminal Session
       Mobile Input ⟷ Desktop Input Equally Valid
```

- **Zero-config connection** — DuoCLI automatically starts a LAN service when launched; just enter the address in your mobile browser
- **True bidirectional sync** — Not screen mirroring, but sharing the same PTY process. Press `Ctrl+C` on your phone, the process on your computer also interrupts
- **Auto-reconnect** — WiFi switching, phone screen lock, reopen within 2 seconds to automatically restore connection with complete terminal history
- **Full mobile functionality** — Create/switch/delete sessions, upload files (up to 50MB), shortcut bar (arrow keys, Tab, Ctrl+C, etc.)
- **Web Push notifications** — Phone receives push notifications when AI tasks complete, no need to keep staring at the screen
- **Deep iOS optimization** — Full-screen mode, keyboard adaptation, touch scrolling, native app-like experience
- **PWA offline support** — Add to home screen for native app-like usage, static resources automatically cached

#### Usage

1. Launch DuoCLI on your computer; the LAN address will be displayed in the status bar (e.g., `http://192.168.1.100:9800`)
2. Open the address in your mobile browser
3. Enter the Token to log in (Token is auto-generated on first desktop launch, stored in `~/.duocli-mobile/config.json`)
4. Start using — what you see on your phone is your computer's terminal; typing, scrolling, switching sessions, everything syncs in real-time

### Screenshots

<p align="center">
  <img src="docs/images/main-ui.png" alt="Main Interface" width="700"/>
</p>

<p align="center">
  <img src="docs/images/snapshot.png" alt="History and Diff" width="700"/>
</p>

<p align="center">
  <img src="docs/images/ai-config.png" alt="AI Configuration" width="700"/>
</p>

### Installation

#### Build from Source

```bash
git clone https://github.com/saddism/DuoCLI.git
cd DuoCLI

# Install dependencies
npm install

# Compile native modules (node-pty)
npm run rebuild

# Run in development mode
npm start

# Build installers
npm run build:mac   # macOS
npm run build:win   # Windows (run on Windows)
npm run build:linux # Linux
```

#### System Requirements

- macOS / Windows / Linux
- Node.js >= 18
- Git (required for history features)
- Windows requires [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) (for compiling node-pty)

### Full Features

#### Mobile Real-time Sync

- LAN WebSocket bidirectional sync — phone and computer share the same terminal process
- Mobile support for creating/switching/deleting sessions, uploading files, shortcut operations
- Web Push notifications — phone push alerts when AI tasks complete
- PWA support — add to home screen for native app-like usage
- Token authentication for security
- Auto-reconnect with complete history buffer replay
- iOS full-screen adaptation, keyboard adaptation, touch scrolling

#### Multi-Terminal Session Management

- Create multiple independent terminals, each with customizable preset commands (Claude, Codex, Gemini, Kimi, etc.)
- Support for normal and fully automatic modes (Claude `--dangerously-skip-permissions`, Codex `--full-auto`, Gemini/Kimi `--yolo`)
- Session list displays title, last active time, and working directory in real-time
- Pin sessions, archive/restore, manual rename, unread indicators
- Auto-detect running terminals and prompt for confirmation when closing the app

#### AI Smart Titles

- Automatically call AI to analyze terminal output and generate short titles
- Support for multiple AI backends: Anthropic Claude, OpenAI, Google Gemini, DeepSeek, MiniMax, ZhipuAI, local Ollama
- Auto-scan existing AI tool configurations on your machine, zero-config ready to use

#### Git History & Rollback

- Auto-create Git snapshots when AI input detected (isolated orphan branch `_duocli_snapshots`, doesn't pollute project history)
- Per-file diff viewing, undo changes, time machine restore
- AI auto-generates snapshot change summaries

#### Others

- File paths in terminal output automatically recognized as clickable links, open in editor on click
- Real-time monitoring of working directory file changes, status bar shows recent modifications
- Session history auto-saved as TXT, supports full-text viewing, copying, and AI summarization
- 6 built-in color schemes: VS Code Dark, Monokai, Dracula, Solarized Dark, One Dark, Nord

### How to Use

1. Set the **working directory** at the top after launching
2. Select a **preset command** (Claude, Codex, Gemini, etc., or leave blank for normal terminal)
3. Select a **color scheme**
4. Click **"+ New Terminal"**

#### AI Configuration

DuoCLI doesn't provide any AI services and doesn't require additional API Key configuration — it simply reads your existing AI tool configurations. If it worked before, it works here.

Switch to the **"AI"** tab on the right, click **"Scan & Test"**, and it will automatically detect and verify available AI services on your machine.

Supported auto-scan configuration sources:

| AI Tool | Configuration File Path |
|---------|------------------------|
| Claude Code | `~/.claude/settings.json` |
| Codex CLI | `~/.codex/config.json`, `~/.codex/config.toml` |
| Gemini CLI | `~/.gemini/.env` |
| OpenCode | `~/.config/opencode/opencode.json` |
| Aider | `~/.aider/env.sh` |
| DeepSeek | Shell environment variable `DEEPSEEK_API_KEY` |
| MiniMax | Shell environment variable `MINIMAX_API_KEY` |
| ZhipuAI | Shell environment variable `ZHIPUAI_API_KEY` |
| Ollama | Local `http://127.0.0.1:11434` |
| Shell Environment | `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, etc. in `~/.zshrc`, `~/.bashrc` |

---

## Project Structure | 项目结构

```
src/
├── main/                    # Electron main process | 主进程
│   ├── index.ts             # Entry, IPC registration, window creation | 入口，IPC 注册，窗口创建
│   ├── pty-manager.ts       # node-pty terminal management | 终端管理
│   ├── remote-server.ts     # Mobile sync service (Express + WebSocket) | 手机同步服务
│   ├── snapshot-manager.ts  # Git snapshot engine | Git 快照引擎
│   ├── ai-config.ts         # AI config auto-scan & management | AI 配置自动扫描
│   └── ollama.ts            # AI calls (title generation / diff summary) | AI 调用
├── preload/
│   └── index.ts             # contextBridge security bridge | 安全桥接
├── renderer/                # Renderer process (UI) | 渲染进程
│   ├── app.ts               # App state & interaction logic | 应用状态与交互
│   ├── terminal-manager.ts  # xterm.js terminal management | 终端管理
│   ├── index.html           # Page structure | 页面结构
│   └── styles.css           # Styles | 样式
└── mobile/client/           # Mobile PWA | 手机端 PWA
    ├── index.html           # Mobile page | 移动端页面
    ├── app.js               # Mobile logic (WebSocket, terminal, session) | 移动端逻辑
    ├── style.css            # Mobile styles (iOS adaptation) | 移动端样式
    └── sw.js                # Service Worker (offline cache + Push) | 离线缓存
```

## Tech Stack | 技术栈

- **Electron** — Desktop app framework | 桌面应用框架
- **node-pty** — Native pseudo-terminal | 原生伪终端
- **xterm.js** — Terminal UI rendering (desktop + mobile shared) | 终端 UI 渲染
- **Express + WebSocket** — Mobile sync service | 手机同步服务
- **Web Push** — Mobile push notifications | 手机推送通知
- **Service Worker** — PWA offline support | PWA 离线支持
- **TypeScript** — Full project type safety | 全项目类型安全
- **esbuild** — Renderer process bundling | 渲染进程打包

## Known Issues | 已知问题

- 左侧终端有时鼠标滚动无法到达最底部，需要按一下方向键 `↓` 回到最新输出  
  The left terminal sometimes can't scroll to the bottom with mouse; press the `↓` arrow key to return to the latest output

- 右侧会话列表的状态指示灯有时显示不准确  
  The status indicator in the right session list sometimes displays inaccurately

## License | 许可证

[MIT](LICENSE)

---

<p align="center">
  Made with ❤️ by <a href="https://github.com/saddism">大壮好大 (saddism)</a>
</p>
