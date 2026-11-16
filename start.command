#!/bin/bash
# Launch Flute Timer on a local server (microphone access needs http://localhost).
set -e
cd "$(dirname "$0")"

PORT="${PORT:-8787}"
while lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; do
  PORT=$((PORT + 1))
done

python3 -m http.server "$PORT" --bind 127.0.0.1 >/tmp/flute-timer-server.log 2>&1 &
SERVER_PID=$!
trap 'kill "$SERVER_PID" 2>/dev/null || true' EXIT INT TERM

sleep 0.4
open "http://127.0.0.1:$PORT/app/"

echo ""
echo "  Flute Timer app → http://127.0.0.1:$PORT/app/"
echo "  Site home       → http://127.0.0.1:$PORT/"
echo ""
echo "  Keep this window open while practicing."
echo "  Press Ctrl+C to stop the server."
echo ""

wait "$SERVER_PID"
