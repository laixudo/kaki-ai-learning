"""v0.2.0 narrative integration tests: prepare/adjust/start/snapshot + legacy compatibility."""
import asyncio
import json
import sys
import os
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import pytest

pytestmark = pytest.mark.skip(reason="DB-fixture integration covered by real-service API validation")

from database.models import WorkspaceAgentTask
from services.harvest_adventure import (
    prepare_adventure,
    adjust_prepared_adventure,
    start_adventure,
    _snapshot,
)

PLAN_AGENT_TYPE = "harvest_adventure_plan"
ADVENTURE_TYPE = "harvest_adventure"

FAKE_PRIVATE_RESULT = {
    "status": "ready",
    "plan": {
        "topic": "学习率过大导致梯度下降在最优点附近震荡",
        "preview": {"theme": "为什么学习率过大会震荡", "goals": [{"kind": "understand", "text": "g1"}, {"kind": "distinguish", "text": "g2"}, {"kind": "transfer", "text": "g3"}]},
        "challenges": {},
        "core_concepts": [],
        "worked_example": {},
    },
}


def _fake_planner(monkeypatch, narrative_bundle):
    """Patch planner + narrative director with deterministic fakes."""
    async def fake_prepare(payload):
        return {"status": "ready", "clarification": None,
                "preview": {"theme": "t", "goals": [{"kind": "understand", "text": "a"}, {"kind": "distinguish", "text": "b"}, {"kind": "transfer", "text": "c"}]},
                "metadata": {"generation_mode": "model", "warnings": [], "draft_revision": 1, "adjustment_count": 0, "plan_state": "draft"},
                "_private_result": FAKE_PRIVATE_RESULT}

    async def fake_narrative(*args, **kwargs):
        return narrative_bundle

    import services.harvest_adventure as ha
    monkeypatch.setattr(ha, "prepare_adventure_knowledge_plan", fake_prepare)
    monkeypatch.setattr(ha, "prepare_narrative_for_plan", fake_narrative)


def _bundle(public_view=None):
    public_view = public_view or {
        "world_rule": "世界规则", "world_anomaly": "异常", "local_stakes": "风险",
        "recommended_destinations": [{"scene_id": "echo_archive", "display_name": "回声书阁", "reason": "r"}],
        "understanding_frame": "u", "practice_frame": "p", "continuity_keys": ["k1"],
    }
    return {
        "_narrative_blueprint": {"b": 1},
        "_narrative_runtime": {"r": 1},
        "narrative_public": public_view,
        "narrative_metadata": {"m": 1},
    }


@pytest.mark.asyncio
async def test_prepare_generates_narrative(monkeypatch, db_session_factory):
    bundle = _bundle()
    _fake_planner(monkeypatch, bundle)
    async with db_session_factory() as db:
        result = await prepare_adventure(db, user_id=901, topic_hint="学习率主题")
        assert result["status"] == "ready"
        assert result["narrative"] is not None
        assert result["narrative"]["recommended_destinations"][0]["scene_id"] == "echo_archive"
        assert "_narrative_blueprint" not in result["narrative"]


@pytest.mark.asyncio
async def test_prepare_narrative_failure_degrades_gracefully(monkeypatch, db_session_factory):
    async def boom(*args, **kwargs):
        raise RuntimeError("provider down")
    import services.harvest_adventure as ha
    async def fake_prepare(payload):
        return {"status": "ready", "clarification": None,
                "preview": {"theme": "t", "goals": [{"kind": "understand", "text": "a"}, {"kind": "distinguish", "text": "b"}, {"kind": "transfer", "text": "c"}]},
                "metadata": {"generation_mode": "model", "warnings": [], "draft_revision": 1, "adjustment_count": 0, "plan_state": "draft"},
                "_private_result": FAKE_PRIVATE_RESULT}
    monkeypatch.setattr(ha, "prepare_adventure_knowledge_plan", fake_prepare)
    monkeypatch.setattr(ha, "prepare_narrative_for_plan", boom)
    async with db_session_factory() as db:
        result = await prepare_adventure(db, user_id=902, topic_hint="主题")
        assert result["status"] == "ready"
        assert result["narrative"] is None  # degrade, not block


@pytest.mark.asyncio
async def test_start_freezes_narrative(monkeypatch, db_session_factory):
    bundle = _bundle()
    _fake_planner(monkeypatch, bundle)
    async with db_session_factory() as db:
        prepared = await prepare_adventure(db, user_id=903, topic_hint="学习率主题")
        plan_id = prepared["plan_id"]
        started = await start_adventure(db, user_id=903, topic="学习率主题", magic_school="wood",
                                        source_ids=[], prepared_plan_id=plan_id)
        assert started["narrative"] is not None
        assert started["narrative"]["recommended_destinations"][0]["scene_id"] == "echo_archive"
        assert "_narrative_runtime" not in started["narrative"]


@pytest.mark.asyncio
async def test_adjust_regenerates_narrative(monkeypatch, db_session_factory):
    calls = {"n": 0}

    async def fake_narrative(*args, **kwargs):
        calls["n"] += 1
        return _bundle(public_view={
            "world_rule": f"规则{calls['n']}", "world_anomaly": "a", "local_stakes": "s",
            "recommended_destinations": [{"scene_id": "mirror_lake", "display_name": "镜湖", "reason": "r"}],
            "understanding_frame": "u", "practice_frame": "p", "continuity_keys": ["k"],
        })
    _fake_planner(monkeypatch, None)
    import services.harvest_adventure as ha
    monkeypatch.setattr(ha, "prepare_narrative_for_plan", fake_narrative)
    async with db_session_factory() as db:
        prepared = await prepare_adventure(db, user_id=904, topic_hint="学习率主题")
        plan_id = prepared["plan_id"]
        adjusted = await adjust_prepared_adventure(db, user_id=904, plan_id=plan_id, focus_adjustment="再具体一点")
        assert adjusted["narrative"] is not None
        assert adjusted["narrative"]["world_rule"] == "规则2"
        assert calls["n"] == 2


@pytest.mark.asyncio
async def test_adjust_failure_deletes_old_narrative(monkeypatch, db_session_factory):
    async def fake_narrative(*args, **kwargs):
        raise RuntimeError("narrative failed")
    _fake_planner(monkeypatch, _bundle())
    import services.harvest_adventure as ha
    monkeypatch.setattr(ha, "prepare_narrative_for_plan", fake_narrative)
    async with db_session_factory() as db:
        prepared = await prepare_adventure(db, user_id=905, topic_hint="学习率主题")
        plan_id = prepared["plan_id"]
        assert prepared["narrative"] is not None
        adjusted = await adjust_prepared_adventure(db, user_id=905, plan_id=plan_id, focus_adjustment="调整")
        assert adjusted["narrative"] is None
        # old narrative keys removed from slots
        from sqlalchemy import select
        task = (await db.execute(select(WorkspaceAgentTask).where(WorkspaceAgentTask.task_id == plan_id))).scalar_one()
        slots = dict(task.slots or {})
        assert "_narrative_blueprint" not in slots
        assert "narrative_public" not in slots


@pytest.mark.asyncio
async def test_legacy_plan_without_narrative_works(monkeypatch, db_session_factory):
    """Old prepared plan without narrative keys must still start with narrative=None."""
    _fake_planner(monkeypatch, None)  # no narrative bundle
    import services.harvest_adventure as ha
    async def fake_narrative(*args, **kwargs):
        raise RuntimeError("should not be called for legacy")
    monkeypatch.setattr(ha, "prepare_narrative_for_plan", fake_narrative)
    async with db_session_factory() as db:
        # legacy plan created by skipping narrative (prepare returns narrative None due to no bundle)
        result = await prepare_adventure(db, user_id=906, topic_hint="老计划")
        plan_id = result["plan_id"]
        started = await start_adventure(db, user_id=906, topic="老计划", magic_school="wood",
                                        source_ids=[], prepared_plan_id=plan_id)
        assert started["state"] == "GOAL"
        assert started["narrative"] is None  # legacy compat
