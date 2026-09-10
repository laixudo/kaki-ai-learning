from __future__ import annotations

import copy
import json

import pytest

from agents.narrative_director.adapter import NarrativeAdapterError, build_narrative_request
from agents.narrative_director.enums import NarrativeGrammar, TeachingMode
from agents.narrative_director.frame_selector import select_narrative_frame


def test_adapter_strips_all_private_answer_fields(narrative_request):
    payload = json.dumps(narrative_request.model_dump(mode="json"), ensure_ascii=False)
    for token in ("correct_option", "accepted_groups", "rubric", "PRIVATE_SOLUTION", "PRIVATE_ACCEPTED", "hint"):
        assert token not in payload


def test_adapter_keeps_all_five_route_tasks(narrative_request):
    assert narrative_request.route_tasks.understanding_trial.public_prompt
    assert narrative_request.route_tasks.practice_trial.public_prompt
    assert narrative_request.route_tasks.remedy.public_prompt
    assert narrative_request.route_tasks.understanding_interleave.public_prompt
    assert narrative_request.route_tasks.practice_interleave.public_prompt


def test_adapter_keeps_boss_order(narrative_request):
    assert narrative_request.boss_tasks.understand.task_role.value == "boss_understand"
    assert narrative_request.boss_tasks.distinguish.task_role.value == "boss_distinguish"
    assert narrative_request.boss_tasks.transfer.task_role.value == "boss_transfer"


@pytest.mark.parametrize(
    "path",
    [
        ("plan", "preview"),
        ("plan", "core_concepts"),
        ("plan", "misconceptions"),
        ("plan", "challenges", "understanding_trial"),
        ("plan", "challenges", "practice_trial"),
        ("plan", "challenges", "remedy"),
        ("plan", "challenges", "understanding_interleave"),
        ("plan", "challenges", "practice_interleave"),
        ("plan", "challenges", "boss"),
    ],
)
def test_adapter_fails_closed_on_missing_academic_fields(planner_result, path):
    value = copy.deepcopy(planner_result)
    parent = value
    for key in path[:-1]:
        parent = parent[key]
    parent.pop(path[-1], None)
    with pytest.raises(NarrativeAdapterError):
        build_narrative_request(
            value,
            teaching_mode="concept_building",
            plan_id="advplan_test_001",
            plan_revision=1,
        )


@pytest.mark.parametrize(
    "mode,expected",
    [
        (TeachingMode.CONCEPT_BUILDING, NarrativeGrammar.DISCOVER_RULE),
        (TeachingMode.MISCONCEPTION_DISTINCTION, NarrativeGrammar.EXPOSE_ILLUSION),
        (TeachingMode.TRANSFER_CHALLENGE, NarrativeGrammar.TRANSFER_ACROSS_BORDER),
        (TeachingMode.SCAFFOLDED_PRACTICE, NarrativeGrammar.REPAIR_MECHANISM),
        (TeachingMode.MECHANISM_LINKING, NarrativeGrammar.REPAIR_MECHANISM),
    ],
)
def test_frame_selection_is_deterministic_by_mode(narrative_request, mode, expected):
    frame1 = select_narrative_frame(mode, narrative_request.route_tasks)
    frame2 = select_narrative_frame(mode, narrative_request.route_tasks)
    assert frame1 == frame2
    assert frame1.grammar == expected
    assert frame1.frame_id == frame2.frame_id


def test_frame_uses_real_scene_registry(narrative_request):
    frame = narrative_request.frame
    assert frame.primary_scene_id == "mirror_lake"
    assert frame.primary_scene_name == "镜湖"
    assert frame.alternate_scene_id == "mist_valley"
    assert frame.alternate_scene_name == "雾谷"
    assert "水面倒影" in frame.allowed_objects


def test_request_revision_contract(planner_result):
    planner_result["metadata"]["draft_revision"] = 2
    planner_result["metadata"]["adjustment_count"] = 1
    request = build_narrative_request(
        planner_result,
        teaching_mode="concept_building",
        plan_id="advplan_test_002",
        plan_revision=2,
    )
    assert request.draft_revision == 2
    assert request.adjustment_count == 1
