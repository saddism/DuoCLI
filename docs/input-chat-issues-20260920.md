# 终端与对话模式问题清单（2026-09-20）

范围：Electron 桌面终端、移动/PWA 终端、原生对话视图、HTTP/WS 输入、PTY 提交、会话切换、草稿与 IME、粘贴、历史恢复和 transcript。配套实现合同见[优化 Spec](./input-chat-optimization-spec-20260920.md)。

状态：本轮发现的代码问题均已处理并纳入自动化回归。这里的“已修复”指当前源码和隔离运行环境；当前正在运行的旧实例、真实 Claude/Codex/Cursor、iPhone Safari 和 Android 输入法仍需现场验收，不能用浏览器夹具替代。

## 1. 输入与终端问题

| ID | 原问题 | 修复结果 | 回归证据 |
| --- | --- | --- | --- |
| INPUT-01 | 切 A→B 时旧 WS 仍可把内容送入 A | 切换开始即冻结输入和关闭旧连接；连接记录实际 sessionId；WS envelope 带 sessionId，服务端核验订阅归属 | `input-chat-audit-probes`：旧连接 0 次写入；`mobile-remote` 错会话提交被拒绝 |
| INPUT-02 | compositionend 读取并发送新会话草稿 | 组合发送意图绑定 sessionId + viewGeneration；过期意图取消 | 专项探针：切换后 0 次发送 |
| INPUT-03 | A 的迟到 ACK 抢 B 焦点，且全局锁阻塞 B | 提交锁改为按会话；回调只更新所属且仍可见的会话 | 专项探针：B 焦点保持 |
| INPUT-04 | 刷新后 pending 存在但输入框无法恢复 | pending 按会话持久化并优先恢复到空草稿；错误原文不覆盖正在编辑的新草稿 | 专项探针：未确认文字恢复 |
| INPUT-05 | 桌面文件粘贴先写原文、再写转义路径 | paste 同步接管并保存当次文本；异步文件判断只选择文件路径或纯文本一个写入者 | 桌面粘贴诊断：一次事件一次转义写入 |
| INPUT-06 | composer 文本与 Enter 之间可插入另一端输入 | PTY 增加输入事务；正文、兼容等待和 Enter 原子排队，其他输入随后冲刷 | `terminal-state` 并发顺序回归 |
| INPUT-07 | 256 条去重窗口过小，旧请求可再次执行 | 活跃进程去重台账扩大为 4096 条并按 24 小时清理，飞行中记录不淘汰 | 257+ 提交协议诊断不再重复写 |
| INPUT-08 | 写入前失败也永久缓存 rejected Promise | 记录 queued/text/entered；仅明确写入前失败移除 ID 允许安全重试，部分写入继续保持不确定状态 | 写入前失败同 ID 重试回归；重复 ID 只写一次 |
| INPUT-09 | 对话模式“插入终端”调用已关闭 WS | 对话模式路径插入 composer，终端模式才写 WS | 页面回归覆盖模式切换与文件入口 |
| INPUT-10 | 草稿与提交上限不一致，超限先等待 WS 超时 | 发送前立即执行统一 100000 字符限制；超限正文仍保留 | 客户端状态检查 |
| INPUT-11 | 软键盘缺少可靠换行入口 | 保留 Enter 发送、Shift+Enter 换行，并增加可点“换行”按钮；IME 确认不发送 | mobile-remote 的 Shift+Enter、IME 回归；页面按钮回归 |
| INPUT-12 | 未确认内容提前成为“最近在说” | 仅提交 ACK 后更新最近发言；失败内容保持草稿/pending | 发送失败页面回归 |
| INPUT-13 | chat 提交错误夺取 mobile 终端尺寸 | `chat` 成为独立输入 source，不参与 terminal sizeOwner/几何切换 | `chat submission does not claim terminal geometry` |

## 2. 对话模式问题

| ID | 原问题 | 修复结果 | 回归证据 |
| --- | --- | --- | --- |
| CHAT-01 | 迟到 createTerminal 在对话模式重连 WS | 增加独立 viewGeneration；创建完成再次核验会话和模式 | 专项探针：对话模式连接数为 0 |
| CHAT-02 | 审批/选择题/停止生成无操作闭环 | 对话页始终提供“终端操作”和“停止”；停止通过目标会话 HTTP 发送 Ctrl+C；对话发送 `/model` 后自动进入同会话终端选择且不改变默认模式 | 移动整页 UI 回归 |
| CHAT-03 | chat 只凭网络在线判断可输入 | 提交固定目标会话，HTTP 端再次验证会话；离线/结束明确报错并保留草稿 | 失败恢复、跨会话回归 |
| CHAT-04 | 文件未落盘期间被误解为 Agent 状态 | UI 以旋转/脉冲状态区分发送、更新、等待记录、成功和失败，不虚构 running/completed | 本地回显和同步状态回归 |
| CHAT-05 | 每次全文件解析、全量传输、全量 DOM | Reader 按 inode/offset/完整行增量解析；revision 无变化轻响应；API 最近 300 条分页；显式加载更早页 | partial-tail 单元；服务端分页合并 E2E；初始 DOM 上限回归 |
| CHAT-06 | Codex input_text/output_text 丢失 | Codex 使用自己的 block mapper；补齐工具结果 callId | native-chat decoder 单元 |
| CHAT-07 | 工具入参/结果被截断且难以核对 | 展开保留全文，显示 callId/状态，并可复制；代码块也可独立复制 | 5000 字工具输出单元 |
| CHAT-08 | 重复文本靠出现次数对账，可能误消本地消息 | 服务端把活跃 submissionId 关联到 transcript 用户消息；客户端优先按 ID 对账，旧快照才回退次数 | 相同“继续”不同提交 ID 单元 |
| CHAT-09 | 上翻后缺少新消息入口，刷新易移动阅读点 | 以 message key 恢复锚点；非贴底显示“查看新消息”；加载旧页保持视口 | 长对话和刷新竞态 E2E |
| CHAT-10 | 上传反馈写入隐藏终端，附件路径不可操作 | chat 状态栏承接上传结果；本地图片/文件引用通过事件进入鉴权预览 | 页面与文件预览回归 |
| CHAT-11 | 后台仍轮询、无退避、回前台不立即同步 | 后台暂停；前台立即刷新；错误指数退避；同代请求按序拒绝迟到结果 | 刷新竞态/失败保留正文 E2E |
| CHAT-12 | 文本、代码、链接、角色、时间和复制能力不足 | 安全转义下增加 http(s) 链接、围栏代码语法染色和语言标签、角色/时间、代码及工具输出复制 | native-chat-view 单元 |

## 3. 验收基础问题

| ID | 原问题 | 修复结果 |
| --- | --- | --- |
| QA-01 | `test:unit` 的引号 glob 在 Node 20 不展开 | 新增可移植测试发现脚本；`npm run test:unit` 当前执行 296 项 |
| QA-02 | 部分 E2E 的 CLI 成功文本是夹具主动注入 | 保留证据边界；新增协议、竞态、错误和分页断言，不把注入文本写成真实 Agent 证明 |
| QA-03 | 缺少实体 IME/Safari/Android/真实 CLI 矩阵 | 自动化能覆盖的事件与协议已补齐；实体设备仍列为发布前现场验收，不伪装完成 |
| QA-04 | 源码构建与用户当前运行版本无关联 | PWA cache 升至 `duocli-v81`；未擅自重启用户实例，部署后仍需核对实际加载版本 |

## 4. 当前验证结果

环境：macOS，Node 20，Chrome/Chromium。没有向用户的真实 Agent 会话注入测试文本。

| 检查 | 结果 |
| --- | --- |
| `npm run build:ts` | 通过 |
| `npm run test:unit` | 298/298 通过 |
| `DUOCLI_INPUT_AUDIT=1 node tests/e2e/mobile.e2e.mjs` | 110/110 通过，包含 5 个原始竞态探针和代码/状态视觉断言 |
| `npm run test:e2e` | 全部 8 个套件通过，共 191 个场景 |
| 对话页截图 | `/tmp/duocli-chat-input-20260920.png`、`/tmp/duocli-chat-code-status-20260920.png`，已目视检查 |

完整 E2E 包含移动整页 104、桌面复制 8、桌面滚动 23、远程输入 20、快捷命令 1、终端历史恢复 12、历史回归 10、连续滚动 13 个场景。

## 5. 仍需现场验证的边界

- 实体 iPhone/Safari 的拼音候选、语音返回和 PWA 前后台；Android 中文输入法。
- Electron 原生剪贴板中的 Finder 文件、图片与失败回退。
- Claude/Codex/Cursor 的真实 multiline paste、审批、Ctrl+C、中断与 CLI 版本 transcript 样本。
- 桌面与手机双端同时输入时的实际 TUI 重排；一万条真实 transcript 的性能分布。
- PTY 进程重启后的 exactly-once 不在本方案承诺内：进程死亡也意味着原 PTY 已死亡。对不确定提交只保留原文并要求用户显式再次发送，不自动重放。

源码已修复不等于旧运行实例已加载。此次没有提交、推送、打包、部署或重启现有 DuoCLI。
