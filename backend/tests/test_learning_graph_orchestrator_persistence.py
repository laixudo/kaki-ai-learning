from __future__ import annotations

import sys
import asyncio
import re
from importlib import import_module
from pathlib import Path
from types import SimpleNamespace

import pytest
from sqlalchemy import ForeignKeyConstraint, UniqueConstraint, text
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from database import models


def _integration():
    return import_module("services.learning_graph_orchestrator_integration")


def _fallback_blueprint(request_id: str = "formal-persistence-create"):
    from agents.learning_graph_orchestrator.compiler import compile_blueprint
    from agents.learning_graph_orchestrator.fallback import build_fallback_candidate
    from agents.learning_graph_orchestrator.models import LearningGraphRequest

    request = LearningGraphRequest.model_validate(
        {
            "request_id": request_id,
            "graph_revision": 0,
            "user_goal": "Understand derivatives and optimization",
            "domain": "math",
            "locale": "zh-CN",
            "source_refs": [
                {
                    "ref_id": "topic-derivatives",
                    "kind": "topic",
                    "title": "Derivatives and optimization",
                    "metadata": {},
                }
            ],
            "source_outline": [
                {
                    "outline_id": "topic-derivatives-root",
                    "title": "Derivatives and optimization",
                    "level": 1,
                    "order": 0,
                    "source_ref_id": "topic-derivatives",
                },
                {
                    "outline_id": "topic-derivatives-basics",
                    "title": "Derivative fundamentals",
                    "level": 2,
                    "order": 1,
                    "parent_outline_id": "topic-derivatives-root",
                    "source_ref_id": "topic-derivatives",
                },
            ],
            "source_summaries": [],
            "resource_capabilities": [
                {
                    "resource_type": "HANDOUT",
                    "agent_key": "lecture",
                    "enabled": True,
                    "constraints": {},
                },
                {
                    "resource_type": "QUESTION",
                    "agent_key": "exam",
                    "enabled": True,
                    "constraints": {},
                },
            ],
            "constraints": {"min_nodes": 2, "max_nodes": 8},
            "update_mode": "CREATE",
        }
    )
    return compile_blueprint(request, build_fallback_candidate(request), fallback_used=True)


async def _database() -> tuple[object, async_sessionmaker[AsyncSession]]:
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as connection:
        await connection.run_sync(models.Base.metadata.create_all)
    return engine, async_sessionmaker(engine, expire_on_commit=False)


async def _add_users(session: AsyncSession) -> None:
    session.add_all(
        [
            models.User(id=1, username="graph-owner", password_hash="hash"),
            models.User(id=2, username="other-owner", password_hash="hash"),
        ]
    )
    await session.commit()


def _columns(model: type) -> set[str]:
    return set(model.__table__.columns.keys())


def _unique_column_sets(model: type) -> set[frozenset[str]]:
    return {
        frozenset(column.name for column in constraint.columns)
        for constraint in model.__table__.constraints
        if isinstance(constraint, UniqueConstraint)
    }


def _foreign_key_targets(model: type) -> set[tuple[str, str]]:
    targets: set[tuple[str, str]] = set()
    for constraint in model.__table__.constraints:
        if not isinstance(constraint, ForeignKeyConstraint):
            continue
        for element in constraint.elements:
            targets.add((element.parent.name, element.target_fullname))
    return targets


def test_existing_graph_and_node_models_gain_only_the_formal_additive_contract():
    assert {
        "external_id",
        "graph_revision",
        "graph_summary",
    }.issubset(_columns(models.LearningGraph))

    assert {
        "external_id",
        "continuity_key",
        "unit_id",
        "summary",
        "node_type",
        "learning_objectives",
        "key_concepts",
        "mastery_evidence",
        "source_refs",
        "resource_plan_ids",
    }.issubset(_columns(models.GraphNode))

    assert frozenset({"user_id", "external_id"}) in _unique_column_sets(
        models.LearningGraph
    )
    assert frozenset({"graph_id", "external_id"}) in _unique_column_sets(
        models.GraphNode
    )
    assert frozenset({"graph_id", "continuity_key"}) in _unique_column_sets(
        models.GraphNode
    )


def test_formal_unit_edge_and_resource_plan_models_attach_to_existing_fact_sources():
    expected_models = {
        "GraphLearningUnit",
        "GraphKnowledgeEdge",
        "GraphResourcePlan",
        "GraphOrchestrationRun",
    }
    missing = sorted(name for name in expected_models if not hasattr(models, name))
    assert not missing, f"missing formal additive ORM models: {missing}"

    unit = models.GraphLearningUnit
    edge = models.GraphKnowledgeEdge
    plan = models.GraphResourcePlan

    assert {
        "graph_id",
        "external_id",
        "continuity_key",
        "title",
        "summary",
        "node_ids",
        "unit_order",
    }.issubset(_columns(unit))
    assert ("graph_id", "learning_graphs.id") in _foreign_key_targets(unit)

    assert {
        "graph_id",
        "external_id",
        "source_node_id",
        "target_node_id",
        "edge_type",
        "reason",
    }.issubset(_columns(edge))
    assert ("source_node_id", "graph_nodes.id") in _foreign_key_targets(edge)
    assert ("target_node_id", "graph_nodes.id") in _foreign_key_targets(edge)

    assert {
        "graph_id",
        "external_id",
        "continuity_key",
        "node_id",
        "resource_type",
        "purpose",
        "generation_spec",
        "required_inputs",
        "trigger",
        "status",
        "priority",
        "artifact_id",
        "private_annotations",
        "execution_task_id",
        "failure_metadata",
    }.issubset(_columns(plan))
    assert ("graph_id", "learning_graphs.id") in _foreign_key_targets(plan)
    assert ("node_id", "graph_nodes.id") in _foreign_key_targets(plan)
    assert ("artifact_id", "generated_items.id") in _foreign_key_targets(plan)


def test_formal_identities_and_orchestration_claims_are_database_unique():
    expected_models = {
        "GraphLearningUnit",
        "GraphKnowledgeEdge",
        "GraphResourcePlan",
        "GraphOrchestrationRun",
    }
    missing = sorted(name for name in expected_models if not hasattr(models, name))
    assert not missing, f"missing formal additive ORM models: {missing}"

    unit = models.GraphLearningUnit
    edge = models.GraphKnowledgeEdge
    plan = models.GraphResourcePlan
    run = models.GraphOrchestrationRun

    for model in (unit, edge, plan):
        uniques = _unique_column_sets(model)
        assert frozenset({"graph_id", "external_id"}) in uniques

    assert frozenset({"graph_id", "continuity_key"}) in _unique_column_sets(unit)
    assert frozenset({"node_id", "continuity_key"}) in _unique_column_sets(plan)
    assert frozenset({"graph_id", "continuity_key"}) not in _unique_column_sets(plan)
    assert frozenset({"execution_task_id"}) not in _unique_column_sets(plan)

    assert {
        "user_id",
        "idempotency_key",
        "graph_id",
        "request_hash",
        "graph_revision",
        "status",
        "result_public",
    }.issubset(_columns(run))
    assert frozenset({"user_id", "idempotency_key"}) in _unique_column_sets(run)
    assert ("user_id", "users.id") in _foreign_key_targets(run)
    assert ("graph_id", "learning_graphs.id") in _foreign_key_targets(run)

    resource_run = models.GraphResourceGenerationRun
    resource_run_uniques = _unique_column_sets(resource_run)
    assert frozenset({"user_id", "execution_key"}) in resource_run_uniques
    assert frozenset({"execution_key"}) not in resource_run_uniques


def test_strict_additive_migration_upgrades_legacy_graph_tables(tmp_path):
    from database.connection import ensure_learning_graph_orchestrator_schema

    async def run():
        database = tmp_path / "legacy-graph.db"
        engine = create_async_engine(f"sqlite+aiosqlite:///{database}")
        async with engine.begin() as connection:
            await connection.execute(text(
                "CREATE TABLE users (id INTEGER PRIMARY KEY, username VARCHAR(50), password_hash VARCHAR(255))"
            ))
            await connection.execute(text(
                "CREATE TABLE learning_graphs (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, title VARCHAR(200) NOT NULL)"
            ))
            await connection.execute(text(
                "CREATE TABLE graph_nodes (id INTEGER PRIMARY KEY, graph_id INTEGER NOT NULL, user_id INTEGER NOT NULL, title VARCHAR(200) NOT NULL)"
            ))
            await connection.execute(text(
                "CREATE TABLE generated_items (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, type VARCHAR(50) NOT NULL, title VARCHAR(200) NOT NULL)"
            ))

        await ensure_learning_graph_orchestrator_schema(engine)
        async with engine.begin() as connection:
            graph_columns = {
                row[1] for row in (await connection.execute(text("PRAGMA table_info(learning_graphs)"))).fetchall()
            }
            node_columns = {
                row[1] for row in (await connection.execute(text("PRAGMA table_info(graph_nodes)"))).fetchall()
            }
            table_names = {
                row[0] for row in (await connection.execute(text(
                    "SELECT name FROM sqlite_master WHERE type='table'"
                ))).fetchall()
            }
            index_names = {
                row[1] for row in (await connection.execute(text("PRAGMA index_list(graph_nodes)"))).fetchall()
            }
        await engine.dispose()

        assert {"external_id", "graph_revision", "graph_summary"}.issubset(graph_columns)
        assert {"external_id", "continuity_key", "unit_id", "resource_plan_ids"}.issubset(node_columns)
        assert {
            "graph_learning_units",
            "graph_knowledge_edges",
            "graph_resource_plans",
            "graph_orchestration_runs",
        }.issubset(table_names)
        assert "uq_graph_nodes_graph_external_idx" in index_names
        assert "uq_graph_nodes_graph_continuity_idx" in index_names

    asyncio.run(run())


def test_strict_migration_preserves_runs_while_replacing_global_execution_key_scope(tmp_path):
    from database.connection import ensure_learning_graph_orchestrator_schema

    async def run():
        database = tmp_path / "global-execution-key.db"
        engine = create_async_engine(f"sqlite+aiosqlite:///{database}")
        async with engine.begin() as connection:
            await connection.run_sync(models.Base.metadata.create_all)
        sessions = async_sessionmaker(engine, expire_on_commit=False)
        async with sessions() as session:
            await _add_users(session)
            graph = models.LearningGraph(
                id=1, user_id=1, external_id="migration-graph", graph_revision=1,
                title="Migration graph", goal="Preserve one run", goal_type="custom",
                status="active",
            )
            node = models.GraphNode(
                id=1, graph_id=1, user_id=1, external_id="migration-node",
                continuity_key="migration-node", unit_id="migration-unit",
                title="Migration node", summary="Migration node summary",
                node_type="concept", learning_objectives=["Understand migration"],
                key_concepts=["migration"], mastery_evidence=["Explain migration"],
                source_refs=["migration-source"], resource_plan_ids=["migration-plan"],
                status="planned",
            )
            plan = models.GraphResourcePlan(
                id=1, graph_id=1, external_id="migration-plan",
                continuity_key="migration-plan", node_id=1, resource_type="HANDOUT",
                purpose="Preserve the migration run", generation_spec={},
                required_inputs=[], trigger="manual_generate", status="failed",
                priority=10, private_annotations={}, failure_metadata={},
            )
            session.add_all([graph, node, plan])
            await session.commit()
        async with engine.begin() as connection:
            await connection.execute(text("DROP TABLE graph_resource_generation_runs"))
            await connection.execute(text(
                "CREATE TABLE graph_resource_generation_runs ("
                "id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, "
                "graph_id INTEGER NOT NULL, node_id INTEGER NOT NULL, "
                "resource_plan_id INTEGER NOT NULL, execution_key VARCHAR(140) NOT NULL, "
                "thread_id VARCHAR(100) NOT NULL, status VARCHAR(20) NOT NULL, "
                "artifact_id INTEGER, failure_metadata JSON NOT NULL, "
                "created_at DATETIME, updated_at DATETIME, "
                "CONSTRAINT uq_graph_resource_runs_execution_key UNIQUE (execution_key))"
            ))
            await connection.execute(text(
                "INSERT INTO graph_resource_generation_runs "
                "(id, user_id, graph_id, node_id, resource_plan_id, execution_key, "
                "thread_id, status, failure_metadata) VALUES "
                "(1, 1, 1, 1, 1, 'shared-key', 'thread-one', 'failed', '{}')"
            ))

        await ensure_learning_graph_orchestrator_schema(engine)
        async with engine.begin() as connection:
            rows = (await connection.execute(text(
                "SELECT id, user_id, execution_key, status "
                "FROM graph_resource_generation_runs ORDER BY id"
            ))).fetchall()
            await connection.execute(text(
                "INSERT INTO graph_resource_generation_runs "
                "(id, user_id, graph_id, node_id, resource_plan_id, execution_key, "
                "thread_id, status, failure_metadata) VALUES "
                "(2, 2, 2, 2, 2, 'shared-key', 'thread-two', 'claimed', '{}')"
            ))
            with pytest.raises(Exception):
                await connection.execute(text(
                    "INSERT INTO graph_resource_generation_runs "
                    "(id, user_id, graph_id, node_id, resource_plan_id, execution_key, "
                    "thread_id, status, failure_metadata) VALUES "
                    "(3, 1, 3, 3, 3, 'shared-key', 'thread-three', 'claimed', '{}')"
                ))
        await engine.dispose()

        assert rows == [(1, 1, "shared-key", "failed")]

    asyncio.run(run())


def test_strict_migration_rejects_an_existing_incomplete_companion_table(tmp_path):
    from database.connection import ensure_learning_graph_orchestrator_schema

    async def run():
        database = tmp_path / "incomplete-companion.db"
        engine = create_async_engine(f"sqlite+aiosqlite:///{database}")
        async with engine.begin() as connection:
            await connection.execute(text(
                "CREATE TABLE users (id INTEGER PRIMARY KEY, username VARCHAR(50), password_hash VARCHAR(255))"
            ))
            await connection.execute(text(
                "CREATE TABLE learning_graphs (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, title VARCHAR(200) NOT NULL)"
            ))
            await connection.execute(text(
                "CREATE TABLE graph_nodes (id INTEGER PRIMARY KEY, graph_id INTEGER NOT NULL, user_id INTEGER NOT NULL, title VARCHAR(200) NOT NULL)"
            ))
            await connection.execute(text(
                "CREATE TABLE generated_items (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, type VARCHAR(50) NOT NULL, title VARCHAR(200) NOT NULL)"
            ))
            await connection.execute(text(
                "CREATE TABLE graph_learning_units (id INTEGER PRIMARY KEY, graph_id INTEGER NOT NULL)"
            ))

        with pytest.raises(RuntimeError, match="companion schema"):
            await ensure_learning_graph_orchestrator_schema(engine)
        await engine.dispose()

    asyncio.run(run())


def test_resource_capabilities_are_derived_only_from_executable_agent_adapters():
    from services.workspace_agent_adapters import AGENT_ADAPTERS

    capabilities = _integration().build_resource_capabilities()
    enabled = [item for item in capabilities if item.enabled]

    assert enabled
    assert {item.agent_key for item in enabled}.issubset(
        {agent_type.value for agent_type in AGENT_ADAPTERS}
    )
    assert {item.resource_type.value for item in enabled} == {
        "HANDOUT",
        "QUESTION",
        "CODE",
        "MIND_MAP",
        "INTERACTIVE_CLASS",
        "PPT",
    }
    assert "VIDEO" not in {item.resource_type.value for item in enabled}
    assert "ADVENTURE" not in {item.resource_type.value for item in enabled}


def test_topic_request_uses_safe_deterministic_opaque_source_identities():
    integration = _integration()
    capabilities = integration.build_resource_capabilities()
    kwargs = {
        "request_id": "topic-create-1",
        "topic": "Derivatives and optimization",
        "domain": "math",
        "locale": "zh-CN",
        "resource_capabilities": capabilities,
    }

    first = integration.build_topic_request_payload(**kwargs)
    second = integration.build_topic_request_payload(**kwargs)

    assert first == second
    assert first["update_mode"] == "CREATE"
    assert first["graph_revision"] == 0
    assert len(first["source_refs"]) == 1
    safe_id = first["source_refs"][0]["ref_id"]
    assert re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,99}", safe_id)
    assert safe_id == first["source_outline"][0]["source_ref_id"]
    assert "Derivatives and optimization" not in safe_id
    assert ":" not in safe_id and "/" not in safe_id and "\\" not in safe_id


def test_update_request_keeps_existing_source_identities_in_the_source_contract(monkeypatch):
    from agents.learning_graph_orchestrator.models import (
        ExistingGraphSummary,
        ExistingNodeSummary,
    )

    async def run():
        integration = _integration()
        existing = ExistingGraphSummary(
            graph_id="graph-existing-sources",
            graph_revision=1,
            graph_title="Probability",
            nodes=[ExistingNodeSummary(
                node_id="node-probability",
                continuity_key="probability",
                title="Probability basics",
                learning_objectives=["Explain probability"],
                key_concepts=["probability"],
                mastery_evidence=["Solve a basic probability problem"],
                source_refs=["topic-original-probability"],
            )],
        )

        async def fake_existing(*args, **kwargs):
            return existing

        monkeypatch.setattr(integration, "load_existing_graph_summary", fake_existing)
        request = await integration.build_formal_request(
            object(),
            user_id=1,
            thread_id="thread-source-continuity",
            request_id="request-source-continuity",
            user_goal="Extend the learning graph with conditional probability",
            domain="mathematics",
            update_mode="EXTEND",
            graph_id=existing.graph_id,
            graph_revision=existing.graph_revision,
        )

        source_ids = {item.ref_id for item in request.source_refs}
        assert "topic-original-probability" in source_ids
        assert request.existing_graph_summary == existing

    asyncio.run(run())


def test_save_create_is_transactional_public_and_idempotent_without_duplicates():
    async def run():
        integration = _integration()
        engine, sessions = await _database()
        blueprint = _fallback_blueprint()
        try:
            async with sessions() as session:
                await _add_users(session)
                first = await integration.save_blueprint(
                    session,
                    user_id=1,
                    blueprint=blueprint,
                    idempotency_key="create-derivatives",
                    request_hash="a" * 64,
                )
                second = await integration.save_blueprint(
                    session,
                    user_id=1,
                    blueprint=blueprint,
                    idempotency_key="create-derivatives",
                    request_hash="a" * 64,
                )

                assert first == second
                assert first["graph_id"] == blueprint.graph_id
                assert first["graph_revision"] == 1
                assert first["status"] in {"draft", "needs_review", "valid"}
                assert "generation_spec" not in str(first)
                assert "private_annotations" not in str(first)

                expected_counts = {
                    models.LearningGraph: 1,
                    models.GraphNode: len(blueprint.nodes),
                    models.GraphLearningUnit: len(blueprint.learning_units),
                    models.GraphKnowledgeEdge: len(blueprint.edges),
                    models.GraphResourcePlan: len(blueprint.resource_plans),
                    models.GraphOrchestrationRun: 1,
                    models.GeneratedItem: 0,
                }
                for model, expected in expected_counts.items():
                    count = await session.scalar(select(func.count()).select_from(model))
                    assert count == expected
        finally:
            await engine.dispose()

    asyncio.run(run())


def test_same_idempotency_key_rejects_a_different_request_hash():
    async def run():
        integration = _integration()
        engine, sessions = await _database()
        try:
            async with sessions() as session:
                await _add_users(session)
                blueprint = _fallback_blueprint()
                await integration.save_blueprint(
                    session,
                    user_id=1,
                    blueprint=blueprint,
                    idempotency_key="same-key",
                    request_hash="a" * 64,
                )
                with pytest.raises(ValueError, match="(?i)idempotency"):
                    await integration.save_blueprint(
                        session,
                        user_id=1,
                        blueprint=blueprint,
                        idempotency_key="same-key",
                        request_hash="b" * 64,
                    )
        finally:
            await engine.dispose()

    asyncio.run(run())


def test_update_revision_mismatch_is_rejected_without_mutating_the_graph():
    async def run():
        integration = _integration()
        engine, sessions = await _database()
        try:
            async with sessions() as session:
                await _add_users(session)
                created = _fallback_blueprint()
                await integration.save_blueprint(
                    session,
                    user_id=1,
                    blueprint=created,
                    idempotency_key="create-first",
                    request_hash="a" * 64,
                )
                stale_update = created.model_copy(update={"graph_revision": 3})
                with pytest.raises(ValueError, match="(?i)revision"):
                    await integration.save_blueprint(
                        session,
                        user_id=1,
                        blueprint=stale_update,
                        idempotency_key="stale-update",
                        request_hash="c" * 64,
                    )
                graph = await session.scalar(
                    select(models.LearningGraph).where(
                        models.LearningGraph.user_id == 1,
                        models.LearningGraph.external_id == created.graph_id,
                    )
                )
                assert graph is not None
                assert graph.graph_revision == 1
        finally:
            await engine.dispose()

    asyncio.run(run())


def test_existing_graph_summary_is_never_loadable_by_another_user():
    async def run():
        integration = _integration()
        engine, sessions = await _database()
        try:
            async with sessions() as session:
                await _add_users(session)
                blueprint = _fallback_blueprint()
                await integration.save_blueprint(
                    session,
                    user_id=1,
                    blueprint=blueprint,
                    idempotency_key="owned-create",
                    request_hash="d" * 64,
                )
                with pytest.raises(PermissionError):
                    await integration.load_existing_graph_summary(
                        session,
                        user_id=2,
                        graph_id=blueprint.graph_id,
                    )
        finally:
            await engine.dispose()

    asyncio.run(run())


def test_legacy_incomplete_active_graph_is_rejected_before_any_provider_call():
    from agents.learning_graph_orchestrator.runner import ExistingGraphContractError

    async def run():
        integration = _integration()
        engine, sessions = await _database()
        provider_calls: list[str] = []
        try:
            async with sessions() as session:
                await _add_users(session)
                graph = models.LearningGraph(
                    user_id=1,
                    external_id="legacy-incomplete",
                    graph_revision=1,
                    graph_summary="Legacy graph missing the formal active-node contract.",
                    title="Legacy graph",
                    goal="Study a legacy topic",
                    goal_type="custom",
                    status="active",
                )
                session.add(graph)
                await session.flush()
                session.add(
                    models.GraphNode(
                        graph_id=graph.id,
                        user_id=1,
                        external_id="legacy-node",
                        continuity_key="legacy-node",
                        title="Legacy node",
                        summary="",
                        node_type="concept",
                        learning_objectives=[],
                        key_concepts=[],
                        mastery_evidence=[],
                        source_refs=[],
                        resource_plan_ids=[],
                        status="planned",
                    )
                )
                await session.commit()

                with pytest.raises(ExistingGraphContractError):
                    await integration.load_existing_graph_summary(
                        session,
                        user_id=1,
                        graph_id="legacy-incomplete",
                    )
                assert provider_calls == []
        finally:
            await engine.dispose()

    asyncio.run(run())


def test_concurrent_same_idempotency_key_claims_before_provider_invocation(tmp_path, monkeypatch):
    async def run():
        integration = _integration()
        database = tmp_path / "provider-idempotency-claim.db"
        engine = create_async_engine(f"sqlite+aiosqlite:///{database}")
        async with engine.begin() as connection:
            await connection.run_sync(models.Base.metadata.create_all)
        sessions = async_sessionmaker(engine, expire_on_commit=False)
        async with sessions() as setup:
            setup.add(models.User(id=1, username="provider-owner", password_hash="hash"))
            await setup.commit()

        provider_entered = asyncio.Event()
        release_provider = asyncio.Event()
        provider_calls = 0
        blueprint = _fallback_blueprint("concurrent-provider-request")

        class ControlledOrchestrator:
            def __init__(self, _provider):
                pass

            async def run(self, _request):
                nonlocal provider_calls
                provider_calls += 1
                provider_entered.set()
                await release_provider.wait()
                return SimpleNamespace(
                    validation=SimpleNamespace(valid=True),
                    blueprint=blueprint,
                )

        monkeypatch.setattr(integration, "LearningGraphOrchestrator", ControlledOrchestrator)
        request = SimpleNamespace(
            graph_revision=0,
            model_dump=lambda mode="json": {
                "request_id": "concurrent-provider-request",
                "graph_revision": 0,
                "user_goal": "Understand derivatives",
            },
        )

        try:
            async with sessions() as first_session, sessions() as second_session:
                first = asyncio.create_task(integration.orchestrate_and_save(
                    first_session,
                    user_id=1,
                    request=request,
                    idempotency_key="same-provider-key",
                    provider=object(),
                ))
                await asyncio.wait_for(provider_entered.wait(), timeout=2)
                second = asyncio.create_task(integration.orchestrate_and_save(
                    second_session,
                    user_id=1,
                    request=request,
                    idempotency_key="same-provider-key",
                    provider=object(),
                ))
                await asyncio.sleep(0.05)
                release_provider.set()
                results = await asyncio.gather(first, second, return_exceptions=True)

            async with sessions() as verification:
                run_count = await verification.scalar(
                    select(func.count()).select_from(models.GraphOrchestrationRun)
                )
                graph_count = await verification.scalar(
                    select(func.count()).select_from(models.LearningGraph)
                )
            assert provider_calls == 1
            assert run_count == 1
            assert graph_count == 1
            assert sum(not isinstance(result, Exception) for result in results) == 1
        finally:
            await engine.dispose()

    asyncio.run(run())


def test_orchestration_idempotency_key_is_scoped_per_user():
    async def run():
        integration = _integration()
        engine, sessions = await _database()
        try:
            async with sessions() as session:
                await _add_users(session)
                first, first_replay = await integration._claim_provider_invocation(
                    session,
                    user_id=1,
                    idempotency_key="shared-orchestration-key",
                    request_hash="a" * 64,
                    graph_revision=0,
                )
                second, second_replay = await integration._claim_provider_invocation(
                    session,
                    user_id=2,
                    idempotency_key="shared-orchestration-key",
                    request_hash="b" * 64,
                    graph_revision=0,
                )
                assert first is not None and second is not None
                assert first_replay is None and second_replay is None
                rows = list((await session.scalars(select(
                    models.GraphOrchestrationRun
                ).where(
                    models.GraphOrchestrationRun.idempotency_key
                    == "shared-orchestration-key"
                ).order_by(models.GraphOrchestrationRun.user_id))).all())
                assert [(row.user_id, row.request_hash) for row in rows] == [
                    (1, "a" * 64),
                    (2, "b" * 64),
                ]
        finally:
            await engine.dispose()

    asyncio.run(run())
