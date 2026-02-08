#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_DIR="$ROOT_DIR/.run"
LOG_DIR="$RUN_DIR/logs"
PID_DIR="$RUN_DIR/pids"

mkdir -p "$LOG_DIR" "$PID_DIR"

stop_pidfile() {
  local name="$1"
  local pid_file="$PID_DIR/$name.pid"

  if [[ -f "$pid_file" ]]; then
    local pid
    pid="$(cat "$pid_file")"
    if [[ -n "$pid" ]] && ps -p "$pid" > /dev/null 2>&1; then
      kill "$pid" || true
      for _ in {1..20}; do
        if ps -p "$pid" > /dev/null 2>&1; then
          sleep 0.1
        else
          break
        fi
      done
      if ps -p "$pid" > /dev/null 2>&1; then
        kill -9 "$pid" || true
      fi
    fi
    rm -f "$pid_file"
  fi
}

stop_services() {
  stop_pidfile "gateway"
  stop_pidfile "matchmaker"

  if command -v docker > /dev/null 2>&1; then
    (cd "$ROOT_DIR" && docker compose down > "$LOG_DIR/docker-compose-down.log" 2>&1) || true
  fi
}

start_services() {
  if command -v docker > /dev/null 2>&1; then
    (cd "$ROOT_DIR" && docker compose up -d redis > "$LOG_DIR/docker-compose-up.log" 2>&1)
  fi

  (cd "$ROOT_DIR" && nohup npm run dev:gateway > "$LOG_DIR/gateway.log" 2>&1 & echo $! > "$PID_DIR/gateway.pid")
  (cd "$ROOT_DIR" && nohup npm run dev:matchmaker > "$LOG_DIR/matchmaker.log" 2>&1 & echo $! > "$PID_DIR/matchmaker.pid")

  if [[ -n "${SESSIONS:-}" ]]; then
    (cd "$ROOT_DIR" && SESSIONS="$SESSIONS" npm run register:sessions)
  fi

  if [[ -n "${COUNT:-}" ]]; then
    (cd "$ROOT_DIR" && COUNT="$COUNT" npm run spawn:ready)
  fi
}

case "${1:-restart}" in
  restart)
    stop_services
    start_services
    ;;
  stop)
    stop_services
    ;;
  start)
    start_services
    ;;
  *)
    echo "Usage: $0 [restart|start|stop]" >&2
    exit 1
    ;;
esac
