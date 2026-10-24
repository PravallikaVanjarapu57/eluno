#!/usr/bin/env bash
# One command after cloning: installs dependencies if needed, then starts the mock and the API.
#   ./run.sh            API on http://localhost:3000, mock on :8787 (no random failures)
#   ./run.sh --flaky    mock returns 429s and terminal 503s like production
#   ./run.sh --demo     runs the narrated Must flow instead of the server
set -euo pipefail
cd "$(dirname "$0")"

command -v node >/dev/null || { echo "Node.js 20+ is required (https://nodejs.org)"; exit 1; }
command -v python3 >/dev/null || { echo "Python 3.8+ is required for the starter-kit mock"; exit 1; }
node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 20 ? 0 : 1)' || { echo "Node.js 20+ is required; found $(node -v)"; exit 1; }

[ -d node_modules ] || npm ci --no-audit --no-fund

case "${1:-}" in
  --demo)  exec npm run demo ;;
  --flaky) exec npm run start:flaky ;;
  *)       exec npm start ;;
esac
