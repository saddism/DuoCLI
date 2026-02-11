# DuoCLI — 像用 Cursor 一样，用 Claude Code

> 多开 CLI 神器 — 一个为 AI 编程时代设计的多终端管理器

基于 Electron，专为同时运行多个 AI 编程助手（Claude Code、Codex CLI、Gemini CLI、Kimi 等）的工作流而打造。

Cursor 好用但又重又贵，Claude Code 厉害但终端体验太原始。DuoCLI 让你用终端跑 AI 编程助手时，也能拥有 Cursor 级别的体验——多开管理、可视化回滚、图片粘贴、会话历史，一个都不少。

## 为什么需要 DuoCLI

用终端跑 AI 编程助手时，总有几个痛点：

- **窗口混乱** — 同时开着 Claude、Codex、Gemini，一堆 "zsh" 标签根本分不清谁是谁
- **回滚困难** — AI 改了一堆代码，效果不对想回退，但已经搞不清改了哪些文件
- **终端臃肿** — 多个方向的任务全挤在一个终端里，新开终端又要重新配目录和命令
- **重复配置** — 每个 AI 工具都要单独配 API Key，明明机器上已经有了
- **对话丢失** — 终端关了就没了，之前 AI 说了什么、改了什么，全部消失

DuoCLI 的解决方案：

- **AI 自动命名** — 根据终端内容自动生成标题（如 "Claude:重构登录模块"），零配置复用本机已有的 AI 配置
- **Git 历史保护** — AI 修改代码前自动创建快照，支持逐文件 diff 查看、撤销变更和时间机器还原
- **多终端并行** — 一个窗口管理所有 AI 终端，支持置顶、归档和恢复
- **全自动模式** — 一键启动 Claude/Codex/Gemini/Kimi 的全自动模式，无需手动输入参数
- **文件路径可点击** — 终端输出中的文件路径自动识别为链接，点击直接用编辑器打开
- **会话历史记录** — 自动保存每次对话的完整内容，支持全文查看、复制和 AI 总结
- **6 套配色方案** — 不同任务用不同颜色，一眼区分

## 截图

![主界面](docs/images/main-ui.png)

![历史与 Diff](docs/images/snapshot.png)

![AI 配置](docs/images/ai-config.png)

## 安装

```bash
git clone https://github.com/saddism/DuoCLI.git
cd DuoCLI
npm install
npm run rebuild   # 编译原生模块（node-pty）
npm start         # 开发模式运行
```

构建安装包：

```bash
npm run build:mac   # macOS
npm run build:win   # Windows（需在 Windows 上执行）
```

### 系统要求

- macOS / Windows / Linux
- Node.js >= 18
- Git（历史功能需要）
- Windows 需安装 [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/)（编译 node-pty）

## 功能特性

### 多终端会话管理

- 创建多个独立终端，每个可指定预设命令（Claude、Codex、Gemini、Kimi 等）
- 支持普通模式和全自动模式（Claude `--dangerously-skip-permissions`、Codex `--full-auto`、Gemini/Kimi `--yolo`）
- 会话列表实时显示标题、最后活跃时间和工作目录
- **会话置顶** — 重要会话可以 Pin 到列表顶部，金色标记一眼可见
- 支持归档/恢复 — 暂时不用的终端可以归档隐藏，进程不会被杀掉
- 双击会话标题可手动重命名
- 非活跃会话有新输出时显示未读标记
- 顶部标题栏实时显示当前活跃会话名称
- 关闭应用时自动检测运行中的终端并弹出确认提示，防止误关

### AI 智能标题

- 自动调用 AI 分析终端输出，生成简短的中文标题
- 首次生成失败时自动重试（最多 10 次）
- 支持多种 AI 后端：Anthropic Claude、OpenAI、Google Gemini、DeepSeek、MiniMax、ZhipuAI、本地 Ollama
- 自动扫描本机已有的 AI 工具配置，零配置即用
- 可在 AI 配置面板中选择不同的模型

### Git 历史与回滚

- 检测到 AI 输入时自动创建 Git 快照（使用独立孤儿分支 `_duocli_snapshots`，不污染项目历史）
- 支持手动创建快照
- 展开查看每个快照的变更文件列表和 diff（带颜色高亮）
- **撤销本次变更** — 回滚这次快照记录的变更文件
- **还原到此时刻** — 把整个项目恢复到某个快照时的完整状态（时间机器），操作前自动创建备份
- 撤销/还原后的记录会显示删除线标记，视觉区分已回滚的历史
- AI 自动生成快照变更总结

### 文件路径链接

- 终端输出中的文件路径自动识别为可点击链接
- 支持绝对路径、相对路径、`@/` 别名路径、单文件名
- 点击直接用指定编辑器打开
- 右键点击文件链接可更换默认编辑器

### 文件监听

- 实时监听工作目录的文件变化，底部状态栏显示最近修改的文件
- 自动过滤编译产物（`dist/`、`node_modules` 等）
- 点击文件名用编辑器打开，右键状态栏可切换编辑器

### 会话历史记录

- 每个终端会话的完整输出自动保存为 TXT 文件
- 高性能缓冲写入，不影响终端响应速度
- 文件名格式：`会话标题_时间戳.txt`，会话重命名时文件自动同步
- 侧边栏「历史对话」区域可浏览所有历史记录
- 点击可查看全文，支持一键复制
- 内置 AI 总结功能，快速回顾对话要点
- 自动清理，保留最近 50 条记录

### 终端配色

内置 6 套配色方案：VS Code Dark、Monokai、Dracula、Solarized Dark、One Dark、Nord

## 使用方法

1. 启动后在顶部设置**工作目录**
2. 选择**预设命令**（Claude、Codex、Gemini 等，或留空打开普通终端；带"全自动"后缀的选项会自动附加对应参数）
3. 选择**配色方案**
4. 点击 **"+ 新建终端"**

### AI 配置

DuoCLI 不提供任何 AI 服务，也不需要额外配置 API Key — 只是读取你本机已有的 AI 工具配置。你原来能用什么，这里就能用什么。

切换到右侧 **"AI"** 标签页，点击 **"扫描并测试"**，自动检测并验证本机可用的 AI 服务，然后选择一个作为默认后端。

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

### 历史

切换到右侧 **"历史"** 标签页（需要工作目录是 Git 仓库）：

- 快照在 AI 输入时自动创建
- 点击快照条目展开查看变更文件
- 点击文件名查看 diff
- **"恢复"** 回滚单个文件
- **"撤销本次变更"** 回滚这次快照的所有变更文件
- **"还原到此时刻"** 把整个项目恢复到该快照时的完整状态

快照存储在 Git 孤儿分支 `_duocli_snapshots` 上，不影响项目分支和提交历史。

## 项目结构

```
src/
├── main/                    # Electron 主进程
│   ├── index.ts             # 入口，IPC 注册，窗口创建
│   ├── pty-manager.ts       # node-pty 终端管理
│   ├── snapshot-manager.ts  # Git 快照引擎（孤儿分支 + plumbing 命令）
│   ├── ai-config.ts         # AI 配置自动扫描与管理
│   └── ollama.ts            # AI 调用（标题生成 / diff 总结）
├── preload/
│   └── index.ts             # contextBridge 安全桥接
└── renderer/                # 渲染进程（UI）
    ├── app.ts               # 应用状态与交互逻辑
    ├── terminal-manager.ts  # xterm.js 终端管理 + 文件路径链接
    ├── index.html           # 页面结构
    └── styles.css           # 样式
```

## 技术栈

- **Electron** — 桌面应用框架
- **node-pty** — 原生伪终端
- **xterm.js** — 终端 UI 渲染
- **TypeScript** — 全项目类型安全
- **esbuild** — 渲染进程打包

## 许可证

MIT
