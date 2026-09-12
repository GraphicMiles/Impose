#!/usr/bin/env bash
# Restart the full Impose stack on the Lightning box.
# Free Studios stop processes on every restart cycle, so run this after each
# boot (and the relay's wake path runs it for you when WAKE_STUDIO=1).
# The gateway spawns llama-server itself (watchdog), so this is the only
# thing that needs to run.
set -e
pkill -f "lightning/server.py" 2>/dev/null || true
pkill -f llama-server 2>/dev/null || true
sleep 2
cd "$(dirname "$0")"
nohup python3 server.py > control-plane.log 2>&1 &
echo "control plane launching, log: $(pwd)/control-plane.log"
echo "health:  curl http://127.0.0.1:${PORT:-9000}/health"
