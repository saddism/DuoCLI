# 终端滚动、选择、加载与侧栏名称优化

日期：2026-09-27。范围：DuoCLI 桌面 renderer 与手机网页；保留工作区原有未提交改动，未提交、推送或重启运行中的应用。

## 实现结果

- 两端全屏终端移除右下角“上翻／下翻”，保留复制当前屏幕。
- 两端全屏滚轮在短手势结束 90ms 后处理剩余位移；反向滚动立即丢弃旧方向余量。退出全屏、销毁终端、切换离开桌面终端后不会补发旧翻页输入。
- 手机快速滑动保留第一段位移；此前仅有一次 touchmove 的手势会完全丢失。
- 两端选中文字时保护当前阅读位置，新输出不会强制拉到底部；显式切换会话／恢复跟随仍然生效。
- 手机连续输出按相邻批次解析，保留字节顺序、分包 ANSI、快照前后边界和旧终端隔离。浏览器测试中 200 段连续输出合为一次解析，头尾内容完整。
- 折叠视图在原样终端模式下停止扫描历史，选中文本时暂停无效重建；读取历史复用字符对象并只在样式变化时生成样式记录。
- 桌面会话标题取消两行截断；CLI 名称取消 42% 宽度限制并允许换行；操作按钮另占一行，避免挤压名称。验证 180px 与 275px 侧栏宽度。
- 手机 Service Worker 缓存版本更新为 v95。

## 验证

环境：Node 20.19.6，已安装 Chrome 的无头浏览器。使用实际前端代码及测试 HTTP/WebSocket 后端；未连接真实 Codex 会话进行翻页验收。

| 检查 | 结果 |
| --- | --- |
| `npm run build:ts` 与 `npm run copy:html` | 通过 |
| 滚动辅助、折叠、加载状态、输出批次单元测试 | 31/31 |
| `tests/e2e/mobile.e2e.mjs` | 121/121 |
| `tests/e2e/desktop-scroll.e2e.mjs` | 27/27 |
| `tests/e2e/desktop-copy.e2e.mjs` | 10/10 |
| `tests/e2e/terminal-history-recovery.e2e.mjs` | 15/15 |
| `tests/e2e/terminal-history-regression.e2e.mjs` | 13/13 |
| 折叠视图与侧栏布局浏览器检查 | 通过 |
| `git diff --check`、手机 JS 语法检查 | 通过 |

额外运行的全仓 `tsc --noEmit -p tsconfig.json` 未通过：已有 Android、通知、会话恢复、pane-workspace、quick-command-composer 等类型错误，以及原有文件链接 `activate()` 缺参。未扩大本次范围修改这些代码；仓库规定的构建命令通过，不能据此声称全仓类型检查通过。

修正了一处加载测试桩遗漏：为现有 `fitTerminalToVisibleBox` 调用补齐测试桩，恢复两项加载状态测试。

## 局部性能对照

本机 Node/headless xterm 上构造 5001 行、80 列带颜色历史，分别运行优化前后的字符与样式读取逻辑，各采样 9 次取中位数，并比较完整文本与样式序列：

- 优化前：446.21ms。
- 优化后：71.28ms，约减少 84%。
- 文本与样式序列一致。

这是历史扫描环节的本地对照，不是整套应用启动、真实手机或网络延迟的提升比例。

## 图像与日志

- 常规侧栏：`/tmp/duocli-sidebar-improved-list.png`
- 窄侧栏完整名称：`/tmp/duocli-sidebar-improved-narrow.png`
- 手机终端滚动：`/tmp/duocli-mobile-scroll-fixed.png`
- 折叠视图：`/tmp/duocli-fold-improved.png`
- 性能数据：`/tmp/duocli-fold-performance.json`
- 构建：`/tmp/duocli-interaction-build.log`
- 手机回归：`/tmp/duocli-mobile-improved.log`
- 桌面滚动：`/tmp/duocli-desktop-improved-final.log`
- 全仓类型检查限制：`/tmp/duocli-interaction-typecheck.log`

尚未验证：用户实际手机浏览器／PWA、正在运行的 Electron 实例、新安装包和真实 Codex 终端。没有关闭用户会话或重启应用。
