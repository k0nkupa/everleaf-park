#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
EVERLEAF_NODE="$(command -v node || true)"
if [[ -z "$EVERLEAF_NODE" ]] || [[ "$($EVERLEAF_NODE -p 'Number(process.versions.node.split(".")[0])')" -lt 24 ]]; then
  EVERLEAF_NODE="$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node"
fi
if [[ ! -x "$EVERLEAF_NODE" ]]; then
  echo 'Everleaf requires Node.js 24 or newer.' >&2
  exit 1
fi
if [[ ! -d node_modules ]]; then
  echo 'Run npm ci --ignore-scripts first.' >&2
  exit 1
fi
export PATH="$(dirname "$EVERLEAF_NODE"):$PATH"
npm run build:client
exec "$EVERLEAF_NODE" scripts/run-framework.mjs dev --host 127.0.0.1 --port "${PORT:-4881}"
