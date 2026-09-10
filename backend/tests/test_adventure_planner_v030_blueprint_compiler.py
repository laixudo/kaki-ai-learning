from __future__ import annotations

import asyncio
import copy
import json
from pathlib import Path

from agents.adventure_planner import AdventureKnowledgePlanner, PlannerRequest, plan_to_existing_content
from agents.adventure_planner.blueprint_compiler import compile_blueprint
from agents.adventure_planner.blueprint_validators import validate_blueprint
from agents.adventure_planner.context_builder import build_model_context
from agents.adventure_planner.models import (
    BlueprintEnvelope,
    DifficultyLevel,
    LLMPlanEnvelope,
)


FIXTURE_PATH = Path(__file__).parent / "fixtures" / "v030-compact-blueprint-gradient.json"
BLUEPRINT_RAW = FIXTURE_PATH.read_text(encoding="utf-8")


class RecordingLLM:
    def __init__(self, outputs):
        self.outputs = list(outputs)
        self.calls: list[dict] = []

    async def chat(self, messages, system_prompt=None, **kwargs):
        self.calls.append({"messages": messages, "system_prompt": system_prompt, "kwargs": kwargs})
        output = self.outputs.pop(0)
        return {
            "content": output,
            "model": "deepseek-v4-flash",
            "tokens_used": 1800,
            "finish_reason": "stop",
        }


def request(**updates) -> PlannerRequest:
    payload = {
        "topic_hint": "梯度下降方向",
        "explicit_confusion": "梯度不是增长最快方向吗？为什么下降要取负号？",
        "learning_evidence": [
            {
                "kind": "self_explanation",
                "summary": "能说明梯度与局部增长有关",
                "confidence": 0.8,
                "difficulty_signal": 0.4,
            }
        ],
    }
    payload.update(updates)
    return PlannerRequest.model_validate(payload)


def run(coro):
    return asyncio.run(coro)


def all_questions(plan):
    challenges = plan.challenges
    return [
        challenges.understanding_trial,
        challenges.practice_trial,
        challenges.remedy,
        challenges.understanding_interleave,
        challenges.practice_interleave,
        *(stage.task for stage in challenges.boss),
    ]


def test_compact_blueprint_compiles_to_existing_full_plan():
    llm = RecordingLLM([BLUEPRINT_RAW])
    result = run(AdventureKnowledgePlanner(llm).generate(request()))

    assert result.metadata.generation_mode == "model"
    assert result.schema_version == "1.1"
    assert result.plan is not None
    assert result.plan.difficulty == DifficultyLevel.STANDARD_PLUS
    assert "compiled_from_blueprint" in result.metadata.diagnostics
    assert "blueprint_schema_version:0.3" in result.metadata.diagnostics

    questions = all_questions(result.plan)
    assert len(questions) == 8
    assert all(question.rubric is not None for question in questions)
    assert all(question.remediation is not None for question in questions)
    assert all(question.verification_method for question in questions)
    assert all(question.answer_boundary for question in questions)

    content = plan_to_existing_content(result)
    assert content["plan_preview"]["theme"] == "负梯度为何让目标函数下降"
    assert len(content["boss"]) == 3
    assert content["boss"][0]["label"] == "解释"
    assert "correct_option" in content["practice"]["trial"]


def test_compiler_is_deterministic_for_same_blueprint_and_request():
    envelope = BlueprintEnvelope.model_validate_json(BLUEPRINT_RAW)
    assert envelope.blueprint is not None
    first = compile_blueprint(envelope.blueprint, request(), DifficultyLevel.STANDARD_PLUS)
    second = compile_blueprint(envelope.blueprint, request(), DifficultyLevel.STANDARD_PLUS)
    assert first.model_dump(mode="json") == second.model_dump(mode="json")


def test_blueprint_schema_is_materially_smaller_than_legacy_plan_schema():
    blueprint_schema = json.dumps(BlueprintEnvelope.model_json_schema(), ensure_ascii=False, separators=(",", ":"))
    legacy_schema = json.dumps(LLMPlanEnvelope.model_json_schema(), ensure_ascii=False, separators=(",", ":"))
    assert len(blueprint_schema) < len(legacy_schema) * 0.62
    assert '"remediation"' not in blueprint_schema
    assert '"rubric"' not in blueprint_schema
    assert '"PlannerMetadata"' not in blueprint_schema


def test_model_call_requests_blueprint_schema_not_full_plan_schema():
    llm = RecordingLLM([BLUEPRINT_RAW])
    result = run(AdventureKnowledgePlanner(llm).generate(request()))
    assert result.metadata.generation_mode == "model"
    prompt = llm.calls[0]["system_prompt"]
    assert '"blueprint"' in prompt
    assert '"blueprint_version"' in prompt
    assert '"remediation":' not in prompt
    assert '"rubric":' not in prompt
    assert "紧凑输出预算" in prompt


def test_learner_state_is_internal_and_not_exposed_by_adapter():
    req = request(
        learner_state={
            "topic_mastery": 0.72,
            "misconception": "把增长方向和下降方向混淆",
            "reasoning_state": "refining",
            "support_level": "independent",
            "transfer_readiness": 0.65,
            "confidence": 0.84,
            "evidence_refs": ["answer:1"],
        }
    )
    context = build_model_context(req)
    assert context["learner_state"]["topic_mastery"] == 0.72
    assert context["learner_state"]["support_level"] == "independent"

    result = run(AdventureKnowledgePlanner(RecordingLLM([BLUEPRINT_RAW])).generate(req))
    public = json.dumps(plan_to_existing_content(result), ensure_ascii=False)
    assert "topic_mastery" not in public
    assert "support_level" not in public
    assert "reasoning_state" not in public


def test_temporary_learner_state_is_conservative_when_missing():
    context = build_model_context(request(learning_evidence=[]))
    state = context["learner_state"]
    assert 0.1 <= state["topic_mastery"] <= 0.9
    assert state["support_level"] in {"hint", "scaffold", "full", "independent"}
    assert state["confidence"] <= 0.5


def test_blueprint_with_unknown_source_id_is_repaired_once():
    bad = json.loads(BLUEPRINT_RAW)
    bad["blueprint"]["source_grounding"] = ["invented-source"]
    llm = RecordingLLM([json.dumps(bad, ensure_ascii=False), BLUEPRINT_RAW])
    result = run(AdventureKnowledgePlanner(llm).generate(request()))
    assert result.metadata.generation_mode == "repair"
    assert result.metadata.raw_attempts == 2
    assert "planner_semantic_validation_failed" in result.metadata.warnings


def test_duplicate_blueprint_questions_are_rejected_before_compilation():
    payload = json.loads(BLUEPRINT_RAW)
    payload["blueprint"]["tasks"]["boss_understand"]["question"] = payload["blueprint"]["tasks"][
        "understanding_trial"
    ]["question"]
    envelope = BlueprintEnvelope.model_validate(payload)
    errors = validate_blueprint(envelope, request())
    assert any("must not be exact duplicates" in item for item in errors)


def test_blueprint_clarification_is_mapped_to_existing_result_shape():
    raw = json.dumps(
        {
            "status": "needs_clarification",
            "clarification": {
                "reason": "ambiguous_term",
                "question": "这里的方向指函数增长方向还是参数更新方向？",
                "options": ["函数增长方向", "参数更新方向"],
            },
            "blueprint": None,
        },
        ensure_ascii=False,
    )
    result = run(AdventureKnowledgePlanner(RecordingLLM([raw])).generate(request(explicit_confusion=None)))
    assert result.status == "needs_clarification"
    assert result.plan is None
    assert result.clarification is not None
    assert result.metadata.generation_mode == "model"
    assert "blueprint_path:clarification" in result.metadata.diagnostics


def test_compiler_preserves_locked_fact_ids_without_model_repetition():
    req = request(
        confirmed_facts=[
            {
                "fact_id": "fact-gradient-1",
                "statement": "梯度是各偏导数组成的向量",
                "source_ids": [],
                "confidence": 1.0,
                "locked": True,
            }
        ]
    )
    result = run(AdventureKnowledgePlanner(RecordingLLM([BLUEPRINT_RAW])).generate(req))
    assert result.plan is not None
    assert result.plan.confirmed_fact_ids == ["fact-gradient-1"]


def test_compiled_interleave_is_derived_from_misconception_not_model_template_noise():
    result = run(AdventureKnowledgePlanner(RecordingLLM([BLUEPRINT_RAW])).generate(request()))
    question = result.plan.challenges.understanding_interleave
    assert question.kind.value == "multiple_choice"
    assert result.plan.misconceptions[0].correction in question.options
    assert question.correct_option == 0
    assert question.remediation.first_attempt_hint == question.hint
