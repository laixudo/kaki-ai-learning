from __future__ import annotations

import asyncio
import copy
import json
from pathlib import Path

from agents.adventure_planner import AdventureKnowledgePlanner, PlannerRequest
from agents.adventure_planner.models import LLMPlanEnvelope
from agents.adventure_planner.normalizers import normalize_raw_plan_payload


FIXTURES = Path(__file__).parent / "fixtures"
SHORT_MICROCOPY = (FIXTURES / "v025-deepseek-short-microcopy.json").read_text(encoding="utf-8")
EXTRA_BRACE = (FIXTURES / "v025-deepseek-short-microcopy-extra-brace.txt").read_text(
    encoding="utf-8"
)


class RecordingLLM:
    def __init__(self, outputs):
        self.outputs = list(outputs)
        self.calls: list[dict] = []

    async def chat(self, messages, system_prompt=None, **kwargs):
        self.calls.append({"messages": messages, "system_prompt": system_prompt, "kwargs": kwargs})
        output = self.outputs.pop(0)
        return {
            "content": output,
            "model": "deepseek-chat",
            "tokens_used": 2773,
            "finish_reason": "stop",
        }


def request() -> PlannerRequest:
    return PlannerRequest(
        topic_hint="梯度下降方向",
        explicit_confusion="梯度不是函数增长最快的方向吗？我主要不懂为什么梯度下降要取负号。",
    )


def run(coro):
    return asyncio.run(coro)


def _all_questions(payload):
    challenges = payload["plan"]["challenges"]
    questions = [
        challenges["understanding_trial"],
        challenges["practice_trial"],
        challenges["remedy"],
        challenges["understanding_interleave"],
        challenges["practice_interleave"],
    ]
    questions.extend(stage["task"] for stage in challenges["boss"])
    return questions


def test_real_v025_generation_is_accepted_without_model_repair():
    llm = RecordingLLM([SHORT_MICROCOPY])
    result = run(AdventureKnowledgePlanner(llm).generate(request()))

    assert result.metadata.generation_mode == "model"
    assert result.metadata.raw_attempts == 1
    assert len(llm.calls) == 1
    assert "planner_microcopy_normalized" in result.metadata.warnings
    assert "planner_schema_invalid" not in result.metadata.warnings
    assert "planner_repair_failed" not in result.metadata.warnings
    assert any(item.startswith("normalized_microcopy_fields:") for item in result.metadata.diagnostics)


def test_raw_normalization_preserves_academic_and_answer_fields():
    payload = json.loads(SHORT_MICROCOPY)
    before = copy.deepcopy(payload)
    report = normalize_raw_plan_payload(payload)

    assert report.normalized_fields > 0
    assert payload["plan"]["topic"] == before["plan"]["topic"]
    assert payload["plan"]["difficulty"] == before["plan"]["difficulty"]
    assert payload["plan"]["source_grounding"] == before["plan"]["source_grounding"]

    for normalized, original in zip(_all_questions(payload), _all_questions(before)):
        assert normalized["question"] == original["question"]
        assert normalized.get("options") == original.get("options")
        assert normalized.get("correct_option") == original.get("correct_option")
        assert normalized.get("accepted_groups") == original.get("accepted_groups")
        confirmation = normalized["remediation"]["third_attempt_confirmation"]
        original_confirmation = original["remediation"]["third_attempt_confirmation"]
        assert confirmation["question"] == original_confirmation["question"]
        assert confirmation["accepted_groups"] == original_confirmation["accepted_groups"]


def test_normalized_payload_passes_strict_schema_and_keeps_quality_floors():
    payload = json.loads(SHORT_MICROCOPY)
    normalize_raw_plan_payload(payload)
    envelope = LLMPlanEnvelope.model_validate(payload)

    assert envelope.plan is not None
    challenges = envelope.plan.challenges
    questions = [
        challenges.understanding_trial,
        challenges.practice_trial,
        challenges.remedy,
        challenges.understanding_interleave,
        challenges.practice_interleave,
        *(stage.task for stage in challenges.boss),
    ]
    for question in questions:
        assert len(question.hint) >= 4
        assert len(question.academic_rationale) >= 6
        assert question.remediation is not None
        assert len(question.remediation.first_attempt_hint) >= 4
        assert len(question.remediation.third_attempt_confirmation.academic_rationale) >= 6
        assert question.rubric is not None
        assert all(len(band.feedback_focus) >= 4 for band in question.rubric.bands)


def test_extra_trailing_brace_is_extracted_then_normalized():
    llm = RecordingLLM([EXTRA_BRACE])
    result = run(AdventureKnowledgePlanner(llm).generate(request()))

    assert result.metadata.generation_mode == "model"
    assert result.metadata.raw_attempts == 1
    assert "planner_microcopy_normalized" in result.metadata.warnings
    assert "planner_invalid_json" not in result.metadata.warnings


def test_normalization_does_not_hide_missing_core_question():
    payload = json.loads(SHORT_MICROCOPY)
    payload["plan"]["challenges"]["understanding_trial"]["question"] = ""
    llm = RecordingLLM([json.dumps(payload, ensure_ascii=False), "still-not-valid"])
    result = run(AdventureKnowledgePlanner(llm).generate(request()))

    assert result.metadata.generation_mode == "fallback"
    assert "planner_schema_invalid" in result.metadata.warnings
    assert "planner_repair_failed" in result.metadata.warnings
