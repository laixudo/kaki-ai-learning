from __future__ import annotations

import copy
import re

import pytest

from agents.narrative_director.enums import Severity
from agents.narrative_director.fallback import build_fallback_blueprint
from agents.narrative_director.models import NarrativeBlueprint
from agents.narrative_director.normalizers import normalize_blueprint
from agents.narrative_director.validators import has_errors, validate_blueprint


def _codes(issues):
    return {issue.code for issue in issues}


def test_fallback_passes_validation(narrative_request):
    blueprint = build_fallback_blueprint(narrative_request)
    blueprint, _ = normalize_blueprint(blueprint, narrative_request)
    issues = validate_blueprint(blueprint, narrative_request)
    assert not has_errors(issues), issues


def test_fallback_has_no_template_placeholders(narrative_request):
    payload = build_fallback_blueprint(narrative_request).model_dump(mode="json")
    def strings(value):
        if isinstance(value, dict):
            for item in value.values():
                yield from strings(item)
        elif isinstance(value, list):
            for item in value:
                yield from strings(item)
        elif isinstance(value, str):
            yield value
    assert not any(re.search(r"\{[A-Za-z_][A-Za-z0-9_]*\}", text) for text in strings(payload))


def test_fallback_uses_primary_scene(narrative_request):
    blueprint = build_fallback_blueprint(narrative_request)
    assert narrative_request.frame.primary_scene_name in blueprint.beats.opening
    assert blueprint.world_anomaly.affected_object in narrative_request.frame.allowed_objects


def test_normalizer_injects_primary_scene(narrative_request, valid_blueprint_payload):
    value = copy.deepcopy(valid_blueprint_payload)
    value["beats"]["opening"] = "一处线索突然失去稳定回应，等待玩家检查。"
    blueprint = NarrativeBlueprint.model_validate(value)
    normalized, warnings = normalize_blueprint(blueprint, narrative_request)
    assert narrative_request.frame.primary_scene_name in normalized.beats.opening
    assert "primary_scene_injected_into_opening" in warnings


def test_unknown_registered_scene_is_normalized(narrative_request, valid_blueprint_payload):
    value = copy.deepcopy(valid_blueprint_payload)
    value["beats"]["opening"] = "机关工坊里，齿轮突然错位。"
    blueprint = NarrativeBlueprint.model_validate(value)
    normalized, warnings = normalize_blueprint(blueprint, narrative_request)
    assert "机关工坊" not in normalized.beats.opening
    assert "镜湖" in normalized.beats.opening
    assert any(item.startswith("scene_name_normalized") for item in warnings)


def test_unregistered_place_is_rejected(narrative_request, valid_blueprint_payload):
    value = copy.deepcopy(valid_blueprint_payload)
    value["beats"]["opening"] = "镜湖里，玩家进入冰原神殿，倒影开始错位。"
    blueprint = NarrativeBlueprint.model_validate(value)
    issues = validate_blueprint(blueprint, narrative_request)
    assert "UNREGISTERED_PLACE_NAME" in _codes(issues)


@pytest.mark.parametrize("token", ["基础薄弱", "粗心", "学渣", "能力差"])
def test_student_labels_are_rejected(narrative_request, valid_blueprint_payload, token):
    value = copy.deepcopy(valid_blueprint_payload)
    value["beats"]["opening"] += token
    issues = validate_blueprint(NarrativeBlueprint.model_validate(value), narrative_request)
    assert "STUDENT_LABEL" in _codes(issues)


@pytest.mark.parametrize("token", ["correct_option", "accepted_groups", "learner_state", "正确答案是B"])
def test_private_and_answer_leaks_are_rejected(narrative_request, valid_blueprint_payload, token):
    value = copy.deepcopy(valid_blueprint_payload)
    value["beats"]["resolution"] += token
    issues = validate_blueprint(NarrativeBlueprint.model_validate(value), narrative_request)
    assert any(code in _codes(issues) for code in {"PRIVATE_DATA_LEAK", "ANSWER_LEAK"})


def test_invalid_object_is_normalized(narrative_request, valid_blueprint_payload):
    value = copy.deepcopy(valid_blueprint_payload)
    value["world_anomaly"]["affected_object"] = "天空飞船"
    blueprint = NarrativeBlueprint.model_validate(value)
    normalized, warnings = normalize_blueprint(blueprint, narrative_request)
    assert normalized.world_anomaly.affected_object in narrative_request.frame.allowed_objects
    assert any(item.startswith("affected_object_normalized") for item in warnings)


def test_grand_stakes_are_reduced(narrative_request, valid_blueprint_payload):
    value = copy.deepcopy(valid_blueprint_payload)
    value["world_anomaly"]["local_stakes"] = "如果失败，整个宇宙毁灭并且所有生命永远消失。"
    blueprint = NarrativeBlueprint.model_validate(value)
    normalized, warnings = normalize_blueprint(blueprint, narrative_request)
    assert "宇宙毁灭" not in normalized.world_anomaly.local_stakes
    assert "grand_stakes_reduced_to_local" in warnings


def test_continuity_requires_scene_object(narrative_request, valid_blueprint_payload):
    value = copy.deepcopy(valid_blueprint_payload)
    value["continuity_keys"] = ["抽象规则"]
    issues = validate_blueprint(NarrativeBlueprint.model_validate(value), narrative_request)
    assert "CONTINUITY_NOT_SCENE_BOUND" in _codes(issues)


def test_validation_issue_severities_are_structured(narrative_request, valid_blueprint_payload):
    value = copy.deepcopy(valid_blueprint_payload)
    value["beats"]["opening"] += "基础薄弱"
    issues = validate_blueprint(NarrativeBlueprint.model_validate(value), narrative_request)
    assert any(issue.severity == Severity.ERROR and issue.repair_mode == "clean" for issue in issues)
