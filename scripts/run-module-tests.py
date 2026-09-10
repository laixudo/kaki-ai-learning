from __future__ import annotations

import subprocess
import sys
from pathlib import Path


root = Path(__file__).resolve().parents[1]
command = [sys.executable, "-m", "pytest", "-q"]
result = subprocess.run(command, cwd=root, check=False)
raise SystemExit(result.returncode)
