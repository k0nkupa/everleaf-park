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
./node_modules/.bin/esbuild src/app.ts --bundle --format=esm --target=es2022 --outfile=public/app.js
exec "$EVERLEAF_NODE" --env-file-if-exists=.env --experimental-strip-types src/server.ts
