# 手机 CLI 对话与命令交互修复

日期：2026-09-28。范围：手机 PWA 的发送、命令切换、对话记录对账。保留工作区原有改动。

## 参考

检查本机 `/Applications/Orca.app`，并读取 Orca 公开源码：

- [命令分类](https://github.com/stablyai/orca/blob/main/src/shared/native-chat-slash-commands.ts)：命令操作与普通消息分别处理。
- [消息合并](https://github.com/stablyai/orca/blob/main/src/shared/native-chat-merge.ts)：按消息编号合并，保留真正重复提交的消息。

本次沿用 DuoCLI 的 PTY 和 HTTP/WebSocket 架构；模型列表仍由实际运行的 CLI 提供。

## 修复

| 问题 | 当前行为 |
| --- | --- |
| 连续两次未确认后生成新提交编号，可能重复执行 | 原文未变时，重试始终使用原编号；已确认后主动再发同文仍是新消息 |
| 触摸发送失败恢复草稿后，兼容 click 再次发送 | 屏蔽紧随触摸的鼠标 click，保留键盘激活 |
| HTTP 回退依赖当前显示会话的终端就绪状态 | 按最初发送目标回退，服务端继续使用原编号去重 |
| 后发的同文消息认领先前对话记录 | 按提交顺序和记录时间匹配，历史记录不能确认未来提交 |
| transcript 先落盘、提交后确认，轮询仍返回 unchanged | revision 同时包含消息与提交编号的关联，关联变化会下发新快照 |
| 只有 `/model` 能打开菜单，命令气泡长时间等待 | 常见控制命令统一打开同会话终端，不新增乐观聊天气泡；文件路径、多行文字与未知技能保持原行为 |
| 菜单操作完成后返回对话入口藏在更多菜单 | 顶部提供“返回对话”，并提示方向键、确认与取消操作 |
| 发送时切换视图后发送按钮可能持续禁用 | 提交结束时同步当前会话按钮；焦点仍受视图代次保护 |
| 迟到发送/停止回调更新其他会话，恢复 pending 覆盖已有气泡 | 限定回调所属会话；恢复记录追加到已有本地消息 |

## 验证

- Node 20.19.6；`npm run build:ts` 通过。
- `npm run test:unit`：347/347，包括新增的对账和真实 HTTP revision 回归。
- `DUOCLI_INPUT_AUDIT=1 node tests/e2e/mobile.e2e.mjs`：131/131。
- `node tests/e2e/mobile-remote.e2e.mjs`：28/28，日志 `/tmp/duocli-chat-remote-final-20260928.log`。
- 手机页面截图：`/tmp/duocli-chat-command-terminal-20260928.png`，已目视检查；返回按钮从横向快捷栏移至顶部，避免滚动后不可见。
- JS 语法检查与 `git diff --check` 通过。

浏览器测试使用真实页面；remote 套件使用真实 HTTP/WebSocket 和提交去重服务，PTY 为隔离测试替身。丢失确认回归验证了三次失败加一次重试只产生一次正文与 Enter，且恢复本地待确认记录后仍使用同一编号。

## 状态与边界

Service Worker 缓存更新为 v96。未提交、推送、打包或重启用户正在使用的 DuoCLI，现有运行实例尚未确认加载新代码。真实手机输入法、实际 Codex/Claude 模型菜单和安装包仍需现场验收。

对账需要 transcript 的时间字段；缺少时间时保留未确认状态，避免用旧同文消息误判送达。重复显示与重复执行分别验证，本次不宣称所有 CLI 日志格式下的重复记录都已消除。
