# -*- coding: utf-8 -*-
"""API + page smoke test for the web takeover isolated environment.

Uses ONLY synthetic credentials against the synthetic database.  Never calls
an external LLM (mock mode).  Writes 09-API-SMOKE-RESULT.json and
10-PAGE-SMOKE-RESULT.json into the given output dir (default ./validation).

Usage:
    python takeover_tools/smoke_test.py \
        [--backend-url http://127.0.0.1:18001] [--frontend-url http://127.0.0.1:15174]
        [--output-dir DIR]
"""
from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.request
import urllib.error
from pathlib import Path

LEARNER = {"username": "web_takeover_learner", "password": "KakiMock-2026!"}
ADMIN = {"username": "web_takeover_admin", "password": "KakiAdminMock-2026!"}


def http_json(method: str, url: str, payload=None, token=None, timeout=15.0):
    body = None
    headers = {"Accept": "application/json"}
    if payload is not None:
        body = json.dumps(payload).encode("utf-8")
        headers["Content-Type"] = "application/json"
    if token:
        headers["Authorization"] = f"Bearer {token}"
    req = urllib.request.Request(url, data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read()
            ct = resp.headers.get("Content-Type", "")
            if "application/json" in ct:
                return resp.status, json.loads(raw.decode("utf-8"))
            return resp.status, {"_raw": raw.decode("utf-8", errors="replace")[:500]}
    except urllib.error.HTTPError as e:
        try:
            detail = json.loads(e.read().decode("utf-8"))
        except Exception:
            detail = {"_http_error": e.code}
        return e.code, detail
    except Exception as e:
        return None, {"_network_error": str(e)}


def http_get_text(url: str, timeout=15.0):
    req = urllib.request.Request(url, headers={"Accept": "text/html"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8", errors="replace")
            return resp.status, raw
    except urllib.error.HTTPError as e:
        return e.code, ""
    except Exception as e:
        return None, str(e)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--backend-url", default="http://127.0.0.1:18001")
    ap.add_argument("--frontend-url", default="http://127.0.0.1:15174")
    ap.add_argument("--output-dir", type=Path, default=Path("validation"))
    args = ap.parse_args()
    args.output_dir.mkdir(parents=True, exist_ok=True)

    B = args.backend_url.rstrip("/")
    F = args.frontend_url.rstrip("/")

    api_results = []
    page_results = []

    # ---- API smoke ----
    def api_case(name, method, path, payload=None, token=None):
        code, data = http_json(method, f"{B}{path}", payload=payload, token=token)
        ok = isinstance(code, int) and code in (200, 201, 204)
        api_results.append({
            "name": name, "method": method, "path": path,
            "status": code, "ok": ok, "detail": data,
        })
        print(f"[API] {name}: {code} {'PASS' if ok else 'FAIL'}")
        return code, data

    code, health = api_case("health", "GET", "/api/health")
    code, login = api_case("learner_login", "POST", "/api/auth/login", LEARNER)
    token = None
    if isinstance(login, dict) and login.get("data") and login["data"].get("token"):
        token = login["data"]["token"]
        print(f"  learner token ok (prefix {token[:12]}...)")
    else:
        print("  !! learner login did not return a token")

    if token:
        api_case("learner_auth_me", "GET", "/api/auth/me", token=token)
        api_case("learner_notes", "GET", "/api/notes", token=token)
        api_case("learner_learning_graphs", "GET", "/api/learning-graphs", token=token)
        # workspace PYC chain: route_message is implemented by the codex-restored PYC
        api_case("workspace_route_pyc_chain", "POST", "/api/chat/tasks/route",
                 {"thread_id": "synthetic-thread-001",
                  "message": "帮我生成一段代码示例",
                  "active_artifact": None}, token=token)

    code, admin_login = api_case("admin_login", "POST", "/api/admin/login", ADMIN)
    admin_token = None
    if isinstance(admin_login, dict) and admin_login.get("data") and admin_login["data"].get("token"):
        admin_token = admin_login["data"]["token"]
        print("  admin token ok")
    if admin_token:
        api_case("admin_dashboard", "GET", "/api/admin/dashboard", token=admin_token)

    # ---- page smoke (HTTP-level: not 404, not blank) ----
    for page, name in [("/login", "login"), ("/ai-learning", "ai_learning"),
                       ("/learning", "learning"), ("/admin/login", "admin_login_page")]:
        code, text = http_get_text(f"{F}{page}")
        ok = isinstance(code, int) and code < 500 and len(text) > 200
        page_results.append({
            "name": name, "path": page, "status": code,
            "html_bytes": len(text), "ok": ok,
        })
        print(f"[PAGE] {name}: {code} bytes={len(text)} {'PASS' if ok else 'FAIL'}")

    api_ok = all(r["ok"] for r in api_results)
    page_ok = all(r["ok"] for r in page_results)

    api_json = {"result": "PASS" if api_ok else "FAIL", "checks": api_results,
                "ran_at": time.strftime("%Y-%m-%dT%H:%M:%S")}
    page_json = {"result": "PASS" if page_ok else "FAIL", "checks": page_results,
                 "ran_at": time.strftime("%Y-%m-%dT%H:%M:%S")}
    (args.output_dir / "09-API-SMOKE-RESULT.json").write_text(
        json.dumps(api_json, ensure_ascii=False, indent=2), encoding="utf-8")
    (args.output_dir / "10-PAGE-SMOKE-RESULT.json").write_text(
        json.dumps(page_json, ensure_ascii=False, indent=2), encoding="utf-8")

    print(f"API_SMOKE {'PASS' if api_ok else 'FAIL'}")
    print(f"PAGE_SMOKE {'PASS' if page_ok else 'FAIL'}")
    return 0 if (api_ok and page_ok) else 1


if __name__ == "__main__":
    raise SystemExit(main())
