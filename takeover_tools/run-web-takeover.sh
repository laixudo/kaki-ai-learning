#!/usr/bin/env bash
# ============================================================================
# Kaki Learning — Web Takeover runner (POSIX shell, works without PowerShell)
# Starts: synthetic DB -> backend (TAKEOVER_BACKEND_PORT default 18001)
#         -> frontend (TAKEOVER_FRONTEND_PORT default 15174) -> smoke tests.
# Everything stays inside this isolated directory; never touches the formal
# project and never calls an external LLM (MODE=mock).
# Env overrides: TAKEOVER_PYTHON, TAKEOVER_BACKEND_PORT, TAKEOVER_FRONTEND_PORT,
#                TAKEOVER_DB_PATH, TAKEOVER_NO_SMOKE
# ============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PYTHON="${TAKEOVER_PYTHON:-python3}"
BACKEND_PORT="${TAKEOVER_BACKEND_PORT:-18001}"
FRONTEND_PORT="${TAKEOVER_FRONTEND_PORT:-15174}"
DB_PATH="${TAKEOVER_DB_PATH:-$ROOT/backend/ml_learning.synthetic.db}"

mkdir -p "$ROOT/takeover_tools/logs"

if [ ! -f "$DB_PATH" ]; then
  echo "[takeover] synthetic DB missing -> creating from scratch..."
  (cd "$ROOT" && "$PYTHON" takeover_tools/create_synthetic_database.py --force)
fi

echo "[takeover] backend -> http://127.0.0.1:$BACKEND_PORT"
(cd "$ROOT" && TAKEOVER_BACKEND_PORT="$BACKEND_PORT" "$PYTHON" takeover_tools/run_backend.py --detach)

echo "[takeover] frontend -> http://127.0.0.1:$FRONTEND_PORT"
(cd "$ROOT" && TAKEOVER_FRONTEND_PORT="$FRONTEND_PORT" TAKEOVER_BACKEND_PORT="$BACKEND_PORT" node takeover_tools/run_frontend.mjs --detach)

if [ "${TAKEOVER_NO_SMOKE:-}" != "1" ]; then
  echo "[takeover] running smoke tests..."
  (cd "$ROOT" && "$PYTHON" takeover_tools/smoke_test.py \
      --backend-url "http://127.0.0.1:$BACKEND_PORT" \
      --frontend-url "http://127.0.0.1:$FRONTEND_PORT")
fi

echo "[takeover] READY -> http://127.0.0.1:$FRONTEND_PORT/"
echo "[takeover] stop with: $PYTHON $SCRIPT_DIR/stop_services.py"
