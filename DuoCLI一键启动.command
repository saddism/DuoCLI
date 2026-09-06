#!/bin/bash
# DuoCLI 一键启动：在项目根目录双击即可 npm start

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$SCRIPT_DIR"

if [ ! -f "$PROJECT_DIR/package.json" ]; then
  echo "DuoCLI 项目目录无效：$PROJECT_DIR"
  exit 1
fi

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:${PATH:-}"
cd "$PROJECT_DIR" || exit 1
exec npm start
