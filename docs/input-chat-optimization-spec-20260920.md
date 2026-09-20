# 终端与对话模式可靠性优化 Spec

日期：2026-09-20。状态：**当前源码已实施，自动化验收通过；真机、真实 Agent、部署验收待执行。**

问题与逐项处置见[问题清单](./input-chat-issues-20260920.md)。本 Spec 既记录已经落地的合同，也作为后续改动不得破坏的回归基线。

## 1. 用户结果与非目标

必须保证：输入属于开始操作时的会话；发送和粘贴不重复；草稿及未确认正文可恢复；对话更新失败不抹掉已读内容；用户阅读历史时不被新消息拽走；需要审批或中断时始终能回终端操作。

本实现不声称 PTY 跨主进程重启 exactly-once，也不从“HTTP/WS 写入成功”推断 Agent 已开始或完成。没有可靠 provider 状态时，页面只陈述“已送达终端”“等待对话记录”“最近同步”，不虚构执行状态。

## 2. 已实施合同

### 2.1 会话归属与生命周期

- 会话切换先冻结输入、保存草稿、关闭旧 WS，再更新当前 sessionId。
- WS 同时维护 `wsSessionId`；submit envelope 必须携带 sessionId，服务端只接受与订阅一致的目标。
- session view 使用独立 generation。终端创建、compositionend、提交 ACK、刷新响应都必须核对捕获的 sessionId/generation。
- terminal 和 chat 分开判断输入路径；chat 不能复用关闭或绑定其他会话的 WS。
- 页面后台暂停 chat 轮询，回前台立即同步；迟到或旧代响应不得覆盖新会话。

### 2.2 Composer、IME 与草稿

- 输入框随内容增长到上限后内部滚动；恢复草稿、插入路径和上传结果都重新计算高度。
- Enter 发送、Shift+Enter 换行；手机提供可点换行按钮；composition 确认 Enter 不提交。
- 组合结束发送意图绑定会话和视图，不允许读取切换后的 composer。
- 每个会话独立 submission lock、draft 和 pending；A 等 ACK 不阻塞 B，也不能操作 B 的焦点。
- 点击发送后同步持久化、清空输入并绘制本地气泡，首帧不等待网络；ACK 或失败只推进气泡状态，不移除未确认正文。
- 提交上限统一为 100000 字符并在网络请求前提示；超限和失败正文不丢失。
- 最近发言只在提交确认后更新。

### 2.3 提交与 PTY 输入事务

- `submissionId + text` 在活跃 PTY 中幂等；相同 ID 不同正文拒绝。
- composer 正文、兼容等待、Enter 是一个输入事务。期间到达的 desktop/mobile 普通输入排在 Enter 后。
- 台账记录 `queued → text → entered`。只有 queued 阶段失败能安全删除并用同 ID 重试；正文可能已写时保持不确定，禁止自动重发。
- 去重记录至少保留 24 小时；超过 4096 条时只清理已过期的完成记录，且不淘汰飞行中请求。
- chat 是独立 source，不夺取 terminal sizeOwner。停止是目标会话的显式 Ctrl+C 控制动作。

### 2.4 粘贴、路径和上传

- desktop paste 在异步检查前同步接管事件，并捕获当次文本；文件路径、图片处理、纯文字回退只有一个写入者。
- 文件路径 shell 转义；失败显示在可见 compose/chat 状态，不静默 catch。
- 对话模式“插入”进入 composer；终端模式才写终端连接。
- 对话里的本地文件/图片引用进入现有鉴权预览，不直接暴露任意本地文件 URL。

### 2.5 Transcript 与对话呈现

- Reader 缓存 inode、size、已消费 offset 和不完整尾行；追加只解码新增完整 JSONL，截断/替换后重建。
- Codex 的 input_text/output_text 使用专用映射；工具结果保留 callId；同 ID 的流式更新以完成记录替换早期记录。
- API 支持 revision 无变化轻响应，以及 `before + limit` 的倒序分页；默认只返回最近 300 条。
- 活跃提交与用户 transcript 反向匹配后附加 submissionId；客户端按 ID 消除本地回显，旧格式才回退文本次数。
- 消息节点按稳定 key 复用，保留工具展开；工具入参/输出不截断并可复制。
- 文本始终 HTML 转义；支持 http(s) 链接、围栏代码和代码复制；不把任意 HTML/URL 当可信内容。
- 上翻保存消息锚点；新消息显示显式按钮；加载旧页后保持当前阅读位置。

### 2.6 更新、错误与操作闭环

- 同一轮 poll 完成后才排下一轮；失败指数退避，已有正文保留并显示错误。
- 贴底才自动跟随；不贴底时显示“查看新消息”。
- 对话页固定提供“终端操作”和“停止”，覆盖无法结构化表达的 CLI 审批/选择题。
- `/model` 这类只有 PTY 选项的交互命令确认送达后临时打开同一会话终端；不硬编码不同 CLI 的动态选项，也不修改用户默认视图。
- 上传、停止、同步失败都在对话页可见；模式切换不丢 composer。

## 3. 关键状态机

| 状态 | 可见行为 | 下一步 |
| --- | --- | --- |
| draft | 可编辑、按会话保存 | 用户发送 |
| sending | 本地气泡“发送中” | 等待 WS/HTTP ACK |
| delivered | “已送达终端，等待对话记录更新” | 等待 transcript submissionId |
| observed | 服务端消息替代本地气泡 | 正常展示 |
| unknown | 恢复原文并说明未确认 | 用户显式再次点击；不自动重放 |
| failed-before-write | 保留同 ID，可安全重试 | 下一次显式发送 |

服务端消息的 `running/completed` 只有 transcript 提供可靠信号时才显示。同步成功、输入写入、Agent 执行完成是三件不同的事。

## 4. 实施位置

| 责任 | 主要文件 |
| --- | --- |
| 移动会话、composer、刷新与分页 | `mobile/client/app.js` |
| 对话 DOM、安全格式与本地回显 | `mobile/client/native-chat-view.js` |
| 对话页结构/样式/PWA 版本 | `mobile/client/index.html`、`style.css`、`sw.js` |
| PTY 事务、幂等、source/尺寸 | `src/main/pty-manager.ts` |
| WS/HTTP 校验、分页和提交关联 | `src/main/remote-server.ts` |
| 增量读取与各 CLI decoder | `src/main/native-chat/` |
| 桌面 paste | `src/renderer/terminal-manager.ts` |
| 便携单测发现 | `scripts/run-unit-tests.mjs` |
| 诊断和竞态回归 | `scripts/audit-input-protocol.mjs`、`tests/e2e/input-chat-audit-probes.mjs` |

## 5. 验收矩阵

### 5.1 自动化发布门槛

每次相关修改至少运行：

```sh
npm run build:ts
npm run test:unit
DUOCLI_INPUT_AUDIT=1 node tests/e2e/mobile.e2e.mjs
npm run test:e2e
```

必须覆盖：A→B 快速切换、composition 后切换、迟到 ACK、失败草稿恢复、同 ID 重试、普通输入与 composer 并发、错会话 WS、重复文本提交 ID、partial JSONL、长对话分页、上翻时新增消息、后台恢复和桌面异步文件 paste。

当前基线：build 通过；unit 298/298；专项 mobile 110/110；完整 E2E 191/191。

### 5.2 现场发布门槛

| 维度 | 必测内容 |
| --- | --- |
| iPhone Safari/PWA | 连续中文候选、语音、多行、锁屏/前后台、弱网 |
| Android Chrome | 中文输入法、换行按钮、切换会话、失败恢复 |
| Electron/macOS | Finder 文件/图片 paste、原生剪贴板、焦点与快捷键 |
| 真实 Agent | Claude/Codex/Cursor multiline paste、重复“继续”、审批、停止、结束后返回 shell |
| 双端 | 手机/桌面交替输入、同时输入、resize、慢 ACK 跨会话 |
| 大数据 | 万条 transcript、工具长输出、文件截断/替换、分页到最早记录 |

记录实际构建/PWA cache 版本、设备、浏览器、CLI 版本、响应延迟和失败现象。自动化注入的输出不得冒充真实 Agent 执行证据。

## 6. 发布与回退边界

- 发布前确认用户运行实例已加载 `duocli-v81` 或对应桌面构建；源码通过不等于部署完成。
- 不自动重放 unknown 提交，不用固定 50ms 或 transcript 文本出现推断命令执行成功。
- 若新 decoder 遇到未知记录，保留原对话和诊断状态，不能清空历史。
- 若分页失败，保留当前页和阅读位置；若刷新失败，保留最后成功 snapshot。
- 本轮没有自动提交、推送、打包、部署或重启现有会话。
