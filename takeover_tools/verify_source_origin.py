# -*- coding: utf-8 -*-
"""Verify a SOURCE-ORIGIN-MANIFEST.csv against the actual staged files.

Every row must satisfy: the staged file at package_path exists and its SHA-256
equals the recorded formal SHA-256 (or the row explicitly marks a generated
file whose "matched" field is intentionally false).

Usage:
    python takeover_tools/verify_source_origin.py --root STAGED_ROOT [--manifest FILE] [--output FILE]
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import json
import time
from pathlib import Path


def sha256_file(p: Path) -> str:
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for c in iter(lambda: f.read(1024 * 1024), b""):
            h.update(c)
    return h.hexdigest()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", required=True, type=Path)
    ap.add_argument("--manifest", type=Path, default=None)
    ap.add_argument("--output", type=Path, default=Path("validation") / "SOURCE-ORIGIN-VERIFY.json")
    args = ap.parse_args()
    args.output.parent.mkdir(parents=True, exist_ok=True)

    manifest = args.manifest or (args.root.parent / "SOURCE-ORIGIN-MANIFEST.csv")
    if not manifest.exists():
        print("manifest not found:", manifest)
        return 2

    total = 0
    matched = 0
    mismatched = []
    missing = []
    generated = 0

    with open(manifest, encoding="utf-8-sig", newline="") as f:
        reader = csv.DictReader(f)
        for row in reader:
            total += 1
            pkg = row.get("包内相对路径", row.get("package_path", "")).strip()
            formal_sha = row.get("正式SHA-256", row.get("formal_sha256", "")).strip()
            source_type = row.get("来源类型", row.get("source_type", "")).strip()
            if source_type.startswith("generated") or "generated" in source_type:
                generated += 1
                continue
            fpath = args.root / pkg
            if not fpath.exists():
                missing.append(pkg)
                continue
            actual = sha256_file(fpath)
            if formal_sha and actual == formal_sha:
                matched += 1
            else:
                mismatched.append({"path": pkg, "expected": formal_sha[:16], "actual": actual[:16]})

    ok = matched == (total - generated) and not missing and not mismatched
    report = {
        "result": "PASS" if ok else "FAIL",
        "total_rows": total,
        "copied_rows_matched": matched,
        "generated_rows_skipped": generated,
        "missing": missing[:20],
        "mismatched": mismatched[:20],
        "ran_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
    }
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"SOURCE_ORIGIN {report['result']} matched={matched}/{total} missing={len(missing)} mismatch={len(mismatched)}")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
