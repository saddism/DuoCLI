# DuoCLI

Electron 桌面端 + 手机 PWA。桌面用 node-pty 跑各家 AI CLI，手机经局域网 HTTP/WebSocket 同步同一终端。

## Architecture
- 主进程：`src/main/` — 窗口、PTY、会话恢复、远程 HTTP/WS、Android adb
- 预加载：`src/preload/index.ts` — `window.duocli` IPC
- 渲染进程：`src/renderer/` — 全局多 Pane 工作区、xterm、文件预览、Android 镜像
- 手机端：`mobile/client/` — PWA，远程终端、会话草稿、文件与 Android 控制
- 配置：Electron `userData`，手机端 `~/.duocli-mobile/config.json`

## Build & Run
```bash
npm install
npm start
npm run test:unit
```

## Conventions
- 主进程 / preload 用 `tsc`，渲染进程用 esbuild 打包
- 只改当前问题和需求，不顺手重构
