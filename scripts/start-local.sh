#!/usr/bin/env bash
set -euo pipefail
PROJECT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_DIR"
if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  echo "Node.js 22.12+ and npm are required. Install Node.js, then run ./scripts/setup.sh." >&2
  exit 1
fi
exec node "$PROJECT_DIR/scripts/local-runner.mjs"
