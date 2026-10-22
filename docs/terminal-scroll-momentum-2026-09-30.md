# 终端触摸滚动惯性（松手滑行）

日期：2026-09-30。范围：手机端终端实时区、双指滚动、历史层（更早输出）。

## 问题

手机端终端滚动由容器捕获 touchmove 并逐行调用 `term.scrollLines()`，
touchmove 里的 `preventDefault` 同时拦掉了浏览器原生滑动，导致：

- 松手即停，快速甩动没有惯性滑行，回看长输出要连续拖很多次；
- 「更早输出」历史层同样逐像素 preventDefault，也没有惯性；
- 全屏 TUI（alternate buffer）已有 90ms 合并翻页机制，行为正常，保持不变。

## 实现

- 新增 `mobile/client/terminal-momentum.js`（UMD，含 `terminal-momentum.test.cjs`）：
  - `createPanVelocityTracker()`：按末次 100ms 窗口聚合手指位移得到松手速度；
    窗口外旧样本一律丢弃，中断的旧手势不会污染下一次松手。
  - `createMomentumRunner()`：rAF 滑行，速度按 iOS Safari 近似的 325ms 指数衰减；
    初速下限 0.15px/ms（慢松手不滑）、上限 3.5px/ms、每帧 dt 截断 64ms，
    低于 0.03px/ms 或 `shouldContinue` 返回 false 即停并回调 `onEnd`。
- `app.js` 接线：
  - 单指 pan 与双指 scroll 的每次位移喂给速度采样器；touchend（非 touchcancel）
    速度达标即启动惯性；惯性期间沿用 `terminalTouchActive` 手势保护，
    新输出不会把视口拽回底部，历史请求也不会被误触发。
  - 每帧位移与拖动同序：先 `handlePagedHistoryPan`（可无缝从实时区滑进档案层、
    滑回底部时经 resumeLive 无缝接回实时区），再 `scrollTerminalByPixels`。
  - 贴边（顶部/底部）即停；滑到最新输出结束时重演松手收尾评估，
    恢复跟尾并清除未读横幅；停在档案层则清空历史意图标记。
  - 终止时机：任何新触摸、滚轮、跳底按钮/replay 跟尾、退出历史层、
    会话切换/重置（`resetTerminalScrollState`）。
  - `beginTerminalMomentum()` 只作用于 normal buffer，TUI 翻页保持确定性。
- `terminal-history-layer.js`：层内 touchmove/touchend/touchcancel 上报
  `onPanMove`/`onPanEnd`/`onPanCancel`，与实时区共用同一惯性引擎。
- Service Worker 缓存版本升到 v99。

## 验证

| 检查 | 结果 |
| --- | --- |
| `node --test mobile/client/terminal-momentum.test.cjs` | 6/6 |
| `npm run test:unit` | 354/354 |
| `tests/e2e/mobile.e2e.mjs` | 138/138（含慢拖不滑行、上/下滑行贴边即停、到底恢复跟尾 5 项新检查） |
| `tests/e2e/terminal-history-regression.e2e.mjs`（层内触摸） | 13/13 |
| `tests/e2e/desktop-scroll.e2e.mjs`、`desktop-copy`、`mobile-remote`、`terminal-history-recovery`、`terminal-continuity`、`terminal-activity-fold`、`workspace-ui`、`quick-commands` | 全部通过 |

## 行为对照

- 慢速拖动松手：原地停住（与原先一致）。
- 快速甩动松手：按速度继续滑行并衰减，方向不反转；全程不触发选区。
- 甩向上方：可穿过实时区顶部直接滑入「更早输出」档案层并继续加载更早行。
- 甩向下方：滑到最新行后恢复跟尾，未读横幅清除。
