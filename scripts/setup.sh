#!/usr/bin/env bash
set -euo pipefail
PROJECT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_DIR"
if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  echo "Install Node.js 22.12+ (including npm), then run this script again." >&2
  exit 1
fi
node -e 'if (((v) => v[0] < 22 || (v[0] === 22 && v[1] < 12))(process.versions.node.split(".").map(Number))) { console.error("Node.js 22.12+ is required."); process.exit(1); }'
if [[ ! -f package-lock.json ]]; then
  echo "Missing package-lock.json: restore the project lockfile before setup." >&2
  exit 1
fi
npm ci
printf '\nSetup complete. Start the game with ./scripts/start-local.sh\n'
