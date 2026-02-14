#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_DIR="$ROOT_DIR/logs"
LOG_FILE="$LOG_DIR/dev_demo.log"

pids=()

cleanup() {
  for pid in "${pids[@]:-}"; do
    if kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
    fi
  done
}

trap cleanup EXIT INT TERM

wait_for_port() {
  local host="$1"
  local port="$2"
  local retries=50
  local delay=0.1

  for _ in $(seq 1 "$retries"); do
    if (echo >"/dev/tcp/${host}/${port}") >/dev/null 2>&1; then
      return 0
    fi
    sleep "$delay"
  done

  return 1
}

cd "$ROOT_DIR"

mkdir -p "$LOG_DIR"
exec > >(tee -a "$LOG_FILE") 2>&1
echo "Demo log: $LOG_FILE"

# Start session auto-scaler (dynamically creates sessions based on demand)
echo "Starting session auto-scaler..."
MIN_SESSIONS=10 MAX_SESSIONS=200 PLAYERS_PER_GAME=100 \
  ./node_modules/.bin/ts-node-dev --respawn --transpile-only src/scripts/session_autoscaler.ts &
pids+=("$!")
sleep 1  # Give autoscaler time to create initial sessions

# Core services with short match durations.
echo "Starting gateway on port 3001..."
PORT=3001 ./node_modules/.bin/ts-node-dev --respawn --transpile-only src/gateway/server.ts &
pids+=("$!")

echo "Starting matchmaker (5-10s matches)..."
MATCH_MIN_SECONDS=5 MATCH_MAX_SECONDS=10 \
  ./node_modules/.bin/ts-node-dev --respawn --transpile-only src/matchmaker/worker.ts &
pids+=("$!")

echo "Starting session runner..."
./node_modules/.bin/ts-node-dev --respawn --transpile-only src/session/runner.ts &
pids+=("$!")

echo "Starting stale-player reaper..."
./node_modules/.bin/ts-node-dev --transpile-only src/scripts/reap_stale_players.ts &
pids+=("$!")

# Wait for gateway to be ready before connecting clients.
if ! wait_for_port 127.0.0.1 3001; then
  echo "Gateway did not start on port 3001" >&2
  exit 1
fi

# Demo helpers.
echo "Starting observer + player spawner..."
URL=ws://127.0.0.1:3001 READY_UP=true HEARTBEAT_MS=5000 \
  ./node_modules/.bin/ts-node-dev --transpile-only src/scripts/observe_match_events.ts &
pids+=("$!")

# Disabled auto-spawn - use dashboard UI to add players manually
# URL=ws://127.0.0.1:3001 COUNT=1000 \
#   ./node_modules/.bin/ts-node-dev --transpile-only src/scripts/spawn_ready_players.ts &
# pids+=("$!")

wait
