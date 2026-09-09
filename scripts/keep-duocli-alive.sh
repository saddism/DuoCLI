#!/bin/bash
# LaunchAgent 守护：保证 DuoCLI Electron（含远程 9800）常驻。
# 退出后由 KeepAlive 自动再拉起，避免 Cloudflare 源站 502。

set -u
PROJECT_DIR="/Users/kaifengwang/Documents/myDev/DuoCLI"
LOG_PATH="${DUOCLI_KEEP_LOG:-/Users/kaifengwang/.config/duocli-tunnel/app-keep.log}"
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:${PATH:-}"

cd "$PROJECT_DIR" || exit 1
mkdir -p "$(dirname "$LOG_PATH")"

{
  echo ""
  echo "======== $(date '+%Y-%m-%d %H:%M:%S') keep-duocli-alive ========"
} >>"$LOG_PATH"

# 已有本仓库 Electron 在跑且 9800 正常时，别重复开第二份
if lsof -nP -iTCP:9800 -sTCP:LISTEN >/dev/null 2>&1; then
  if pgrep -f "${PROJECT_DIR}/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron" >/dev/null 2>&1; then
    echo "[keep] already healthy on :9800, waiting" >>"$LOG_PATH"
    # 阻塞跟随已有进程，避免 LaunchAgent 立刻重启刷屏
    while pgrep -f "${PROJECT_DIR}/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron" >/dev/null 2>&1 \
      && lsof -nP -iTCP:9800 -sTCP:LISTEN >/dev/null 2>&1; do
      sleep 5
    done
    echo "[keep] previous instance gone, will relaunch" >>"$LOG_PATH"
  fi
fi

ELECTRON_BIN="${PROJECT_DIR}/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
if [ ! -x "$ELECTRON_BIN" ]; then
  echo "[keep] electron binary missing, npm install?" >>"$LOG_PATH"
  exit 1
fi

# 产物缺失时补一次主进程编译（避免空跑）
if [ ! -f "${PROJECT_DIR}/dist/main/index.js" ]; then
  echo "[keep] building main..." >>"$LOG_PATH"
  npm run build:main >>"$LOG_PATH" 2>&1 || exit 1
fi

echo "[keep] exec electron ." >>"$LOG_PATH"
exec "$ELECTRON_BIN" "$PROJECT_DIR" >>"$LOG_PATH" 2>&1
