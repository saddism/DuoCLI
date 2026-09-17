# DuoCLI 终端滚动、历史与会话切换诊断

> **收尾以 [`terminal-diagnostics-followup-20260918.md`](./terminal-diagnostics-followup-20260918.md) 为准。**  
> 本文记录前序：增量归档、虚拟列表、桌面输出补写与焦点切换。其中「尚未消除」若干项已在收尾文档关闭（选区手柄、noVNC 误初始化、`duocli-v72`、尺寸发送饥饿等）。

## 范围与交付状态

项目：`/Users/kaifengwang/Documents/myDev/DuoCLI`。
本轮修改源代码并完成 `build:ts` 和 `copy:html`，未 commit、push、发布、重启 DuoCLI 或终止用户 Agent/PTY 会话。工作区存在大量先前修改，且诊断期间发生并行写入；采用唯一文本替换及连接器备份，没有用整文件回退覆盖其它工作。

这不是全项目发布验收报告。下面把已验证的终端修复与仍存在的问题分开记录。

## 确认的问题与修复

### 1. 屏幕很短，后台却仍逐块扫描全部历史

`src/main/terminal-state.ts` 原先在每个 headless xterm write 回调中调用 `history.syncFromBuffer`。该路径会重新提取所有滚动历史行的文字和逐单元格样式，再做内容比较。压缩前端显示范围并没有移除这项后台工作。

现在用公开的位置标记定位新增历史部分，调用 `syncTailFromBuffer` 增量更新。尺寸变化、位置标记失效等情况仍进行完整对齐。顺便修复环形缓存满后连续相同输出行被文本去重误吞的问题，以及软换行逻辑行延长时的重复归档问题。

实际同机测试：预置 4,800 行，然后逐次处理 60 个小输出块。

| 项目 | 改前 | 改后 |
| --- | ---: | ---: |
| 60 次写入处理耗时 | 1,402 ms | 81 ms |
| 历史归档行数 | 4,837 | 4,837 |

这是一次受控后端微基准，约 17.3 倍吞吐改善、耗时降低约 94.2%。它不是整个界面的帧率测试，不能据此声称所有手机或交互快了 17 倍。`scripts/benchmark-terminal-history.mjs` 可在当前构建上对比旧扫描策略与增量策略。

最终又实际运行了该脚本：旧扫描策略 1,073 ms，增量策略 77 ms，约 13.94 倍。两者都保留 4,837 行，而且完整历史内容的 SHA-256 一致（`d8a6ffef30eaf10d69bb718a3787f5c6f020e1d141e8fd7ed89d78aff72d85ff`）。不同轮次的时间会随系统负载变化；这次复测同时验证了内容一致性。

### 2. 历史分页与实时边界混用

涉及 `mobile/client/terminal-history-layer.js`、`mobile/client/app.js`、`src/renderer/terminal-manager.ts`。

- 把历史层的向前分页游标与实时会话历史边界分开。翻到最老页，不再把实时会话的“还有历史”状态永久覆盖。
- 重复进入/滚轮事件不重置正在浏览的分页游标；过期请求不能污染重置后的历史层。
- 手机重新进入历史时，从服务端当前边界取最近一页，避免一直沿用最初一屏快照的旧边界。
- 手机请求增加 10 秒超时释放、会话/请求匹配与断线清理；超时之后可以继续手势重试。
- 程序恢复阅读位置不作为自动取下一页的意图；显式向上滚轮、触摸和键盘行为可以在短页边界继续取历史。

### 3. 虚拟历史窗口的换行、重建与锚点问题

- 滚动时使用二分查找定位可见范围，并复用可见行节点，不再每次替换全部窗口 HTML。
- 保持已选择文本对应的节点，避免小幅滚动立即清掉选择。
- 实测已挂载行的高度，处理手机窄屏、中文和长行；仅用服务端终端列数估算 CSS 高度并不可靠。
- 前插一页时先更新滚动范围、恢复阅读锚点，再绘制窗口，减少空白和跳动。
- 相同列数/宽度的 setCols 不再反复重建历史布局。
- 两端历史滚动容器增加 `min-height: 0` 和 `overflow-anchor: none`，避免 flex 尺寸和浏览器锚点与程序恢复相互干扰。

### 4. 快照恢复期间新输出可能漏接

`src/renderer/app.ts` 的终端绘制统一采用带序号的 parsed 输出流，原始数据事件仍用于活动状态，不再重复绘制同一份内容。

`src/renderer/terminal-manager.ts` 恢复快照后持续批量排空尾部，而不是只截取一次尾部然后等待各条写入。重复序号被忽略；有限尾部缓存被淘汰而出现缺口时重新取近期快照，不把缺失数据默认为已渲染。快照超时/恢复失败保留需要重新同步的状态，并给出重选重试提示。

### 5. 单视图切换与焦点

独立单视图模式以前可能把多个 active 终端留在同一可见容器。现在仅挂载当前终端，其他视图退回 detached host；PaneWorkspace 分屏模式保留原来的多视图行为。焦点在下一可见帧交付，并检查当前会话、世代和 detached 状态，替代固定 50 ms 延迟。

最初桌面滚动套件 14/15 通过，快速切换焦点失败。修改并复测后 15/15 全部通过，未放宽原有断言；仅补充失败诊断信息。

## 验证结果

| 验证 | 实际结果 |
| --- | --- |
| 主进程、preload、renderer 构建和静态资源复制 | 通过 |
| 终端、历史、滚动、复制与提示条相关单元测试 | 66 通过，0 失败 |
| 原桌面滚动 E2E | 最后一次完整运行 15 通过，0 失败 |
| 新增历史/序号/切换浏览器回归 | 最后一次运行 10 通过，0 失败 |
| 手机连续创建、关闭、再创建专项 | 终端生命周期断言通过；独立 noVNC 异常另行输出，不算作终端通过证明 |

新增回归文件：

- `tests/terminal-incremental-history.test.mjs`
- `tests/e2e/terminal-history-regression.e2e.mjs`
- `tests/e2e/mobile-terminal-lifecycle.e2e.mjs`

历史浏览器测试已加入 `npm run test:e2e`，并保留期间并行加入的 `terminal-history-recovery.e2e.mjs` 测试入口。

浏览器回归使用本地 mock 后端和真实 headless Chrome，包含 CDP touch 事件，不是实体 iPhone/Safari 或打包 Electron 应用的人工验收。手机滚动截图由测试生成在 `tests/.artifacts/terminal-audit/mobile-history.png`。

最终复核命令：

```sh
npm run build:ts && npm run copy:html
node --test tests/terminal-incremental-history.test.mjs tests/terminal-history.test.mjs tests/terminal-state.test.mjs mobile/client/terminal-history-layer.test.cjs mobile/client/terminal-scroll-helpers.test.cjs mobile/client/terminal-content-helpers.test.cjs mobile/client/user-prompt-banner.test.cjs
node tests/e2e/desktop-scroll.e2e.mjs
node tests/e2e/terminal-history-regression.e2e.mjs
node tests/e2e/mobile-terminal-lifecycle.e2e.mjs
```

## 尚未消除的验收问题

综合回归不是全绿。相对本文写作时点：

1. ~~`mobile.e2e.mjs` 长按选区手柄数量~~ → **收尾已通过**（见 followup §4.2）。
2. 旧的“更多菜单三项”断言与当前五项菜单不一致 → **仍开放**（followup 整页 4 失败之一）。
3. ~~`mac-desktop-novnc-bundle.js` 误启独立 UI~~ → **收尾已改为 RFB-only**；真实远程桌面连接仍未验收。
4. Android pointer/gesture 单元失败（`androidControlDeviceId`）→ **仍开放**；与终端专项无关，`newFailures=[]`。
5. `git diff --check` 在已有 mobile app/CSS 的其他改动行仍有尾部空白警告 → 未对本轮无关代码做大范围格式化。

另：Android 镜像长按拖拽 / 首次控制权触摸 / 拖出边界 MOVE+UP 仍失败（followup §4.1）。

## 生效与后续验收边界

PWA 缓存：本文当时为 `duocli-v70` → `duocli-v71`；**收尾已到 `duocli-v72`**。构建不会自动替换正在运行的桌面进程。应在用户现有 Agent 任务安全收尾后启动新构建，并刷新网页/PWA。

尚未验证实体 iPhone Safari 的惯性滚动、弱网长时间持续输出及打包 Electron 的现场体验；细节与复现日志见 followup。
