#!/bin/bash
# All local entry points build this checkout. Never pull, stash or kill sessions.
set -eu

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
export PATH="/opt/homebrew/opt/node@20/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:${PATH:-}"
cd "$PROJECT_DIR"
exec node scripts/source-launcher.mjs >>"${DUOCLI_START_LOG:-/tmp/duocli-start.log}" 2>&1
