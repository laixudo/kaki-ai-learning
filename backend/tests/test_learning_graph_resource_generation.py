from __future__ import annotations

import asyncio
import sys
from importlib import import_module
from pathlib import Path
from typing import Any

import pytest
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from database import models


def _service():
    return import_module("services.learning_graph_resource_generation")


async def _database() -> tuple[object, async_sessionmaker[AsyncSession]]:
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as connection:
        await connection.run_sync(models.Base.metadata.create_all)
    return engine, async_sessionmaker(engine, expire_on_commit=False)


async def _seed_graph(session: AsyncSession) -> dict[str, Any]:
    session.add_all(
        [
            models.User(id=1, username="resource-owner", password_hash="hash"),
            models.User(id=2, username="other-owner", password_hash="hash"),
        ]
    )
    owner_graph = models.LearningGraph(
        user_id=1,
        external_id="graph-owner",
        graph_revision=1,
        graph_summary="A formal graph used for resource generation tests.",
        title="Owner graph",
        goal="Understand derivatives",
        goal_type="custom",
        status="active",
    )
    other_graph = models.LearningGraph(
        user_id=2,
        external_id="graph-other",
        graph_revision=1,
        graph_summary="Another user's graph.",
        title="Other graph",
        goal="Private goal",
        goal_type="custom",
        status="active",
    )
    session.add_all([owner_graph, other_graph])
    await session.flush()

    owner_node = models.GraphNode(
        graph_id=owner_graph.id,
        user_id=1,
        external_id="node-owner",
        continuity_key="node-continuity-owner",
        unit_id="unit-owner",
        title="Derivative fundamentals",
        summary="Learn the derivative definition and interpretation.",
        node_type="concept",
        learning_objectives=["Explain a derivative as a rate of change."],
        key_concepts=["limit", "rate of change"],
        mastery_evidence=["Solve and explain one derivative problem."],
        source_refs=["source-owner"],
        resource_plan_ids=["plan-owner-a", "plan-owner-b"],
        status="planned",
    )
    other_node = models.GraphNode(
        graph_id=other_graph.id,
        user_id=2,
        external_id="node-other",
        continuity_key="node-continuity-other",
        unit_id="unit-other",
        title="Other private node",
        summary="Private node.",
        node_type="concept",
        learning_objectives=["Private objective."],
        key_concepts=["private"],
        mastery_evidence=["Private evidence."],
        source_refs=["source-other"],
        resource_plan_ids=["plan-other"],
        status="planned",
    )
    session.add_all([owner_node, other_node])
    await session.flush()

    plan_a = models.GraphResourcePlan(
        graph_id=owner_graph.id,
        external_id="plan-owner-a",
        continuity_key="resource-continuity-a",
        node_id=owner_node.id,
        resource_type="HANDOUT",
        purpose="Teach derivative fundamentals.",
        generation_spec={"topic": "Derivative fundamentals", "detail_level": "detailed"},
        required_inputs=["source-owner"],
        trigger="user_opens_node",
        status="planned",
        priority=10,
        private_annotations={},
        failure_metadata={},
    )
    plan_b = models.GraphResourcePlan(
        graph_id=owner_graph.id,
        external_id="plan-owner-b",
        continuity_key="resource-continuity-b",
        node_id=owner_node.id,
        resource_type="HANDOUT",
        purpose="Provide an independent practice handout.",
        generation_spec={"topic": "Derivative practice", "detail_level": "concise"},
        required_inputs=["source-owner"],
        trigger="manual_generate",
        status="planned",
        priority=20,
        private_annotations={},
        failure_metadata={},
    )
    other_plan = models.GraphResourcePlan(
        graph_id=other_graph.id,
        external_id="plan-other",
        continuity_key="resource-continuity-other",
        node_id=other_node.id,
        resource_type="HANDOUT",
        purpose="Private resource.",
        generation_spec={"topic": "Private"},
        required_inputs=["source-other"],
        trigger="manual_generate",
        status="planned",
        priority=10,
        private_annotations={},
        failure_metadata={},
    )
    session.add_all([plan_a, plan_b, other_plan])
    await session.commit()
    return {
        "owner_graph": owner_graph,
        "other_graph": other_graph,
        "owner_node": owner_node,
        "other_node": other_node,
        "plan_a": plan_a,
        "plan_b": plan_b,
        "other_plan": other_plan,
    }


class RecordingDispatcher:
    """Controllable stand-in for the already-registered real agent dispatcher."""

    def __init__(
        self,
        session: AsyncSession,
        plan_id: int,
        *,
        content: str = "Real lecture content returned by the lecture agent.",
        failure: Exception | None = None,
    ) -> None:
        self.session = session
        self.plan_id = plan_id
        self.content = content
        self.failure = failure
        self.calls: list[dict[str, Any]] = []

    async def __call__(self, **kwargs: Any) -> dict[str, Any]:
        self.calls.append(kwargs)
        plan = await self.session.get(models.GraphResourcePlan, self.plan_id)
        assert plan is not None
        assert plan.status == "generating", "the durable plan must transition before dispatch"
        if self.failure is not None:
            raise self.failure
        return {
            "title": "Derivative fundamentals lecture",
            "content": self.content,
            "raw_data": {"agent": "lecture", "provider_result": "real"},
        }


def test_materialization_creates_a_real_artifact_then_marks_the_exact_plan_generated():
    async def run() -> None:
        service = _service()
        engine, sessions = await _database()
        try:
            async with sessions() as session:
                seeded = await _seed_graph(session)
                plan = seeded["plan_a"]
                dispatcher = RecordingDispatcher(session, plan.id)

                result = await service.materialize_resource_plan(
                    session,
                    user_id=1,
                    thread_id="thread-resource-1",
                    graph_id=seeded["owner_graph"].id,
                    node_id=seeded["owner_node"].id,
                    resource_plan_id=plan.id,
                    dispatcher=dispatcher,
                    execution_key="resource-execution-1",
                )

                await session.refresh(plan)
                artifact = await session.get(models.GeneratedItem, plan.artifact_id)
                events = list((await session.scalars(select(models.WorkspaceLearningEvent))).all())

                assert plan.status == "generated"
                assert plan.execution_task_id == "resource-execution-1"
                assert plan.failure_metadata == {}
                assert artifact is not None
                assert result.id == artifact.id
                assert artifact.user_id == 1
                assert artifact.type == "workspace_lecture"
                assert artifact.content == "Real lecture content returned by the lecture agent."
                assert artifact.raw_data["graph_node_id"] == seeded["owner_node"].id
                assert artifact.raw_data["resource_plan_id"] == plan.id
                assert artifact.raw_data["thread_id"] == "thread-resource-1"
                assert len(events) == 1
                assert events[0].user_id == 1
                assert events[0].thread_id == "thread-resource-1"
                assert events[0].artifact_id == artifact.id
                assert len(dispatcher.calls) == 1
                assert dispatcher.calls[0]["agent_key"] == "lecture"
        finally:
            await engine.dispose()

    asyncio.run(run())


def test_materialization_rejects_ownership_and_graph_node_plan_identity_mismatches():
    async def run() -> None:
        service = _service()
        engine, sessions = await _database()
        try:
            async with sessions() as session:
                seeded = await _seed_graph(session)
                plan = seeded["plan_a"]
                dispatcher = RecordingDispatcher(session, plan.id)

                with pytest.raises(PermissionError):
                    await service.materialize_resource_plan(
                        session,
                        user_id=2,
                        thread_id="thread-forbidden",
                        graph_id=seeded["owner_graph"].id,
                        node_id=seeded["owner_node"].id,
                        resource_plan_id=plan.id,
                        dispatcher=dispatcher,
                        execution_key="forbidden-owner",
                    )

                with pytest.raises(ValueError, match="(?i)(graph|node|plan|identity)"):
                    await service.materialize_resource_plan(
                        session,
                        user_id=1,
                        thread_id="thread-mismatch",
                        graph_id=seeded["owner_graph"].id,
                        node_id=seeded["other_node"].id,
                        resource_plan_id=plan.id,
                        dispatcher=dispatcher,
                        execution_key="mismatched-node",
                    )

                with pytest.raises(ValueError, match="(?i)(graph|node|plan|identity)"):
                    await service.materialize_resource_plan(
                        session,
                        user_id=1,
                        thread_id="thread-mismatch",
                        graph_id=seeded["other_graph"].id,
                        node_id=seeded["owner_node"].id,
                        resource_plan_id=plan.id,
                        dispatcher=dispatcher,
                        execution_key="mismatched-graph",
                    )

                assert dispatcher.calls == []
                assert await session.scalar(select(func.count()).select_from(models.GeneratedItem)) == 0
                assert await session.scalar(select(func.count()).select_from(models.WorkspaceLearningEvent)) == 0
        finally:
            await engine.dispose()

    asyncio.run(run())


def test_same_execution_key_is_idempotent_without_a_second_dispatch_or_event():
    async def run() -> None:
        service = _service()
        engine, sessions = await _database()
        try:
            async with sessions() as session:
                seeded = await _seed_graph(session)
                plan = seeded["plan_a"]
                dispatcher = RecordingDispatcher(session, plan.id)
                arguments = {
                    "user_id": 1,
                    "thread_id": "thread-idempotent",
                    "graph_id": seeded["owner_graph"].id,
                    "node_id": seeded["owner_node"].id,
                    "resource_plan_id": plan.id,
                    "dispatcher": dispatcher,
                    "execution_key": "same-resource-execution",
                }

                first = await service.materialize_resource_plan(session, **arguments)
                second = await service.materialize_resource_plan(session, **arguments)

                assert first.id == second.id
                assert len(dispatcher.calls) == 1
                assert await session.scalar(select(func.count()).select_from(models.GeneratedItem)) == 1
                assert await session.scalar(select(func.count()).select_from(models.WorkspaceLearningEvent)) == 1
        finally:
            await engine.dispose()

    asyncio.run(run())



def test_execution_key_replay_rejects_a_different_thread_without_new_artifact_or_event():
    async def run() -> None:
        service = _service()
        engine, sessions = await _database()
        try:
            async with sessions() as session:
                seeded = await _seed_graph(session)
                plan = seeded["plan_a"]
                dispatcher = RecordingDispatcher(session, plan.id)
                artifact = await service.materialize_resource_plan(
                    session,
                    user_id=1,
                    thread_id="thread-original",
                    graph_id=seeded["owner_graph"].id,
                    node_id=seeded["owner_node"].id,
                    resource_plan_id=plan.id,
                    dispatcher=dispatcher,
                    execution_key="thread-bound-execution",
                )

                with pytest.raises(ValueError, match="different resource request"):
                    await service.materialize_resource_plan(
                        session,
                        user_id=1,
                        thread_id="thread-changed",
                        graph_id=seeded["owner_graph"].id,
                        node_id=seeded["owner_node"].id,
                        resource_plan_id=plan.id,
                        dispatcher=RecordingDispatcher(session, plan.id),
                        execution_key="thread-bound-execution",
                    )

                assert len(dispatcher.calls) == 1
                assert await session.scalar(select(func.count()).select_from(models.GeneratedItem)) == 1
                assert await session.scalar(select(func.count()).select_from(models.WorkspaceLearningEvent)) == 1
                assert artifact.id == plan.artifact_id
        finally:
            await engine.dispose()

    asyncio.run(run())

def test_execution_key_cannot_transfer_an_artifact_to_a_different_continuity_plan():
    async def run() -> None:
        service = _service()
        engine, sessions = await _database()
        try:
            async with sessions() as session:
                seeded = await _seed_graph(session)
                first_plan = seeded["plan_a"]
                second_plan = seeded["plan_b"]
                first_dispatcher = RecordingDispatcher(session, first_plan.id)
                first = await service.materialize_resource_plan(
                    session,
                    user_id=1,
                    thread_id="thread-continuity",
                    graph_id=seeded["owner_graph"].id,
                    node_id=seeded["owner_node"].id,
                    resource_plan_id=first_plan.id,
                    dispatcher=first_dispatcher,
                    execution_key="continuity-bound-execution",
                )
                second_dispatcher = RecordingDispatcher(session, second_plan.id)

                with pytest.raises(ValueError, match="(?i)(continuity|identity|execution)"):
                    await service.materialize_resource_plan(
                        session,
                        user_id=1,
                        thread_id="thread-continuity",
                        graph_id=seeded["owner_graph"].id,
                        node_id=seeded["owner_node"].id,
                        resource_plan_id=second_plan.id,
                        dispatcher=second_dispatcher,
                        execution_key="continuity-bound-execution",
                    )

                await session.refresh(second_plan)
                assert second_plan.artifact_id is None
                assert second_plan.status == "planned"
                assert second_dispatcher.calls == []
                assert await session.scalar(select(func.count()).select_from(models.GeneratedItem)) == 1
                assert first.id == first_plan.artifact_id
        finally:
            await engine.dispose()

    asyncio.run(run())


def test_failed_generation_stays_failed_until_explicit_retry_then_creates_one_artifact():
    async def run() -> None:
        service = _service()
        engine, sessions = await _database()
        try:
            async with sessions() as session:
                seeded = await _seed_graph(session)
                plan = seeded["plan_a"]
                failing = RecordingDispatcher(
                    session,
                    plan.id,
                    failure=RuntimeError("lecture agent unavailable"),
                )

                with pytest.raises(RuntimeError, match="lecture agent unavailable"):
                    await service.materialize_resource_plan(
                        session,
                        user_id=1,
                        thread_id="thread-retry",
                        graph_id=seeded["owner_graph"].id,
                        node_id=seeded["owner_node"].id,
                        resource_plan_id=plan.id,
                        dispatcher=failing,
                        execution_key="failed-execution",
                    )

                await session.refresh(plan)
                assert plan.status == "failed"
                assert plan.artifact_id is None
                assert plan.failure_metadata
                assert plan.failure_metadata["code"] == "resource_generation_failed"
                assert "message" not in plan.failure_metadata
                assert await session.scalar(select(func.count()).select_from(models.GeneratedItem)) == 0
                assert await session.scalar(select(func.count()).select_from(models.WorkspaceLearningEvent)) == 0

                blocked = RecordingDispatcher(session, plan.id)
                with pytest.raises(ValueError, match="(?i)retry"):
                    await service.materialize_resource_plan(
                        session,
                        user_id=1,
                        thread_id="thread-retry",
                        graph_id=seeded["owner_graph"].id,
                        node_id=seeded["owner_node"].id,
                        resource_plan_id=plan.id,
                        dispatcher=blocked,
                        execution_key="implicit-retry-forbidden",
                    )
                assert blocked.calls == []

                retry_dispatcher = RecordingDispatcher(session, plan.id)
                artifact = await service.retry_resource_generation(
                    session,
                    user_id=1,
                    thread_id="thread-retry",
                    graph_id=seeded["owner_graph"].id,
                    node_id=seeded["owner_node"].id,
                    resource_plan_id=plan.id,
                    dispatcher=retry_dispatcher,
                    execution_key="explicit-retry-execution",
                )

                await session.refresh(plan)
                assert plan.status == "generated"
                assert plan.artifact_id == artifact.id
                assert plan.execution_task_id == "explicit-retry-execution"
                assert plan.failure_metadata == {}
                assert len(retry_dispatcher.calls) == 1
                assert await session.scalar(select(func.count()).select_from(models.GeneratedItem)) == 1
                assert await session.scalar(select(func.count()).select_from(models.WorkspaceLearningEvent)) == 1
        finally:
            await engine.dispose()

    asyncio.run(run())


def test_failed_execution_key_remains_historically_bound_after_explicit_retry():
    async def run() -> None:
        service = _service()
        engine, sessions = await _database()
        try:
            async with sessions() as session:
                seeded = await _seed_graph(session)
                plan = seeded["plan_a"]
                failing = RecordingDispatcher(
                    session,
                    plan.id,
                    failure=RuntimeError("temporary provider failure"),
                )
                with pytest.raises(RuntimeError):
                    await service.materialize_resource_plan(
                        session,
                        user_id=1,
                        thread_id="thread-history",
                        graph_id=seeded["owner_graph"].id,
                        node_id=seeded["owner_node"].id,
                        resource_plan_id=plan.id,
                        dispatcher=failing,
                        execution_key="historical-failed-key",
                    )

                await service.retry_resource_generation(
                    session,
                    user_id=1,
                    thread_id="thread-history",
                    graph_id=seeded["owner_graph"].id,
                    node_id=seeded["owner_node"].id,
                    resource_plan_id=plan.id,
                    dispatcher=RecordingDispatcher(session, plan.id),
                    execution_key="successful-retry-key",
                )

                other = seeded["plan_b"]
                with pytest.raises(ValueError, match="(?i)(execution|history|identity)"):
                    await service.materialize_resource_plan(
                        session,
                        user_id=1,
                        thread_id="thread-history",
                        graph_id=seeded["owner_graph"].id,
                        node_id=seeded["owner_node"].id,
                        resource_plan_id=other.id,
                        dispatcher=RecordingDispatcher(session, other.id),
                        execution_key="historical-failed-key",
                    )

                runs = list((await session.scalars(
                    select(models.GraphResourceGenerationRun).order_by(
                        models.GraphResourceGenerationRun.id
                    )
                )).all())
                assert [(row.execution_key, row.status) for row in runs] == [
                    ("historical-failed-key", "failed"),
                    ("successful-retry-key", "generated"),
                ]
        finally:
            await engine.dispose()

    asyncio.run(run())


def test_execution_key_is_idempotent_within_one_user_but_reusable_by_another_user():
    async def run() -> None:
        service = _service()
        engine, sessions = await _database()
        try:
            async with sessions() as session:
                seeded = await _seed_graph(session)
                shared_key = "same-client-generated-key"

                owner_artifact = await service.materialize_resource_plan(
                    session,
                    user_id=1,
                    thread_id="thread-owner",
                    graph_id=seeded["owner_graph"].id,
                    node_id=seeded["owner_node"].id,
                    resource_plan_id=seeded["plan_a"].id,
                    dispatcher=RecordingDispatcher(session, seeded["plan_a"].id),
                    execution_key=shared_key,
                )
                other_dispatcher = RecordingDispatcher(session, seeded["other_plan"].id)
                other_artifact = await service.materialize_resource_plan(
                    session,
                    user_id=2,
                    thread_id="thread-other",
                    graph_id=seeded["other_graph"].id,
                    node_id=seeded["other_node"].id,
                    resource_plan_id=seeded["other_plan"].id,
                    dispatcher=other_dispatcher,
                    execution_key=shared_key,
                )

                runs = list((await session.scalars(
                    select(models.GraphResourceGenerationRun).where(
                        models.GraphResourceGenerationRun.execution_key == shared_key
                    ).order_by(models.GraphResourceGenerationRun.user_id)
                )).all())
                assert owner_artifact.user_id == 1
                assert other_artifact.user_id == 2
                assert len(other_dispatcher.calls) == 1
                assert [(row.user_id, row.execution_key) for row in runs] == [
                    (1, shared_key),
                    (2, shared_key),
                ]
        finally:
            await engine.dispose()

    asyncio.run(run())


def test_concurrent_different_execution_keys_claim_one_plan_at_most_once(
    tmp_path, monkeypatch,
):
    async def run() -> None:
        service = _service()
        database = tmp_path / "concurrent-resource-claim.db"
        engine = create_async_engine(f"sqlite+aiosqlite:///{database}")
        async with engine.begin() as connection:
            await connection.run_sync(models.Base.metadata.create_all)
        sessions = async_sessionmaker(engine, expire_on_commit=False)

        try:
            async with sessions() as setup_session:
                seeded = await _seed_graph(setup_session)
                graph_id = seeded["owner_graph"].id
                node_id = seeded["owner_node"].id
                plan_id = seeded["plan_a"].id

            original_existing_execution = service._existing_execution
            both_history_checks_complete = asyncio.Event()
            history_check_count = 0

            async def synchronised_existing_execution(
                db: AsyncSession, *, user_id: int, execution_key: str,
            ):
                nonlocal history_check_count
                existing = await original_existing_execution(
                    db,
                    user_id=user_id,
                    execution_key=execution_key,
                )
                history_check_count += 1
                if history_check_count == 2:
                    both_history_checks_complete.set()
                await asyncio.wait_for(both_history_checks_complete.wait(), timeout=2)
                return existing

            monkeypatch.setattr(
                service,
                "_existing_execution",
                synchronised_existing_execution,
            )

            dispatch_calls: list[str] = []

            async def dispatcher(**kwargs: Any) -> dict[str, Any]:
                dispatch_calls.append(kwargs["plan"].execution_task_id)
                await asyncio.sleep(0.05)
                return {
                    "title": "Concurrent claim result",
                    "content": "Only one real agent execution may become an artifact.",
                    "raw_data": {"agent": "lecture", "provider_result": "real"},
                }

            async with sessions() as first_session, sessions() as second_session:
                # Keep both identity maps on the same durable planned state before
                # either execution reaches the claim transaction.
                for session in (first_session, second_session):
                    assert (await session.get(models.LearningGraph, graph_id)).id == graph_id
                    assert (await session.get(models.GraphNode, node_id)).id == node_id
                    assert (await session.get(models.GraphResourcePlan, plan_id)).status == "planned"

                results = await asyncio.gather(
                    service.materialize_resource_plan(
                        first_session,
                        user_id=1,
                        thread_id="thread-concurrent",
                        graph_id=graph_id,
                        node_id=node_id,
                        resource_plan_id=plan_id,
                        dispatcher=dispatcher,
                        execution_key="concurrent-execution-a",
                    ),
                    service.materialize_resource_plan(
                        second_session,
                        user_id=1,
                        thread_id="thread-concurrent",
                        graph_id=graph_id,
                        node_id=node_id,
                        resource_plan_id=plan_id,
                        dispatcher=dispatcher,
                        execution_key="concurrent-execution-b",
                    ),
                    return_exceptions=True,
                )

            async with sessions() as verification_session:
                artifact_count = await verification_session.scalar(
                    select(func.count()).select_from(models.GeneratedItem)
                )
                event_count = await verification_session.scalar(
                    select(func.count()).select_from(models.WorkspaceLearningEvent)
                )
                successful_claims = await verification_session.scalar(
                    select(func.count()).select_from(models.GraphResourceGenerationRun).where(
                        models.GraphResourceGenerationRun.status == "generated"
                    )
                )

            assert len(dispatch_calls) <= 1
            assert artifact_count == 1
            assert event_count == 1
            assert successful_claims == 1
            assert sum(not isinstance(result, Exception) for result in results) == 1
        finally:
            await engine.dispose()

    asyncio.run(run())
