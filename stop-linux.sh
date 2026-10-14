#!/usr/bin/env sh
set -eu

PROJECT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PID_FILE="$PROJECT_DIR/.mafia-server-linux.pid"

if [ ! -f "$PID_FILE" ]; then
  echo "Mafia server is not running through start-linux.sh."
  exit 0
fi

SERVER_PID=$(cat "$PID_FILE")
case "$SERVER_PID" in ''|*[!0-9]*) echo "Invalid PID file; refusing to stop a process." >&2; exit 1 ;; esac

if ! kill -0 "$SERVER_PID" 2>/dev/null; then
  rm -f "$PID_FILE"
  echo "Removed stale PID file; server was not running."
  exit 0
fi

if [ ! -r "/proc/$SERVER_PID/cmdline" ] || ! tr '\000' ' ' < "/proc/$SERVER_PID/cmdline" | grep -F -- "$PROJECT_DIR/server.js" >/dev/null; then
  echo "PID $SERVER_PID does not match this project's server; refusing to stop it." >&2
  exit 1
fi

kill -TERM "$SERVER_PID"
count=0
while kill -0 "$SERVER_PID" 2>/dev/null && [ "$count" -lt 10 ]; do
  sleep 1
  count=$((count + 1))
done
if kill -0 "$SERVER_PID" 2>/dev/null; then
  kill -KILL "$SERVER_PID"
fi
rm -f "$PID_FILE"
echo "Mafia server stopped."
