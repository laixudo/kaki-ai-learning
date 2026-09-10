# -*- coding: utf-8 -*-
"""Start the Kaki Learning backend in isolated mock mode (no external LLM).

Never touches the formal project.  All paths are resolved relative to the
project root this script lives in.  Ports and DB path are configurable.

Examples:
    python takeover_tools/run_backend.py                     # port 18001
    TAKEOVER_BACKEND_PORT=18002 python takeover_tools/run_backend.py
    python takeover_tools/run_backend.py --port 18003 --db-path backend/ml_learning.synthetic.db
"""
from __future__ import annotations

import argparse
import os
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
BACKEND_DIR = PROJECT_ROOT / "backend"

DEFAULT_PORT = int(os.environ.get("TAKEOVER_BACKEND_PORT", "18001"))
DEFAULT_DB = PROJECT_ROOT / "backend" / "ml_learning.synthetic.db"
PID_FILE = PROJECT_ROOT / "takeover_tools" / ".run-backend.pid"
LOG_DIR = PROJECT_ROOT / "takeover_tools" / "logs"


def build_env(db_path: Path, port: int, host: str) -> dict:
    env = dict(os.environ)
    env["MODE"] = "mock"
    env["DB_ENGINE"] = "sqlite"
    env["DATABASE_URL"] = "sqlite+aiosqlite:///" + db_path.as_posix()
    env["LLM_PROVIDER"] = "mock"
    env["LLM_MODEL"] = "mock"
    env["REDIS_ENABLED"] = "false"
    env["MILVUS_ENABLED"] = "false"
    env["MINIO_ENABLED"] = "false"
    env["OPENMAIC_ENABLED"] = "false"
    env["SECRET_KEY"] = "web-takeover-mock-dev-only-do-not-use-in-production"
    env["HOST"] = host
    env["PORT"] = str(port)
    env["INITIAL_ADMIN_USERNAME"] = "web_takeover_admin"
    env["INITIAL_ADMIN_PASSWORD"] = "KakiAdminMock-2026!"
    env["INITIAL_ADMIN_DISPLAY_NAME"] = "网页接管合成管理员"
    return env


def wait_ready(url: str, timeout: float = 90.0) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=3) as resp:
                if resp.status < 500:
                    return True
        except Exception:
            time.sleep(1.0)
    return False


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=DEFAULT_PORT)
    ap.add_argument("--db-path", type=Path, default=DEFAULT_DB)
    ap.add_argument("--detach", action="store_true", help="write PID file and exit")
    ap.add_argument("--timeout", type=float, default=90.0)
    args = ap.parse_args()

    db_path = args.db_path
    if not db_path.is_absolute():
        db_path = PROJECT_ROOT / db_path
    if not db_path.exists():
        print(f"[run_backend] synthetic DB missing: {db_path}")
        print("[run_backend] create it first with: python takeover_tools/create_synthetic_database.py --force")
        return 2

    LOG_DIR.mkdir(parents=True, exist_ok=True)
    out = open(LOG_DIR / "backend.out.log", "a", encoding="utf-8")
    err = open(LOG_DIR / "backend.err.log", "a", encoding="utf-8")

    cmd = [
        sys.executable, "-m", "uvicorn", "app:app",
        "--host", args.host, "--port", str(args.port),
    ]
    print(f"[run_backend] starting: {' '.join(cmd)} (cwd={BACKEND_DIR})")
    print(f"[run_backend] DB: {db_path}")
    proc = subprocess.Popen(
        cmd, cwd=str(BACKEND_DIR), env=build_env(db_path, args.port, args.host),
        stdout=out, stderr=err,
    )
    PID_FILE.write_text(str(proc.pid), encoding="utf-8")

    url = f"http://{args.host}:{args.port}/api/health"
    ready = wait_ready(url, args.timeout)
    if not ready:
        print(f"[run_backend] NOT READY within {args.timeout}s -> {url}")
        print("[run_backend] see takeover_tools/logs/backend.err.log")
        proc.terminate()
        return 3
    print(f"[run_backend] READY -> {url} (pid={proc.pid})")
    if args.detach:
        return 0
    try:
        return proc.wait()
    except KeyboardInterrupt:
        proc.terminate()
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
