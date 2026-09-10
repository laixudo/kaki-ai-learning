from __future__ import annotations

import asyncio

import pytest

from database.models import WorkspaceAgentTask
import services.harvest_adventure as harvest_service
from services.harvest_adventure import (
    PLAN_AGENT_TYPE,
    adjust_prepared_adventure,
)


class _ScalarResult:
    def __init__(self, task):
        self.task = task

    def scalar_one_or_none(self):
        return self.task


class _FakeDB:
    def __init__(self, task):
        self.task = task
        self.execute_calls = 0
        self.commit_calls = 0

    async def execute(self, _statement):
        self.execute_calls += 1
        return _ScalarResult(self.task)

    async def commit(self):
        self.commit_calls += 1

    async def refresh(self, _task):
        return None


def _task(*, task_id: str, slots: dict) -> WorkspaceAgentTask:
    return WorkspaceAgentTask(
        task_id=task_id,
        user_id=41,
        thread_id="qa-v022-adjustment-limit",
        agent_type=PLAN_AGENT_TYPE,
        state="prepared",
        execution_key=f"plan_{task_id}",
        slots=slots,
    )


async def _fake_prepare(payload):
    count = int(payload["adjustment_count"])
    revision = int(payload["draft_revision"])
    return {
        "status": "ready",
        "clarification": None,
        "preview": {
            "theme": f"调整版本 {revision}",
            "goals": [
                {"kind": "understand", "text": "理解当前核心概念"},
                {"kind": "distinguish", "text": "辨析当前关键误区"},
                {"kind": "transfer", "text": "迁移到一个新的情境"},
            ],
        },
        "metadata": {
            "generation_mode": "model",
            "request_fingerprint": f"request-{revision:02d}-fingerprint",
            "content_fingerprint": f"content-{revision:02d}-fingerprint",
            "model": "fake-model",
            "tokens_used": 1,
            "warnings": [],
            "diagnostics": [],
            "difficulty_trace": [],
            "raw_attempts": 1,
            "draft_revision": revision,
            "adjustment_count": count,
            "plan_state": "draft",
        },
        "_private_result": None,
    }


def _base_slots() -> dict:
    return {
        "status": "ready",
        "preview": None,
        "clarification": None,
        "metadata": {
            "draft_revision": 1,
            "adjustment_count": 0,
            "plan_state": "draft",
        },
        "topic_hint": "梯度下降方向",
        "explicit_confusion": "为什么要沿负梯度方向？",
        "source_ids": [],
        "confirmed_facts": [],
        "focus_adjustment_history": [],
        "draft_revision": 1,
        "adjustment_count": 0,
        "plan_state": "draft",
        "context_mode": "relevant_recent",
    }


def test_two_adjustments_succeed_and_third_is_rejected(monkeypatch):
    async def run():
        monkeypatch.setattr(
            harvest_service,
            "prepare_adventure_knowledge_plan",
            _fake_prepare,
        )
        task = _task(task_id="advplan_v022_limit", slots=_base_slots())
        db = _FakeDB(task)

        first = await adjust_prepared_adventure(
            db, task.user_id, task.task_id, "多讲几何意义"
        )
        second = await adjust_prepared_adventure(
            db, task.user_id, task.task_id, "增加一个生活类比"
        )

        assert first["draft_revision"] == 2
        assert first["adjustment_count"] == 1
        assert second["draft_revision"] == 3
        assert second["adjustment_count"] == 2
        assert task.slots["focus_adjustment_history"] == [
            "多讲几何意义",
            "增加一个生活类比",
        ]
        assert task.slots["metadata"]["adjustment_count"] == 2

        with pytest.raises(ValueError, match="最多 2 次"):
            await adjust_prepared_adventure(
                db, task.user_id, task.task_id, "第三次调整不应成功"
            )
        assert db.commit_calls == 2

    asyncio.run(run())


def test_stored_count_blocks_third_adjustment_even_when_history_is_stale(monkeypatch):
    async def run():
        called = False

        async def must_not_call(_payload):
            nonlocal called
            called = True
            raise AssertionError("planner must not be called after the limit")

        monkeypatch.setattr(
            harvest_service,
            "prepare_adventure_knowledge_plan",
            must_not_call,
        )
        slots = _base_slots()
        slots["metadata"] = {
            "draft_revision": 3,
            "adjustment_count": 2,
            "plan_state": "draft",
        }
        slots["draft_revision"] = 3
        slots["adjustment_count"] = 2
        slots["focus_adjustment_history"] = []

        task = _task(task_id="advplan_v022_stale_history", slots=slots)
        db = _FakeDB(task)

        with pytest.raises(ValueError, match="最多 2 次"):
            await adjust_prepared_adventure(
                db, task.user_id, task.task_id, "不应通过的第三次调整"
            )
        assert called is False
        assert db.commit_calls == 0

    asyncio.run(run())


def test_locked_plan_cannot_be_adjusted(monkeypatch):
    async def run():
        async def must_not_call(_payload):
            raise AssertionError("locked plan must not call planner")

        monkeypatch.setattr(
            harvest_service,
            "prepare_adventure_knowledge_plan",
            must_not_call,
        )
        slots = _base_slots()
        slots["plan_state"] = "locked"
        task = _task(task_id="advplan_v022_locked", slots=slots)
        db = _FakeDB(task)

        with pytest.raises(ValueError, match="不能继续调整"):
            await adjust_prepared_adventure(
                db, task.user_id, task.task_id, "锁定后不应调整"
            )
        assert db.commit_calls == 0

    asyncio.run(run())
