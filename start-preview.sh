#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
export PREVIEW_MODE=1 NODE_ENV=development HOST=127.0.0.1
export PORT="${PORT:-4881}"
export APP_ORIGIN="http://127.0.0.1:$PORT"
export DATA_DIR="${DATA_DIR:-.preview-data}"
export RESEND_API_KEY='' EMAIL_FROM=''
exec bash ./start-local.sh
