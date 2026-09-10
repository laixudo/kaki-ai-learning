from __future__ import annotations

import csv
import hashlib
from pathlib import Path


root = Path(__file__).resolve().parents[1]
excluded = {"MANIFEST.csv", "SHA256SUMS.txt"}
files = [
    path for path in root.rglob("*")
    if path.is_file()
    and path.name not in excluded
    and "__pycache__" not in path.parts
    and ".pytest_cache" not in path.parts
]
rows = []
for path in sorted(files):
    relative = path.relative_to(root).as_posix()
    digest = hashlib.sha256(path.read_bytes()).hexdigest().upper()
    rows.append((relative, path.stat().st_size, digest))
with (root / "MANIFEST.csv").open("w", encoding="utf-8-sig", newline="") as handle:
    writer = csv.writer(handle)
    writer.writerow(["relative_path", "size", "sha256"])
    writer.writerows(rows)
with (root / "SHA256SUMS.txt").open("w", encoding="utf-8", newline="\n") as handle:
    for relative, _size, digest in rows:
        handle.write(f"{digest}  {relative}\n")
print(f"manifest_files={len(rows)}")
