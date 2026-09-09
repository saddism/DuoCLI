#!/bin/bash
# DuoCLI 一键启动：拉取最新源码 → 关掉旧打包版/旧进程 → npm start

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$SCRIPT_DIR"

if [ ! -f "$PROJECT_DIR/package.json" ]; then
  # 允许把本脚本拷到桌面：回退到固定项目路径（用户名从 HOME 取，避免硬编码）
  PROJECT_DIR="${HOME}/Documents/myDev/DuoCLI"
fi

if [ ! -f "$PROJECT_DIR/scripts/start-latest.sh" ]; then
  echo "找不到 start-latest.sh：$PROJECT_DIR/scripts/start-latest.sh"
  exit 1
fi

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:${PATH:-}"
cd "$PROJECT_DIR" || exit 1
exec bash "$PROJECT_DIR/scripts/start-latest.sh"
