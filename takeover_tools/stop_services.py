# -*- coding: utf-8 -*-
"""Stop the takeover backend/frontend services started by run_backend/run_frontend.

Only stops processes recorded in the takeover PID files (isolated directory
only).  Never touches formal services (8001/5174) or the formal project.
"""
from __future__ import annotations

import os
import signal
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
PID_FILES = [
    PROJECT_ROOT / "takeover_tools" / ".run-backend.pid",
    PROJECT_ROOT / "takeover_tools" / ".run-frontend.pid",
]


def stop_pid_file(pid_file: Path) -> None:
    if not pid_file.exists():
        return
    raw = pid_file.read_text(encoding="utf-8").strip()
    if not raw:
        return
    pid = int(raw)
    try:
        if os.name == "nt":
            import subprocess
            subprocess.run(["taskkill", "/F", "/PID", str(pid)],
                           capture_output=True, timeout=10)
        else:
            os.kill(pid, signal.SIGTERM)
        print(f"[stop_services] stopped pid {pid} ({pid_file.name})")
    except (ProcessLookupError, PermissionError, ValueError):
        print(f"[stop_services] pid {pid} already gone ({pid_file.name})")
    pid_file.unlink(missing_ok=True)


def main() -> int:
    for pf in PID_FILES:
        stop_pid_file(pf)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
