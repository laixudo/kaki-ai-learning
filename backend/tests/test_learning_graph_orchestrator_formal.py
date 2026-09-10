from __future__ import annotations

import asyncio
import sys
from dataclasses import dataclass, field
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest
from fastapi import HTTPException
from sqlalchemy import UniqueConstraint

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from agents.learning_graph_orchestrator.compiler import compile_blueprint
from agents.learning_graph_orchestrator.enums import (
    GenerationMode,
    ResourcePlanStatus,
    UpdateMode,
)
from agents.learning_graph_orchestrator.fallback import build_fallback_candidate
from agents.learning_graph_orchestrator.models import (
    ExistingGraphSummary,
    LearningGraphRequest,
)
from agents.learning_graph_orchestrator.runner import (
    LearningGraphOrchestrator,
    SourceContractError,
)
from agents.learning_graph_orchestrator.validators import (
    validate_existing_graph_contract,
)
from database.models import GraphResourcePlan
from routers import workspace_agents
from services.workspace_task_contracts import (
    AgentType,
    SemanticAction,
    SemanticRoute,
    TaskDecision,
)


def _create_request() -> LearningGraphRequest:
    return LearningGraphRequest.model_validate(
        {
            "request_id": "formal-contract-create",
            "graph_revision": 0,
            "user_goal": "Understand derivatives and optimization",
            "domain": "math",
            "locale": "zh-CN",
            "source_refs": [
                {
                    "ref_id": "source-math-outline",
                    "kind": "outline",
                    "title": "Derivatives and optimization",
                    "metadata": {},
                }
            ],
            "source_outline": [
                {
                    "outline_id": "outline-root",
                    "title": "Derivatives and optimization",
                    "level": 1,
                    "order": 0,
                    "source_ref_id": "source-math-outline",
                },
                {
                    "outline_id": "outline-derivative",
                    "title": "Derivative fundamentals",
                    "level": 2,
                    "order": 1,
                    "parent_outline_id": "outline-root",
                    "source_ref_id": "source-math-outline",
                },
            ],
            "source_summaries": [],
            "resource_capabilities": [
                {
                    "resource_type": "HANDOUT",
                    "agent_key": "document_agent",
                    "enabled": True,
                    "constraints": {},
                },
                {
                    "resource_type": "QUESTION",
                    "agent_key": "exam_agent",
                    "enabled": True,
                    "constraints": {},
                },
            ],
            "constraints": {"min_nodes": 2, "max_nodes": 8},
            "update_mode": "CREATE",
        }
    )


def _existing_summary(blueprint) -> ExistingGraphSummary:
    return ExistingGraphSummary.model_validate(
        {
            "graph_id": blueprint.graph_id,
            "graph_revision": blueprint.graph_revision,
            "graph_title": blueprint.graph_title,
            "graph_summary": blueprint.graph_summary,
            "learning_units": [
                item.model_dump(mode="json") for item in blueprint.learning_units
            ],
            "nodes": [item.model_dump(mode="json") for item in blueprint.nodes],
            "edges": [item.model_dump(mode="json") for item in blueprint.edges],
            "resource_plans": [
                item.model_dump(mode="json") for item in blueprint.resource_plans
            ],
        }
    )


def _update_request(base: LearningGraphRequest, blueprint) -> LearningGraphRequest:
    payload = base.model_dump(mode="json")
    payload.update(
        {
            "request_id": "PRIVATE-REQUEST-ID-SENTINEL",
            "graph_id": blueprint.graph_id,
            "graph_revision": blueprint.graph_revision,
            "existing_graph_summary": _existing_summary(blueprint).model_dump(
                mode="json"
            ),
            "update_mode": UpdateMode.REVISE.value,
        }
    )
    return LearningGraphRequest.model_validate(payload)


@dataclass
class RecordingProvider:
    responses: list[dict[str, Any]]
    name: str = "recording-provider"
    model_id: str = "contract-test"
    prompts: list[str] = field(default_factory=list)

    async def generate(self, prompt: str) -> dict[str, Any]:
        self.prompts.append(prompt)
        return self.responses[len(self.prompts) - 1]


def _run_workspace_graph_plan(
    monkeypatch,
    *,
    update_mode: str,
    session_artifacts: list[dict[str, Any]],
    model_graph_id: str = "graph-model-invented",
    model_graph_revision: int = 999,
) -> dict[str, Any]:
    captured: dict[str, Any] = {}
    session = SimpleNamespace(
        messages=[{"role": "assistant", "artifact": item} for item in session_artifacts]
    )

    async def owned_session(*_args, **_kwargs):
        return session

    async def load_current(*_args, **_kwargs):
        return None

    async def route(**_kwargs):
        return SemanticRoute(
            action=SemanticAction.NEW_TASK,
            agent_type=AgentType.LEARNING_GRAPH,
            slot_updates={
                "user_goal": "Continue the trusted graph",
                "domain": "math",
                "update_mode": update_mode,
                "graph_id": model_graph_id,
                "graph_revision": model_graph_revision,
                "replaced_source_ref_ids": ["source-old"],
            },
            confidence=1.0,
            reason_code="formal_graph_update",
        )

    def advance(_current, semantic, _user_id, _thread_id):
        captured.update(semantic.slot_updates)
        return TaskDecision(mode="chat")

    monkeypatch.setattr(workspace_agents, "_owned_session", owned_session)
    monkeypatch.setattr(workspace_agents, "load_current_task", load_current)
    monkeypatch.setattr(workspace_agents, "route_semantically", route)
    monkeypatch.setattr(workspace_agents, "advance_task", advance)
    monkeypatch.setattr(workspace_agents, "begin_runtime_operation", lambda *_args: None)
    monkeypatch.setattr(workspace_agents, "complete_runtime_operation", lambda *_args: None)

    request = workspace_agents.PlanRequest(
        thread_id="thread-formal-graph-update",
        message=f"Please {update_mode.lower()} this learning graph",
    )
    asyncio.run(workspace_agents.plan_task(request, user_id=7, db=object()))
    return captured


def test_unsafe_source_identity_stops_before_provider_call():
    request = _create_request()
    request.source_refs[0].ref_id = "https://private.example/material.pdf"
    provider = RecordingProvider(responses=[])

    with pytest.raises(SourceContractError):
        asyncio.run(LearningGraphOrchestrator(provider).run(request))

    assert provider.prompts == []


def test_resource_plan_continuity_is_unique_per_node_not_per_graph():
    request = _create_request()
    blueprint = compile_blueprint(request, build_fallback_candidate(request))
    update_request = _update_request(request, blueprint)
    summary = update_request.existing_graph_summary
    assert summary is not None
    first = summary.resource_plans[0]
    second = next(
        plan for plan in summary.resource_plans if plan.node_id != first.node_id
    )
    second.continuity_key = first.continuity_key

    assert validate_existing_graph_contract(update_request).valid

    unique_columns = {
        tuple(column.name for column in constraint.columns)
        for constraint in GraphResourcePlan.__table__.constraints
        if isinstance(constraint, UniqueConstraint)
    }
    assert ("node_id", "continuity_key") in unique_columns
    assert ("graph_id", "continuity_key") not in unique_columns


@pytest.mark.parametrize(
    "update_mode",
    ["EXTEND", "REVISE", "MERGE", "REPLACE_SOURCE"],
)
def test_workspace_graph_updates_inject_identity_from_persisted_artifact(
    monkeypatch, update_mode: str
):
    captured = _run_workspace_graph_plan(
        monkeypatch,
        update_mode=update_mode,
        session_artifacts=[
            {
                "kind": "learning_graph",
                "graph_id": "graph-trusted-from-session",
                "graph_revision": 7,
                "title": "Trusted graph",
            }
        ],
    )

    assert captured["graph_id"] == "graph-trusted-from-session"
    assert captured["graph_revision"] == 7


def test_workspace_graph_update_rejects_model_invented_identity_without_context(
    monkeypatch,
):
    with pytest.raises(HTTPException) as exc_info:
        _run_workspace_graph_plan(
            monkeypatch,
            update_mode="EXTEND",
            session_artifacts=[],
        )

    assert exc_info.value.status_code == 422


def test_initial_and_repair_provider_prompts_omit_private_sentinels():
    base = _create_request()
    existing = compile_blueprint(base, build_fallback_candidate(base))
    existing_plan = existing.resource_plans[0]
    existing_plan.status = ResourcePlanStatus.GENERATED
    existing_plan.artifact_id = 987654
    existing_plan.generation_spec = {
        "internal_instruction": "PRIVATE-GENERATION-SPEC-SENTINEL"
    }
    existing_plan.required_inputs = ["PRIVATE-REQUIRED-INPUT-SENTINEL"]
    existing_plan.private_annotations = {
        "secret_token": "PRIVATE-ANNOTATION-SENTINEL",
        "local_path": "C:/private/material.pdf",
    }
    request = _update_request(base, existing)

    invalid = build_fallback_candidate(request)
    invalid.edges[0].source_key = "missing-node-key"
    repaired = build_fallback_candidate(request)
    provider = RecordingProvider(
        responses=[
            invalid.model_dump(mode="json"),
            repaired.model_dump(mode="json"),
        ]
    )

    result = asyncio.run(LearningGraphOrchestrator(provider).run(request))

    assert result.metadata.generation_mode == GenerationMode.REPAIR
    assert len(provider.prompts) == 2
    joined_prompts = "\n".join(provider.prompts)
    for forbidden in (
        "PRIVATE-REQUEST-ID-SENTINEL",
        existing.graph_id,
        "987654",
        "artifact_id",
        "PRIVATE-GENERATION-SPEC-SENTINEL",
        "PRIVATE-REQUIRED-INPUT-SENTINEL",
        "PRIVATE-ANNOTATION-SENTINEL",
        "C:/private/material.pdf",
        "private_annotations",
        "secret_token",
        "local_path",
    ):
        assert forbidden not in joined_prompts


def test_generated_artifact_is_not_transferred_to_a_new_resource_identity():
    base = _create_request()
    existing = compile_blueprint(base, build_fallback_candidate(base))
    old_plan = existing.resource_plans[0]
    old_plan.status = ResourcePlanStatus.GENERATED
    old_plan.artifact_id = 777
    request = _update_request(base, existing)

    candidate = build_fallback_candidate(request)
    old_node = next(node for node in existing.nodes if node.node_id == old_plan.node_id)
    candidate_node = next(node for node in candidate.nodes if node.title == old_node.title)
    replacement = next(
        plan
        for plan in candidate.resource_plans
        if plan.node_key == candidate_node.key
        and plan.resource_type == old_plan.resource_type
    )
    replacement.continuity_key = "new-resource-continuity"
    replacement.purpose = "A materially different transfer challenge"

    updated = compile_blueprint(request, candidate)
    preserved = next(
        plan
        for plan in updated.resource_plans
        if plan.resource_plan_id == old_plan.resource_plan_id
    )
    fresh = next(
        plan
        for plan in updated.resource_plans
        if plan.continuity_key == "new-resource-continuity"
    )

    assert preserved.status == ResourcePlanStatus.GENERATED
    assert preserved.artifact_id == 777
    assert fresh.resource_plan_id != preserved.resource_plan_id
    assert fresh.status == ResourcePlanStatus.PLANNED
    assert fresh.artifact_id is None
