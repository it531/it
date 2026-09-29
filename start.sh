#!/usr/bin/env bash
# Deep Hospital launcher for macOS / Linux. Run: ./start.sh  (or: bash start.sh)
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is not installed. Install version 22 or newer from https://nodejs.org and run this again."; exit 1
fi
MAJOR=$(node -p 'process.versions.node.split(".")[0]')
if [ "$MAJOR" -lt 22 ]; then echo "Node.js $(node -v) is too old. Install version 22 or newer from https://nodejs.org"; exit 1; fi
[ -d node_modules ] || { echo "Installing dependencies (first run only)..."; npm install; }
echo "Starting Deep Hospital — open http://localhost:3000 and sign in with admin / 123. Press Ctrl+C to stop."
( sleep 18; (command -v open >/dev/null && open http://localhost:3000) || (command -v xdg-open >/dev/null && xdg-open http://localhost:3000) ) >/dev/null 2>&1 &
exec node --disable-warning=ExperimentalWarning server/index.js
