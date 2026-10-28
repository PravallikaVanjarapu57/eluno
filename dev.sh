#!/usr/bin/env bash
# Local development: mock (:8787) + till API (:3000) from backend/, and the Vite UI (:5173) from frontend/.
# Open http://localhost:5173 (Vite proxies /api to the API, so there is no CORS to configure).
#   ./dev.sh           reliable mock
#   ./dev.sh --flaky   mock returns random 429s and terminal 503s
set -euo pipefail
cd "$(dirname "$0")"
command -v node >/dev/null || { echo "Node.js 20+ is required"; exit 1; }
command -v python3 >/dev/null || { echo "Python 3 is required for the starter-kit mock"; exit 1; }
[ -d backend/node_modules ] || (cd backend && npm ci --no-audit --no-fund)
[ -d frontend/node_modules ] || (cd frontend && npm ci --no-audit --no-fund)

trap 'kill 0' EXIT INT TERM
(cd backend && npm run "$([ "${1:-}" = "--flaky" ] && echo start:flaky || echo start)") &
(cd frontend && npm run dev) &
wait
