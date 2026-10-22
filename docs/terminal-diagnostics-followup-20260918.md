# DuoCLI 终端诊断与修复记录

日期：2026-09-18  
状态：代码与自动化验证完成；**未** commit / 部署 / 重启正在使用的 DuoCLI / 终止实际 Agent 会话。

> 前序诊断见 [`terminal-scroll-audit-2026-09-18.md`](./terminal-scroll-audit-2026-09-18.md)（增量归档、虚拟列表、桌面输出补写等）。  
> **本文是收尾核对**：以本轮回归与源文件哈希为准；前序文档中仍标为未关闭、但本轮已修的项，以本文为准。

---

## 1. 结论

- 终端专项 `npm run test:terminal`：**71 / 71 通过**。
- 全量单元：**273** 项中 **251** 通过、**22** 失败；`newFailures=[]`，与检查开始时失败名完全相同。
- 通用移动整页：**92** 项中 **88** 通过、**4** 失败（非终端专项范围，未通过改断言掩盖）。
- 工作区原本已有大量未提交修改；增量历史归档、虚拟列表、桌面输出补写等属前序实现，**不能全部记为本轮新增**。
- 「只显示一屏仍会卡」不是单一 scrollback 参数问题；本轮确认的是历史边界、请求竞态、迟到回调、尺寸发送饥饿等。

---

## 2. 本轮修复清单（7 项）

| # | 问题 | 做法 | 主要文件 |
| --- | --- | --- | --- |
| 1 | 历史不足一屏时无法继续翻页 | `scrollByPixels` 向上拖动时主动 `maybeLoadMore`，不依赖原生 scroll | `mobile/client/terminal-history-layer.js` |
| 2 | 历史请求与「回到最新」互相干扰 | 请求代次 / 实例身份校验；10s 超时；旧成败不覆盖新请求；显式 `null` 游标不误替；最新边界与更早页游标分离 | `src/renderer/terminal-manager.ts` |
| 3 | 首屏 / 切换 / 重连迟到回调 | 以终端实例、打开代次、连接代次、交互版本确认回调仍有效 | `mobile/client/app.js`（`revealTerminalAtLatest` / `restoreTerminalSnapshot` / `createTerminal`） |
| 4 | 尺寸确认被破坏；连续布局导致发送饥饿 | 100ms 合并发送且不无限延期；已确认快照不再偷偷本地 fit；服务端首次 resize 有序确认；仅最新快照完成后恢复实时输出 | `mobile/client/app.js`、`src/main/remote-server.ts` |
| 5 | 重建终端后历史阅读位置丢失 | 重建前保存已加载页 / 游标 / 逻辑行锚点 / 像素偏移，重建后恢复且不重复请求 | `mobile/client/app.js`（`forceTerminalRecreate`） |
| 6 | 长按已选中但手柄迟迟不出现 | 长按成立时立即更新手柄与复制按钮；滚动仍合并到 rAF | `mobile/client/app.js` 长按处理 |
| 7 | 页面错误执行 noVNC 独立 UI 初始化 | 打包入口改为 RFB 核心；`duocli-v72`；包体 461241 → 402823 字节（仅包体实测） | `scripts/build-novnc.mjs`、`mac-desktop-novnc-bundle.js`、`sw.js` |

修复后尺寸诊断：浏览器 / 已发送 / 后端均为 **42×16**，且无待发送定时器（见 `terminal-gate.log` 中 `RESIZE_DIAGNOSTIC`）。

---

## 3. 文件范围（建议单独提交时参考）

### 3.1 终端收尾直接相关（本轮核对哈希已对齐）

| 路径 | 角色 |
| --- | --- |
| `mobile/client/app.js` | 首屏/回调代次、resize 合并、重建锚点、长按手柄 |
| `mobile/client/terminal-history-layer.js` | 短页边界继续分页 |
| `mobile/client/sw.js` | `duocli-v72` |
| `mobile/client/mac-desktop-novnc-bundle.js` | RFB-only 包（生成物） |
| `scripts/build-novnc.mjs` | noVNC 打包入口 |
| `src/main/remote-server.ts` | resize 有序确认、快照门控实时输出 |
| `src/renderer/terminal-manager.ts` | 桌面历史请求竞态与超时 |
| `package.json` | `test:terminal` |
| `tests/mobile-reveal-state.test.mjs` | 首屏/过期回调/连续尺寸 |
| `tests/e2e/terminal-history-recovery.e2e.mjs` | 历史恢复竞态 |
| `tests/e2e/terminal-history-regression.e2e.mjs` | 虚拟列表 / 中文 / 触摸 |
| `tests/e2e/mobile-remote.e2e.mjs` | 远程链路与重建锚点等 |

### 3.2 前序终端基建（保留并验证，勿误记为本轮从零新增）

- `src/main/terminal-history.ts`、`src/main/terminal-state.ts`
- `mobile/client/terminal-history-layer.test.cjs`、`tests/terminal-history.test.mjs`、`tests/terminal-incremental-history.test.mjs`
- `scripts/benchmark-terminal-history.mjs`
- 桌面滚动/焦点相关：`src/renderer/app.ts`、`terminal-scroll-controller.ts`、`pane-workspace.ts` 等（见前序审计）

### 3.3 同工作区但非本终端收尾（勿与终端修复混提交）

- Mac 远程桌面：`src/main/mac-desktop-*.ts`、`mobile/client/mac-desktop-*`、相关 `docs/mac-*`
- Native chat：`src/main/native-chat/`
- 截图与杂项：`IMG_*.png/jpeg`、`MAC-REMOTE-DESKTOP-COMPLETION.md` 等

核对时（2026-09-18）上述 3.1 与 `verification-manifest.json` 中 SHA-256 **全部一致**。

---

## 4. 验证结果

统一入口（**不**替代 `npm test`）：

```sh
npm run test:terminal
```

| 检查 | 最终结果 |
| --- | --- |
| TypeScript + 渲染器构建 + noVNC 打包 | 通过 |
| 首屏 / 过期回调 / 连续尺寸（unit） | 9 / 9 |
| 历史分页与恢复竞态（browser） | 10 / 10 |
| 历史虚拟列表 / 中文换行 / 触摸 / 尾队列 | 10 / 10 |
| 移动远程 HTTP/WebSocket | 19 / 19 |
| 桌面滚动 / 切换 / 焦点 | 15 / 15 |
| 桌面复制与链接 | 8 / 8 |
| **终端专项合计** | **71 / 71** |
| 全量单元 | 273：251 通过，22 失败 |
| 最后一轮通用移动整页 | 92：88 通过，4 失败 |

### 4.1 仍失败、且非本轮引入

**单元 22 条**：集中在 `android-pointer-gestures.test.cjs` / 相关用例的 `ReferenceError: androidControlDeviceId is not defined`。同一根因重复触发，不能当成 22 个独立产品缺陷。

**移动整页 4 条**：

1. 「详情页更多入口展开三项菜单」——界面已是五项（项目文件 / 切换到对话 / 计划设置 / 手机设备 / 关闭对话），断言过时。
2. Android 鼠标长按拖拽：保留持续时间与最后坐标。
3. Android 兼容画面：首次触摸在取得控制权后立即开始。
4. Android 手指拖出边缘后仍收到 MOVE 和 UP。

### 4.2 本轮相对前序审计已关闭

| 前序未关闭项 | 本轮状态 |
| --- | --- |
| 长按选区手柄数量断言失败 | 整页已通过（`handles: 2`，`pendingHandleFrame: 0`） |
| noVNC `addOption` / `initSettings` 误启动 | 已改为 RFB-only；远程专项有「embedded RFB without standalone UI」通过；**真实远程桌面连接未验收** |
| PWA 缓存 | `duocli-v71` → **`duocli-v72`** |

---

## 5. 覆盖与限制

- 浏览器：真实 Chrome + 实际网页 / 桌面渲染器代码。
- 移动远程：真实 HTTP/WebSocket；PTY 输入来自夹具与录制，非全部新起真实 Agent。
- 已对 Qoder / Cursor / Antigravity / Codex 录制输出做最新屏与服务端比对；重连连续 60 条输出经历史分页 + 最新屏联合验证，有序、不重不漏。
- 增量归档现场探针：约 5000 行历史后，40 次 spinner 更新未触发全量历史同步；**无同条件旧版端到端基线，不写虚构帧率/加速百分比**。
- **未做**：真机 iPhone/Safari 长惯性滚动、设备内存峰值、生产弱网、全部 Agent 实时跑、真实远程桌面连接。

---

## 6. 留档与复现

目录：`.local/terminal-audit-20260918/`

| 文件 | 用途 |
| --- | --- |
| `terminal-gate.log` | `test:terminal` 最终输出 |
| `mobile-last.log` | 通用移动整页最终结果（88/92） |
| `unit-current.log` | 全量单元最终结果（251/273） |
| `verification-manifest.json` | 失败名比较 + 相关源文件 SHA-256 |
| `last-verification.json` | terminal-gate / mobile-last 退出码 |

任务引用：

- 专项 + 整页最终验证：`job_f85f64e0d60f4c45a80d442caa36bfae`
- 单元复跑 + 源文件校验：`job_823f698589074119a6574d0ae4fffbf7`

本地构建完成 ≠ 正在运行的已安装桌面进程已更新；本轮未执行 restart / 强制刷新实际用户会话。
