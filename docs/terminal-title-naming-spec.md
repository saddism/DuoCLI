# 终端会话「智能起名」重构 — 需求与实现交接文档

> 本文档面向**接手实现的工程师 / AI 模型**。你**没有**先前讨论的上下文,所需信息本文档已尽量自包含。请通读后再动手。
> 基线:DuoCLI 仓库当前 `main` 分支工作区(干净原版,无未提交改动)。文中行号以该基线为准,实现时请以实际代码复核。

---

## 0. 一句话目标

重写**终端会话**(非聊天会话)右侧列表标题的自动生成逻辑:**只用「用户在终端里逐字敲下、回车发送的内容」来起名,按段累加、覆盖式更新,到第 5 段封顶。** 绝不把 CLI 的终端输出 / AI 回复掺进起名材料。

---

## 1. 背景与架构

### 1.1 DuoCLI 是什么
DuoCLI 是一个 Electron 桌面应用,在内部用 `node-pty` 起真实终端,让用户在里面跑 `claude code` / `codex` / `gemini` 等 **TUI 命令行 AI 工具**。每个终端是一个「会话」,显示在右侧会话列表里,**每个会话有一个标题**,由 AI 自动生成("智能起名")。

> 注意:项目里还有另一套「聊天会话」(`chat-session-manager.ts`)及其起名逻辑。**本任务完全不涉及聊天会话,只改终端会话。**

### 1.2 用户输入的真实链路(关键事实)
终端会话用 **xterm.js**,用户直接在终端里击键,**没有独立的"输入框 + 发送按钮"**。链路如下:

```
用户击键(xterm)
  → src/renderer/terminal-manager.ts  term.onData(data) → window.duocli.writePty(id, data)
  → preload(ipcRenderer.send 'pty:write', ...)        // 通道名以代码为准
  → 主进程 ipcMain → PtyManager.write(id, data)        // ★ 改造主战场:src/main/pty-manager.ts:432
  → session.ptyProcess.write(data)                     // 原始字节转发给 CLI 进程
```

- `data` 是用户击键的**原始字节流**:可见字符(含中文 UTF-8)、回车 `\r`、退格 `\x7f`/`\b`、方向键/功能键的 ESC 序列(如 `\x1b[A`)、Ctrl 组合(0x00–0x1F)、以及粘贴内容。
- CLI(如 claude)在 raw mode 下**逐字节**读取;用户逐字打字时,`onData` 通常**一个字符触发一次**。
- CLI 会把渲染后的画面(含对你输入的回显)通过另一条输出流回传(`onData` 事件 / `onPtyData`),**那是终端输出,不是用户输入,起名绝不能用它。**

---

## 2. 需求规格

| 编号 | 需求 |
|------|------|
| **R1** | 仅作用于**终端会话**(`pty-manager.ts`)。聊天会话不动。 |
| **R2** | **「用户输入」的定义** = 用户在终端里**逐字敲下、并最终回车发送**给 CLI 的文本内容。方向键、Tab 补全、Ctrl 组合、历史调用(↑)、TUI 内部交互等**一律不算**用户输入。 |
| **R3** | 起名材料**只包含用户输入**(R2)。**严禁**掺入 CLI 的终端输出、AI 回复、ANSI 控制序列。 |
| **R4** | **累加 + 覆盖 + 封顶**:<br>· 用户发出第 1 段 → 用【段1】起名;<br>· 发出第 2 段 → 用【段1+段2】起名,**覆盖**旧标题;<br>· 第 3、4 段 → 依次用【1+2+3】【1+2+3+4】覆盖;<br>· 第 5 段 → 用【1+2+3+4+5】起名,**之后锁定,不再自动改名**。 |
| **R5** | 用户**手动改名**(已有功能)或后续**手动「重新生成标题」**(已有右键菜单)的行为要保持可用,不被本次改动破坏。 |
| **R6** | **不得影响**:命令转发(`ptyProcess.write`)、resume 捕获、自动切号、远程终端回放等任何现有功能(见 §6 约束)。 |

---

## 3. 现状代码分析(为什么现在不行)

### 3.1 现有的三处起名触发(全部要重做/移除)

**① buffer 输出量触发(主力,需移除)** — `pty-manager.ts` 约 388–401:
```ts
// 累积 CLI 输出到 buffer
session.buffer += stripped;
if (session.buffer.length > 8000) session.buffer = session.buffer.slice(-8000);
// buffer 超过 200 字符且未起名 → 1500ms 后触发起名
if (!session.titleGenerated && !session.titleLocked &&
    session.buffer.length > 200 && !session.summarizeScheduled) {
  session.summarizeScheduled = true;
  session.summarizeTimer = setTimeout(() => { ... triggerSummarize(id); }, 1500);
}
```
> ❌ 问题:**靠 CLI 输出量触发**。CLI 一吐字就起名,根本不等用户发送;且后续 `buildTitlePrompt` 直接用了这个 `buffer`(=终端输出),违反 R3。

**② 回车计数触发(需改造)** — `pty-manager.ts` 452–471(`write()` 内):
```ts
if (data === '\r') {
  session.commandCount++;
  if (!session.titleGenerated && !session.titleLocked && session.commandCount <= 3) {
    // 防抖 800ms 后 triggerSummarize
  }
}
```
> ⚠️ 方向对(回车触发),但:上限是 **3** 不是 5(违反 R4);且最终喂给 AI 的料仍掺了终端输出。

**③ 用户输入采集(根本缺陷,需替换)** — `pty-manager.ts` 439–450(`write()` 内):
```ts
// 检测粘贴输入：一次性写入多个字符
if (data.length > 5 && data !== '\r') {
  const cleaned = data.replace(/[\r\n]/g, ' ').trim();
  session.userInputs.push(cleaned);   // 只保留最近 20 条
}
```
> ❌ **致命缺陷**:判据是「单次 `data` 长度 > 5」。但用户**逐字打字时,每次 `data` 只有 1 个字符**,永远不满足 `> 5`。结果:**用户手打的 prompt 几乎完全没被采集**,`userInputs` 实际只抓到了「粘贴的大块」。这正是起名跑偏的根因之一——AI 根本没看到用户真正输入的内容。

### 3.2 起名材料的拼装(违反 R3) — `buildTitlePrompt()` 约 636–654:
```ts
private buildTitlePrompt(session: PtySession): string {
  const recentInputs = session.userInputs.slice(-10);
  if (recentInputs.length === 0) return '';
  const inputsText = recentInputs.join('\n');
  // ▼ 把终端输出也拼进 prompt —— 违反 R3
  const bufferText = stripTerminalControlSequences(session.buffer)
    .split('\n').map(l => l.trim()).filter(l => l.length > 0).slice(-30).join('\n');
  const prompt = `...用户输入：\n${inputsText}\n\n终端输出（最近）：\n${bufferText}\n\n...`;
  return prompt;
}
```

### 3.3 起名请求与落盘 — `triggerSummarize()` 约 599–634:
读 `buildTitlePrompt` → 调 `requestTitleFromConfiguredAI(config, prompt)` → `cleanGeneratedTitle()` → 非空且未锁定则 `session.title = title; titleGenerated = true;` → `onTitleUpdate` + 落盘 + 失败重试。**这套调用骨架可复用**,只需替换"料怎么来"。

### 3.4 底层起名接口(无需改动,直接复用) — `src/main/title-ai.ts`:
- `requestTitleFromConfiguredAI(config: TitleAIConfig, prompt: string): Promise<string>` — 按 `config.apiFormat`(anthropic / openai / gemini / ollama)分发请求。用户当前配置为 **GLM-4.6 / openai 格式**(`~/.duocli/config.json` 的 `titleAI`)。
- `cleanGeneratedTitle(title)` — 去首尾引号、去结尾标点。
- 各 provider 当前 `max_tokens: 64`,思考关闭。**这些保持现状即可**(本任务不涉及"开思考")。

### 3.5 相关数据结构 — `PtySession`(`pty-manager.ts:9–36`)
现有相关字段:`buffer`(CLI 输出,**仍被 resume/远程用,不可删**)、`rawBuffer`(远程回放用,不可删)、`userInputs: string[]`、`commandCount: number`、`title`、`titleLocked`、`titleGenerated`、`summarizeScheduled`、`summarizeTimer`。

---

## 4. 目标方案设计

### 4.1 核心思路
在用户输入的**唯一必经入口** `PtyManager.write(id, data)` 处,自己维护一个**「用户输入行缓冲」(模拟极简行编辑器)**:用户敲字就累积、退格就删尾、控制键/方向键忽略;**每检测到一次回车,就把"到目前为止累积的用户输入"作为起名材料,去生成/覆盖标题**,并把该次回车计为一"段";到**第 5 段封顶**。

> 关键洞察:**为了起名,不需要区分这次回车是"发送"还是"换行"**。无论哪种,敲进缓冲的字符**都是用户自己的输入**,料天然干净;每次回车就用"累积内容"重起名,正好实现 R4 的累加+覆盖+封顶。

### 4.2 「段」的定义与触发时机 —— 采用方案 X(见 §8 开放决策)
**方案 X(本文档采用):一个回车 = 一段。**
- 用户每按一次回车(`\r`),`titleSegmentCount++`,若 `≤ 5` 且未锁定 → 拿"累积用户输入"去起名(防抖,见 4.5)。
- 粘贴的内容靠"成块识别"整体纳入累积(其内部换行**不**各算一段,见 4.4)。
- 已知取舍:用户在 TUI 里**主动多行换行**(每行一个回车)时,会被各算一段,可能令"第 5 段封顶"提前到达。但标题内容始终是用户输入,不会跑偏,可接受。

### 4.3 输入行缓冲的维护规则(字节处理)
在 `write()` 里,对每个 `data` 分类处理(建议抽成一个纯函数便于单测):

| 输入字节/序列 | 处理 |
|---|---|
| 可打印字符(`>= 0x20`,含多字节 UTF-8 中文) | 追加到 `currentLine` 缓冲 |
| 退格 `0x7f`(DEL)或 `0x08`(BS) | 从 `currentLine` 删除最后一个字符(注意按「字符」而非「字节」删,处理 UTF-8) |
| 回车 `\r`(0x0D)/ 可能的 `\n` | **触发分段**:`currentLine` trim 后若非空,追加进 `accumulatedInputs`;然后清空 `currentLine`;再执行起名(4.4/4.5) |
| ESC 序列(以 `0x1b` / `\x1b` 开头,如 `\x1b[A` 方向键、功能键) | **整体忽略**,不计入缓冲(需识别并吞掉完整序列,避免残留 `[A` 之类) |
| 其它控制字符(`0x00–0x1F`,除回车) | 忽略(Ctrl 组合、Tab `0x09` 等) |
| 成块粘贴(见 4.4) | 整块按可见文本纳入 `currentLine`(去掉内部 `\r\n` 或转空格) |

> UTF-8 提示:中文等多字节字符在 `onData` 中可能整体或分片到达。累积时建议以 string 拼接(Node 的 string 已是 UTF-16),退格按 `Array.from(str)` 的字符单位删除,避免切坏多字节。

### 4.4 粘贴处理
两种识别方式,任选其一并在实现中标注(需实测 claude/codex/gemini 行为):
1. **括号粘贴模式(bracketed paste)**:若启用,粘贴内容会被 `\x1b[200~` … `\x1b[201~` 包裹。识别这对标记,把中间内容整体作为一段输入纳入(内部换行不分段)。
2. **退化判据**:单次 `data` 长度明显大于 1(例如 `> 1` 且包含多个可打印字符)视为粘贴块,整体纳入。
> 目的:避免"粘贴一段带换行的长文"被错误地拆成很多段、瞬间耗尽 5 段配额。

### 4.5 起名触发与防抖
- 每次回车分段后,若 `titleSegmentCount ≤ 5` 且 `!titleLocked`:用**累积用户输入**调用起名。
- **防抖**:建议合并 800–1200ms 内的多次回车(沿用现有 `summarizeTimer` 模式),避免用户连按回车时狂发 AI 请求。最后一次为准。
- 第 5 段完成并成功起名后:设 `titleGenerated = true`(或新增 `titleFinalized`),后续回车不再自动改名(直到用户手动「重新生成标题」重置)。

### 4.6 起名材料(prompt)的拼装 —— 改写 `buildTitlePrompt`
```ts
private buildTitlePrompt(session: PtySession): string {
  const inputs = session.accumulatedInputs;        // 只用累积的用户输入
  if (inputs.length === 0) return '';
  const inputsText = inputs.join('\n');
  // ❗只含用户输入，不含任何终端输出
  return `你是终端会话标题生成助手。下面是用户先后输入并发送给命令行工具的内容，` +
         `请理解用户想做什么，生成一个简洁的中文标题（不超过12个字，不要标点、不要引号、不要解释）。\n\n` +
         `用户输入：\n${inputsText}\n\n只返回标题本身。`;
}
```
> 调用 `requestTitleFromConfiguredAI` + `cleanGeneratedTitle` 的骨架沿用 `triggerSummarize`。

### 4.7 PtySession 需新增/调整的字段
```ts
// 新增
currentLine: string;            // 当前正在输入、尚未回车的行缓冲
accumulatedInputs: string[];    // 已发送的各段用户输入（累加，封顶5段）
titleSegmentCount: number;      // 已触发起名的段数（回车计数，用于第5段封顶）
inPaste?: boolean;              // 括号粘贴模式状态（若采用方式1）
// 复用/语义微调
titleLocked / titleGenerated / summarizeTimer / summarizeScheduled
// 移除依赖：不再用 userInputs(length>5) 采集、不再用 buffer 触发起名
```
> `commandCount`、`buffer`、`rawBuffer` 等字段**保留**(可能被其它功能使用);只是起名逻辑不再依赖 `buffer` 做触发与料源。

---

## 5. 需要移除 / 改造的旧逻辑清单
1. **移除** `write()` 中 439–450 的 `userInputs`(`data.length > 5`)采集——被新的行缓冲取代。(如 `onPasteInput` 事件被其它功能依赖,保留事件触发,仅替换采集方式。)
2. **移除** 388–401 的 `buffer > 200` 起名触发。(`buffer` 累积本身保留,供 resume/远程使用;仅删掉它触发 `triggerSummarize` 的部分。)
3. **改造** 452–471 的回车触发:`commandCount <= 3` → 新的 `titleSegmentCount <= 5`,并改为对接新的累积输入与起名。
4. **改写** `buildTitlePrompt`(§4.6)。
5. **校验** `triggerSummarize`:料源换成 `accumulatedInputs`,其余(请求、清洗、落盘、失败重试)保留。
6. **校验** `regenerateTitle`(手动重新生成,约 518–525):重置 `titleSegmentCount`/`titleGenerated`/`titleLocked` 后,用当前 `accumulatedInputs` 重起一次名。

---

## 6. 不可破坏的硬约束(务必遵守)
- **C1 命令转发不能断**:`write()` 末尾 `session.ptyProcess.write(data)` **必须对所有输入照常执行**。无论你怎么解析缓冲,都不能吞掉或改写真正发给 CLI 的字节。起名逻辑是"旁路观察",绝不能干扰转发。
- **C2 不动 `buffer` / `rawBuffer` 的既有用途**:它们被 resume 捕获(`captureResumeFromBuffer`)、远程终端回放等使用。可以不再用它们起名,但**不能删除其累积逻辑**。
- **C3 只碰起名**:不得影响自动切号(`switchAttempts`/`autoRetryCooldown`/rate limit 相关)、resume、`onExit`、`onData`/`onRawData` 事件等。
- **C4 不动聊天会话**(`chat-session-manager.ts`)与底层 `title-ai.ts`(除非确需,且需说明)。
- **C5 ESM 约定**:本项目 `"type": "module"`,import 路径用 `.js` 扩展名(TS ESM 约定);保持风格一致。
- **C6 编译须通过**:改完 `npx tsc -p tsconfig.main.json --noEmit` 必须 0 error。

---

## 7. 验收标准(实现完成后逐条自测)
1. **逐字输入被采集**:在 claude 会话里逐字敲「帮我写一个登录页面」并回车 → 生成的标题反映该内容(证明已抓到逐字输入,而非旧逻辑的漏抓)。
2. **累加覆盖**:再敲第 2 段「再加上记住密码」并回车 → 标题更新为综合【1+2】的名字,覆盖旧标题。
3. **第 5 段封顶**:发满 5 段后,第 6 段回车**不再**改名。
4. **控制键不污染**:输入中途按 ↑/↓/←/→、退格修改、Ctrl+C → 这些不进入起名材料;退格能正确删字。
5. **只含用户输入**:无论 CLI 输出多少内容,起名 prompt 里**不含任何终端输出**(可加日志验证 prompt 文本)。
6. **粘贴整块**:粘贴一段带换行的文字 → 作为整体纳入,不被拆成多段、不瞬间耗尽 5 段。
7. **回归**:命令正常转发执行;resume 捕获、自动切号、远程回放不受影响;手动改名 / 手动「重新生成标题」可用。
8. **编译**:`tsc` 0 error。

---

## 8. 开放决策点(实现前请与需求方确认)
- **D1「段」的定义(§4.2)**:本文档默认 **X(一回车一段)**。若需求方更想要 **Y**(回车后看 CLI 是否大量输出来判断"真发送"才算一段,更准但更复杂、依赖输出量推断)或 **Z**(不数段、改为"停止输入 N 秒后"重起名,但偏离"第5段封顶"原始设计),需改 4.2/4.5。
- **D2 防抖时长**(§4.5):默认 800–1200ms,可调。
- **D3 粘贴识别方式**(§4.4):优先 bracketed paste;能否生效取决于各 TUI 是否启用 DECSET 2004,**需在 claude/codex/gemini 实测**,否则退化用长度判据。
- **D4 封顶后语义**:第 5 段后是否允许用户手动「重新生成标题」再刷新(建议:允许,见 §5.6)。

---

## 9. 涉及文件清单
| 文件 | 作用 | 本次改动 |
|------|------|---------|
| `src/main/pty-manager.ts` | 终端会话核心、`write()` 入口、起名触发与拼料 | **主改动**:新增输入行缓冲、分段、改 `buildTitlePrompt`、清理旧触发 |
| `src/main/title-ai.ts` | 起名请求底层 | 复用,**不改**(除非 D 决策需要) |
| `src/renderer/terminal-manager.ts` | 前端 xterm → writePty | 仅参考链路,**不改** |
| `src/main/chat-session-manager.ts` | 聊天会话起名 | **不动** |

---

## 10. 给实现者的建议步骤
1. 先读 `pty-manager.ts` 的 `write()`(432)、`triggerSummarize`(~599)、`buildTitlePrompt`(~636)、`PtySession`(9–36),以及 388–401 的 buffer 触发。
2. 与需求方确认 §8 的 D1(段定义)。
3. 把"字节 → 行缓冲"的处理抽成纯函数(便于单测 §4.3 的表)。
4. 接入 `write()`:维护 `currentLine` / `accumulatedInputs` / `titleSegmentCount`,回车分段 + 防抖触发起名。
5. 改 `buildTitlePrompt` 只用 `accumulatedInputs`;清理旧触发(§5)。
6. 跑 §7 验收 + `tsc`。

— 完 —
