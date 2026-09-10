from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import pytest
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from database.models import WorkspaceAgentTask
import services.harvest_adventure as service


@pytest.mark.asyncio
async def test_repeated_prepare_reuses_one_draft(monkeypatch, tmp_path):
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'prepare-idempotency.db'}")
    async with engine.begin() as connection:
        await connection.run_sync(WorkspaceAgentTask.__table__.create)
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    planner_calls = 0

    async def build_request(*args, **kwargs):
        return {"context_mode": "current_item_only", "recent_turns": []}

    async def prepare_plan(payload):
        nonlocal planner_calls
        planner_calls += 1
        return {
            "status": "ready",
            "clarification": None,
            "preview": {"theme": "光合作用", "goals": []},
            "metadata": {
                "generation_mode": "model",
                "warnings": [],
                "draft_revision": 1,
                "adjustment_count": 0,
                "plan_state": "draft",
            },
            "_private_result": None,
        }

    async def no_snapshot(*args, **kwargs):
        return None

    monkeypatch.setattr(service, "_build_planner_request", build_request)
    monkeypatch.setattr(service, "prepare_adventure_knowledge_plan", prepare_plan)
    monkeypatch.setattr(service, "load_latest_topic_snapshot", no_snapshot)

    async with sessions() as db:
        first = await service.prepare_adventure(
            db, user_id=8808, topic_hint="光合作用", thread_id="same-thread"
        )
        second = await service.prepare_adventure(
            db, user_id=8808, topic_hint="光合作用", thread_id="same-thread"
        )
        count = await db.scalar(select(func.count()).select_from(WorkspaceAgentTask))

    await engine.dispose()
    assert first["plan_id"] == second["plan_id"]
    assert first["idempotent_replay"] is False
    assert second["idempotent_replay"] is True
    assert count == 1
    assert planner_calls == 1
