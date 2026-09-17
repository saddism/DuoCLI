# Mac 远程桌面控制系统 - 快速启动与调试指南

## 🚀 5 分钟快速启动

### 第一步：启动服务 (Mac)

```bash
cd ~/Documents/myDev/DuoCLI
npm start
```

**预期输出**:
```
[patch-xterm] @xterm/xterm 5.5.0 IME 补丁就绪
dist/renderer/app.js  749.7kb
⚡ Done in XXms
(等待 Electron 窗口打开)
```

### 第二步：验证环境准备

确保 Mac 已满足以下条件：

1. ✅ **Screen Sharing 已启用**
   ```
   System Settings → Sharing → Screen Sharing → ON
   ```

2. ✅ **端口 5900 可访问**
   ```bash
   # Check if port is listening
   lsof -i :5900
   
   # Should show output like:
   # sshd  1234  user  3u  TCP  *:5900  LISTEN
   ```

3. ✅ **防火墙设置允许连接**
   ```
   System Settings → Network → Firewall → Allow incoming connections on port 5900
   ```

### 第三步：手机访问（局域网模式）

1. 确定 Mac 本地 IP:
   ```bash
   ipconfig getifaddr en0  # WiFi adapter
   # OR
   ipconfig getifaddr en1  # Ethernet adapter
   ```

2. 手机浏览器访问：
   ```
   http://<MAC_IP>:port/mobile/client/index.html
   ```
   
   **示例**: `http://192.168.1.100:3000/mobile/client/index.html`

### 第四步：建立连接

1. 点击「这台 Mac」卡片
2. 点击「连接」按钮
3. 观察状态变化：
   - 正在连接...
   - 正在进行 Mac 认证
   - ✅ 已连接

**成功标志**: Canvas 中出现 Mac 桌面画面

---

## 🔧 常见问题排查

### T01: Canvas 黑屏但 WebSocket 连接成功

**症状**: 
- 控制台显示 "✅ VNC connected"
- Canvas 元素存在但内容为黑色/灰色

**诊断步骤**:
```javascript
// In browser console:
const canvas = document.querySelector('canvas.rfb');
console.log('Canvas dimensions:', canvas.width, canvas.height);
console.log('RFB state:', window.macDesktopClient.rfb._rfbConnectionState);
console.log('Display available:', !!window.macDesktopClient.rfb.display);
```

**可能原因 & 解决方案**:

| 原因 | 检查方法 | 解决 |
|------|---------|------|
| macOS 未解锁 | Mac 是否锁屏？ | 解锁屏幕后重试 |
| 无活动显示器 | 运行 `system_profiler SPDisplaysDataType` | 连接主显示器 |
| Session timeout | 超过 30 秒未连接完成 | 重新获取 ticket |
| Display permissions | System Settings → Privacy → Screen Recording | 授予 DuoCLI 权限 |

---

### T02: 中文输入完全无效

**症状**:
- ASCII 字符正常输入
- 拼音 "ni hao" 或中文 "你好" 不出现

**诊断**:
```javascript
// Check clipboard extension support:
const rfb = window.macDesktopClient.rfb;
console.log('Clipboard caps:', rfb._clipboardServerCapabilitiesActions);

// Test extended clipboard manually:
rfb.clipboardPasteFrom('Test Chinese: 你好世界');
```

**可能原因**:
1. macOS Screen Sharing 不支持 RFB Clipboard Extension
2. noVNC client-server capability mismatch

**临时方案**:
```javascript
// Fallback to character-by-character simulation
window.MacDesktopKeyboard.sendText('Hello World');
// Uses keydown/keyup events for each char
```

**长期方案**: Implement Electron IPC physical keystroke forwarding (see docs备选路线)

---

### T03: 触摸响应延迟高

**症状**:
- 手指滑动后光标延迟 1-2 秒才移动
- 视频帧率低于 15fps

**诊断**:
```javascript
// Performance monitoring:
new PerformanceObserver(list => {
  list.getEntries().forEach(entry => {
    console.log(`Frame duration: ${entry.duration.toFixed(2)}ms`);
  });
}).observe({ entryTypes: ['paint'] });

// Network quality:
navigator.connection.effectiveType // 4G/3G/2g
```

**优化建议**:

| 场景 | 调整策略 |
|------|---------|
| LAN (< 50ms latency) | Enable high-quality JPEG encoding |
| WAN (Cloudflare Tunnel) | Use low-framerate mode (15fps) |
| Weak cellular | Enable progressive JPEG + lower resolution |

---

### T04: 虚拟键盘无法弹出

**症状**:
- 点击「键盘」按钮无反应
- 控制台报错 "Cannot read property 'appendChild'"

**诊断**:
```javascript
console.log('Container exists?', !!document.getElementById('mac-desktop-container'));
console.log('Toolbar exists?', !!window.macDesktopClient.$toolbar);
```

**可能原因**:
1. `$container` DOM 元素未初始化
2. Keyboard UI creation blocked by exception

**修复**:
```javascript
// Manual recreation:
window.macDesktopClient.createKeyboard();
```

---

## 📊 性能基准测试模板

### 测试配置记录

**Date**: __________  
**Mac Model**: __________  
**macOS Version**: __________  
**Network**: ☐ LAN ☐ WAN (Cloudflare)  
**Phone**: iPhone ______ / Android ______  

### 测试结果表

| Metric | Target | Actual | Status |
|--------|--------|--------|--------|
| Connection time | < 5s | ___ s | ☐ Pass ☐ Fail |
| First frame render | < 3s | ___ s | ☐ Pass ☐ Fail |
| Touch response delay | < 100ms | ___ ms | ☐ Pass ☐ Fail |
| Video frame rate | ≥ 24fps | ___ fps | ☐ Pass ☐ Fail |
| Bandwidth usage | ≤ 1MB/s | ___ MB/s | ☐ Pass ☐ Fail |

### 手动测试项目

#### A. Basic Navigation
- [ ] Open Finder window
- [ ] Drag window around screen
- [ ] Double-click file icon
- [ ] Right-click context menu appears

#### B. Text Input
- [ ] Type "Hello World" in Safari address bar
- [ ] Select all text with ⌘A
- [ ] Copy with ⌘C
- [ ] Paste into TextEdit with ⌘V
- [ ] Undo changes with ⌘Z

#### C. Keyboard Shortcuts
- [ ] ⌘C (Copy)
- [ ] ⌘V (Paste)
- [ ] ⌘A (Select All)
- [ ] ⌘T (New Tab)
- [ ] ⌘W (Close Tab)
- [ ] ⌘Q (Quit App)
- [ ] Escape (Cancel dialog)

#### D. Gestures
- [ ] Single finger drag moves cursor smoothly
- [ ] Two-finger pinch scrolls page content
- [ ] Toggle drag mode works correctly
- [ ] Right-click button opens context menu
- [ ] View mode zooms and pans canvas

---

## 🔍 高级调试技巧

### Chrome DevTools Panel Setup

1. **Open DevTools on Mac (development only)**:
   ```
   Chrome Menu → More Tools → Remote Debugging
   Or access via: chrome://inspect/#devices
   ```

2. **Enable Console Logging Levels**:
   ```javascript
   // Set global log level
   console.level = 'debug'; // or 'info', 'warn', 'error'
   
   // Filter logs
   const filter = new ConsoleAPIModule('MacDesktop.*');
   ```

3. **Monitor WebSocket Activity**:
   ```javascript
   // Add network event listener
   window.addEventListener('message', (event) => {
     if (event.data?.type === 'wss-message') {
       console.log('WS Traffic:', { direction: 'inbound', size: event.data.size });
     }
   });
   ```

### Memory Leak Detection

**Check for stale timers**:
```javascript
// In Production app, run this periodically:
function checkForLeaks() {
  const activeTimers = Object.keys(setInterval).length;
  console.log('Active intervals:', activeTimers);
  
  if (activeTimers > 1) {
    console.warn('Possible memory leak detected!');
  }
}

// Call after reconnection:
setInterval(checkForLeaks, 5000);
```

**Inspect RFB object lifecycle**:
```javascript
// Track RFB instance references
const instances = [];
const OriginalRFB = RFB;
RFB = function(...args) {
  const instance = new OriginalRFB(...args);
  instances.push(instance);
  return instance;
};
```

### Network Packet Analysis

**Capture raw traffic**:
```javascript
// Monkey-patch Websocket to log data
const OriginalWebSocket = window.WebSocket;
window.WebSocket = class extends OriginalWebSocket {
  send(data) {
    console.log('[WS Out]', { size: data.byteLength, type: data.constructor.name });
    return super.send(data);
  }
  
  addEventListener(event, handler) {
    if (event === 'message') {
      this.addEventListener(event, (e) => {
        console.log('[WS In]', { size: e.data?.byteLength || 0 });
        handler(e);
      });
    } else {
      super.addEventListener(event, handler);
    }
  }
};
```

**Protocol debug mode**:
```bash
# On Mac terminal, enable verbose logging:
defaults write com.apple.screenshare DebugMode -bool true
```

---

## 📱 Mobile-Specific Testing Tips

### iPhone Safari Considerations

1. **Retina Display Scaling**:
   - CSS transforms may not scale as expected
   - Verify `clientWidth/clientHeight` matches visual display
   
2. **Touch Event Precision**:
   - iOS may interpret taps as gestures differently
   - Test both single-tap and double-tap scenarios
   
3. **Safari Autocomplete**:
   - Disable autocomplete for input fields
   - Prevent URL bar from interfering

### Android Chrome Considerations

1. **Chrome Custom Tabs**:
   - May have different security policies
   - Test full-screen vs embedded modes
   
2. **Hardware Acceleration**:
   - Some devices disable GPU rendering
   - Fall back to software-based animations if needed

---

## 🛠️ 故障排除命令参考

### Server-side checks (Mac Terminal)

```bash
# Check Screen Sharing status
networksetup -listuserservices

# Verify port availability
lsof -i :5900

# Check firewall rules
pfctl -v -s info

# Restart screen sharing service
sudo killall ScreenSharing.app

# Monitor connection attempts
tail -f /var/log/system.log | grep -i "screen\|vnc"
```

### Client-side checks (Browser Console)

```javascript
// Get current state
window.macDesktopClient.state

// Inspect RFB internals
window.macDesktopClient.rfb._rfbConnectionState
window.macDesktopClient.rfb.display.width × height

// Force reconnect
await window.macDesktopClient.resume(window.macDesktopClient._lastTicket);

// Clear session storage
localStorage.removeItem('duocli_token');
sessionStorage.clear();
```

---

## 📞 获取帮助

### Documentation Resources

1. **Spec Reference**: `docs/mac-remote-desktop-spec.md`
2. **Implementation Guide**: `docs/mac-desktop-implementation-report.md`
3. **Test Plan**: `docs/mac-desktop-test-plan.md`
4. **Enhancement Summary**: `docs/mac-desktop-enhancements-summary.md`

### Common Error Codes

| Code | Message | Action |
|------|---------|--------|
| SERVICE_DISABLED | Service disabled | Enable Screen Sharing in System Settings |
| SERVICE_BUSY | Another connection in use | Wait or disconnect other session |
| UNSUPPORTED_DISPLAY | Unsupported display config | Use single monitor setup |
| INVALID_TICKET | Authentication failed | Re-authenticate from mobile page |
| ORIGIN_NOT_ALLOWED | Access denied | Use localhost or trusted domain |

---

**这份指南由 @Qoder AI Assistant 创建**  
**版本**: 1.4.0  
**最后更新**: 2026-09-15  
**适用平台**: macOS, iOS, Android
