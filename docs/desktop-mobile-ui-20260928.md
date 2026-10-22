# 桌面与手机工作区界面优化 · 2026-09-28

## 参考与实现

参考本机已安装 Orca 的项目导航、中央工作区、文件检查栏和移动端紧凑工具栏，保留 DuoCLI 的深色终端与现有终端配色。

- 桌面：左侧项目/会话导航，中间终端，右侧目录树；支持两侧拖拽与收起。手机连接信息和关于信息收进可展开区域。
- 两端：统一中性深灰、细分隔线、低强调工具按钮和紫色主要操作；增加按会话标题、项目路径、CLI 名称搜索，包含已关闭会话。
- 手机：常驻“终端 / 对话 / 项目文件”入口，当前视图明确标记；统一输入框、附件、换行、发送与快捷命令样式。
- 手机空列表保留完整欢迎区域；320px 小屏不横向溢出，发送按钮与文件入口可见。
- 桌面目录异步刷新增加代次校验，避免多个刷新回调重复插入文件行。
- 修正侧栏位置交换后的拖拽方向、提示文字、收起后的边框残留，以及收起按钮覆盖会话操作的问题。
- 移动端 service worker 缓存版本更新为 v97。

## 验证

使用 Node 20。测试均基于当前源码；桌面完整页面通过 Electron IPC 测试替身运行，手机 HTTP/WebSocket 使用测试服务。截图里的会话与终端内容为测试数据。

| 检查 | 结果 |
| --- | --- |
| `npm run build:ts`、`npm run copy:html` | 通过 |
| `npm run test:unit` | 最终 347/347 通过 |
| `node tests/e2e/workspace-ui.e2e.mjs` | 7 组通过：结构、目录去重、搜索、拖拽、收起、弹窗、窄屏 |
| `node tests/e2e/mobile.e2e.mjs` | 133/133 通过 |
| `node tests/e2e/mobile-remote.e2e.mjs` | 28/28 通过 |
| `node tests/e2e/desktop-copy.e2e.mjs` | 10 组通过 |
| `node tests/e2e/desktop-scroll.e2e.mjs` | 27 组通过 |
| `node tests/e2e/desktop-sidebar-layout.e2e.mjs` | 通过：窄侧栏标题、500/900px 设置弹窗 |
| `git diff --check` | 通过 |

首轮单元测试为 346/347：`LAN probe races IPs in parallel` 在浏览器测试并行运行时超出原有 70ms 时间断言。停止并行负载后完整重跑 347/347；没有修改网络实现或放宽断言。保留两轮日志。

新增桌面工作区检查已纳入 `npm run test:e2e`，测试时即时打包 renderer，避免使用过期构建。

## 截图与边界

截图及本次日志：`tests/.artifacts/workspace-ui/`。

- `desktop-workspace.png`、`desktop-compact.png`、`desktop-new-session.png`
- `mobile-list.png`、`mobile-terminal.png`、`mobile-chat.png`、`mobile-small.png`、`mobile-chat-code.png`

已检查浏览器实际渲染和触控/输入自动化。没有重启正在运行的桌面应用，没有打安装包；安装版 Electron、目标手机及真实软键盘仍未实机验收。现有未提交工作保持原状，本次没有提交或推送。
