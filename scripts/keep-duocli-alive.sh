#!/bin/bash
# LaunchAgent 守护：保证 DuoCLI Electron（含远程 9800）常驻。
# 异常退出后由 KeepAlive 自动再拉起，避免 Cloudflare 源站 502。
# 用户 Cmd+Q / 菜单退出时会写入 app-keep.paused，此时不得再拉起。

set -u
PROJECT_DIR="/Users/kaifengwang/Documents/myDev/DuoCLI"
KEEP_DIR="${DUOCLI_KEEP_DIR:-/Users/kaifengwang/.config/duocli-tunnel}"
LOG_PATH="${DUOCLI_KEEP_LOG:-${KEEP_DIR}/app-keep.log}"
PAUSE_PATH="${DUOCLI_KEEP_PAUSE:-${KEEP_DIR}/app-keep.paused}"
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:${PATH:-}"

cd "$PROJECT_DIR" || exit 1
mkdir -p "$(dirname "$LOG_PATH")"

wait_while_paused() {
  if [ ! -f "$PAUSE_PATH" ]; then
    return 0
  fi
  echo "[keep] paused by user quit ($(date '+%Y-%m-%d %H:%M:%S')), not relaunching" >>"$LOG_PATH"
  # KeepAlive=true 时若直接 exit 会立刻被拉起刷屏；阻塞等到取消暂停。
  while [ -f "$PAUSE_PATH" ]; do
    sleep 30
  done
  echo "[keep] pause cleared, continuing" >>"$LOG_PATH"
}

{
  echo ""
  echo "======== $(date '+%Y-%m-%d %H:%M:%S') keep-duocli-alive ========"
} >>"$LOG_PATH"

wait_while_paused

# 已有本仓库 Electron 在跑且 9800 正常时，别重复开第二份
if lsof -nP -iTCP:9800 -sTCP:LISTEN >/dev/null 2>&1; then
  if pgrep -f "${PROJECT_DIR}/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron" >/dev/null 2>&1; then
    echo "[keep] already healthy on :9800, waiting" >>"$LOG_PATH"
    # 阻塞跟随已有进程，避免 LaunchAgent 立刻重启刷屏
    while pgrep -f "${PROJECT_DIR}/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron" >/dev/null 2>&1 \
      && lsof -nP -iTCP:9800 -sTCP:LISTEN >/dev/null 2>&1; do
      if [ -f "$PAUSE_PATH" ]; then
        echo "[keep] pause while following healthy instance" >>"$LOG_PATH"
        break
      fi
      sleep 5
    done
    wait_while_paused
    if pgrep -f "${PROJECT_DIR}/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron" >/dev/null 2>&1 \
      && lsof -nP -iTCP:9800 -sTCP:LISTEN >/dev/null 2>&1; then
      echo "[keep] still healthy after pause wait, continuing follow" >>"$LOG_PATH"
      exec "$0" "$@"
    fi
    echo "[keep] previous instance gone, will relaunch" >>"$LOG_PATH"
  fi
fi

wait_while_paused

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
