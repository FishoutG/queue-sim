#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

pids=()

cleanup() {
  for pid in "${pids[@]:-}"; do
    if kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
    fi
  done
}

trap cleanup EXIT INT TERM

cd "$ROOT_DIR"

# Start core services with shorter match durations.
PORT=3001 ./node_modules/.bin/ts-node-dev --respawn --transpile-only src/gateway/server.ts &
pids+=("$!")

MATCH_MIN_SECONDS=5 MATCH_MAX_SECONDS=10 \
  ./node_modules/.bin/ts-node-dev --respawn --transpile-only src/matchmaker/worker.ts &
pids+=("$!")

./node_modules/.bin/ts-node-dev --respawn --transpile-only src/session/runner.ts &
pids+=("$!")

./node_modules/.bin/ts-node-dev --transpile-only src/scripts/reap_stale_players.ts &
pids+=("$!")

wait
