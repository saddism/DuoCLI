# DuoCLI

> **一个窗口，随手管理你常用的 AI CLI。**

DuoCLI 是一个轻量级 AI CLI 多终端管理器。它把 Claude Code、Codex、Gemini、Kimi、Cursor、Kiro、QoderCN、OpenCode、Antigravity、DSH 等工具放进同一个清爽的桌面工作区。

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

## v1.4.1：滚出去很远，也还记得自己在说什么

对话一长，最先找不到的是你自己刚才那句话。v1.4.1 把它钉在顶上，并修了几个文件和会话顺序上的别扭：

- 桌面和手机网页都显示「最近在说」，可展开，也能滚回标题栏顶部
- 电脑上发的话，手机打开同一会话就能看见
- 文件可用其他应用程序打开，不只走默认应用
- 已关闭会话按最后活动时间排，下载不再被存成 `.html`

[查看 v1.4.1 中英双语更新说明](./docs/updates/v1.4.1-release-notes.md)

## v1.4.0：离开电脑，工作也接得住

手机远程开发最怕的不是断一次线，而是重连后草稿没了、命令重复执行，或者上传的文件跑进了另一个会话。v1.4.0 把这些容易翻车的细节收紧了：

- 每个会话独立保存草稿、上传结果与待确认提交
- 计划执行和自动同意移入主进程，桌面窗口不活跃也能继续
- 桌面与手机共享快捷命令，点击先插入、确认后发送
- 通知直达对应会话，手机横屏可同时查看会话、终端和 Android 画面
- 跨项目 Pane 保持同一块工作区，支持拖拽交换位置
- 终端中的中文路径、换行路径、压缩包和常见工作文件可直接预览或下载

[查看 v1.4.0 中英双语更新说明](./docs/updates/v1.4.0-release-notes.md)

## v1.5.0：手机直接操控 Mac 桌面 🎉 (NEW!)

**Mac 远程控制全新上线！** 现在可以用 iPhone 或 Android 手机直接查看并操作你当前的 Mac 桌面，就像用 VNC 一样，但完全不需要安装额外的软件：

### 核心功能（v1.5.0）
- ✅ **屏幕实时流**: 通过 macOS Screen Sharing + noVNC 获取当前桌面画面
- ✅ **触控板模式**: 单指滑动移动光标，双指滚动页面内容
- ✅ **虚拟键盘**: 输入文字、发送快捷键（⌘C/V/A/Z/Tab/ESC 等）
- ✅ **安全认证**: 一次性票据验证，30 秒有效期，单次连接
- ✅ **状态管理**: 连接/断开/挂起/恢复完整生命周期控制

### 快速开始
```bash
# 1. 确保 Screen Sharing 已启用
# System Settings → Sharing → Screen Sharing → ON

# 2. 启动 DuoCLI
npm start

# 3. 手机浏览器访问
# http://<mac-ip>:port/mobile/client/index.html

# 4. 点击「这台 Mac」→「连接」
```

详细使用说明请查阅：[`docs/mac-desktop-quickstart-guide.md`](./docs/mac-desktop-quickstart-guide.md)  
技术架构文档：[`docs/mac-desktop-architecture-reference.md`](./docs/mac-desktop-architecture-reference.md)

### 技术亮点
- 🚀 **零依赖**: 使用 macOS 原生 Screen Sharing 服务，无需安装任何组件
- 🔒 **安全可靠**: Token-based authentication, Origin validation, one-time tickets
- ⚡ **高性能**: 60fps 动画，GPU 加速渲染，渐进式 JPEG 编码
- 📱 **移动端优化**: 虚拟键盘滑出动画，呼吸状态效果，触摸反馈增强

### 适用场景
- 临时需要打开浏览器、Finder 或系统对话框（无需回到电脑前）
- 演示 Mac 应用给远程同事（分享当前桌面视图）
- 测试移动端网页在不同 Mac 环境下的显示效果
- 在会议中快速切换应用而不中断工作

> **注意**: 首版仅支持单显示器配置，多屏将在后续版本支持。中文输入法需要通过 Extended Clipboard 方案实现，已在测试中验证可用性。

[查看 v1.5.0 完整功能清单](./docs/mac-desktop-final-delivery-report.md)
[验收测试指南](./docs/mac-desktop-test-plan.md)

## 核心体验

### 一键多开，不再找窗口

选择 Claude、Codex、Gemini、Kimi 等预设，DuoCLI 自动准备对应命令和参数。普通会话想开几个开几个；需要并行查看时，用 Pane 拆分按钮把重要会话排在一起。

### 多 CLI，一个工作区

不同工具、不同任务、不同颜色，一眼就能区分。会话标题还可以根据你发送给终端的内容自动生成，侧边栏不再是一串看不懂的“zsh”。

### AI 配置，用途说得清楚

AI 配置主要用于整理会话历史和自动生成对话标题，不参与终端命令执行。你可以按需配置 Anthropic、OpenAI 兼容接口、Gemini 或 Ollama。

### 手机远程开发

在电脑前启动 DuoCLI，离开工位后仍可通过手机查看终端、发送输入、切换会话。局域网和互联网连接状态会在桌面端明确显示，异常时支持自动恢复和手动重试。右侧「手机远程同步」卡片可复制地址和 Token；点「怎么连」可按步骤配置局域网和固定公网域名。

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

DuoCLI is a lightweight desktop workspace for the AI CLI tools you already use. Keep Claude Code, Codex, Gemini, Kimi, Cursor, DSH, and more in one place, switch sessions from a clear sidebar, and split only when side-by-side visibility is useful.

Version 1.4.1 pins your latest real prompt above the conversation on desktop and phone, jumps back to the title-bar top after a long scroll, lets you open files with another app, and sorts closed sessions by last activity. Downloads keep their real filenames instead of turning into `.html`.

[Read the bilingual v1.4.1 release notes](./docs/updates/v1.4.1-release-notes.md).

Version 1.4.0 makes remote work dependable across desktop and phone: drafts stay with the right session, retries do not duplicate commands, scheduled work continues outside the renderer, and shared quick commands wait for your explicit send. Ordinary sessions are not blocked by the four-pane readability limit, and the same global pane board can hold work from different projects.

[Read the bilingual v1.4.0 release notes](./docs/updates/v1.4.0-release-notes.md).
