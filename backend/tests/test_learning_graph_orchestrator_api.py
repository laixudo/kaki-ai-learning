from __future__ import annotations

import sys
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from pydantic import ValidationError
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from services.workspace_agent_adapters import AGENT_ADAPTERS
from services.workspace_semantic_router import parse_semantic_route, route_semantically
from services.workspace_task_contracts import (
    AgentType,
    SemanticAction,
    SemanticRoute,
    TaskState,
)
from services.workspace_task_machine import advance_task
from agents.learning_graph_orchestrator.enums import Severity
from agents.learning_graph_orchestrator.enums import ResourcePlanStatus
from agents.learning_graph_orchestrator.models import (
    LearningGraphRequest,
    ValidationIssue,
    ValidationReport,
)
from agents.learning_graph_orchestrator.runner import (
    ExistingGraphContractError,
    SourceContractError,
)
from agents.learning_graph_orchestrator.compiler import compile_blueprint
from agents.learning_graph_orchestrator.fallback import build_fallback_candidate
from database import models
from routers import learning_graph as graph_api
from routers import workspace_agents as workspace_api
from services import learning_graph_orchestrator_integration as graph_integration
from services.workspace_task_contracts import AgentTask
from services.workspace_task_store import fail_task, save_task


def _orchestrate_request(**updates):
    values = {
        "request_id": "request-api-1",
        "idempotency_key": "execution-api-1",
        "thread_id": "thread-api-1",
        "user_goal": "Master derivatives",
        "domain": "mathematics",
    }
    values.update(updates)
    return graph_api.OrchestrateGraphRequest.model_validate(values)


def _contract_report(code: str) -> ValidationReport:
    return ValidationReport(
        valid=False,
        issues=[
            ValidationIssue(
                code=code,
                severity=Severity.ERROR,
                path="$.source_contract",
                message="contract rejected",
                repairable=False,
            )
        ],
    )


def _persistence_blueprint(request_id: str):
    request = LearningGraphRequest.model_validate(
        graph_integration.build_topic_request_payload(
            request_id=request_id,
            topic="Understand derivatives and optimization",
            domain="mathematics",
        )
    )
    return compile_blueprint(
        request,
        build_fallback_candidate(request),
        fallback_used=True,
    )


async def _api_test_database():
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as connection:
        await connection.run_sync(models.Base.metadata.create_all)
    return engine, async_sessionmaker(engine, expire_on_commit=False)


def test_learning_graph_is_a_registered_workspace_agent_type():
    assert AgentType.LEARNING_GRAPH.value == "learning_graph"


def test_learning_graph_adapter_owns_only_the_formal_task_slots():
    adapter = AGENT_ADAPTERS[AgentType.LEARNING_GRAPH]

    assert adapter.required_slots == ("user_goal", "domain")
    assert adapter.optional_slots == (
        "source_material_ids",
        "update_mode",
        "graph_id",
        "graph_revision",
        "replaced_source_ref_ids",
    )
    assert adapter.initial_slots() == {
        "source_material_ids": [],
        "update_mode": "CREATE",
        "graph_id": None,
        "graph_revision": 0,
        "replaced_source_ref_ids": [],
    }


def test_learning_graph_adapter_rejects_unknown_slots():
    adapter = AGENT_ADAPTERS[AgentType.LEARNING_GRAPH]

    with pytest.raises(ValueError, match="unsupported slots: private_profile"):
        adapter.normalise_updates(
            {
                "user_goal": "掌握导数与优化",
                "domain": "math",
                "private_profile": {"student_name": "should-not-pass"},
            }
        )


def test_learning_graph_task_requires_confirmation_then_runs_once_with_execution_key():
    agent_type = AgentType.LEARNING_GRAPH
    create = SemanticRoute(
        action=SemanticAction.NEW_TASK,
        agent_type=agent_type,
        slot_updates={
            "user_goal": "掌握导数与优化",
            "domain": "math",
            "source_material_ids": ["material-7"],
            "update_mode": "CREATE",
            "graph_id": None,
            "graph_revision": 0,
            "replaced_source_ref_ids": [],
        },
        confidence=0.99,
        reason_code="learning_graph_request",
    )

    confirmation = advance_task(None, create, user_id=17, thread_id="thread-lg")

    assert confirmation.execute is False
    assert confirmation.task is not None
    assert confirmation.task.state == TaskState.AWAITING_CONFIRMATION
    assert confirmation.reply

    confirmed = advance_task(
        confirmation.task,
        SemanticRoute(
            action=SemanticAction.CONFIRM,
            agent_type=agent_type,
            slot_updates={},
            confidence=0.99,
            reason_code="explicit_confirmation",
        ),
        user_id=17,
        thread_id="thread-lg",
    )

    assert confirmed.execute is True
    assert confirmed.mode == "execute"
    assert confirmed.task is not None
    assert confirmed.task.state == TaskState.RUNNING
    assert confirmed.task.execution_key == (
        f"{confirmed.task.task_id}:{confirmed.task.version}"
    )
    assert confirmed.execution_payload == create.slot_updates


def test_semantic_route_parser_accepts_learning_graph_agent_type():
    route = parse_semantic_route(
        {
            "action": "new_task",
            "agent_type": "learning_graph",
            "artifact_operation": None,
            "target_artifact_id": None,
            "slot_updates": {
                "user_goal": "建立线性代数学习图谱",
                "domain": "math",
            },
            "confidence": 0.98,
            "reason_code": "learning_graph_request",
        }
    )

    assert route.agent_type is AgentType.LEARNING_GRAPH


@pytest.mark.asyncio
async def test_explicit_english_learning_graph_request_survives_execution_gate():
    class RouterLLM:
        async def chat(self, **kwargs):
            return {"content": """{
              "action":"new_task",
              "agent_type":"learning_graph",
              "artifact_operation":null,
              "target_artifact_id":null,
              "slot_updates":{"user_goal":"master quadratic functions","domain":"mathematics"},
              "confidence":0.99,
              "reason_code":"learning_graph_request"
            }"""}

    route = await route_semantically(
        message="Create a formal learning graph to master quadratic functions.",
        llm=RouterLLM(),
    )

    assert route.action is SemanticAction.NEW_TASK
    assert route.agent_type is AgentType.LEARNING_GRAPH


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("message", "update_mode"),
    [
        ("Extend this learning graph with conditional probability.", "EXTEND"),
        ("Revise this learning graph to focus on Bayes theorem.", "REVISE"),
        ("Merge this learning graph with probability distributions.", "MERGE"),
        ("请把这个学习图谱扩展到条件概率。", "EXTEND"),
        ("请将这个学习图谱修订为以贝叶斯定理为重点。", "REVISE"),
        (
            "Replace the source for this learning graph with the selected material.",
            "REPLACE_SOURCE",
        ),
    ],
)
async def test_explicit_learning_graph_update_overrides_normal_chat_route(
    message, update_mode,
):
    class NormalChatRouterLLM:
        async def chat(self, **kwargs):
            return {"content": """{
              "action":"normal_chat",
              "agent_type":null,
              "artifact_operation":null,
              "target_artifact_id":null,
              "slot_updates":{},
              "confidence":0.61,
              "reason_code":"ordinary_conversation"
            }"""}

    route = await route_semantically(
        message=message,
        llm=NormalChatRouterLLM(),
        artifact_candidates=[{
            "kind": "learning_graph",
            "graph_id": "graph-existing-1",
            "graph_revision": 2,
            "title": "Probability foundations",
            "user_goal": "Master probability",
            "domain": "mathematics",
        }],
    )

    assert route.action is SemanticAction.NEW_TASK
    assert route.agent_type is AgentType.LEARNING_GRAPH
    assert route.slot_updates["update_mode"] == update_mode
    assert route.slot_updates["user_goal"] == message
    assert route.slot_updates["domain"] == "mathematics"


@pytest.mark.asyncio
async def test_plan_update_binds_the_requested_persisted_graph_not_the_latest(monkeypatch):
    graph_a = {
        "kind": "learning_graph",
        "graph_id": "graph-a",
        "graph_revision": 1,
        "title": "Graph A",
        "user_goal": "Learn A",
        "domain": "mathematics",
        "source_ref_ids": ["topic-a"],
    }
    graph_b = {
        "kind": "learning_graph",
        "graph_id": "graph-b",
        "graph_revision": 3,
        "title": "Graph B",
        "user_goal": "Learn B",
        "domain": "biology",
        "source_ref_ids": ["topic-b"],
    }
    session = SimpleNamespace(messages=[
        {"role": "assistant", "artifact": graph_a},
        {"role": "assistant", "artifact": graph_b},
    ])

    async def fake_route(**kwargs):
        return SemanticRoute(
            action=SemanticAction.NEW_TASK,
            agent_type=AgentType.LEARNING_GRAPH,
            slot_updates={
                "user_goal": "Revise the selected learning graph",
                "domain": "mathematics",
                "update_mode": "REVISE",
                "graph_id": "model-invented-id",
                "graph_revision": 999,
            },
            confidence=0.99,
            reason_code="learning_graph_request",
        )

    async def fake_save(_db, task):
        return task

    async def fake_append(*args, **kwargs):
        return None

    async def no_current(*args, **kwargs):
        return None

    async def fake_owned(*args, **kwargs):
        return session

    monkeypatch.setattr(workspace_api, "_owned_session", fake_owned)
    monkeypatch.setattr(workspace_api, "load_current_task", no_current)
    monkeypatch.setattr(workspace_api, "route_semantically", fake_route)
    monkeypatch.setattr(workspace_api, "save_task", fake_save)
    monkeypatch.setattr(workspace_api, "_append", fake_append)
    monkeypatch.setattr(workspace_api, "begin_runtime_operation", lambda *args: None)
    monkeypatch.setattr(workspace_api, "complete_runtime_operation", lambda *args: None)

    result = await workspace_api.plan_task(
        workspace_api.PlanRequest(
            thread_id="thread-two-graphs",
            message="Revise this learning graph.",
            active_artifact=graph_a,
        ),
        user_id=731,
        db=object(),
    )

    task = result["data"]["task"]
    assert task["graph_id"] == "graph-a"
    assert task["graph_revision"] == 1
    assert task["domain"] == "mathematics"


def test_multi_graph_conversation_requires_an_explicit_persisted_selection():
    session = SimpleNamespace(messages=[
        {"artifact": {
            "kind": "learning_graph",
            "graph_id": "graph-a",
            "graph_revision": 1,
        }},
        {"artifact": {
            "kind": "learning_graph",
            "graph_id": "graph-b",
            "graph_revision": 1,
        }},
    ])

    assert workspace_api._trusted_learning_graph_artifact(session, None) is None
    assert workspace_api._trusted_learning_graph_artifact(
        session,
        {"kind": "learning_graph", "graph_id": "graph-not-persisted"},
    ) is None


@pytest.mark.asyncio
async def test_failed_task_retry_rotates_execution_key_without_changing_confirmed_slots(monkeypatch):
    from services import workspace_task_store

    task = AgentTask(
        task_id="task-retry-graph",
        user_id=731,
        thread_id="thread-retry-graph",
        agent_type=AgentType.LEARNING_GRAPH,
        slots={"user_goal": "Probability", "domain": "mathematics"},
        state=TaskState.FAILED,
        version=2,
        confirmed_version=2,
        execution_key="task-retry-graph:2",
        error_code="UnrecoverableFallbackError",
    )

    async def fake_save(_db, value):
        return value

    monkeypatch.setattr(workspace_task_store, "save_task", fake_save)
    first = await workspace_task_store.retry_failed_task(object(), task)
    assert first.state is TaskState.RUNNING
    assert first.version == first.confirmed_version == 2
    assert first.execution_key == "task-retry-graph:2:retry:1"
    assert first.slots == task.slots

    first.state = TaskState.FAILED
    second = await workspace_task_store.retry_failed_task(object(), first)
    assert second.execution_key == "task-retry-graph:2:retry:2"


def test_orchestrate_graph_request_forbids_unknown_fields():
    with pytest.raises(ValidationError) as exc_info:
        _orchestrate_request(private_profile={"student_name": "must-not-pass"})

    errors = exc_info.value.errors()
    assert any(
        error["type"] == "extra_forbidden"
        and error["loc"] == ("private_profile",)
        for error in errors
    )


def test_orchestrate_route_precedes_dynamic_graph_id_route():
    route_paths = [route.path for route in graph_api.router.routes]

    assert route_paths.index("/api/learning-graphs/orchestrate") < route_paths.index(
        "/api/learning-graphs/{graph_id}"
    )


@pytest.mark.asyncio
async def test_orchestrate_graph_uses_authenticated_user(monkeypatch):
    db = object()
    formal_request = object()
    calls = []

    async def fake_build_formal_request(received_db, **kwargs):
        calls.append(("build", received_db, kwargs))
        return formal_request

    async def fake_orchestrate_and_save(received_db, **kwargs):
        calls.append(("save", received_db, kwargs))
        return {"graph_id": "graph-12", "status": "valid"}

    monkeypatch.setattr(graph_api, "build_formal_request", fake_build_formal_request)
    monkeypatch.setattr(graph_api, "orchestrate_and_save", fake_orchestrate_and_save)

    response = await graph_api.orchestrate_graph(
        _orchestrate_request(), current_user_id=731, db=db
    )

    assert response["success"] is True
    assert response["validation"] == {"valid": True}
    assert calls[0][0:2] == ("build", db)
    assert calls[0][2]["user_id"] == 731
    assert calls[0][2]["thread_id"] == "thread-api-1"
    assert calls[1] == (
        "save",
        db,
        {
            "user_id": 731,
            "request": formal_request,
            "idempotency_key": "execution-api-1",
        },
    )


@pytest.mark.asyncio
async def test_unsafe_source_stops_before_provider_or_persistence(monkeypatch):
    provider_or_persistence_calls = []

    async def reject_unsafe_source(*args, **kwargs):
        raise SourceContractError(_contract_report("SOURCE_ID_INVALID"))

    async def must_not_orchestrate(*args, **kwargs):
        provider_or_persistence_calls.append((args, kwargs))
        raise AssertionError("unsafe source reached provider/persistence")

    monkeypatch.setattr(graph_api, "build_formal_request", reject_unsafe_source)
    monkeypatch.setattr(graph_api, "orchestrate_and_save", must_not_orchestrate)

    with pytest.raises(HTTPException) as exc_info:
        await graph_api.orchestrate_graph(
            _orchestrate_request(source_material_ids=["C:/private/student.txt"]),
            current_user_id=731,
            db=object(),
        )

    assert provider_or_persistence_calls == []
    assert exc_info.value.status_code == 422
    assert exc_info.value.detail == {
        "code": "SourceContractError",
        "issues": ["SOURCE_ID_INVALID"],
        "message": "learning graph contract rejected",
    }


@pytest.mark.asyncio
async def test_formal_api_does_not_return_internal_value_error_text(monkeypatch):
    private_text = "private source summary input_value must stay internal"

    async def reject_internal(*args, **kwargs):
        raise ValueError(private_text)

    monkeypatch.setattr(graph_api, "build_formal_request", reject_internal)
    with pytest.raises(HTTPException) as exc_info:
        await graph_api.orchestrate_graph(
            _orchestrate_request(),
            current_user_id=731,
            db=object(),
        )

    assert exc_info.value.status_code == 422
    assert exc_info.value.detail == {
        "code": "LEARNING_GRAPH_INVALID",
        "message": "learning graph request is invalid",
    }
    assert private_text not in str(exc_info.value.detail)


@pytest.mark.asyncio
async def test_workspace_api_does_not_return_internal_value_error_text(monkeypatch):
    private_text = "private source title input_value must stay internal"
    task = AgentTask(
        task_id="task-private-value-error",
        user_id=731,
        thread_id="thread-private-value-error",
        agent_type=AgentType.LEARNING_GRAPH,
        slots={
            "user_goal": "Probability",
            "domain": "mathematics",
            "update_mode": "CREATE",
        },
        state=TaskState.RUNNING,
        version=1,
        confirmed_version=1,
        execution_key="task-private-value-error:1",
    )

    async def fake_owned(*args, **kwargs):
        return object()

    async def fake_execution(*args, **kwargs):
        return task

    async def reject_internal(*args, **kwargs):
        raise ValueError(private_text)

    async def fake_fail(*args, **kwargs):
        return task

    monkeypatch.setattr(workspace_api, "_owned_session", fake_owned)
    monkeypatch.setattr(workspace_api, "_execution_task", fake_execution)
    monkeypatch.setattr(workspace_api, "fail_persisted_task", fake_fail)
    monkeypatch.setattr(workspace_api, "begin_runtime_operation", lambda *args: None)
    monkeypatch.setattr(workspace_api, "fail_runtime_operation", lambda *args: None)
    monkeypatch.setattr(
        "services.learning_graph_orchestrator_integration.build_formal_request",
        reject_internal,
    )

    with pytest.raises(HTTPException) as exc_info:
        await workspace_api.generate_learning_graph(
            workspace_api.LearningGraphAgentRequest(
                thread_id=task.thread_id,
                task_id=task.task_id,
                task_version=task.version,
            ),
            user_id=731,
            db=object(),
        )

    assert exc_info.value.status_code == 422
    assert exc_info.value.detail == {
        "code": "LEARNING_GRAPH_INVALID",
        "message": "learning graph request is invalid",
    }
    assert private_text not in str(exc_info.value.detail)


@pytest.mark.parametrize(
    "payload",
    [
        {"execution_key": "execution-resource-1"},
        {"thread_id": "thread-resource-1"},
    ],
)
def test_resource_materialize_and_retry_contracts_require_thread_and_execution_key(
    payload,
):
    with pytest.raises(ValidationError):
        graph_api.ResourceMaterializeRequest.model_validate(payload)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("endpoint_name", "service_name"),
    [
        ("materialize_formal_resource", "materialize_resource_plan"),
        ("retry_formal_resource", "retry_resource_generation"),
    ],
)
async def test_resource_endpoints_resolve_and_pass_exact_graph_node_and_plan_ids(
    monkeypatch, endpoint_name, service_name
):
    db = object()
    resolve_calls = []
    service_calls = []

    async def fake_resolve(received_db, **kwargs):
        resolve_calls.append((received_db, kwargs))
        return 101, 202, 303

    async def fake_service(received_db, **kwargs):
        service_calls.append((received_db, kwargs))
        return SimpleNamespace(id=404)

    monkeypatch.setattr(graph_api, "resolve_resource_record_ids", fake_resolve)
    monkeypatch.setattr(graph_api, service_name, fake_service)

    response = await getattr(graph_api, endpoint_name)(
        "graph-public-1",
        "node-public-2",
        "plan-public-3",
        graph_api.ResourceMaterializeRequest(
            thread_id="thread-resource-1",
            execution_key="execution-resource-1",
        ),
        current_user_id=731,
        db=db,
    )

    assert resolve_calls == [
        (
            db,
            {
                "user_id": 731,
                "graph_id": "graph-public-1",
                "node_id": "node-public-2",
                "resource_plan_id": "plan-public-3",
            },
        )
    ]
    assert service_calls == [
        (
            db,
            {
                "user_id": 731,
                "thread_id": "thread-resource-1",
                "graph_id": 101,
                "node_id": 202,
                "resource_plan_id": 303,
                "execution_key": "execution-resource-1",
            },
        )
    ]
    assert response == {
        "success": True,
        "data": {
            "artifact_id": 404,
            "resource_plan_id": "plan-public-3",
            "status": "generated",
        },
    }


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("endpoint_name", "service_name", "public_code", "public_message"),
    [
        (
            "materialize_formal_resource",
            "materialize_resource_plan",
            "RESOURCE_GENERATION_CONFLICT",
            "resource generation conflicts with persisted state",
        ),
        (
            "retry_formal_resource",
            "retry_resource_generation",
            "RESOURCE_RETRY_CONFLICT",
            "resource retry conflicts with persisted state",
        ),
    ],
)
async def test_resource_endpoints_do_not_return_internal_value_error_text(
    monkeypatch, endpoint_name, service_name, public_code, public_message,
):
    private_text = "private generation_spec input_value must stay internal"

    async def fake_resolve(*args, **kwargs):
        return 101, 202, 303

    async def reject_internal(*args, **kwargs):
        raise ValueError(private_text)

    monkeypatch.setattr(graph_api, "resolve_resource_record_ids", fake_resolve)
    monkeypatch.setattr(graph_api, service_name, reject_internal)
    with pytest.raises(HTTPException) as exc_info:
        await getattr(graph_api, endpoint_name)(
            "graph-public-1",
            "node-public-2",
            "plan-public-3",
            graph_api.ResourceMaterializeRequest(
                thread_id="thread-resource-1",
                execution_key="execution-resource-1",
            ),
            current_user_id=731,
            db=object(),
        )

    assert exc_info.value.status_code == 409
    assert exc_info.value.detail == {
        "code": public_code,
        "message": public_message,
    }
    assert private_text not in str(exc_info.value.detail)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("error_type", "code"),
    [
        (SourceContractError, "SOURCE_SCOPE_INVALID"),
        (ExistingGraphContractError, "GRAPH_REVISION_MISMATCH"),
    ],
)
async def test_contract_errors_are_structured_and_never_return_invalid_success(
    monkeypatch, error_type, code
):
    async def fake_build(*args, **kwargs):
        if error_type is SourceContractError:
            raise error_type(_contract_report(code))
        return object()

    async def fake_orchestrate(*args, **kwargs):
        raise error_type(_contract_report(code))

    monkeypatch.setattr(graph_api, "build_formal_request", fake_build)
    monkeypatch.setattr(graph_api, "orchestrate_and_save", fake_orchestrate)

    with pytest.raises(HTTPException) as exc_info:
        await graph_api.orchestrate_graph(
            _orchestrate_request(), current_user_id=731, db=object()
        )

    assert exc_info.value.status_code == 422
    assert exc_info.value.detail["code"] == error_type.__name__
    assert exc_info.value.detail["issues"] == [code]
    assert exc_info.value.detail.get("success") is not True
    assert exc_info.value.detail.get("valid") is not False


@pytest.mark.asyncio
async def test_workspace_learning_graph_endpoint_executes_only_the_confirmed_task(monkeypatch):
    task = AgentTask(
        task_id="task-learning-graph-1",
        user_id=731,
        thread_id="thread-api-1",
        agent_type=AgentType.LEARNING_GRAPH,
        slots={
            "user_goal": "掌握导数与优化",
            "domain": "数学",
            "source_material_ids": [],
            "update_mode": "CREATE",
            "graph_id": None,
            "graph_revision": 0,
            "replaced_source_ref_ids": [],
        },
        state=TaskState.RUNNING,
        version=2,
        confirmed_version=2,
        execution_key="learning-graph-execution-1",
    )
    calls = []

    async def fake_owned(*args, **kwargs):
        return object()

    async def fake_execution(*args, **kwargs):
        calls.append(("execution", args[1:]))
        return task

    async def fake_build(*args, **kwargs):
        calls.append(("build", kwargs))
        return object()

    async def fake_orchestrate(*args, **kwargs):
        calls.append(("orchestrate", kwargs))
        return {
            "graph_id": "graph-public-1",
            "graph_revision": 1,
            "graph_title": "导数学习图谱",
            "status": "valid",
            "nodes": [{"node_id": "node-1"}],
        }

    async def fake_append(*args, **kwargs):
        calls.append(("append", args[-1]))

    async def fake_save(*args, **kwargs):
        calls.append(("save", args[-1].state))
        return args[-1]

    monkeypatch.setattr(workspace_api, "_owned_session", fake_owned)
    monkeypatch.setattr(workspace_api, "_execution_task", fake_execution)
    monkeypatch.setattr(workspace_api, "_append", fake_append)
    monkeypatch.setattr(workspace_api, "save_task", fake_save)
    monkeypatch.setattr(workspace_api, "begin_runtime_operation", lambda *args: None)
    monkeypatch.setattr(workspace_api, "complete_runtime_operation", lambda *args: None)
    monkeypatch.setattr(
        "services.learning_graph_orchestrator_integration.build_formal_request",
        fake_build,
    )
    monkeypatch.setattr(
        "services.learning_graph_orchestrator_integration.orchestrate_and_save",
        fake_orchestrate,
    )

    result = await workspace_api.generate_learning_graph(
        workspace_api.LearningGraphAgentRequest(
            thread_id="thread-api-1",
            task_id="task-learning-graph-1",
            task_version=2,
        ),
        user_id=731,
        db=object(),
    )

    build_call = next(value for name, value in calls if name == "build")
    orchestrate_call = next(value for name, value in calls if name == "orchestrate")
    assert build_call["user_id"] == 731
    assert build_call["thread_id"] == "thread-api-1"
    assert orchestrate_call["user_id"] == 731
    assert orchestrate_call["idempotency_key"] == "learning-graph-execution-1"
    assert task.state == TaskState.COMPLETED
    assert result["data"]["kind"] == "learning_graph"
    assert result["data"]["url"] == "/learning?graph=graph-public-1"
    assert result["data"]["user_goal"] == task.slots["user_goal"]
    assert result["data"]["domain"] == task.slots["domain"]


@pytest.mark.asyncio
async def test_failed_blueprint_save_cannot_be_committed_with_task_failure_state():
    engine, sessions = await _api_test_database()
    try:
        async with sessions() as session:
            session.add(models.User(id=1, username="rollback-owner", password_hash="hash"))
            await session.commit()
            task = AgentTask(
                task_id="rollback-task",
                user_id=1,
                thread_id="rollback-thread",
                agent_type=AgentType.LEARNING_GRAPH,
                slots={"user_goal": "Derivatives", "domain": "mathematics"},
                state=TaskState.RUNNING,
                version=1,
                confirmed_version=1,
                execution_key="rollback-execution",
            )
            task = await save_task(session, task)
            blueprint = _persistence_blueprint("rollback-blueprint")
            invalid_plan = blueprint.resource_plans[0].model_copy(
                update={
                    "status": ResourcePlanStatus.GENERATED,
                    "artifact_id": 999_999,
                }
            )
            blueprint = blueprint.model_copy(
                update={
                    "resource_plans": [
                        invalid_plan,
                        *blueprint.resource_plans[1:],
                    ]
                }
            )

            with pytest.raises(ValueError, match="artifact ownership mismatch"):
                await graph_integration.save_blueprint(
                    session,
                    user_id=1,
                    blueprint=blueprint,
                    idempotency_key="rollback-blueprint-save",
                    request_hash="a" * 64,
                )

            await fail_task(session, task, error_code="LEARNING_GRAPH_INVALID")

        async with sessions() as verification:
            persisted_task = await verification.scalar(
                select(models.WorkspaceAgentTask).where(
                    models.WorkspaceAgentTask.task_id == "rollback-task"
                )
            )
            assert persisted_task is not None
            assert persisted_task.state == TaskState.FAILED.value
            for model in (
                models.LearningGraph,
                models.GraphLearningUnit,
                models.GraphNode,
                models.GraphOrchestrationRun,
            ):
                assert await verification.scalar(
                    select(func.count()).select_from(model)
                ) == 0
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_same_external_graph_id_is_scoped_independently_per_user():
    engine, sessions = await _api_test_database()
    try:
        async with sessions() as session:
            session.add_all(
                [
                    models.User(id=1, username="tenant-one", password_hash="hash"),
                    models.User(id=2, username="tenant-two", password_hash="hash"),
                ]
            )
            await session.commit()
            blueprint = _persistence_blueprint("shared-external-identity")

            await graph_integration.save_blueprint(
                session,
                user_id=1,
                blueprint=blueprint,
                idempotency_key="tenant-one-save",
                request_hash="1" * 64,
            )
            await graph_integration.save_blueprint(
                session,
                user_id=2,
                blueprint=blueprint,
                idempotency_key="tenant-two-save",
                request_hash="2" * 64,
            )

            tenant_one = await graph_integration.load_existing_graph_summary(
                session,
                user_id=1,
                graph_id=blueprint.graph_id,
            )
            tenant_two = await graph_integration.load_existing_graph_summary(
                session,
                user_id=2,
                graph_id=blueprint.graph_id,
            )
            assert tenant_one.graph_id == blueprint.graph_id
            assert tenant_two.graph_id == blueprint.graph_id
            assert await session.scalar(
                select(func.count()).select_from(models.LearningGraph).where(
                    models.LearningGraph.external_id == blueprint.graph_id
                )
            ) == 2
    finally:
        await engine.dispose()
