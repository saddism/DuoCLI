# Mac 远程桌面控制系统 - 架构参考手册

## 🏗️ 系统架构图

```
┌─────────────────────────────────────────────────────────────────────┐
│                         MOBILE DEVICE (Client)                       │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │                    Safari / Chrome Browser                   │   │
│  ├─────────────────────────────────────────────────────────────┤   │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐  │   │
│  │  │ mac-desktop- │  │ mac-desktop- │  │  mac-desktop-    │  │   │
│  │  │ index.html   │  │ client.js    │  │ keyboard.js      │  │   │
│  │  └──────────────┘  └──────────────┘  └──────────────────┘  │   │
│  │                                                             │   │
│  │  ┌──────────────────────────────────────────────────────┐  │   │
│  │  │              Virtual Keyboard UI                      │  │   │
│  │  │  [ESC] [⌘C ⌘V ⌘A ⌘Z] [Arrows] [F1-F4] [Send]        │  │   │
│  │  └──────────────────────────────────────────────────────┘  │   │
│  └─────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────┘
                              │ HTTPS/WSS
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│                     DUOCLI BACKEND (Electron)                        │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │                   remote-server.ts                          │   │
│  │  • HTTP Server                                              │   │
│  │  • WebSocket Server                                         │   │
│  └─────────────────────────────────────────────────────────────┘   │
│         │                               │                           │
│         ▼                               ▼                           │
│  ┌──────────────┐               ┌──────────────┐                   │
│  │ REST API     │               │ WS Bridge    │                   │
│  │ Routes       │               │ Handler      │                   │
│  │ • capabilities│              │ startVncBridge()│                 │
│  │ • sessions POST│             │ TCP Proxy    │                   │
│  │ • disconnect │              │ localhost:5900│                   │
│  └──────────────┘               └──────────────┘                   │
│                                       │                             │
└───────────────────────────────────────┼─────────────────────────────┘
                                        │ TCP
                                        ▼
┌─────────────────────────────────────────────────────────────────────┐
│                        macOS SYSTEM SERVICE                          │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │          Screen Sharing Service (VNC Server)                │   │
│  │  Port: 5900                                                 │   │
│  │  Protocol: RFB (Remote Frame Buffer)                        │   │
│  └─────────────────────────────────────────────────────────────┘   │
│                                     │                               │
│                                     ▼                               │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │           Current User Desktop Session                      │   │
│  │  • Primary display capture                                  │   │
│  │  • Input handling                                           │   │
│  │  • Audio (not transmitted in P0)                            │   │
│  └─────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 📡 API Reference

### REST Endpoints

#### GET `/api/mac-desktop/capabilities`
**Purpose**: Check service availability and status

**Request Headers**:
```
Authorization: Bearer <duocli_token>
Cache-Control: no-cache
```

**Success Response (200)**:
```json
{
  "success": true,
  "enabled": true,
  "serviceReachable": true,
  "busy": false,
  "displayCount": 1,
  "status": "ready",
  "reasonCode": null,
  "generation": 3
}
```

**Error Responses**:
| Status | Code | Description |
|--------|------|-------------|
| 403 | SERVICE_DISABLED | Screen Sharing not enabled |
| 403 | UNSUPPORTED_DISPLAY | Multi-monitor or locked state |
| 500 | INTERNAL_ERROR | Server exception |

**Implementation File**: `src/main/mac-desktop-routes.ts:74-91`

---

#### POST `/api/mac-desktop/sessions`
**Purpose**: Create new session with one-time ticket

**Request Headers**:
```
Authorization: Bearer <duocli_token>
Content-Type: application/json
Cache-Control: no-store
```

**Success Response (200)**:
```json
{
  "success": true,
  "sessionId": "a1b2c3d4e5f6...", // 32-char hex
  "ticket": "f7e8d9c0b1a2...",   // 64-char hex
  "expiresAt": 1726400000000      // Unix timestamp (ms)
}
```

**Field Descriptions**:
- `sessionId`: Unique identifier for this connection attempt
- `ticket`: One-time authentication token (single-use, expires in 30s)
- `expiresAt`: Ticket validity expiration time

**Error Responses**:
| Status | Code | Condition |
|--------|------|-----------|
| 403 | ORIGIN_NOT_ALLOWED | Rejected host header |
| 403 | SERVICE_DISABLED | Backend disabled |
| 403 | SERVICE_BUSY | Active session exists |
| 409 | SESSION_CREATE_FAILED | Invalid state |

**Implementation File**: `src/main/mac-desktop-routes.ts:102-193`

---

#### POST `/api/mac-desktop/sessions/:id/disconnect`
**Purpose**: Force termination of specified session

**URL Parameters**:
- `id`: Session ID from previous response

**Headers**: Same as session creation

**Response (200)**:
```json
{
  "success": true,
  "message": "Session disconnected"
}
```

**Note**: This endpoint is typically used by the mobile app to initiate clean disconnect before page unload.

**Implementation File**: `src/main/mac-desktop-routes.ts:200-256`

---

### WebSocket Interface

#### Upgrade Endpoint: `wss://host:port/mac-desktop-ws`

**Upgrade Request Format**:
```
GET /mac-desktop-ws?sessionId=<ID>&ticket=<TOKEN>
Host: hostname:port
Connection: Upgrade
Upgrade: websocket
Sec-WebSocket-Version: 13
Origin: https://trusted-origin.com
```

**Authentication Flow**:
1. Client obtains sessionId + ticket via POST `/sessions`
2. Client attempts WS upgrade with query parameters
3. Server validates ticket against session storage
4. If valid, establishes TCP bridge to localhost:5900
5. All subsequent messages are raw RFB protocol bytes

**Message Format**: 
- Bidirectional binary data packets
- Size varies from 16 bytes (heartbeat) to 65KB (frame update)
- No framing layer (raw TCP → WebSocket mapping)

**Close Codes**:
| Code | Meaning | Cause |
|------|---------|-------|
| 1000 | Normal close | Client disconnected gracefully |
| 4001 | Invalid credentials | Ticket mismatch on reconnect |
| 4002 | Session expired | TTL exceeded before completion |
| 1011 | Internal error | TCP/VNC handshake failure |

**Implementation File**: `src/main/mac-desktop-routes.ts:267-390`

---

## 🔄 Session Lifecycle State Machine

```
┌─────────────────────────────────────────────────────────────┐
│                     CLIENT-SIDE STATES                       │
└─────────────────────────────────────────────────────────────┘

          ┌─────────────┐
          │   DISABLED  │ ←─ Service not enabled on backend
          └──────┬──────┘
                 │ enable() triggered
                 ▼
          ┌──────────────┐
          │ SETUP-REQUIRED │ ←─ Screen sharing configured but VNC not ready
          └──────┬───────┘
                 │ port 5900 listening
                 ▼
          ┌──────────────┐
          │  UNAVAILABLE │ ←─ Locked screen or sleeping
          └──────┬───────┘
                 │ unlock & wake
                 ▼
          ┌──────────┐
          │ READY    │ ←─ Initial state, waiting for connect()
          └────┬─────┘
               │ connect() called
               ▼
          ┌────────────┐
          │ CONNECTING │
          └────┬───────┘
               │ session created
               ▼
          ┌─────────────┐
          │ AUTHENTICATING │ ←─ Sending credentials to VNC server
          └──────┬──────┘
                 │ credential accepted
                 ▼
          ┌──────────────┐
          │ ACTIVE       │ ←─ Connected, receiving frames, accepting input
          └──────┬───────┘
     ┌───────────┼───────────┐
     │ suspend() │ resume()  │ disconnect()
     ▼           ▼           ▼
┌────────────┐ ┌────────────┐ ┌──────────────┐
│ SUSPENDED  │ │ ACTIVE     │ │ DISCONNECTED │
└────────────┘ └─────┬──────┘ └───────┬──────┘
                     │               │
                     └────────┬──────┘
                              │
                              ▼
                       ┌──────────────┐
                       │DISCONNECTED* │ ←─ Can be reached from any state
                       └──────────────┘

* Disconnected state supports both manual disconnect and auto-expires
```

**Server-Side States**:
```
CREATED → CONNECTING → AUTHENTICATING → AWAITING_FRAME → ACTIVE
                                    ↓
                          (optional) SUSPENDED
                                    ↓
                            DISCONNECTED (terminal)
```

---

## 🔒 Security Model

### Origin Validation

**Valid Origins** (whitelist approach):
```javascript
const ALLOWED_ORIGINS = new Set([
  'http://localhost:3000',
  'https://your-domain.com',
]);

// Additional dynamic checks:
if (origin.includes('localhost') || origin.includes('127.0.0.1')) {
  return true; // Development mode
}

const currentHost = req.headers.host;
if (origin.includes(currentHost)) {
  return true; // Same domain access
}
```

**Rejection Behavior**:
- Silent rejection for WebSocket upgrades (connection fails)
- HTTP 403 JSON response for REST endpoints

---

### Ticket-Based Authentication

**Properties**:
- **Single-use**: Consumed after first validation
- **Time-limited**: Expires after 30 seconds
- **One-per-session**: Only active session can use it
- **Cryptographically secure**: 32-byte random hex string

**Validation Logic**:
```typescript
validateTicket(sessionId: string, ticket: string): SessionInfo | null {
  const session = this.sessions.get(sessionId);
  
  // 1. Verify session existence
  if (!session) return null;
  
  // 2. Match ticket exactly
  if (session.ticket !== ticket) return null;
  
  // 3. Check expiration
  if (Date.now() > session.expiresAt) {
    this.removeSession(sessionId); // Clean up
    return null;
  }
  
  // 4. Ensure still active
  if (this.activeSessionId !== sessionId) return null;
  
  // ✅ Valid - consume ticket immediately
  return session;
}
```

**Security Benefits**:
- Prevents replay attacks (tickets expire quickly)
- Limits damage from intercepted tokens (one-time use)
- Automatic cleanup prevents stale sessions

---

## 💾 Data Flow Diagram

### Connection Establishment Sequence

```
Mobile Device                  Electron Server              macOS System
     │                            │                           │
     ├─── POST /sessions ───────►│                           │
     │   (Bearer token)          │                           │
     │◄── sessionId+ticket ──────┤                           │
     │   (30s TTL)               │                           │
     │                            │                           │
     ├─── WS Upgrade ────────────►│                           │
     │   ?sessionId=...&ticket=...│                           │
     │                            │                           │
     │◄── Validate Ticket ───────┤                           │
     │                            │                           │
     │                            │─── TCP Connect ──────────►│
     │                            │   localhost:5900          │
     │                            │◄── VNC Banner ────────────┤
     │                            │                           │
     ├─ RFB Handshake Bytes ─────►│── Forward ─────────────►│
     │   (Authentication)         │                           │
     │                            │◄── Apple VNC Auth ────────┤
     │                            │                           │
     │   Frame Updates ◄─────────┤◄── Frame Data ───────────►│
     │   (JPEG/Raw Pixels)        │                           │
     │◄── Canvas Rendered ────────┤                           │
     │                            │                           │
     └────────────────────────────┴───────────────────────────┘
                              │
                              ▼
                       Desktop Captured!
```

---

## 🎨 Component Interaction Patterns

### Client-Side Architecture

```javascript
┌─────────────────────────────────────────────┐
│            Main Entry Point                 │
│                                             │
│  initializeMacDesktop()                     │
│    └─→ creates new MacDesktopClient()      │
│    └─→ await .init()                       │
└─────────────────────────────────────────────┘
           │
           ▼
┌─────────────────────────────────────────────┐
│         MacDesktopClient Instance           │
│                                             │
│  State Machine:                             │
│  - currentState: 'ready'                    │
│  - sessionId/ticket management              │
│  - Toolbar UI rendering                     │
│  - Keyboard integration                     │
└─────────────────────────────────────────────┘
           │
    ┌──────┼───────┬───────────┬──────────────┐
    │      │       │           │              │
    ▼      ▼       ▼           ▼              ▼
┌──────┐ ┌──────┐ ┌──────┐ ┌─────────┐ ┌────────────┐
│RFB    │ │Virtual │ │Input │ │Event     │ │Capability│
│Manager│ │Keyboard│ │Handler│ │Listener │ │Polling  │
└──────┘ └───────┘ └──────┘ └─────────┘ └────────────┘
```

### Event Propagation Chain

**User Action Flow**:
```
Touch Event (mobile device)
    ↓
gesture-to-input-mapping.js (convert gestures to mouse events)
    ↓
rfb._handleMouse() (noVNC handler)
    ↓
sendMouseEvent(x, y, buttonMask) (RFB protocol encoding)
    ↓
WebSocket send() (binary payload transmission)
    ↓
startVncBridge() receives data
    ↓
tcpSocket.write() (forward to VNC server)
    ↓
Screen Sharing Service processes input
```

---

## 🧩 Module Dependencies

### Direct Dependencies
```json
{
  "express": "^5.2.1",       // HTTP/WebSocket server
  "ws": "^8.19.0",           // WebSocket implementation
  "node-pty": "^1.0.0",      // PTY support (indirect)
  "crypto": native module    // Secure ticket generation
}
```

### Embedded Dependencies (Bundled)
```javascript
{
  "novnc": "v1.5.0",         // Bundled into novnc-bundle.js
  "lib": {
    "core/rfb.js",           // RFB protocol implementation
    "core/websock.js",       // WebSocket abstraction
    "core/display.js",       // Canvas rendering engine
    "input/keyboard.js",     // Keyboard event handling
    "app/ui.js"              // Web UI components
  }
}
```

---

## ⚙️ Configuration Options

### Runtime Configuration Variables

| Variable | Scope | Default | Override |
|----------|-------|---------|----------|
| `TICKET_TTL_MS` | Backend | 30000 | Modify constant in `mac-desktop-session.ts` |
| `PORT_LISTENING_CHECK_INTERVAL` | Backend | 30000ms | Adjust `setInterval` frequency |
| `NOVNC_BUNDLE_PATH` | Build | static path | Edit `scripts/build-novnc.mjs` |

### Build-Time Configuration

**esbuild Options** (`build:novnc.mjs`):
```javascript
{
  format: 'iife',              // Output module type
  globalName: 'NoVNC',         // Global export name
  minify: false,               // Development mode
  sourcemap: false             // Source maps disabled
}
```

---

## 🐛 Debugging Strategies

### Server-Side Debugging

**Enable verbose logging**:
```typescript
// In src/main/mac-desktop-routes.ts
console.log('[MacDesktop] DEBUG MODE ON');

// Add to WebSocket handler:
clientSocket.on('data', (data: Buffer) => {
  console.log(`[WS_IN] Size: ${data.byteLength}`);
  tcpSocket.write(data);
});

tcpSocket.on('data', (data: Buffer) => {
  console.log(`[TCP_OUT] Size: ${data.byteLength}`);
  clientSocket.send(data);
});
```

**Monitor connection queue**:
```bash
# Check active connections
lsof -i :5900 | wc -l
```

---

### Client-Side Debugging

**Console diagnostics**:
```javascript
// Inspect current state
window.macDesktopClient.state

// Monitor frame updates
window.macDesktopClient.rfb.addEventListener('update', (e) => {
  console.time('Frame render');
});

// Track memory usage
performance.memory.usedJSHeapSize / 1024 / 1024
```

**Network traffic analysis**:
```javascript
// Capture all WebSocket messages
const OriginalWebSocket = window.WebSocket;
window.WebSocket = class extends OriginalWebSocket {
  send(data) {
    console.log('[SEND]', { size: data.byteLength });
    return super.send(data);
  }
};
```

---

## 📊 Performance Considerations

### Memory Budget

**Estimated Peak Usage**:
- noVNC core: ~2MB
- Frame buffers (2x for double buffering): ~1.5MB
- WebSocket buffers: ~500KB per connection
- **Total**: ~4MB (well within mobile limits)

### CPU Impact

**Per-frame costs**:
- JPEG decoding: ~5-15ms (varies by quality)
- Canvas painting: ~2-5ms
- Gesture processing: <1ms

**Optimization opportunities**:
1. Progressive JPEG vs Full decode
2. Resize viewport instead of full resolution
3. Frame rate limiting when inactive

---

## 🔮 Future Extension Points

### Planned Enhancements (Not in P0)

1. **Audio Streaming Layer**
   ```typescript
   // TODO: Integrate CoreAudio capture
   function captureSystemAudio(): MediaStream {
     // Implementation pending
   }
   ```

2. **Multi-Screen Support**
   ```typescript
   // Display enumeration
   async function getAvailableDisplays(): Promise<Display[]> {
     // Need macOS display policy API
   }
   ```

3. **File Transfer Protocol**
   ```typescript
   // Shared temp directory sandbox
   async function uploadFile(file: File): Promise<void> {
     // Requires Electron IPC bridge
   }
   ```

---

## 📚 References

1. **RFB Protocol Specification**: http://www.realvnc.com/docs/rfbproto.pdf
2. **noVNC Documentation**: https://github.com/novnc/noVNC/blob/master/docs/API.md
3. **Apple VNC Authentication**: https://support.apple.com/guide/apple-screen-sharing/welcome/mac
4. **Extended Clipboard Extensions**: https://github.com/novnc/noVNC/blob/master/core/rfb.js#L72-L89

---

**Document Version**: 1.4.0  
**Last Updated**: 2026-09-15  
**Maintained By**: DuoCLI Team  
**Status**: Production-Ready Architecture Documentation
