# 新建终端计划任务与依赖队列 Spec

日期：2026-09-20。状态：**已实施；构建、303 项单测和完整 E2E 通过，真实 CLI 人工验收待执行。**

## 1. 用户目标与本次决策

新建终端时既可立即启动，也可指定时间启动，或等另一个前置终端任务完成后启动；可以串成 A → B → C。

用户先以“灯转灰”描述完成，随后补充“没有新的内容，静止就算”。本 Spec 以最后的语义为执行规则：**本轮任务开始后，终端持续没有新的有效内容，即视为本轮完成并允许后续任务启动。** 不要求进程退出，也不要求 AI 返回结构化成功信号。

用户已明确确认：黄色和灰色两种停止状态都应算完成，并将静止阈值从现有 3 秒延长为 10 秒。保留灯色外观，队列消费共同的“停止”事件；查看终端不能改变任务是否完成。

默认静止时间统一改为 10 秒，任务表单允许修改为 1–3600 秒。10 秒是界面活动规则，不证明命令成功或 AI 已完成业务目标：长时间无输出的命令也会被视为本轮完成。这是本方案遵循用户规则的明确行为，不在实现中偷偷改用进程退出规则。

## 2. 当前实现核查

行号为本次研究快照，实施时按函数名重新定位；工作区已有多处并行未提交修改，应先重读文件与 diff。

| 位置 | 当前行为 | 对本功能的影响 |
| --- | --- | --- |
| `src/renderer/index.html:12` | 新建弹窗只有目录、CLI、配色 | 没有时间、依赖和任务正文 |
| `src/renderer/app.ts:3620` `createSession` | 立即调用 `createPty` 并打开终端 | 不能把等待任务伪装成已经创建的 PTY |
| `src/main/index.ts:651` `pty:create` | 合并预设环境、创建 PTY、返回会话 | 桌面启动入口 |
| `src/main/remote-server.ts:1979` `POST /api/sessions` | 手机直接创建 PTY | 与桌面有独立创建路径 |
| `src/main/pty-manager.ts:323` `create` | 创建交互 shell；约 300ms 后发送 CLI 预设 | 延时发送不是 CLI 就绪确认 |
| `src/main/pty-manager.ts:625` `submit` | 输入事务、submissionId 去重、正文后回车 | Promise 成功只代表送达终端，不代表任务完成 |
| `src/renderer/app.ts:1486–1553` | busy/unread/viewing 合成灯色并同步 main | 灯色计算目前依赖 renderer |
| `src/renderer/app.ts:4350–4444` | 有输出变绿；提示符立即停止；否则静默 3000ms 停止 | 当前为 3 秒，计划改为 10 秒；符合“静止停止”的大方向，但有下述问题 |
| `src/main/session-status.ts` | ANSI 瞬态过滤和颜色映射 | 可复用过滤规则，不能直接当任务状态机 |
| `src/main/index.ts:1408` | main 接收整份 renderer 状态到 global | 缺失状态默认灰，不能用于任务完成 |
| `src/main/auto-continue-manager.ts` | 向已有会话定时循环发送 messages，写 auto-continue.json | 是定时发送，不是创建终端或跨任务队列 |
| `src/main/index.ts:1485` `cleanupForQuit` | 退出停止主进程服务，终端进程结束 | 应用完全退出时无法执行计划任务 |
| `tests/session-status.test.mjs` | 覆盖颜色映射与若干控制序列 | 未覆盖静止计时、启动或跨进程队列 |

### 2.1 灯逻辑是不是正确

作为“最近有没有活动、有没有看过”的提示基本成立；作为可靠的队列触发器，目前不足。

1. **灰色不等于刚完成。** 初始灰色、缺失状态、未运行过、黄灯被查看，都可能显示灰色。
2. **提示符可提前结束。** 当前看到 `$`、`>` 等尾部字符就立即停止，未等待 3 秒；任务输出也可能包含这些字符。
3. **纯控制输出可能延长绿色。** `ignoreBusy` 只有在“不忙”时才排除瞬态输出；已忙时光标/颜色控制序列仍会重置计时。
4. **重绘可能被当成新内容。** resize 的 1500ms 抑制窗口只是时间过滤，超出窗口的重复画面仍可能变绿；窗口内真实输出也可能被漏掉。
5. **启动输出可能误完成。** 欢迎信息和初始提示符会产生绿→停止，但用户任务可能尚未送达。
6. **状态依赖 renderer。** 关闭窗口、页面销毁或重载后，不应让主进程队列停摆或因初始灰色误放行。
7. **静止不等于成功。** `sleep`、网络等待、审批、等待用户输入都可能无输出；必须明确产品采用的是“静止完成”。

以上由源码分支核查得到；本轮未做真实 Electron 动态复现，不能把风险条目写成已复现故障。

## 3. 第一版范围与界面

### 3.1 新建弹窗

保留目录、CLI、配色和原来的“创建终端”；新增可折叠“计划任务”，默认关闭，普通新建流程不受影响。

启用后出现：

- 任务名称：必填，1–120 字符。
- 启动安排：立即 / 指定时间；时间按设备本地时区输入，旁边显示时区。
- 前置任务：无 / 选择一个任务 / 选择一个正在运行的普通终端。
- 首条任务指令：多行文本，最多 100000 字符；CLI 模式为提示词，空终端模式为 shell 命令。第一版每任务一个正文，不拆行发送。
- 静止判定：默认 10 秒，可修改；说明“发送本轮指令后，持续没有新内容即完成；未查看的黄灯也算停止”。
- 创建按钮显示“加入任务队列”，点击后保持表单到持久化成功；错误显示原表单内，重复点击使用同一个 requestId。

时间与依赖允许同时使用，关系是 AND：到达指定时间且前置完成，才能启动。未来时间才可新建；修改时也校验，不依赖浏览器验证。

只有 CLI 启动命令、没有首条任务指令，无法区分欢迎页和真正任务。第一版计划任务要求填写正文；普通空终端仍走原新建入口。

### 3.2 队列视图

桌面侧栏提供“任务队列”入口；手机会话页提供同名入口。每项显示名称、目录、CLI、时间、前置名称、当前状态、等待原因、关联终端和完成依据。

状态文案：等待时间 / 等待前置 / 启动中 / 执行中 / 已完成（内容静止） / 启动失败 / 已取消 / 受阻 / 执行状态待确认。

操作：查看终端、取消等待、修改等待任务、取消执行、确认已完成、重新创建。完成后保留终端及输出，不自动关闭。等待任务没有 sessionId，不创建 xterm 或空 PTY。

自动启动只加入会话列表并提示，不切换用户正在查看的终端、不清空草稿；用户点“查看终端”才切换。不能直接复用当前会抢焦点的 `onRemoteCreated` 整段逻辑。

### 3.3 边界

首版实现一次性时间、单前置、可分叉链、两端创建/查看/取消和主进程持久化。不同无依赖任务可同时执行；同一前置的多个后继可同时开始。串行队列通过显式依赖建立，不额外做全局 FIFO 或并发额度。

不含 cron、每天重复、跨电脑执行、自动传递前置输出、任务优先级、自动重试失败任务。前置只控制启动，不注入上下文。

## 4. 活动与本轮完成合同

新增主进程 `TerminalActivityTracker`，成为桌面灯、手机灯与队列共同的数据来源；前端仅渲染颜色、报告查看行为，不再决定业务完成。

### 4.1 新有效内容

- 基于 PTY 解析后的内容变化记录 `lastContentAt` 和递增 `contentRevision`。
- 仅光标、颜色、标题、终端查询/应答、尺寸变化不能刷新有效内容时间。
- 完整 TUI 重绘而可见内容不变不刷新时间；正常滚动产生新行应刷新，哪怕两行文本相同。比较时同时考虑屏幕内容和滚动历史增长，不能只比较最后一屏文本。
- 分片 ANSI/OSC 由有状态解析层处理，不能对每个 chunk 独立正则裁切后当可靠内容。
- 使用 `TerminalState` 的解析完成回调建立顺序，再提取活动变化；不要另加无序 snapshot 轮询覆盖新 revision。
- spinner 文本变化仍算内容变化；首版不建立各 CLI 的 spinner 语义库。
- 提示符仅可作为显示信息，不再绕过完整静止时间提前产生本轮完成。

### 4.2 启动与计时

每次执行使用新的 runId，并经历独立启动阶段。先创建 PTY、启动 CLI、确认可接收输入，再投递正文。原先 300ms 延时不足以作为“就绪”。

实现等待 shell 启动；有预设 CLI 时，等待启动命令发送后输出连续静止 1.5 秒再投递任务正文，最长等待 60 秒。超时转失败或待确认，不自动重发。各真实 CLI 的冷启动速度仍需人工验收，不能仅凭自动化断言所有 CLI 都已现场通过。

投递正文前记录输入事务与内容基线；正文回显、启动欢迎页不算执行结果。`submit` 的 Enter 成功提交后将该 run 置为 armed/running，开始计算静止时间：

- 没有任何后续输出，也在投递后满 quietMs 完成本轮，符合“静止就算”的规则。
- 后续有效内容将静止截止时间推到 `lastContentAt + quietMs`。
- 输入仍在事务中、CLI 未就绪、仅准备启动时，不允许完成。
- 启动输入写入状态不确定转 `needs_attention`，不能进入静止计时或重复发送。
- 人工在同一任务终端提交新内容时更新活动基线、延后完成；手工单纯切换查看不影响计时。

到期时必须再次核对 taskId、runId、revision、armed、状态、最新内容时间，排除取消/重试后的旧 timer。主进程挂起恢复后允许将已超过阈值的运行任务判定静止，与用户定义一致；记录恢复后判定的原因。

### 4.3 颜色与完成事件

运行中为绿；静止为 stopped。`stopped + 未查看` 显示黄，`stopped + 已查看` 显示灰；初始显示灰但没有本轮完成事件。完成事件包含 taskId/runId/activityRevision/observedAt/reason=`quiet`/quietMs。

停止事件一次性结算任务；黄→灰不重复结算。已完成终端又有输出可重新变绿，但已结算任务不自动回退，不撤销已启动后继。

非默认 quietMs 的计划终端，其灯色停止与本轮阈值同步；普通终端也改为 10 秒默认值，避免“灯已停止而本轮还在计时”的冲突。

### 4.4 绑定已有普通终端

创建依赖时由 main 原子读取状态：若正在运行，绑定当前 activity generation；若已经停止/初始灰，等待下一轮真实提交或运行，不追认历史灰色为新完成。表单清楚显示“等待当前一轮”或“等待下一轮”。

该绑定是稳定的外部前置记录，包含 sessionId、generation 和基线 revision；一旦收到对应停止事件，持久化完成凭据，终端以后关闭也不丢。终端在完成前关闭或应用退出使该会话消失，则受阻，需要重新选择前置。不得按标题或目录猜测重绑。

已有“计划设置/循环发送”与任务运行可能争抢输入：计划任务关联 PTY 在本轮未结束前禁止启用循环发送；绑定已有终端时若循环计划已启用，提示先停止循环计划再加入依赖。无需改动既有循环任务的其他行为。

## 5. 任务模型、依赖与状态机

持久化文件：`app.getPath('userData')/terminal-tasks.json`，schemaVersion=1。

```ts
type TaskStatus = 'pending' | 'starting' | 'running' | 'completed'
  | 'failed' | 'cancelled' | 'blocked' | 'needs_attention';
interface TerminalTask {
  id: string;
  revision: number;
  requestId: string;
  name: string;
  cwd: string;
  presetCommand: string;
  presetId?: string;
  themeId: string;
  instruction: string;
  notBefore?: number; // epoch milliseconds
  timeZone?: string; // 展示创建时区，调度只用 notBefore
  dependency?: { kind: 'task'; id: string }
    | { kind: 'session'; id: string; generation: number; baselineRevision: number };
  quietMs: number;
  status: TaskStatus;
  runId?: string;
  sessionId?: string;
  submissionId?: string;
  armedAt?: number;
  lastContentAt?: number;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
  completion?: { reason: 'quiet' | 'manual'; runId: string; activityRevision: number };
  error?: { code: string; message: string };
}
```

环境变量使用既有预设配置引用，在启动时解析；不把 token、密钥写进任务文件或任务列表 API。预设被删除或必要配置缺失时受阻。命令、目录、正文和时间在创建时保存快照；启动前重新验证目录存在和配置可用。无稳定 presetId 时先补预设引用合同，不用命令文本假装唯一身份。

| 起点 | 条件 | 结果 |
| --- | --- | --- |
| pending | 时间到且前置 completed | 持久化 starting/runId，然后启动 |
| pending | 前置失败、取消或遗失 | blocked，显示具体前置 |
| starting | PTY 就绪且指令已提交 | running，armed |
| starting | 可确认未写入前失败 | failed |
| starting/running | 写入不确定、恢复无法确认 | needs_attention |
| running | 本轮连续静止达到阈值 | completed，再评估后继 |
| pending/starting/running/blocked/needs_attention | 用户取消 | cancelled，阻止旧回调放行 |
| needs_attention/running | 用户确认完成 | completed，reason=manual |

只有 completed 满足依赖；failed/cancelled/blocked/needs_attention 都不能放行。进程退出不视为静止完成：正常退出尚未结算时转待确认，异常退出转失败；用户主动关闭转取消。已经 completed 的任务不因其终端关闭而改变。

依赖创建/修改均验证存在性、自依赖、间接环；运行后不可修改执行配置或前置。任务链 A→B→C 任一前置失败，都要给后续项可追溯的受阻原因。

重新创建会生成新 taskId/runId，不自动把旧任务的后继迁移过去；用户在尚未启动的受阻任务上重新选择前置。第一版不提供硬删除历史，保留依赖证据。

## 6. 调度、并发与恢复

- 一个主进程 `TerminalTaskScheduler` 管理所有任务，桌面/手机不各自 setTimeout。
- 创建使用 requestId 持久幂等；相同 requestId 不同内容拒绝。编辑/取消携带 expectedRevision，冲突返回 409/对应 IPC 错误。
- 创建响应在任务写盘成功后返回；按队列串行提交状态变化，成功持久化后才发布新 revision 和执行外部副作用。
- 启动路径写 `starting + runId` 后再创建 PTY；异步任一阶段都复查该 run 未取消。取消发生在创建过程中，新获得的 PTY 也应立即停止并不再投递。
- 使用短周期 tick（建议 1 秒）与事件唤醒统一评估，长远时间不使用超长 setTimeout。睡眠后唤醒按当前墙钟重新检查。
- pending 时间已过，重启后补执行一次；时间条件满足但前置未完成继续等待。时钟回拨则等到 notBefore，时区改变不改变已保存执行瞬间。
- starting/running 在主进程重启后转 needs_attention，不重放命令；PTY 外部副作用与文件写盘无法保证跨崩溃 exactly-once。
- completed 保留完成凭据，未启动后继正常恢复；completed 写盘前崩溃则需确认，不猜测成功。
- 原子写临时文件后 rename，文件权限 0600。写盘失败停止新的启动/输入副作用，返回可见错误；配置损坏保留原文件并提示，不覆盖为空列表。
- 收到静止事件但结算写盘失败时不放行后继；保留待持久化状态，恢复写入后才发布。
- 应用退出先停止调度、保存待确认状态，再终止服务；退出提示包括等待任务数。关闭窗口但主进程尚在时继续调度；完全退出和系统关机不运行。
- 多实例必须确认现有应用单实例行为；如可多开，任务存储增加单写者锁，锁失败实例只读队列。不能靠进程内 Map 保证跨实例不重复。

## 7. 接口与模块落点

| 模块 | 责任与改动 |
| --- | --- |
| 新增 `src/main/terminal-activity-tracker.ts` | 内容 revision、静止计时、generation、主进程活动事件 |
| `src/main/terminal-state.ts`、`pty-manager.ts` | 有序内容变化、输入投递生命周期、退出码与取消原因；保持原 submit 去重合同 |
| 新增 `terminal-task-store.ts` | schema 校验、原子持久化、requestId/revision |
| 新增 `terminal-task-scheduler.ts` | 时间 AND 依赖、取消竞态、恢复、启动 adapter |
| 新增 `terminal-task-types.ts` | 数据与错误合同；根据三个 tsconfig 的 rootDir 选择类型导入方式，不为本功能重构整个工程 |
| `src/main/index.ts` | 初始化/停机、IPC、活动订阅、任务会话创建；收拢普通与任务创建共同的必要逻辑 |
| `src/preload/index.ts` | 白名单 API 和任务/活动事件，支持取消订阅 |
| `src/main/remote-server.ts` | 在既有 `/api` 鉴权下接入相同 scheduler；不用 globals 再造一个调度器 |
| `src/renderer/app.ts/index.html/styles.css` | 计划表单、队列视图、主进程灯状态消费、活动观看上报、不抢焦点 |
| `mobile/client/app.js/index.html/style.css/sw.js` | 同合同表单和队列，断线重同步、PWA 资源版本 |
| `auto-continue-manager.ts` | 仅增加任务运行中的输入互斥校验，保留旧功能 |

新 IPC：`tasks:list/create/update/cancel/confirm-complete`、`tasks:confirm-ready`、`tasks:changed`、`session:activity-changed`。输入均做 main 侧运行时验证，不仅依赖 TS 类型。

HTTP：`GET/POST /api/tasks`、`PATCH /api/tasks/:id`、`POST /api/tasks/:id/cancel`、`POST /api/tasks/:id/confirm-complete`、`POST /api/tasks/:id/confirm-ready`。原 `/api/sessions` 与 `pty:create` 保持兼容。

变更事件携带 storeRevision/taskRevision；首次载入与重连拉取快照，客户端丢弃旧 revision。任务先完成、列表后拉取也能得到完整结果；不能靠一次性的前端事件保留任务事实。

错误码至少：INVALID_INPUT、INVALID_TIME、DEPENDENCY_NOT_FOUND、DEPENDENCY_CYCLE、REVISION_CONFLICT、PRESET_UNAVAILABLE、CWD_UNAVAILABLE、STORE_WRITE_FAILED、LAUNCH_FAILED、DELIVERY_UNKNOWN、SESSION_LOST、READY_TIMEOUT。

## 8. 开发计划与阶段退出条件

P1→P5 已完成代码与自动化验证；P6 的真实 Electron/真实 CLI 现场验收仍需在运行应用中执行。

| 阶段 | 具体工作 | 退出条件 |
| --- | --- | --- |
| P1 活动逻辑 | 提取 main tracker；修复纯控制序列重置、提示符提前停止；统一桌面/手机灯；保留未读展示 | 假时钟与真实解析 fixture 覆盖 10 秒边界、分片控制码、重绘、新行；renderer 不存在仍产生停止事件 |
| P2 任务存储与依赖 | types/store、输入验证、DAG 单前置校验、请求幂等、revision、错误传播 | 创建/编辑/取消/损坏文件/写盘失败/循环依赖测试通过 |
| P3 调度和执行 | AND 条件、runId、PTY 创建就绪/正文投递、普通终端依赖、恢复和停止 | 假 PTY 验证 A→B→C、取消竞态、静止事件去重、崩溃不重放；明确支持的 ready adapter |
| P4 桌面完整闭环 | 新建表单、队列、等待原因、查看/修改/取消/确认，后台启动不抢焦点 | 桌面 E2E 完成定时链与失败修正；保存截图；原普通新建与滚动/输入回归通过 |
| P5 手机与同步 | 鉴权 HTTP、两端事件/快照、手机表单、断线和版本更新 | 两端并发修改冲突可见，刷新不重复创建，旧客户端普通新建不受影响 |
| P6 集成与交付 | unit/build/E2E、真实 Electron 与 CLI、退出/重启/睡眠试验、文档 | 按下面矩阵分别报告自动化、真实 CLI、桌面、手机、安装包证据，不以 build 通过代替实机通过 |

P1 的内容变化提取和 P3 的 CLI 就绪识别是主要工作量与风险。开始实施时先验证两项，不能等到 UI 做完才发现任务无法可靠投递。

## 9. 验收矩阵

| 编号 | 场景 | 预期 |
| --- | --- | --- |
| A01 | 普通立即创建空终端/预设 CLI | 与原行为一致 |
| A02 | 定时任务未到时间 | 没有创建 PTY、没有正文写入 |
| A03 | 到时，多次 tick/事件并发 | 仅一个 run/PTY/正文投递 |
| A04 | 同时设置时间与前置 | 两条件全满足才启动 |
| A05 | A→B→C，每项正文执行后静止 | 顺序自动启动，前项终端保留 |
| A06 | 无人查看，前项变黄 | 按静止语义完成，队列不卡在黄灯 |
| A07 | 初始灰色、欢迎信息、旧灰色快照 | 不产生本轮完成 |
| A08 | 当前运行普通终端被设为前置 | 绑定当前 generation，停止只放行一次 |
| A09 | 已灰的普通终端被选为前置 | 明确等待下一轮，不立即放行 |
| A10 | 最后有效内容后 9999/10000ms，中途又有新内容 | 阈值前不完成，到阈值才完成；新内容重新开始 10 秒计时 |
| A11 | 提示符字符出现在正文里 | 不提前绕过静止时间 |
| A12 | 忙碌期间持续光标/颜色控制码 | 不推迟 lastContentAt |
| A13 | 分片 OSC、相同画面重绘、resize | 不伪造内容活动；真实新输出不丢 |
| A14 | 相同文本连续新增滚动行 | 当作新内容，持续延后完成 |
| A15 | 指令送达后无输出，如 sleep | 达到 quietMs 即完成，明确符合静止规则 |
| A16 | CLI 仍启动/等待就绪确认 | 不发送正文，不自动完成 |
| A17 | submit 抛错且可能已写正文 | 待确认，不自动重发、不放行 |
| A18 | 前置失败/取消/未完成就关闭 | 后继受阻，显示具体原因 |
| A19 | 取消与启动/静止回调交错 | 旧 run 回调不创建、输入或放行新任务 |
| A20 | 完成后重复输出、黄转灰、重复事件 | 不重复启动后继 |
| A21 | 创建/编辑制造自依赖或间接环 | 服务端拒绝且不写坏原队列 |
| A22 | 双击/HTTP 重试/两端同 revision 修改 | 创建幂等；编辑一方成功另一方冲突 |
| A23 | 重启，pending 已过时间 | 自动补启动一次 |
| A24 | 重启，starting/running 残留 | 待确认，不重放外部副作用 |
| A25 | 存储满、权限错误、文件损坏 | 可见失败，不先执行再假装保存成功 |
| A26 | renderer 销毁、手机离线 | main 继续调度，重新连接恢复同一状态 |
| A27 | 主进程退出/系统睡眠 | 退出不执行；重启与唤醒遵循恢复合同 |
| A28 | 后台任务自动创建 | 不抢焦点、不切走终端、不丢草稿或滚动位置 |
| A29 | 启用旧循环发送与计划运行冲突 | 清楚拒绝冲突，旧循环独立使用仍正常 |
| A30 | token/env/指令内特殊字符、多行正文 | 配置不泄漏；正文通过 submit 原样投递，不拼接进 shell 启动命令 |

建议新增 `tests/terminal-activity-tracker.test.mjs`、`terminal-task-store.test.mjs`、`terminal-task-scheduler.test.mjs`、`tests/e2e/terminal-task-queue.e2e.mjs`。用注入时钟覆盖时间边界，不靠真实 sleep 堆慢测试；真实 CLI 验证另列。

实施后执行：`npm run build:ts`、`npm run test:unit`、新队列 E2E，以及涉及创建/输入/滚动的既有 E2E；最终运行 `npm run test:e2e`。截图和日志放独立验收目录，标注代码版本与实际运行产物。

## 10. 本轮交付边界

已实施主进程活动跟踪、任务存储与调度、时间和单前置依赖、重启恢复、桌面 IPC、手机 HTTP/SSE、两端创建与队列界面、修改/取消/确认完成，以及循环发送冲突保护。黄色和灰色共用同一停止事实，普通终端与计划任务默认均为连续 10 秒无有效输出后停止。

验证已完成：`npm run build:ts`、`npm run test:unit`（303/303）和 `npm run test:e2e` 全部通过；手机主场景 105/105、桌面复制 8/8、远程终端 20/20、历史恢复 12/12、历史回归 10/10、连续滚动 13/13 均通过。本轮未重启用户正在运行的 Electron、未创建真实 CLI 计划任务、未打包发布，因此真实 CLI 冷启动与安装包行为仍是明确的现场验收边界。
