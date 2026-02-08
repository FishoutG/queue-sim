#!/usr/bin/env bash
set -euo pipefail

LOG_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../logs" && pwd)"
PID_FILE="${LOG_DIR}/session-runners.pids"

if [[ ! -f "$PID_FILE" ]]; then
  echo "No PID file found at $PID_FILE"
  exit 0
fi

echo "Stopping session runners from $PID_FILE ..."
while read -r pid; do
  if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
    kill "$pid" || true
    echo "  killed pid=$pid"
  fi
done < "$PID_FILE"

rm -f "$PID_FILE"
echo "Done."

