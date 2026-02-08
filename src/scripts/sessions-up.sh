#!/usr/bin/env bash
set -euo pipefail

# Usage:
#   ./scripts/sessions-up.sh 10
#   ./scripts/sessions-up.sh 40
COUNT="${1:-10}"

# Where logs go
LOG_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../logs" && pwd)"
PID_FILE="${LOG_DIR}/session-runners.pids"

mkdir -p "$LOG_DIR"
: > "$PID_FILE"

echo "Starting ${COUNT} session runners..."
echo "Logs: $LOG_DIR/session-*.log"
echo "PIDs: $PID_FILE"

for i in $(seq 1 "$COUNT"); do
  SESSION_ID="sess-${i}"
  LOG_FILE="${LOG_DIR}/session-${i}.log"

  # Start each runner in background, with a deterministic SESSION_ID
  ( export SESSION_ID="$SESSION_ID"; npm run dev:session ) > "$LOG_FILE" 2>&1 &

  echo $! >> "$PID_FILE"
  echo "  started $SESSION_ID (pid=$!) -> $LOG_FILE"
done

echo "Done."
echo "Verify idle sessions: docker exec -it queue-sim-redis-1 redis-cli SCARD sessions:idle"
echo "Tail logs: tail -f $LOG_DIR/session-1.log"
