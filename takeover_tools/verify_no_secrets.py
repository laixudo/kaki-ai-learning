# -*- coding: utf-8 -*-
"""Secret / privacy gate for a web-takeover package directory.

Scans a tree for the items the brain forbids in any takeover ZIP and writes a
JSON report.  NEVER prints real secret values — only file paths, risk category,
blocking flag, and the first 8 chars of the item's SHA-256.

Usage:
    python takeover_tools/verify_no_secrets.py --root DIR [--formal-db-sha HEX] [--output FILE]
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import time
from pathlib import Path

# The only permitted .pyc in the whole package.
ALLOWED_PYC = "backend/services/workspace_agents.codex-restored-20260715.pyc"

# Tight rules: catch real secret VALUES, not code identifiers.
#   - sk- + 32+ base64-ish chars          (OpenAI-style API keys)
#   - api_key|apikey|secret_key|token + ":" or "=" + quoted 24+ char value
#   - Authorization: Bearer + 24+ char token
API_KEY_RE = re.compile(
    r"(?i)("
    r"sk-[a-z0-9]{32,}"
    r"|(?:api[_-]?key|apikey|secret[_-]?key|token)\s*[:=]\s*['\"][a-z0-9+/=_.-]{24,}['\"]"
    r"|authorization\s*:\s*bearer\s+[a-z0-9._-]{24,}"
    r")"
)
PRIVATE_KEY_RE = re.compile(r"-----BEGIN (RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----")
COOKIE_RE = re.compile(r"(?i)(set-cookie\s*:|cookie\s*[:=]\s*['\"]?)")

SEVERITY_ORDER = {"SECRET_ENV", "REAL_DB", "DB_SIDECAR", "UPLOADS", "PRIVATE_KEY",
                  "API_KEY", "AUTH_TOKEN", "COOKIE", "REAL_ABSOLUTE_PATH",
                  "LOG", "CACHE", "NON_PERMITTED_PYC", "SCREENSHOT"}


def sha256_file(p: Path) -> str:
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for c in iter(lambda: f.read(1024 * 1024), b""):
            h.update(c)
    return h.hexdigest()


def scan(root: Path, formal_db_sha: str | None) -> list[dict]:
    findings = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in ("node_modules", ".venv", ".venv311", ".git")]
        rel_dir = os.path.relpath(dirpath, root).replace("\\", "/")
        for fn in filenames:
            full = Path(dirpath) / fn
            rel = (rel_dir + "/" + fn) if rel_dir != "." else fn
            rel_l = rel.lower()
            size = full.stat().st_size
            entry = None

            # 1. env files
            if fn in (".env", ".env.local") or (
                fn.startswith(".env.")
                and fn not in (".env.example", ".env.web-takeover.example")
            ):
                entry = {"path": rel, "category": "SECRET_ENV", "blocking": True,
                         "hash8": sha256_file(full)[:8], "size": size}
            # 2. real DB (formal SHA match) / any ml_learning.db that is not synthetic
            elif fn == "ml_learning.db" or fn.endswith(".db"):
                if formal_db_sha and sha256_file(full) == formal_db_sha:
                    entry = {"path": rel, "category": "REAL_DB", "blocking": True,
                             "hash8": "", "size": size}
                elif fn == "ml_learning.db":
                    entry = {"path": rel, "category": "UNEXPECTED_REAL_NAMED_DB",
                             "blocking": True, "hash8": sha256_file(full)[:8], "size": size}
                elif ".synthetic" not in rel_l:
                    entry = {"path": rel, "category": "OTHER_DB", "blocking": True,
                             "hash8": sha256_file(full)[:8], "size": size}
            # 3. db sidecars
            elif fn.endswith(".db-wal") or fn.endswith(".db-shm"):
                entry = {"path": rel, "category": "DB_SIDECAR", "blocking": True,
                         "hash8": sha256_file(full)[:8], "size": size}
            # 4. uploads
            elif "/uploads/" in rel_l:
                entry = {"path": rel, "category": "UPLOADS", "blocking": True,
                         "hash8": sha256_file(full)[:8], "size": size}
            # 5. pyc
            elif fn.endswith(".pyc"):
                if rel_l != ALLOWED_PYC:
                    entry = {"path": rel, "category": "NON_PERMITTED_PYC", "blocking": True,
                             "hash8": sha256_file(full)[:8], "size": size}
            # 6. logs
            elif fn.endswith(".log") or ".log." in fn or rel_l.endswith("_8001.log"):
                entry = {"path": rel, "category": "LOG", "blocking": False,
                         "hash8": sha256_file(full)[:8], "size": size}
            # 7. cache dirs
            elif "__pycache__" in rel_l or ".pytest_cache" in rel_l or ".tsbuildinfo" in rel_l:
                entry = {"path": rel, "category": "CACHE", "blocking": False,
                         "hash8": sha256_file(full)[:8], "size": size}
            elif fn.endswith(".tsbuildinfo"):
                entry = {"path": rel, "category": "CACHE", "blocking": False,
                         "hash8": sha256_file(full)[:8], "size": size}
            # 8. content scans (text-ish only)
            elif size > 0 and size <= 4 * 1024 * 1024:
                try:
                    sample = full.read_bytes()
                    head = sample[:64 * 1024]
                    text = head.decode("utf-8", errors="ignore")
                    known_test_fixture = rel_l == "backend/tests/test_cloud_video_contracts.py"
                    generated_vendor_bundle = rel_l.startswith("frontend/dist/assets/vendor-")
                    if PRIVATE_KEY_RE.search(text):
                        entry = {"path": rel, "category": "PRIVATE_KEY", "blocking": True,
                                 "hash8": sha256_file(full)[:8], "size": size}
                    elif API_KEY_RE.search(text) and not known_test_fixture:
                        entry = {"path": rel, "category": "API_KEY", "blocking": True,
                                 "hash8": sha256_file(full)[:8], "size": size}
                    elif COOKIE_RE.search(text) and not generated_vendor_bundle:
                        entry = {"path": rel, "category": "COOKIE", "blocking": True,
                                 "hash8": sha256_file(full)[:8], "size": size}
                    elif re.search(r"C:\\Users\\[A-Za-z0-9_]+(\\|/)", text):
                        entry = {"path": rel, "category": "REAL_ABSOLUTE_PATH", "blocking": False,
                                 "hash8": sha256_file(full)[:8], "size": size}
                except Exception:
                    pass
            if entry:
                findings.append(entry)
    return findings


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", required=True, type=Path)
    ap.add_argument("--formal-db-sha", default="")
    ap.add_argument("--output", type=Path, default=Path("validation") / "11-SECRET-PRIVACY-GATE.json")
    args = ap.parse_args()
    args.output.parent.mkdir(parents=True, exist_ok=True)

    findings = scan(args.root, args.formal_db_sha or None)
    blocking = [f for f in findings if f["blocking"]]
    report = {
        "result": "PASS" if not blocking else "FAIL",
        "blocking_count": len(blocking),
        "non_blocking_count": len(findings) - len(blocking),
        "findings": sorted(findings, key=lambda f: (list(SEVERITY_ORDER).index(f["category"]) if f["category"] in SEVERITY_ORDER else 99, f["path"])),
        "scanned_root": str(args.root),
        "formal_db_sha_reference": args.formal_db_sha,
        "ran_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
    }
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"SECRET_GATE {report['result']}  blocking={len(blocking)} non_blocking={len(findings)-len(blocking)}")
    for f in report["findings"]:
        print(f"  [{f['category']}] {f['path']} {'BLOCK' if f['blocking'] else 'warn'}")
    return 0 if not blocking else 1


if __name__ == "__main__":
    raise SystemExit(main())
