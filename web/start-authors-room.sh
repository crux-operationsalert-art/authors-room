#!/usr/bin/env bash
# Mac / Linux: double-click or run ./start-authors-room.sh
cd "$(dirname "$0")"
command -v node >/dev/null || { echo "Install Node.js LTS from https://nodejs.org"; exit 1; }
[ -d node_modules ] || npm install
( sleep 4; (open http://localhost:3000 || xdg-open http://localhost:3000) >/dev/null 2>&1 ) &
npm run dev
