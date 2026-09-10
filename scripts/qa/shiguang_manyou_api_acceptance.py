from __future__ import annotations

import argparse
import json
from datetime import datetime
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen


def request(base: str, path: str, *, token: str | None = None, body: dict | None = None) -> tuple[int, dict]:
    headers = {"Accept": "application/json"}
    data = None
    if token:
        headers["Authorization"] = f"Bearer {token}"
    if body is not None:
        headers["Content-Type"] = "application/json; charset=utf-8"
        data = json.dumps(body, ensure_ascii=False).encode("utf-8")
    req = Request(f"{base.rstrip('/')}{path}", headers=headers, data=data, method="POST" if body is not None else "GET")
    try:
        with urlopen(req, timeout=20) as response:
            return response.status, json.loads(response.read().decode("utf-8"))
    except HTTPError as error:
        detail = error.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"{path} returned HTTP {error.code}: {detail}") from error


def main() -> int:
    parser = argparse.ArgumentParser(description="拾光漫游真实 HTTP 链路验收")
    parser.add_argument("--base", default="http://127.0.0.1:8001")
    parser.add_argument("--report", type=Path)
    args = parser.parse_args()

    stamp = datetime.now().strftime("%Y%m%d%H%M%S%f")
    username = f"manyou_accept_{stamp}"
    password = "Manyou!2026"
    register_status, register = request(args.base, "/api/auth/register", body={
        "username": username,
        "password": password,
        "email": f"{username}@example.test",
    })
    token = register["data"]["token"]

    health_status, health = request(args.base, "/api/health")
    notes_status, notes = request(args.base, "/api/notes", token=token)
    start_status, start = request(args.base, "/api/adventure/start", token=token, body={
        "topic": "机器学习模型评估",
        "magic_school": "wood",
        "source_ids": ["qa-path-node"],
        "thread_id": f"qa-{stamp}",
        "source_type": "learning_path",
    })
    game = start["data"]
    run_id = game["run_id"]
    state_path = [game["state"]]

    def advance(action: str, payload: dict | None = None) -> dict:
        status, response = request(args.base, "/api/adventure/advance", token=token, body={
            "run_id": run_id,
            "action": action,
            "payload": payload or {},
        })
        if status != 200:
            raise RuntimeError(f"advance {action} returned {status}")
        return response["data"]

    game = advance("continue")
    state_path.append(game["state"])
    game = advance("continue")
    state_path.append(game["state"])
    game = advance("choose_strategy", {"choice": "practice", "method": "做中学"})
    state_path.append(game["state"])
    game = advance("submit", {"answer": game["content"]["practice"]["trial"]["options"][0]})
    state_path.append(game["state"])
    game = advance("continue")
    state_path.append(game["state"])
    game = advance("submit", {"answer": "我会用正则化减少过拟合"})
    state_path.append(game["state"])
    game = advance("submit", {"answer": "泛化能力是模型在未见新数据上的表现"})
    boss_stage_one = game["archive"]["boss_stage"]
    game = advance("submit", {"answer": game["content"]["boss"][1]["options"][0]})
    boss_stage_two = game["archive"]["boss_stage"]
    game = advance("submit", {"answer": "这是过拟合，我会使用早停来改善泛化"})
    state_path.append(game["state"])
    game = advance("claim")
    state_path.append(game["state"])
    current_status, current = request(args.base, "/api/adventure/current", token=token)

    report = {
        "status": "PASS",
        "base_url": args.base,
        "user_id": register["data"]["user_id"],
        "username": username,
        "http": {
            "register": register_status,
            "health": health_status,
            "notes_get": notes_status,
            "adventure_start": start_status,
            "adventure_current_after_claim": current_status,
        },
        "health_payload": health,
        "notes_count": len(notes.get("data", notes) or []),
        "run_id": run_id,
        "state_path": state_path,
        "boss_stages": [boss_stage_one, boss_stage_two, game["archive"]["boss_stage"]],
        "node_count": len(game["nodes"]),
        "all_nodes_completed": all(node["status"] == "completed" for node in game["nodes"]),
        "artifact_id": game["artifact_id"],
        "current_after_claim": current["data"],
    }
    if not (report["artifact_id"] and report["all_nodes_completed"] and report["current_after_claim"] is None):
        report["status"] = "FAIL"
    text = json.dumps(report, ensure_ascii=False, indent=2)
    if args.report:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(text + "\n", encoding="utf-8")
    print(text)
    return 0 if report["status"] == "PASS" else 1


if __name__ == "__main__":
    raise SystemExit(main())
