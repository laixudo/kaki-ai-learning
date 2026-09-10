from __future__ import annotations

import json

from agents.narrative_director.compiler import STATE_ORDER, compile_runtime
from agents.narrative_director.serializer import PUBLIC_TOP_LEVEL_KEYS, build_public_view, public_payload
from agents.narrative_director.validators import validate_blueprint


def _runtime(narrative_request, fallback_blueprint):
    return compile_runtime(
        narrative_request,
        fallback_blueprint,
        generation_mode="fallback",
        model=None,
        tokens_used=0,
        raw_attempts=0,
        warnings=[],
        diagnostics=["test"],
        prompt_hash="a" * 64,
        schema_hash="b" * 64,
        validation_issues=validate_blueprint(fallback_blueprint, narrative_request),
    )


def test_state_order_is_exactly_existing_eight_states(narrative_request, fallback_blueprint):
    runtime = _runtime(narrative_request, fallback_blueprint)
    assert runtime.state_order == STATE_ORDER
    assert [item.value for item in runtime.state_order] == [
        "GOAL", "SCROLL", "METHOD", "TRIAL", "SUPPLY", "INTERLEAVE", "BOSS", "TREASURY"
    ]


def test_compiler_binds_all_five_route_tasks(narrative_request, fallback_blueprint):
    runtime = _runtime(narrative_request, fallback_blueprint)
    assert runtime.bindings.trial.understanding_task.path == "understanding.trial"
    assert runtime.bindings.trial.practice_task.path == "practice.trial"
    assert runtime.bindings.supply.remedy_task.path == "remedy"
    assert runtime.bindings.interleave.understanding_task.path == "understanding.interleave"
    assert runtime.bindings.interleave.practice_task.path == "practice.interleave"


def test_compiler_binds_boss_in_fixed_order(narrative_request, fallback_blueprint):
    runtime = _runtime(narrative_request, fallback_blueprint)
    assert [stage.stage for stage in runtime.bindings.boss.stages] == ["understand", "distinguish", "transfer"]
    assert [stage.label for stage in runtime.bindings.boss.stages] == ["解释", "辨析", "迁移"]
    assert [stage.task.path for stage in runtime.bindings.boss.stages] == [
        "boss.understand", "boss.distinguish", "boss.transfer"
    ]


def test_supply_has_success_and_remediation_branches(narrative_request, fallback_blueprint):
    runtime = _runtime(narrative_request, fallback_blueprint)
    assert runtime.bindings.supply.success_respite
    assert runtime.bindings.supply.remediation_reframe
    assert runtime.bindings.supply.remedy_task.public_prompt == narrative_request.route_tasks.remedy.public_prompt


def test_destinations_use_real_scene_ids(narrative_request, fallback_blueprint):
    runtime = _runtime(narrative_request, fallback_blueprint)
    ids = [item.scene_id for item in runtime.recommended_destinations]
    assert ids[:2] == [narrative_request.frame.primary_scene_id, narrative_request.frame.alternate_scene_id]
    assert 2 <= len(ids) <= 3
    assert all(scene_id in {"camp", "echo_archive", "mirror_lake", "mechanism_workshop", "mist_valley", "transfer_bridge"} for scene_id in ids)


def test_runtime_hash_is_deterministic(narrative_request, fallback_blueprint):
    one = _runtime(narrative_request, fallback_blueprint)
    two = _runtime(narrative_request, fallback_blueprint)
    assert one.blueprint_hash == two.blueprint_hash
    assert one.frame.frame_id == two.frame.frame_id


def test_public_view_uses_exact_allowlist(narrative_request, fallback_blueprint):
    runtime = _runtime(narrative_request, fallback_blueprint)
    view = build_public_view(runtime, fallback_blueprint)
    payload = public_payload(view)
    assert set(payload) == PUBLIC_TOP_LEVEL_KEYS


def test_public_view_does_not_leak_private_fields(narrative_request, fallback_blueprint):
    runtime = _runtime(narrative_request, fallback_blueprint)
    payload = json.dumps(public_payload(build_public_view(runtime, fallback_blueprint)), ensure_ascii=False)
    for token in (
        "alignment_note", "teaching_mode", "confidence", "evidence_refs", "validation_issues",
        "calibration", "prompt_hash", "schema_hash", "correct_option", "accepted_groups", "rubric"
    ):
        assert token not in payload


def test_public_view_includes_frontend_scene_identifiers(narrative_request, fallback_blueprint):
    runtime = _runtime(narrative_request, fallback_blueprint)
    payload = public_payload(build_public_view(runtime, fallback_blueprint))
    assert payload["world"]["scene_id"] == narrative_request.frame.primary_scene_id
    assert payload["world"]["scene_name"] == narrative_request.frame.primary_scene_name
    assert payload["recommended_destinations"][0]["scene_id"] == narrative_request.frame.primary_scene_id


def test_runtime_keeps_plan_identity(narrative_request, fallback_blueprint):
    runtime = _runtime(narrative_request, fallback_blueprint)
    assert runtime.plan_id == narrative_request.plan_id
    assert runtime.plan_revision == narrative_request.plan_revision
    assert runtime.source_plan_fingerprint == narrative_request.source_plan_fingerprint


def test_concept_building_does_not_recommend_transfer_bridge_too_early(planner_result):
    from agents.narrative_director.adapter import build_narrative_request
    from agents.narrative_director.fallback import build_fallback_blueprint

    request = build_narrative_request(
        planner_result,
        teaching_mode="concept_building",
        plan_id="advplan_concept_001",
        plan_revision=1,
    )
    blueprint = build_fallback_blueprint(request)
    runtime = compile_runtime(
        request,
        blueprint,
        generation_mode="fallback",
        model=None,
        tokens_used=0,
        raw_attempts=0,
        warnings=[],
        diagnostics=[],
        prompt_hash="a" * 64,
        schema_hash="b" * 64,
        validation_issues=validate_blueprint(blueprint, request),
    )
    assert "transfer_bridge" not in [item.scene_id for item in runtime.recommended_destinations]


def test_slot_public_reader_fails_closed_on_extra_private_field(narrative_request, fallback_blueprint):
    from agents.narrative_director.compiler import compile_runtime
    from agents.narrative_director.serializer import build_public_view, public_payload
    from integrations.narrative_director_adapter import PUBLIC_VIEW_KEY, narrative_public_from_slots

    runtime = compile_runtime(
        narrative_request,
        fallback_blueprint,
        generation_mode="fallback",
        model=None,
        tokens_used=0,
        raw_attempts=0,
        warnings=[],
        diagnostics=[],
        prompt_hash="p" * 64,
        schema_hash="s" * 64,
        validation_issues=[],
    )
    payload = public_payload(build_public_view(runtime, fallback_blueprint))
    payload["_narrative_runtime"] = {"secret": True}
    assert narrative_public_from_slots({PUBLIC_VIEW_KEY: payload}) is None
