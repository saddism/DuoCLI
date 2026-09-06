# Changelog

## v1.2.0 — 远程同步自愈 & 多 Pane 工作区 (2026-09-07)

> 完整宣传版更新说明（中英双语）：[docs/updates/v1.2.0-release-notes.md](./docs/updates/v1.2.0-release-notes.md)

### 新增功能

#### 远程同步健康监控与自动恢复
- **三层探测**：本地 9800、cloudflared 进程、公网 URL（`/ping.png`，502 视为失败）
- **自动恢复**：本地服务重启 + 清理僵尸隧道 + 强制重启 cloudflared（60 秒冷却）
- **状态面板**：右上角绿/黄/红状态、文案说明、手动「重试」
- **Token 隐私**：默认打星，眼睛图标临时显示/隐藏，可复制

#### 多 Pane 工作区
- 分屏、平铺布局，布局持久化
- 多终端并行管理（Claude / Codex / Kimi 等）

#### 会话恢复
- 关闭终端时捕获 resume 元数据
- 侧边栏已关闭会话一键恢复，支持多家 CLI

#### Android 镜像（预览）
- 桌面端 adb 镜像、截图、触控与文字输入
- H264 / JPEG 双通道

#### 手机端
- 终端滚动与弱网重连优化
- 媒体文件预览增强
- Spinner 拦截

### 改进

- cloudflared 脚本兼容 `~/.config/duocli-tunnel/config.yml`
- macOS 一键启动脚本
- 终端自动应答配置
- 移除内置 Chat 视图与 Windsurf 代理，聚焦终端核心体验
- 72+ 单元测试

---

## v1.1.0 — Devin 多账号管理 & 智能切号 (2026-06-05)

### 新增功能

#### Devin 账号管理器（侧边栏 "👤 Devin" 标签页）
- **多账号管理**：添加/删除 Devin 账号，支持同时管理多个账号
- **一键切换**：点击任一账号旁的"切换"按钮，自动登录并写入凭证
- **配额查询**：显示每个账号的日/周配额余额（D/W 百分比）
- **方案识别**：自动识别 Pro Trial / Pro / Free / Teams / Enterprise 方案
- **状态监控**：绿/红/灰圆点标识账号状态（正常/异常/未登录）
- 数据存储复用 `~/.session-sync-manager/accounts.json`，与 session-sync 工具互通

#### 智能错误检测 & 自动恢复（Devin 终端专属）
- **硬限流自动切号**：检测到以下错误时，后台自动切号 + 发送"继续"恢复会话：
  - `quota exhausted` / `usage is exhausted`（日/周额度用完）
  - `overall message rate limit`（账号级硬限制）
  - `Permission denied ... rate limit`（权限级限流）
- **软限流自动等待**：检测到临时 `rate limit` 时，等待 8 秒后自动发送"继续"
- **设备指纹旋转**：每次切号时自动轮换 `installation_id`，防止跨账号限流关联
  - 轮换路径：`~/.local/share/devin/cli/installation_id` 和 `cli-next/installation_id`
- **三重兜底保障**：`auth-cli.mjs` 内部旋转 → DuoCLI IPC 兜底旋转 → PTY 自动切号直接旋转
- **智能冷却**：切换成功/失败均有冷却期，防止快速重试导致的资源浪费

#### 会话恢复增强
- 终端退出时自动捕获 `--resume` 参数，保存到已关闭会话列表
- 侧边栏可查看已关闭会话，支持一键恢复上次会话

### 改进

- macOS Dock 启动时 PATH 不包含 `~/.local/bin` 的问题已修复，使用绝对路径调用 `session-sync`
- 子进程管理优化：`stdio: 'ignore'` + `unref()` 防止 pipe 阻塞和资源泄漏
- 切号失败时终端内有可见提示（`⚠️ [DuoCLI] 自动切号失败`），而非静默失败
- 自动重试定时器纳入会话生命周期管理，销毁时自动清理
- 代码去重：`rotateDevinInstallationId` 收敛到 pty-manager.ts 统一导出

### 技术细节

- 认证操作通过 `auth-cli.mjs` 子进程完成，复用 Windsurf/Codeium 的登录协议
- 不存储明文密码在 DuoCLI 本地；密码仅通过 IPC 传递给子进程做一次性登录
- 账号列表、配额信息通过直接读 `accounts.json` 快速获取，无需每次调子进程

### 已知局限

- Devin 的 `sessions.db`（172MB）尚未在切号时清理，未来可考虑轮换
- 仅支持 Devin CLI 账号，暂不支持 Windsurf/Cascade 账号的直接管理
