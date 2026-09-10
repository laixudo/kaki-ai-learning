from __future__ import annotations

from pathlib import Path

import pytest
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from database.models import (
    Base, GeneratedItem, InteractiveQuestionAttempt, LearningGraph, GraphNode,
    User, WorkspaceLearningEvent,
)
from integrations.learning_evaluator_evidence import load_question_attempt_evidence
from services.workspace_artifact_versions import build_public_projection, ensure_initial_version
from services.workspace_interactive_attempts import (
    InteractiveAttemptConflict,
    InteractiveAttemptInvalid,
    InteractiveAttemptNotFound,
    get_interactive_state,
    record_support_action,
    submit_interactive_answer,
)


SLIDES = [
    {"title": "学习率与步幅", "content": "请选择", "interaction": {
        "question": "学习率过大最可能导致什么？",
        "options": ["更稳定", "越过最低点并震荡", "梯度消失"],
        "correct_index": 1,
        "hint": "关注每一步移动的距离。",
        "explanation": "学习率决定步幅；步幅过大会反复越过最低点。",
    }},
]


async def database(path: Path):
    engine = create_async_engine(f"sqlite+aiosqlite:///{path}")
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    factory = async_sessionmaker(engine, expire_on_commit=False)
    async with factory() as db:
        db.add_all([
            User(id=1, username="question_a", password_hash="synthetic"),
            User(id=2, username="question_b", password_hash="synthetic"),
            LearningGraph(id=71, user_id=1, external_id="graph-a", title="学习率", goal="理解震荡", graph_revision=1, source_detail={"continuity_key": "graph-a-c"}),
            GraphNode(
                id=72, graph_id=71, user_id=1, external_id="node-a", continuity_key="node-a-c",
                title="学习率与步幅", node_type="concept", status="active",
                learning_objectives=["判断学习率是否合理"], mastery_evidence=["独立完成一道迁移题"],
            ),
            GeneratedItem(
                id=201, user_id=1, type="workspace_interactive_lesson", title="学习率互动课堂", chapter="梯度下降",
                content="interactive lesson", raw_data={
                    "kind": "interactive_lesson", "delivery_mode": "interactive_lesson",
                    "thread_id": "thread-question", "slides": SLIDES,
                    "source": "learning_graph", "graph_id": "graph-a",
                    "graph_node_external_id": "node-a", "resource_plan_id": "plan-q",
                },
            ),
        ])
        await db.commit()
        version = await ensure_initial_version(db, await db.get(GeneratedItem, 201))
        await db.commit()
    return engine, factory, version.id


@pytest.mark.asyncio
async def test_public_projection_hides_answer_facts(tmp_path):
    engine, factory, version_id = await database(tmp_path / "question-public.db")
    async with factory() as db:
        projection = await build_public_projection(db, user_id=1, artifact_id=201, version_id=version_id)
        dumped = str(projection)
        assert "correct_index" not in dumped
        assert "步幅过大会反复越过最低点" not in dumped
        assert "options" in dumped
    await engine.dispose()


@pytest.mark.asyncio
async def test_server_judgment_idempotency_retry_and_event_once(tmp_path):
    engine, factory, version_id = await database(tmp_path / "question-attempt.db")
    async with factory() as db:
        wrong, replay = await submit_interactive_answer(
            db, user_id=1, thread_id="thread-question", artifact_id=201,
            artifact_version_id=version_id, item_identity="slide-0", selected_answer=0,
            submission_request_id="submit-1", idempotency_key="attempt-key-1",
        )
        await db.commit()
        assert replay is False
        assert wrong["result"]["correct"] is False
        assert wrong["attempt"]["attempt_number"] == 1
    async with factory() as db:
        same, replay = await submit_interactive_answer(
            db, user_id=1, thread_id="thread-question", artifact_id=201,
            artifact_version_id=version_id, item_identity="slide-0", selected_answer=0,
            submission_request_id="submit-1", idempotency_key="attempt-key-1",
        )
        await db.commit()
        assert replay is True and same["attempt"]["attempt_id"] == wrong["attempt"]["attempt_id"]
    async with factory() as db:
        with pytest.raises(InteractiveAttemptConflict):
            await submit_interactive_answer(
                db, user_id=1, thread_id="thread-question", artifact_id=201,
                artifact_version_id=version_id, item_identity="slide-0", selected_answer=1,
                submission_request_id="submit-1", idempotency_key="attempt-key-1",
            )
        await db.rollback()
    async with factory() as db:
        correct, _ = await submit_interactive_answer(
            db, user_id=1, thread_id="thread-question", artifact_id=201,
            artifact_version_id=version_id, item_identity="slide-0", selected_answer=1,
            submission_request_id="submit-2", idempotency_key="attempt-key-2",
        )
        await db.commit()
        assert correct["result"]["correct"] is True
        assert correct["attempt"]["attempt_number"] == 2
        assert correct["progress"]["current_step"] == 1
        assert correct["progress"]["total_steps"] == 1
        assert correct["progress"]["answered_interactive_items"] == 1
        assert correct["progress"]["total_interactive_items"] == 1
        assert correct["progress"]["all_interactive_items_attempted"] is True
        assert correct["progress"]["lesson_viewing_completed"] is False
        assert correct["completion_eligibility"] is None
    async with factory() as db:
        attempts = list((await db.execute(select(InteractiveQuestionAttempt).order_by(InteractiveQuestionAttempt.attempt_number))).scalars())
        events = list((await db.execute(select(WorkspaceLearningEvent).where(WorkspaceLearningEvent.event_type == "interaction_answered"))).scalars())
        assert [row.correct for row in attempts] == [False, True]
        assert len(events) == 2
        assert {row.event_id for row in attempts} == {row.id for row in events}
    await engine.dispose()


@pytest.mark.asyncio
async def test_hint_solution_flags_and_evaluator_evidence(tmp_path):
    engine, factory, version_id = await database(tmp_path / "question-evidence.db")
    async with factory() as db:
        with pytest.raises(InteractiveAttemptInvalid, match="提交答案后"):
            await record_support_action(
                db, user_id=1, thread_id="thread-question", artifact_id=201,
                artifact_version_id=version_id, item_identity="slide-0", action="solution_viewed",
            )
        await db.rollback()
    async with factory() as db:
        hint = await record_support_action(
            db, user_id=1, thread_id="thread-question", artifact_id=201,
            artifact_version_id=version_id, item_identity="slide-0", action="hint_requested",
        )
        assert "步" in hint["hint"]
        first, _ = await submit_interactive_answer(
            db, user_id=1, thread_id="thread-question", artifact_id=201,
            artifact_version_id=version_id, item_identity="slide-0", selected_answer=0,
            submission_request_id="support-submit-1", idempotency_key="support-key-1",
        )
        await db.commit()
        assert first["attempt"]["hint_used"] is True
        assert first["attempt"]["solution_viewed"] is False
    async with factory() as db:
        solution = await record_support_action(
            db, user_id=1, thread_id="thread-question", artifact_id=201,
            artifact_version_id=version_id, item_identity="slide-0", action="solution_viewed",
        )
        assert "学习率" in solution["explanation"]
        second, _ = await submit_interactive_answer(
            db, user_id=1, thread_id="thread-question", artifact_id=201,
            artifact_version_id=version_id, item_identity="slide-0", selected_answer=1,
            submission_request_id="support-submit-2", idempotency_key="support-key-2",
        )
        await db.commit()
        assert second["attempt"]["hint_used"] is False
        assert second["attempt"]["solution_viewed"] is True
    async with factory() as db:
        graph = await db.get(LearningGraph, 71)
        node = await db.get(GraphNode, 72)
        evidence = await load_question_attempt_evidence(db, user_id=1, graph=graph, node=node)
        assert len(evidence) == 2
        assert evidence[0].evidence_payload.hint_used is True
        assert evidence[0].evidence_payload.solution_viewed is False
        assert evidence[1].evidence_payload.hint_used is False
        assert evidence[1].evidence_payload.solution_viewed is True
        assert evidence[1].evidence_payload.attempt_number == 2
    await engine.dispose()


@pytest.mark.asyncio
async def test_invalid_submission_cross_user_and_version_mismatch(tmp_path):
    engine, factory, version_id = await database(tmp_path / "question-guards.db")
    async with factory() as db:
        with pytest.raises(InteractiveAttemptInvalid):
            await submit_interactive_answer(
                db, user_id=1, thread_id="thread-question", artifact_id=201,
                artifact_version_id=version_id, item_identity="slide-0", selected_answer=None,
                submission_request_id="none", idempotency_key="none",
            )
        with pytest.raises(InteractiveAttemptNotFound):
            await get_interactive_state(db, user_id=2, artifact_id=201, artifact_version_id=version_id)
        with pytest.raises(Exception):
            await get_interactive_state(db, user_id=1, artifact_id=201, artifact_version_id=999)
        await db.rollback()
    await engine.dispose()


@pytest.mark.asyncio
async def test_event_write_failure_rolls_back_attempt(tmp_path):
    engine, factory, version_id = await database(tmp_path / "question-rollback.db")
    async with factory() as db:
        original_flush = db.flush
        async def failing_flush(*args, **kwargs):
            if any(isinstance(row, WorkspaceLearningEvent) and row.event_type == "interaction_answered" for row in db.new):
                raise RuntimeError("controlled event failure")
            return await original_flush(*args, **kwargs)
        db.flush = failing_flush  # type: ignore[method-assign]
        with pytest.raises(RuntimeError, match="controlled event failure"):
            await submit_interactive_answer(
                db, user_id=1, thread_id="thread-question", artifact_id=201,
                artifact_version_id=version_id, item_identity="slide-0", selected_answer=1,
                submission_request_id="rollback", idempotency_key="rollback",
            )
        await db.rollback()
    async with factory() as db:
        assert await db.scalar(select(func.count(InteractiveQuestionAttempt.id))) == 0
        assert await db.scalar(select(func.count(WorkspaceLearningEvent.id)).where(WorkspaceLearningEvent.event_type == "interaction_answered")) == 0
    await engine.dispose()

@pytest.mark.asyncio
async def test_attempt_event_drives_formal_evaluator_public_view(tmp_path, monkeypatch):
    from services.learning_evaluator_integration import evaluate_graph_node, get_latest_public_evaluation

    monkeypatch.setenv("EVALUATOR_MASTER_KEY", "c1-interactive-evaluator-test-key-not-production")
    monkeypatch.setenv("KAKI_EVALUATOR_TEST_PROVIDER", "1")
    engine, factory, version_id = await database(tmp_path / "question-evaluator.db")
    async with factory() as db:
        answer, _ = await submit_interactive_answer(
            db, user_id=1, thread_id="thread-question", artifact_id=201,
            artifact_version_id=version_id, item_identity="slide-0", selected_answer=1,
            submission_request_id="evaluator-submit", idempotency_key="evaluator-submit",
        )
        await db.commit()
        assert answer["learning_event_ref"]
    async with factory() as db:
        public = await evaluate_graph_node(
            db, user_id=1, graph_ref="graph-a", node_ref="node-a",
            request_id="c1-evaluator-request", idempotency_key="c1-evaluator-idempotency",
            expected_evaluation_revision=0,
        )
        assert public["evaluation_revision"] == 1
        assert public["evidence_summaries"]
        assert "selected_index" not in str(public)
        assert "correct_index" not in str(public)
    async with factory() as db:
        recovered = await get_latest_public_evaluation(db, user_id=1, graph_ref="graph-a", node_ref="node-a")
        node = await db.get(GraphNode, 72)
        assert recovered is not None and recovered["evaluation_revision"] == 1
        assert node.status == "active"
    await engine.dispose()


@pytest.mark.asyncio
async def test_interactive_completion_semantics_distinguish_attempts_viewing_and_evaluation(tmp_path):
    from services.workspace_interactive_attempts import get_interactive_state
    engine, factory, version_id = await database(tmp_path / "question-semantics.db")
    async with factory() as db:
        initial = await get_interactive_state(db, user_id=1, artifact_id=201, artifact_version_id=version_id, thread_id="thread-question")
        assert initial["progress"] == {
            "current_step": 1, "total_steps": 1,
            "answered_interactive_items": 0, "total_interactive_items": 1,
            "all_interactive_items_attempted": False, "lesson_viewing_completed": False,
        }
        assert initial["evaluation_status"] == "NOT_EVALUATED"
        assert initial["completion_eligibility"] is None
    async with factory() as db:
        await submit_interactive_answer(
            db, user_id=1, thread_id="thread-question", artifact_id=201,
            artifact_version_id=version_id, item_identity="slide-0", selected_answer=1,
            submission_request_id="semantic-submit", idempotency_key="semantic-submit",
        )
        await db.commit()
    async with factory() as db:
        attempted = await get_interactive_state(db, user_id=1, artifact_id=201, artifact_version_id=version_id, thread_id="thread-question")
        assert attempted["progress"]["all_interactive_items_attempted"] is True
        assert attempted["progress"]["lesson_viewing_completed"] is False
        item = await db.get(GeneratedItem, 201)
        raw = dict(item.raw_data or {})
        raw["progress"] = {"completed": True, "viewed_slide_indexes": [0], "current_slide": 0, "percent": 100}
        item.raw_data = raw
        await db.commit()
    async with factory() as db:
        completed = await get_interactive_state(db, user_id=1, artifact_id=201, artifact_version_id=version_id, thread_id="thread-question")
        assert completed["progress"]["lesson_viewing_completed"] is True
        assert completed["evaluation_status"] == "READY_FOR_EVALUATION"
        assert completed["completion_eligibility"] is None
    await engine.dispose()
