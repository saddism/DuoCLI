#!/bin/bash
# DuoCLI 最新源码启动：先拉远程、停掉旧进程（含打包版 App），再 npm start。
# 桌面「一键启动」应调用本脚本，避免继续跑 release/mac-arm64 里的旧包。

set -u

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
LOG_PATH="${DUOCLI_START_LOG:-/tmp/duocli-start.log}"
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:${PATH:-}"

cd "$PROJECT_DIR" || exit 1

if [ ! -f package.json ]; then
  echo "DuoCLI 项目目录无效：$PROJECT_DIR" >&2
  exit 1
fi

{
  echo ""
  echo "======== $(date '+%Y-%m-%d %H:%M:%S') DuoCLI start-latest ========"
  echo "project=$PROJECT_DIR"
} >>"$LOG_PATH"

# 1) 拉取远程最新（有本地改动时用 autostash，避免挡住启动）
# GitHub SSH 卡住时不能挡住启动：SSH 连接超时 + 整段 fetch/pull 限时。
GIT_TIMEOUT_SEC="${DUOCLI_GIT_TIMEOUT:-20}"
export GIT_SSH_COMMAND="${GIT_SSH_COMMAND:-ssh -o BatchMode=yes -o ConnectTimeout=8 -o ConnectionAttempts=1 -o ServerAliveInterval=5 -o ServerAliveCountMax=2}"

run_with_timeout() {
  local seconds="$1"
  shift
  "$@" &
  local pid=$!
  local elapsed=0
  while kill -0 "$pid" 2>/dev/null; do
    if [ "$elapsed" -ge "$seconds" ]; then
      echo "[start-latest] 命令超时 ${seconds}s，结束 PID $pid：$*" >>"$LOG_PATH"
      kill "$pid" 2>/dev/null || true
      sleep 1
      kill -9 "$pid" 2>/dev/null || true
      pkill -P "$pid" 2>/dev/null || true
      wait "$pid" 2>/dev/null || true
      return 124
    fi
    sleep 1
    elapsed=$((elapsed + 1))
  done
  wait "$pid"
}

if [ -d .git ]; then
  echo "[start-latest] git fetch/pull（最多 ${GIT_TIMEOUT_SEC}s）..." | tee -a "$LOG_PATH"
  if run_with_timeout "$GIT_TIMEOUT_SEC" git fetch origin >>"$LOG_PATH" 2>&1; then
    BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo main)"
    if ! run_with_timeout "$GIT_TIMEOUT_SEC" git pull --rebase --autostash origin "$BRANCH" >>"$LOG_PATH" 2>&1; then
      echo "[start-latest] git pull 未完全成功，继续用当前工作区源码启动（详见 $LOG_PATH）" | tee -a "$LOG_PATH"
    else
      echo "[start-latest] git: $(git rev-parse --short HEAD) ($BRANCH)" | tee -a "$LOG_PATH"
    fi
  else
    echo "[start-latest] git fetch 失败或超时，继续用本地源码启动" | tee -a "$LOG_PATH"
  fi
fi

# 2) 关掉旧 DuoCLI：打包 App + 本仓库的 electron 开发实例
stop_old() {
  # 打包版（release 里冻住的旧 App，常被 Spotlight/访达误开）
  pkill -f "${PROJECT_DIR}/release/.*DuoCLI\\.app/Contents/MacOS/DuoCLI" 2>/dev/null || true
  osascript -e 'tell application "DuoCLI" to quit' >/dev/null 2>&1 || true

  # 本仓库 npm/electron 开发实例
  pkill -f "${PROJECT_DIR}/node_modules/electron/dist/Electron\\.app/Contents/MacOS/Electron" 2>/dev/null || true
  pkill -f "${PROJECT_DIR}/node_modules/\\.bin/electron" 2>/dev/null || true

  # 等 9800 释放（远程服务端口）
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    if ! lsof -nP -iTCP:9800 -sTCP:LISTEN >/dev/null 2>&1; then
      break
    fi
    PIDS="$(lsof -nP -iTCP:9800 -sTCP:LISTEN -t 2>/dev/null || true)"
    if [ -n "${PIDS:-}" ]; then
      kill $PIDS 2>/dev/null || true
    fi
    sleep 1
  done
}

echo "[start-latest] stopping old DuoCLI..." | tee -a "$LOG_PATH"
stop_old

# 3) 用源码最新构建启动
echo "[start-latest] npm start..." | tee -a "$LOG_PATH"
exec npm start >>"$LOG_PATH" 2>&1
