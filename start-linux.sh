#!/usr/bin/env sh
set -eu

PROJECT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$PROJECT_DIR"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 22.13 or newer is required." >&2
  exit 1
fi
NODE_MAJOR=$(node -p "process.versions.node.split('.')[0]")
NODE_MINOR=$(node -p "process.versions.node.split('.')[1]")
if [ "$NODE_MAJOR" -lt 22 ] || { [ "$NODE_MAJOR" -eq 22 ] && [ "$NODE_MINOR" -lt 13 ]; }; then
  echo "Node.js 22.13 or newer is required for the built-in SQLite module." >&2
  exit 1
fi

PID_FILE="$PROJECT_DIR/.mafia-server-linux.pid"
DATA_DIR="$PROJECT_DIR/data"
mkdir -p "$DATA_DIR"

if [ -f "$PID_FILE" ]; then
  OLD_PID=$(cat "$PID_FILE")
  if case "$OLD_PID" in ''|*[!0-9]*) false ;; *) kill -0 "$OLD_PID" 2>/dev/null ;; esac; then
    echo "Mafia server may already be running (PID $OLD_PID). Use ./stop-linux.sh first." >&2
    exit 1
  fi
  rm -f "$PID_FILE"
fi

nohup node "$PROJECT_DIR/server.js" >> "$DATA_DIR/server.log" 2>&1 </dev/null &
SERVER_PID=$!
printf '%s\n' "$SERVER_PID" > "$PID_FILE"
sleep 1
if ! kill -0 "$SERVER_PID" 2>/dev/null; then
  rm -f "$PID_FILE"
  echo "Server did not start. See $DATA_DIR/server.log" >&2
  tail -n 30 "$DATA_DIR/server.log" 2>/dev/null || true
  exit 1
fi

PORT=${PORT:-4444}
echo "Mafia server started (PID $SERVER_PID). Open http://localhost:$PORT"
echo "Log: $DATA_DIR/server.log"
echo "Stop with ./stop-linux.sh"
