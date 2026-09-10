"""Formal-project adapter checks for immutable Learning Evaluator v0.1.10.

These tests use a fresh synthetic SQLite database and the real candidate core,
formal evidence adapter, execution port, authenticity port and persistence.
"""
from __future__ import annotations

import os

import pytest
from sqlalchemy import func, select

import database.connection as db_connection
from database.models import (
    GeneratedItem, GraphNode, LearningEvaluation, LearningEvaluationExecution,
    LearningEvaluationResultRecord, LearningGraph, StudentProfile, User,
    WorkspaceLearningEvent,
)
from services.learning_evaluator_integration import (
    EvaluationAccessDeniedError, evaluate_graph_node, get_latest_public_evaluation,
)
from integrations.learning_evaluator_evidence import build_node_contract


@pytest.mark.asyncio
async def test_formal_node_contract_hashes_non_ascii_continuity_key(tmp_path):
    database_url = f"sqlite+aiosqlite:///{tmp_path / 'evaluator-contract.db'}"
    await db_connection.init_db(database_url)
    factory = db_connection.get_session_factory()
    try:
        async with factory() as db:
            db.add(User(id=701, username="eval-contract-user", password_hash="synthetic"))
            await db.flush()
            graph = LearningGraph(
                user_id=701, external_id="graph-contract", graph_revision=1,
                graph_summary="synthetic", title="contract",
            )
            db.add(graph)
            await db.flush()
            node = GraphNode(
                graph_id=graph.id, user_id=701, external_id="node-contract",
                continuity_key="\u51c6\u5907\u9ad8\u7b49\u6570\u5b66\u671f\u672b",
                title="contract", node_type="concept", learning_objectives=["objective"],
                mastery_evidence=["evidence"], status="planned",
            )
            db.add(node)
            await db.flush()
            contract = await build_node_contract(db, graph, node)
            assert contract.node_continuity_key.startswith("node-")
            assert contract.node_continuity_key != node.continuity_key
    finally:
        await db_connection.close_db()


@pytest.mark.asyncio
async def test_formal_evaluator_includes_declared_prerequisite_contracts(tmp_path, monkeypatch):
    database_url = f"sqlite+aiosqlite:///{tmp_path / 'evaluator-prerequisite.db'}"
    monkeypatch.setenv("DATABASE_URL", database_url)
    monkeypatch.setenv("EVALUATOR_MASTER_KEY", "formal-evaluator-test-key-not-production")
    monkeypatch.setenv("KAKI_EVALUATOR_TEST_PROVIDER", "1")
    await db_connection.init_db(database_url)
    factory = db_connection.get_session_factory()
    try:
        async with factory() as db:
            db.add(User(id=702, username="eval-prerequisite-user", password_hash="synthetic"))
            await db.flush()
            graph = LearningGraph(
                user_id=702, external_id="graph-prerequisite", graph_revision=1,
                graph_summary="synthetic", title="contract",
            )
            db.add(graph)
            await db.flush()
            prerequisite = GraphNode(
                graph_id=graph.id, user_id=702, external_id="node-prerequisite",
                continuity_key="node-prerequisite", title="prerequisite", node_type="concept",
                learning_objectives=["objective"], mastery_evidence=["evidence"], status="planned",
            )
            db.add(prerequisite)
            await db.flush()
            target = GraphNode(
                graph_id=graph.id, user_id=702, external_id="node-target",
                continuity_key="node-target", title="target", node_type="assessment",
                learning_objectives=["objective"], mastery_evidence=["evidence"],
                depends_on=[str(prerequisite.id)], status="planned",
            )
            db.add(target)
            await db.commit()

        async with factory() as db:
            result = await evaluate_graph_node(
                db, user_id=702, graph_ref="graph-prerequisite", node_ref="node-target",
                request_id="prerequisite-contract", idempotency_key="prerequisite-contract",
                expected_evaluation_revision=0,
            )
            assert result["evaluation_revision"] == 1
    finally:
        await db_connection.close_db()


@pytest.mark.asyncio
async def test_formal_evaluator_initial_replay_incremental_and_isolation(tmp_path, monkeypatch):
    database_url = f"sqlite+aiosqlite:///{tmp_path / 'evaluator.db'}"
    monkeypatch.setenv("DATABASE_URL", database_url)
    monkeypatch.setenv("EVALUATOR_MASTER_KEY", "formal-evaluator-test-key-not-production")
    monkeypatch.setenv("KAKI_EVALUATOR_TEST_PROVIDER", "1")
    await db_connection.init_db(database_url)
    factory = db_connection.get_session_factory()
    try:
        async with factory() as db:
            db.add_all([
                User(id=501, username="eval-user-a", password_hash="synthetic"),
                User(id=502, username="eval-user-b", password_hash="synthetic"),
            ])
            await db.flush()
            graph = LearningGraph(
                user_id=501, external_id="graph-formal-evaluator", graph_revision=1,
                graph_summary="synthetic", title="学习率", source_detail={"continuity_key": "graph-continuity"},
            )
            db.add(graph); await db.flush()
            node = GraphNode(
                graph_id=graph.id, user_id=501, external_id="node-learning-rate",
                continuity_key="node-learning-rate-continuity", title="学习率决定步幅",
                node_type="concept", learning_objectives=["解释学习率与更新步幅的关系"],
                mastery_evidence=["完成可验证互动题"], status="planned", mastery_score=0,
            )
            db.add(node); await db.flush()
            artifact = GeneratedItem(
                user_id=501, type="workspace_interactive_lesson", title="互动题", content="synthetic",
                raw_data={
                    "source": "learning_graph", "thread_id": "eval-thread", "delivery_mode": "interactive_lesson",
                    "graph_id": graph.external_id, "graph_node_id": node.id,
                    "graph_node_external_id": node.external_id, "resource_plan_id": 1,
                    "resource_plan_external_id": "plan-interactive", "resource_plan_continuity_key": "plan-continuity",
                },
            )
            db.add(artifact); await db.flush()
            db.add(WorkspaceLearningEvent(
                user_id=501, thread_id="eval-thread", artifact_id=artifact.id,
                event_type="interaction_answered",
                payload={"slide_index": 1, "selected_index": 1, "correct": True, "correct_index": 1},
            ))
            await db.commit()

        async with factory() as db:
            first = await evaluate_graph_node(
                db, user_id=501, graph_ref="graph-formal-evaluator", node_ref="node-learning-rate",
                request_id="request-initial", idempotency_key="idem-initial", expected_evaluation_revision=0,
            )
            replay = await evaluate_graph_node(
                db, user_id=501, graph_ref="graph-formal-evaluator", node_ref="node-learning-rate",
                request_id="request-initial", idempotency_key="idem-initial", expected_evaluation_revision=0,
            )
            assert first == replay
            assert first["evaluation_revision"] == 1
            assert first["evidence_summaries"]

        async with factory() as db:
            artifact = await db.scalar(select(GeneratedItem).where(GeneratedItem.user_id == 501))
            db.add(WorkspaceLearningEvent(
                user_id=501, thread_id="eval-thread", artifact_id=artifact.id,
                event_type="interaction_answered",
                payload={"slide_index": 1, "selected_index": 0, "correct": False, "correct_index": 1},
            ))
            await db.commit()
            second = await evaluate_graph_node(
                db, user_id=501, graph_ref="graph-formal-evaluator", node_ref="node-learning-rate",
                request_id="request-incremental", idempotency_key="idem-incremental", expected_evaluation_revision=1,
            )
            assert second["evaluation_revision"] == 2

        async with factory() as db:
            with pytest.raises(EvaluationAccessDeniedError):
                await get_latest_public_evaluation(
                    db, user_id=502, graph_ref="graph-formal-evaluator", node_ref="node-learning-rate",
                )
            aggregate = await db.scalar(select(LearningEvaluation))
            node = await db.scalar(select(GraphNode))
            assert aggregate.current_revision == 2
            assert node.status == "planned"
            assert node.mastery_score in (0, 0.0, None)
            assert int((await db.execute(select(func.count()).select_from(LearningEvaluationResultRecord))).scalar_one()) == 2
            assert int((await db.execute(select(func.count()).select_from(LearningEvaluationExecution))).scalar_one()) == 2
            assert int((await db.execute(select(func.count()).select_from(StudentProfile))).scalar_one()) == 0

        # Recreate the session/engine and recover the exact durable Public View.
        await db_connection.close_db()
        await db_connection.init_db(database_url)
        factory = db_connection.get_session_factory()
        async with factory() as db:
            recovered = await get_latest_public_evaluation(
                db, user_id=501, graph_ref="graph-formal-evaluator", node_ref="node-learning-rate",
            )
            assert recovered is not None and recovered["evaluation_revision"] == 2
            public_blob = str(recovered)
            for private_name in ("request_digest", "authenticity_proof", "private_payload", "selected_index", "correct_index"):
                assert private_name not in public_blob
    finally:
        await db_connection.close_db()
