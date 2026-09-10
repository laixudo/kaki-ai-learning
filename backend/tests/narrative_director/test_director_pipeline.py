from __future__ import annotations

import copy
import json

import pytest

from agents.narrative_director.director import NarrativeDirector
from agents.narrative_director.fallback import build_fallback_blueprint
from agents.narrative_director.llm_protocol import UnavailableLLM


@pytest.mark.asyncio
async def test_valid_model_output_compiles_without_repair(narrative_request, valid_blueprint_payload, fake_llm_cls):
    llm = fake_llm_cls([valid_blueprint_payload])
    result = await NarrativeDirector(llm).generate(narrative_request)
    assert result.runtime.metadata.generation_mode == "model"
    assert result.runtime.metadata.raw_attempts == 1
    assert len(llm.calls) == 1


@pytest.mark.asyncio
async def test_invalid_json_gets_one_structural_repair(narrative_request, valid_blueprint_payload, fake_llm_cls):
    llm = fake_llm_cls([
        {"content": "not-json", "model": "fake", "tokens_used": 10, "finish_reason": "stop"},
        valid_blueprint_payload,
    ])
    result = await NarrativeDirector(llm).generate(narrative_request)
    assert result.runtime.metadata.generation_mode == "repair"
    assert result.runtime.metadata.raw_attempts == 2
    assert len(llm.calls) == 2
    repair_payload = json.loads(llm.calls[1]["messages"][0]["content"])
    assert "CANDIDATE_BLUEPRINT" in repair_payload


@pytest.mark.asyncio
async def test_student_label_uses_clean_regeneration_without_candidate(narrative_request, valid_blueprint_payload, fake_llm_cls):
    unsafe = copy.deepcopy(valid_blueprint_payload)
    unsafe["beats"]["opening"] += "这是给基础薄弱学生的惩罚。"
    llm = fake_llm_cls([unsafe, valid_blueprint_payload])
    result = await NarrativeDirector(llm).generate(narrative_request)
    assert result.runtime.metadata.generation_mode == "repair"
    assert len(llm.calls) == 2
    repair_payload = json.loads(llm.calls[1]["messages"][0]["content"])
    assert "CANDIDATE_BLUEPRINT" not in repair_payload
    assert "FAILURE_CATEGORIES" in repair_payload


@pytest.mark.asyncio
async def test_failed_repair_falls_back(narrative_request, fake_llm_cls):
    llm = fake_llm_cls([
        {"content": "not-json", "model": "fake", "tokens_used": 10, "finish_reason": "stop"},
        {"content": "still-not-json", "model": "fake", "tokens_used": 10, "finish_reason": "stop"},
    ])
    result = await NarrativeDirector(llm).generate(narrative_request)
    assert result.runtime.metadata.generation_mode == "fallback"
    assert len(llm.calls) == 2


@pytest.mark.asyncio
async def test_unavailable_provider_uses_deterministic_fallback(narrative_request):
    result = await NarrativeDirector(UnavailableLLM("disabled")).generate(narrative_request)
    assert result.runtime.metadata.generation_mode == "fallback"
    assert result.runtime.metadata.model is None
    assert result.public_view.world.scene_id == narrative_request.frame.primary_scene_id


@pytest.mark.asyncio
async def test_finish_reason_length_is_not_force_parsed(narrative_request, valid_blueprint_payload, fake_llm_cls):
    llm = fake_llm_cls([
        {"content": '{"blueprint_version":"0.2"', "model": "fake", "tokens_used": 10, "finish_reason": "length"},
        valid_blueprint_payload,
    ])
    result = await NarrativeDirector(llm).generate(narrative_request)
    assert result.runtime.metadata.generation_mode == "repair"
    assert len(llm.calls) == 2


@pytest.mark.asyncio
async def test_director_temperature_is_zero(narrative_request, valid_blueprint_payload, fake_llm_cls):
    llm = fake_llm_cls([valid_blueprint_payload])
    await NarrativeDirector(llm).generate(narrative_request)
    assert llm.calls[0]["temperature"] == 0.0


@pytest.mark.asyncio
async def test_director_never_asks_model_to_choose_grammar(narrative_request, valid_blueprint_payload, fake_llm_cls):
    llm = fake_llm_cls([valid_blueprint_payload])
    result = await NarrativeDirector(llm).generate(narrative_request)
    schema_text = llm.calls[0]["system_prompt"]
    assert '"grammar"' not in schema_text
    assert result.runtime.frame.grammar == narrative_request.frame.grammar


@pytest.mark.asyncio
async def test_prompt_contains_exact_deterministic_frame(narrative_request, valid_blueprint_payload, fake_llm_cls):
    llm = fake_llm_cls([valid_blueprint_payload])
    await NarrativeDirector(llm).generate(narrative_request)
    user_payload = json.loads(llm.calls[0]["messages"][0]["content"])
    assert user_payload["frame"]["grammar"] == narrative_request.frame.grammar.value
    assert user_payload["frame"]["primary_scene_name"] == narrative_request.frame.primary_scene_name
    assert user_payload["frame"]["allowed_objects"] == narrative_request.frame.allowed_objects


@pytest.mark.asyncio
async def test_model_cannot_change_companion_policy(narrative_request, valid_blueprint_payload, fake_llm_cls):
    llm = fake_llm_cls([valid_blueprint_payload])
    result = await NarrativeDirector(llm).generate(narrative_request)
    assert result.runtime.bindings.method.companion_policy == narrative_request.frame.companion_policy
