# Mac 远程桌面控制系统 - 验收测试清单

## 测试环境准备

### 前置条件
- [ ] Mac 电脑运行 DuoCLI (macOS 12.0+)
- [ ] macOS Screen Sharing 已启用（系统设置 → 共享 → 屏幕共享）
- [ ] iPhone 或 Android 设备与 Mac 在同一网络
- [ ] Chrome/Safari/Edge 浏览器（支持 ES Modules）

### 启动步骤
```bash
cd ~/Documents/myDev/DuoCLI
npm start
```

---

## P0 功能验收测试

### T01: 基础连接测试
**预期**: 能成功建立 VNC 连接并显示 Mac 桌面

| 步骤 | 操作 | 预期结果 | 实际结果 |
|------|------|----------|---------|
| 1 | 手机浏览器访问页面 | 看到「这台 Mac」卡片 | |
| 2 | 点击卡片 → 连接 | 状态：正在连接 → Mac 认证 | |
| 3 | 等待 30 秒内 | Canvas 出现桌面画面 | |
| 4 | 检查控制台日志 | ✅ VNC connected, Resize 事件 | |

**通过标准**: Canvas 中显示 Mac 当前登录用户的桌面画面

**失败排查**:
- 检查 `lsof -i :5900` 是否有输出
- 确认防火墙未阻止端口 5900
- 验证 Ticket 未过期（30 秒内完成）

---

### T02: 鼠标输入测试
**预期**: 移动端手势映射到远端鼠标移动和点击

| 模式 | 手势动作 | 预期行为 | 测试项 |
|------|---------|---------|-------|
| Trackpad | 单指滑动 | 远端光标跟随 | ☐ |
| Trackpad | 轻点 | 左键单击 | ☐ |
| Trackpad | 双击 | 左键双击 | ☐ |
| Drag | 开启拖拽→按住移动 | 拖动窗口 | ☐ |
| Right-click | 右键按钮后点击 | 弹出上下文菜单 | ☐ |

**工具**: 打开 Finder 窗口，尝试拖动窗口边缘、双击文件

---

### T03: 滚动测试
**预期**: 双指捏合/滑动实现页面滚动

| 场景 | 手势 | 预期行为 | 测试项 |
|------|------|---------|-------|
| Web 页面 | 双指向上滑动 | 页面滚动向下 | ☐ |
| Text 内容 | 双指向下滑动 | 页面滚动向上 | ☐ |
| Finder | 双指滑动 | 文件夹列表滚动 | ☐ |

**注意**: 依赖 noVNC gestures extension，如果无效需查看 console 错误

---

### T04: 虚拟键盘 ASCII 输入测试
**预期**: 文本框输入可发送到远端应用

| 步骤 | 操作 | 预期结果 | 测试项 |
|------|------|---------|-------|
| 1 | 点击「键盘」按钮 | 键盘面板从底部滑出 | ☐ |
| 2 | 在输入框输入 "Hello World" | 光标正常移动 | ☐ |
| 3 | 点击「发送」按钮 | 浏览器地址栏应显示 Hello World | ☐ |
| 4 | 按 Enter 键发送 | 同上效果 | ☐ |

**测试应用**: Safari 地址栏、Finder 搜索框、TextEdit

**失败可能性**: 
- 中文 IME 不支持（需单独测试 T05）
- Extended clipboard paste 未被服务端识别

---

### T05: Chinese IME 输入测试 ⚠️ 关键测试
**预期**: 中文文字可通过虚拟键盘输入

| 测试场景 | 输入内容 | 预期结果 | 实际结果 |
|---------|---------|---------|---------|
| 拼音输入 | "ni hao" → 候选词选择 | 出现中文候选 | ☐ |
| 直接发送 | "你好世界" | 中文显示在目标应用 | ☐ |
| Emoji | "😀🎉" | Emoji 正确渲染 | ☐ |

**测试应用**: 
- TextEdit (新建空白文档)
- Messages (发送给自测号码)
- Safari 地址栏（部分支持 Emoji）

**降级方案**:
- 如果实时键盘不可用，考虑 Electron IPC 转发物理按键
- 或使用剪贴板同步作为临时方案

---

### T06: 快捷键组合测试
**预期**: ⌘+X 组合键模拟成功

| 快捷键 | 预期用途 | 测试方法 | 结果 |
|--------|---------|---------|------|
| ⌘C | 复制 | 选中文字→复制→粘贴验证 | ☐ |
| ⌘V | 粘贴 | 准备剪贴板→粘贴验证 | ☐ |
| ⌘A | 全选 | Finder 中全选文件 | ☐ |
| ⌘Z | 撤销 | TextEdit 中输入→撤销 | ☐ |
| ⌘T | 新标签 | Safari 打开新标签页 | ☐ |
| ⌘W | 关闭窗口 | Safari 关闭当前标签 | ☐ |
| ⌘Q | 退出应用 | 询问是否退出 Safari | ☐ |
| Tab | 切换焦点 | Finder 文件名↔搜索框 | ☐ |
| ESC | 取消操作 | 弹窗按 ESC 关闭 | ☐ |

**关键**: 这些快捷键应该直接映射到 macOS，不是浏览器快捷键

---

### T07: 视图模式测试
**预期**: 放大/缩放不影响输入准确性

| 步骤 | 操作 | 预期行为 | 结果 |
|------|------|---------|------|
| 1 | 点击「查看」按钮 | 进入缩放模式 | ☐ |
| 2 | 拖动 canvas 平移 | 画面随手指移动 | ☐ |
| 3 | 双指捏合缩放 | Canvas 缩放 | ☐ |
| 4 | 点击「适应」按钮 | 恢复 100% 原始尺寸 | ☐ |
| 5 | 退出查看模式 | 恢复触控板操作 | ☐ |

---

### T08: 会话生命周期测试
**预期**: 连接状态管理正确

| 场景 | 操作 | 预期状态变化 | 结果 |
|------|------|-------------|------|
| Normal connect | 点击连接 | ready → connecting → active | ☐ |
| Force disconnect | 点击断开按钮 | active → disconnected | ☐ |
| Resume after disconnect | 再次连接 | disconnected → ready → active | ☐ |
| Ticket timeout | 超过 30 秒未连接 | 提示票据过期 | ☐ |
| Single session | 已有连接时再建 | 返回 SERVICE_BUSY | ☐ |

---

### T09: Origin Security 测试
**预期**: 仅允许信任来源访问

| 测试方式 | 预期结果 | 结果 |
|---------|---------|------|
| localhost 访问 | ✅ 允许 | ☐ |
| 同一域名 HTTPS | ✅ 允许 | ☐ |
| 第三方域 iframe | ❌ 拒绝 | ☐ |
| IP 地址访问 | ⚠️ 取决于配置 | ☐ |

---

### T10: 跨网路穿透测试（可选）
**预期**: Cloudflare Tunnel 公网访问可用

| 条件 | 操作步骤 | 预期结果 | 结果 |
|------|---------|---------|------|
| LAN | 同 WiFi 手机访问 | 延迟 < 50ms | ☐ |
| WAN (Cloudflare) | 使用手机蜂窝网络 | 延迟 < 200ms | ☐ |
| 弱网 | 网络限制测试 | 视频流畅度可接受 | ☐ |

---

## 失败场景处理指南

### F01: Canvas 黑屏但 WebSocket 连接成功
**原因**: VNC 协议握手失败或无权限  
**解决**: 
1. 检查 macOS Screen Sharing 是否启用
2. 确认没有锁屏（解锁屏幕后重试）
3. 查看 Console 错误：`securityfailure` vs `failed`

### F02: 视频正常但键盘无响应
**原因**: RFB Keyboard Extension 未激活  
**解决**: 
1. 使用 Extended Clipboard Paste 替代
2. 临时用 Electron IPC 转发（方案 B）
3. 记录具体字符类型（ASCII OK，Chinese fail）

### F03: 多显示器适配问题
**原因**: 当前版本仅支持单显示器  
**表现**: 副屏无法访问  
**缓解**: 
1. 将主显示器设置为唯一显示器
2. 或使用 `system_profiler SPDisplaysDataType` 检测

### F04: Retina 缩放坐标偏移
**原因**: CSS transform 与 RFB absolute 坐标不匹配  
**解决**: 
1. 检查 `updateViewport()` 中的 clip region 计算
2. 验证 `scale` 和 `offset` 是否正确应用

---

## 性能指标基准

| 指标 | 优秀 | 合格 | 不合格 |
|------|------|------|--------|
| 首帧时间 | < 2s | < 5s | > 10s |
| 操作延迟 | < 100ms | < 300ms | > 500ms |
| 视频刷新率 | ≥ 24fps | ≥ 15fps | < 10fps |
| 带宽占用 | ≤ 1Mbps | ≤ 3Mbps | > 5Mbps |

**测量方法**:
```javascript
// Browser Console
performance.now() - startTime; // 从连接到首帧
new PerformanceObserver(list => list.getEntries()).observe(); // FPS monitoring
navigator.connection.downlink; // Network estimation
```

---

## 兼容性矩阵

| 平台 | 浏览器 | 状态 | 备注 |
|------|--------|------|------|
| iOS Safari 15+ | ✅ | 主要验收端 | Retina 缩放需注意 |
| Android Chrome 80+ | ✅ | 次要验收端 | Gesture API 可能差异 |
| macOS Safari 15+ | ⏸️ | 开发调试 | 不建议真机测试本机 |
| Windows Chrome | ⚠️ | 需要测试 | 非目标平台但应工作 |

---

## 已知限制（需在报告中标注）

1. **中文 IME 真实输入法未实测**
   - 当前方案：Extended Clipboard Paste
   - 风险：部分字符可能被转义或过滤
   
2. **多显示器仅支持主屏**
   - Spec 明确标注为 P0 边界
   - 建议在 UI 中提示「当前仅支持单显示器配置」

3. **手势控制需额外开发**
   - 当前依赖 noVNC 原生手势
   - 如需自定义（如右击），需添加 UI 按钮

4. **音频不传输**
   - Spec 第 3.2 节明确排除
   - 如需支持，需实施备选方案（Electron + WebRTC）

---

## 测试报告模板

**测试日期**: __________  
**测试者**: __________  
**Mac 型号**: __________  
**macOS 版本**: __________  
**DuoCLI 版本**: v1.4.0  

**测试结果汇总**:
- [ ] 所有 T01-T10 通过
- [ ] 部分通过（见下方说明）
- [ ] 失败（需修复后重测）

**关键问题记录**:
```
问题描述:
复现步骤:
控制台日志:
影响范围:
```

**改进建议**:
```

```

**下一步计划**:
- [ ] Fix critical issues
- [ ] Add Chinese IME support
- [ ] Implement multi-monitor handling
- [ ] Performance optimization
- [ ] Production deployment

---

## 自动化测试脚本（未来规划）

```javascript
// tests/mac-desktop-e2e.mjs
import puppeteer from 'puppeteer-core';

async function testConnection() {
  const browser = await puppeteer.launch({ /* ... */ });
  const page = await browser.newPage();
  
  // Test connection flow
  await page.goto('/mobile/client/index.html');
  await page.click('.mac-desktop-card');
  await page.click('.connect-btn');
  
  // Wait for VNC connection
  const connected = await page.waitForSelector('canvas.rfb', { timeout: 30000 });
  console.assert(connected, 'Failed to connect to VNC');
  
  // Test keyboard input
  await page.click('.keyboard-btn');
  await page.fill('.keyboard-input', 'Test Message');
  await page.click('.send-btn');
  
  // Verify text appeared in target window
  // TODO: Implement vision-based verification
  
  await browser.close();
}
```

---

**文档版本**: 1.0  
**最后更新**: 2026-09-15  
**维护者**: DuoCLI Team
