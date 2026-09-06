#!/bin/bash

# Start the source build after a previous DuoCLI process has exited.
#
# This is intentionally a wait-only helper: it never kills a process. The
# caller can pass DUOCLI_WAIT_PID when replacing a packaged app, then close
# that app separately. Running it detached keeps the restart alive while the
# old Electron process is shutting down.

set -u

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
WAIT_PID="${DUOCLI_WAIT_PID:-}"

if [ -n "$WAIT_PID" ]; then
  while kill -0 "$WAIT_PID" 2>/dev/null; do
    sleep 1
  done
fi

cd "$PROJECT_DIR" || exit 1
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:${PATH:-}"
exec npm start
