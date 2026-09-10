# -*- coding: utf-8 -*-
"""ZIP integrity gate for a web-takeover ZIP.

Checks: SHA-256 hex length, CRC pass, no absolute paths, no ../ traversal,
no symlinks, no encrypted members, internal SHA256SUMS all pass, SHA256SUMS
does not list itself, manifest-referenced files exist, required dirs non-empty.

Usage:
    python takeover_tools/verify_package_integrity.py --zip FILE [--output FILE]
"""
from __future__ import annotations

import argparse
import hashlib
import json
import time
import zipfile
from pathlib import Path


def sha256_file(p: Path) -> str:
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for c in iter(lambda: f.read(1024 * 1024), b""):
            h.update(c)
    return h.hexdigest()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--zip", required=True, type=Path)
    ap.add_argument("--output", type=Path, default=Path("validation") / "12-PACKAGE-INTEGRITY.json")
    args = ap.parse_args()
    args.output.parent.mkdir(parents=True, exist_ok=True)

    zip_path = args.zip
    checks = {}

    checks["exists"] = zip_path.exists()
    if not checks["exists"]:
        print("ZIP missing:", zip_path)
        report = {"result": "FAIL", "checks": checks}
        args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
        return 1

    sha = sha256_file(zip_path)
    checks["sha256_len_64"] = len(sha) == 64
    checks["sha256"] = sha
    checks["size_bytes"] = zip_path.stat().st_size

    bad = []
    names = []
    crc_ok = True
    symlinks = []
    encrypted = []
    abs_paths = []
    traversal = []

    with zipfile.ZipFile(zip_path) as z:
        for info in z.infolist():
            n = info.filename
            names.append(n)
            if not info.flag_bits & 0x1:
                try:
                    z.read(info)
                except Exception as e:
                    crc_ok = False
                    bad.append((n, f"crc_read:{e}"))
            else:
                encrypted.append(n)
            if "\\" in n or (len(n) > 1 and n[1:2] == ":"):
                abs_paths.append(n)
            if n.startswith("/") or n.startswith("//"):
                abs_paths.append(n)
            if ".." in n.split("/"):
                traversal.append(n)
            if info.external_attr >> 16 & 0o170000 == 0o120000:
                symlinks.append(n)
            if info.flag_bits & 0x1:
                encrypted.append(n)

    # detect a single common root prefix (e.g. kaki-learning-final/) so
    # internal SHA256SUMS (which list bare relative paths) and required-dir
    # checks resolve correctly regardless of the packaging root.
    root_prefix = ""
    dir_parts = {n.split("/")[0] for n in names if n.count("/") > 0}
    if len(dir_parts) == 1:
        candidate = next(iter(dir_parts)) + "/"
        if all(n.startswith(candidate) or n == candidate.rstrip("/") for n in names):
            root_prefix = candidate

    checks["zip_crc_pass"] = crc_ok
    checks["no_absolute_paths"] = len(abs_paths) == 0
    checks["no_traversal"] = len(traversal) == 0
    checks["no_symlinks"] = len(symlinks) == 0
    checks["no_encrypted_members"] = len(encrypted) == 0
    if bad:
        checks["crc_failures"] = bad[:10]
    if abs_paths:
        checks["abs_paths"] = abs_paths[:10]
    if traversal:
        checks["traversal"] = traversal[:10]
    if symlinks:
        checks["symlinks"] = symlinks[:10]
    if encrypted:
        checks["encrypted"] = encrypted[:10]

    root_sums = root_prefix + "SHA256SUMS.txt"
    sums_file = root_sums if root_sums in names else next(
        (n for n in names if n.rstrip("/").endswith("/SHA256SUMS.txt") or n == "SHA256SUMS.txt"), None)
    checks["sha256sums_present"] = sums_file is not None
    internal_ok = True
    if sums_file:
        try:
            with zipfile.ZipFile(zip_path) as z:
                sums_text = z.read(sums_file).decode("utf-8", errors="replace")
            expected = {}
            for line in sums_text.splitlines():
                line = line.strip()
                if not line:
                    continue
                parts = line.split(None, 1)
                if len(parts) != 2:
                    continue
                expected[parts[1].lstrip("*")] = parts[0]
            self_key = sums_file.split("/")[-1]
            if self_key in expected:
                internal_ok = False
                checks["sha256sums_includes_self"] = True
            mismatch = []
            with zipfile.ZipFile(zip_path) as z:
                for rel, exp_sha in expected.items():
                    member = root_prefix + rel
                    try:
                        data = z.read(member)
                    except KeyError:
                        mismatch.append((rel, "missing"))
                        continue
                    got = hashlib.sha256(data).hexdigest()
                    if got != exp_sha:
                        mismatch.append((rel, "sha_mismatch"))
            if mismatch:
                internal_ok = False
                checks["sha256sums_mismatch"] = mismatch[:10]
        except Exception as e:
            internal_ok = False
            checks["sha256sums_error"] = str(e)
    checks["internal_sha256sums_pass"] = internal_ok

    # required-dirs gate is SOURCE-specific (backend/frontend/takeover_tools).
    required = []
    if "SOURCE" in zip_path.name.upper():
        required = ["backend", "frontend", "takeover_tools"]
    empty_required = []
    for d in required:
        prefix = root_prefix + d + "/"
        if not any(n.startswith(prefix) and not n.endswith("/") for n in names):
            empty_required.append(d)
    checks["required_dirs_non_empty"] = len(empty_required) == 0
    if empty_required:
        checks["empty_required_dirs"] = empty_required

    all_ok = all(checks.get(k, True) for k in [
        "exists", "sha256_len_64", "zip_crc_pass", "no_absolute_paths",
        "no_traversal", "no_symlinks", "no_encrypted_members",
        "internal_sha256sums_pass", "required_dirs_non_empty",
    ])
    report = {
        "result": "PASS" if all_ok else "FAIL",
        "zip_path": str(zip_path),
        "file_count": len(names),
        "checks": checks,
        "ran_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
    }
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"ZIP_INTEGRITY {report['result']}  files={len(names)} sha={sha[:16]}...")
    for k, v in checks.items():
        if isinstance(v, bool):
            print(f"  {k}: {v}")
    return 0 if all_ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
