from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
ROUTER = (ROOT / "routers" / "workspace_agents.py").read_text(encoding="utf-8")
API = (ROOT.parent / "frontend" / "src" / "api" / "artifacts.ts").read_text(encoding="utf-8")


def test_code_run_routes_and_required_identity_fields_are_wired():
    assert '@router.post("/code/{artifact_id}/rerun")' in ROUTER
    assert '@router.get("/code/{artifact_id}/runs")' in ROUTER
    assert '@router.get("/code/{artifact_id}/runs/{run_id}")' in ROUTER
    for field in ("artifact_version_id", "execution_request_id", "idempotency_key", "parameters"):
        assert field in ROUTER
    assert "execute_code_version(" in ROUTER
    assert "list_code_runs(" in ROUTER
    assert "get_code_run(" in ROUTER
    assert "/api/chat/tasks/code/${artifactId}/rerun" in API


def test_interactive_attempt_routes_use_server_judgment_contract():
    assert '@router.post("/presentations/{artifact_id}/attempts")' in ROUTER
    assert '@router.get("/presentations/{artifact_id}/attempts/state")' in ROUTER
    assert '@router.post("/presentations/{artifact_id}/attempts/hint")' in ROUTER
    assert '@router.post("/presentations/{artifact_id}/attempts/solution")' in ROUTER
    for field in ("artifact_version_id", "item_identity", "selected_answer", "submission_request_id", "idempotency_key"):
        assert field in ROUTER
    assert "submit_interactive_answer(" in ROUTER
    assert "get_interactive_state(" in ROUTER
    # Trust boundary: the request schema does not accept correctness or mastery claims.
    schema = ROUTER.split("class InteractiveAnswerRequest", 1)[1].split("class InteractiveSupportRequest", 1)[0]
    for forbidden in ("correct:", "score:", "mastered:", "evaluation_passed:"):
        assert forbidden not in schema
    assert "/api/chat/tasks/presentations/${artifactId}/attempts" in API
