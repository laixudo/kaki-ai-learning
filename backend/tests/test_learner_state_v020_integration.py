import asyncio
import inspect
from types import SimpleNamespace

from agents.learner_state import (
    BarrierCategory,
    DifficultyAction,
    LearnerStateSnapshot,
    PrimaryBarrier,
    ReasoningState,
    SupportLevel,
    TopicMastery,
    TransferReadiness,
    timeline_to_evidence,
)
from integrations.learner_state_adapter import inspect_learner_state_provider
from services import harvest_adventure
from services.learner_state_service import (
    RUNTIME_KEY,
    SLOT_KEY,
    attach_private_snapshot,
    build_request_for_run,
    initialize_run_state,
    planner_state_from_snapshot,
    record_hint_event,
    teaching_mode,
    update_after_submit,
)


def _snapshot(
    mastery=TopicMastery.PARTIAL,
    barrier=BarrierCategory.CONCEPT_CONFUSION,
    support=SupportLevel.MINIMAL_SCAFFOLD,
    transfer=TransferReadiness.NOT_READY,
):
    return LearnerStateSnapshot(
        state_id="lst_12345678",
        student_id="7",
        topic_key="梯度方向",
        topic_name="梯度方向",
        topic_mastery=mastery,
        primary_barrier=PrimaryBarrier(
            category=barrier,
            description="当前存在需要处理的概念障碍",
            evidence_refs=[],
        ),
        reasoning_state=ReasoningState.CAN_RECALL,
        support_level=support,
        transfer_readiness=transfer,
        difficulty_action=DifficultyAction.HOLD,
        next_teaching_focus="补足当前主题中的关键机制联系",
        confidence=0.8,
        evidence_refs=[],
    )


def test_v020_planner_mapping_keeps_difficulty_private():
    mapped = planner_state_from_snapshot(_snapshot())
    assert mapped["support_level"] == "hint"
    assert "difficulty_action" not in mapped


def test_v020_three_states_have_distinct_teaching_modes():
    unknown = _snapshot(mastery=TopicMastery.UNKNOWN, support=SupportLevel.WORKED_EXAMPLE)
    confused = _snapshot()
    transfer = _snapshot(
        mastery=TopicMastery.TRANSFERABLE,
        barrier=BarrierCategory.NONE_OBSERVED,
        support=SupportLevel.INDEPENDENT,
        transfer=TransferReadiness.DEMONSTRATED,
    )
    assert len({teaching_mode(unknown), teaching_mode(confused), teaching_mode(transfer)}) == 3


def test_v020_available_hint_is_not_hint_usage():
    timeline = [
        {"node":"INTERLEAVE", "decision":"needs_review", "score":0, "attempts":1, "hint":"可用提示", "response":"错"},
        {"node":"INTERLEAVE", "decision":"pass", "score":1, "attempts":2, "response":"改正"},
    ]
    final = timeline_to_evidence(timeline)[-1]
    assert final.self_corrected is True
    assert final.corrected_with_support is False


def test_v020_explicit_hint_marks_supported_correction():
    slots = {"timeline":[{"node":"INTERLEAVE", "decision":"needs_review", "score":0, "attempts":1, "response":"错"}]}
    record_hint_event(slots, node="INTERLEAVE", hint="看关键条件")
    slots["timeline"].append({"node":"INTERLEAVE", "decision":"pass", "score":1, "attempts":2, "response":"改正"})
    final = timeline_to_evidence(slots["timeline"])[-1]
    assert final.corrected_with_support is True
    assert final.self_corrected is False


def test_v020_boss_stage_two_is_the_transfer_stage():
    evidence = timeline_to_evidence([
        {"node":"BOSS", "boss_stage":1, "decision":"pass", "score":1, "attempts":1, "response":"辨析"},
        {"node":"BOSS", "boss_stage":2, "decision":"pass", "score":1, "attempts":2, "response":"迁移"},
    ])
    assert evidence[0].task_type.value == "distinction"
    assert evidence[1].task_type.value == "transfer"


def test_v020_private_snapshot_does_not_require_public_schema_change():
    slots = {"timeline":[]}
    state = _snapshot()
    initialize_run_state(slots, state, plan_id="p1", draft_revision=1)
    public = {"run_id":"r1", "state":"GOAL"}
    private = dict(public)
    attach_private_snapshot(private, slots)
    assert SLOT_KEY in slots
    assert "learner_state_snapshot" in private
    assert "learner_state_snapshot" not in public


def test_v020_provider_failure_does_not_block_state_update():
    async def broken_factory():
        raise RuntimeError("offline")
    task = SimpleNamespace(task_id="r1", user_id=7)
    slots = {
        "archive":{"topic":"梯度方向"},
        "timeline":[{"node":"TRIAL", "decision":"needs_review", "score":0, "attempts":1, "response":"错"}],
    }
    state = asyncio.run(update_after_submit(task, slots, attempted_node="TRIAL", analyzer_factory=broken_factory))
    assert state.source == "fallback"
    assert slots[RUNTIME_KEY]["last_metadata"]["fallback_used"] is True


def test_v020_model_call_budget_is_three():
    async def should_not_run():
        raise AssertionError("model budget should block this call")
    task = SimpleNamespace(task_id="r1", user_id=7)
    slots = {
        "archive":{"topic":"梯度方向"},
        "timeline":[{"node":"INTERLEAVE", "decision":"pass", "score":1, "attempts":1, "response":"正确"}],
        RUNTIME_KEY:{"model_calls":3},
    }
    asyncio.run(update_after_submit(task, slots, attempted_node="INTERLEAVE", analyzer_factory=should_not_run))
    assert slots[RUNTIME_KEY]["model_calls"] == 3
    assert slots[RUNTIME_KEY]["last_metadata"]["generation_mode"] == "deterministic"


def test_v020_current_item_only_has_no_recent_history():
    task = SimpleNamespace(task_id="r1", user_id=7)
    request = build_request_for_run(task, {
        "archive":{"topic":"圆面积"},
        "context_mode":"current_item_only",
        "timeline":[{"node":"TRIAL", "decision":"pass", "score":1, "attempts":1, "response":"πr²"}],
    }, attempted_node="TRIAL")
    assert request.recent_related_evidence == []


def test_v020_provider_status_keeps_configured_model_separate():
    status = inspect_learner_state_provider(SimpleNamespace(
        MODE="production", LLM_PROVIDER="deepseek", MODEL="deepseek-chat", DEEPSEEK_API_KEY="secret"
    ))
    assert status.ready is True
    assert status.configured_model_id == "deepseek-chat"
    assert "secret" not in status.reason


def test_v020_public_snapshot_source_has_no_learner_state_field():
    source = inspect.getsource(harvest_adventure._snapshot)
    assert '"learner_state"' not in source
    assert '"confidence"' not in source
    assert '"evidence_refs"' not in source


def test_v020_claim_separates_public_content_and_private_raw_data():
    source = inspect.getsource(harvest_adventure._claim)
    assert "public_summary" in source
    assert "private_raw_data" in source
    assert "attach_private_snapshot(private_raw_data, slots)" in source
    assert "content=json.dumps(public_summary" in source


def test_v020_current_item_only_never_reuses_historical_state():
    prepare_source = inspect.getsource(harvest_adventure.prepare_adventure)
    assert 'if effective_context_mode != "current_item_only"' in prepare_source
    start_source = inspect.getsource(harvest_adventure.start_adventure)
    assert 'initial_learner_state is None and run_context_mode != "current_item_only"' in start_source


def test_v020_same_checkpoint_calls_model_at_most_once():
    calls = {"count": 0}

    async def failing_factory():
        calls["count"] += 1
        raise RuntimeError("offline")

    task = SimpleNamespace(task_id="r-repeat", user_id=7)
    slots = {
        "archive": {"topic": "梯度方向"},
        "timeline": [
            {"node": "TRIAL", "decision": "needs_review", "score": 0, "attempts": 1, "response": "错"}
        ],
    }
    asyncio.run(update_after_submit(task, slots, attempted_node="TRIAL", analyzer_factory=failing_factory))
    slots["timeline"].append(
        {"node": "TRIAL", "decision": "pass", "score": 1, "attempts": 2, "response": "改正"}
    )
    asyncio.run(update_after_submit(task, slots, attempted_node="TRIAL", analyzer_factory=failing_factory))

    assert calls["count"] == 1
    assert slots[RUNTIME_KEY]["model_calls"] == 1
    assert slots[RUNTIME_KEY]["model_checkpoints"] == ["TRIAL"]
