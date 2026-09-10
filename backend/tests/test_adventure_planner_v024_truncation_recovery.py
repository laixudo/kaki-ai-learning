from __future__ import annotations

import asyncio
from pathlib import Path

from agents.adventure_planner import AdventureKnowledgePlanner, PlannerRequest
from agents.adventure_planner.planner import PlannerConfig


FIXTURE = (
    Path(__file__).parent
    / "fixtures"
    / "v022-deepseek-valid-json-hint-mismatch.json"
).read_text(encoding="utf-8")


class RecordingLLM:
    def __init__(self, outputs):
        self.outputs = list(outputs)
        self.calls: list[dict] = []

    async def chat(self, messages, system_prompt=None, **kwargs):
        self.calls.append(
            {
                "messages": messages,
                "system_prompt": system_prompt,
                "kwargs": kwargs,
            }
        )
        output = self.outputs.pop(0)
        if isinstance(output, Exception):
            raise output
        if isinstance(output, dict):
            return output
        return {
            "content": output,
            "model": "deepseek-chat",
            "tokens_used": 100,
            "finish_reason": "stop",
        }


def request() -> PlannerRequest:
    return PlannerRequest(
        topic_hint="梯度下降方向",
        explicit_confusion="梯度不是函数增长最快的方向吗？我主要不懂为什么梯度下降要取负号。",
    )


def run(coro):
    return asyncio.run(coro)


def truncated(content: str = '{"status":"ready"') -> dict:
    return {
        "content": content,
        "model": "deepseek-chat",
        "tokens_used": 6400,
        "finish_reason": "length",
    }


def completed(content: str = FIXTURE) -> dict:
    return {
        "content": content,
        "model": "deepseek-chat",
        "tokens_used": 4200,
        "finish_reason": "stop",
    }


def test_default_budget_has_headroom_and_bounded_retry():
    config = PlannerConfig()
    assert config.max_tokens == 6400
    assert config.timeout_seconds == 60.0
    assert config.truncation_retry_max_tokens == 8000
    assert config.truncation_retry_timeout_seconds == 80.0


def test_initial_generation_uses_compact_schema_and_budget():
    llm = RecordingLLM([completed()])
    result = run(AdventureKnowledgePlanner(llm).generate(request()))

    assert result.metadata.generation_mode == "model"
    call = llm.calls[0]
    assert call["kwargs"]["max_tokens"] == 6400
    assert call["kwargs"]["response_format"] == {"type": "json_object"}
    assert '"$defs":' in call["system_prompt"]
    assert '"$defs": {' not in call["system_prompt"]
    assert "紧凑输出预算" in call["system_prompt"]


def test_truncation_regenerates_from_context_with_larger_budget():
    llm = RecordingLLM([truncated(), completed()])
    result = run(AdventureKnowledgePlanner(llm).generate(request()))

    assert result.metadata.generation_mode == "repair"
    assert result.metadata.raw_attempts == 2
    assert "planner_output_truncated" in result.metadata.warnings
    assert "repair_strategy:regenerate_after_truncation" in result.metadata.diagnostics
    assert len(llm.calls) == 2
    retry = llm.calls[1]
    assert retry["kwargs"]["max_tokens"] == 8000
    assert retry["kwargs"]["temperature"] == 0.0
    assert retry["kwargs"]["response_format"] == {"type": "json_object"}
    assert "TRUNCATION RETRY REQUIREMENTS" in retry["system_prompt"]
    assert "invalid_output" not in retry["messages"][0]["content"]
    assert "explicit_confusion" in retry["messages"][0]["content"]


def test_truncation_retry_does_not_feed_partial_json_back_to_model():
    partial = '{"status":"ready","plan":{"topic":"PARTIAL_SENTINEL"'
    llm = RecordingLLM([truncated(partial), completed()])
    result = run(AdventureKnowledgePlanner(llm).generate(request()))

    assert result.metadata.generation_mode == "repair"
    retry_payload = llm.calls[1]["messages"][0]["content"]
    assert "PARTIAL_SENTINEL" not in retry_payload


def test_second_length_stop_falls_back_with_specific_diagnostics():
    llm = RecordingLLM([truncated(), truncated()])
    result = run(AdventureKnowledgePlanner(llm).generate(request()))

    assert result.metadata.generation_mode == "fallback"
    assert result.metadata.raw_attempts == 2
    assert "planner_output_truncated" in result.metadata.warnings
    assert "planner_repair_failed" in result.metadata.warnings
    assert "model_finish_reason:length" in result.metadata.diagnostics
    assert "repair_finish_reason:length" in result.metadata.diagnostics


def test_normal_invalid_json_still_uses_targeted_repair_payload():
    llm = RecordingLLM(["not-json", completed()])
    result = run(AdventureKnowledgePlanner(llm).generate(request()))

    assert result.metadata.generation_mode == "repair"
    assert "planner_invalid_json" in result.metadata.warnings
    assert "repair_strategy:repair_invalid_output" in result.metadata.diagnostics
    repair_payload = llm.calls[1]["messages"][0]["content"]
    assert "invalid_output" in repair_payload
    assert "not-json" in repair_payload
    assert llm.calls[1]["kwargs"]["max_tokens"] == 6400


def test_empty_output_still_skips_retry():
    llm = RecordingLLM(
        [
            {
                "content": "",
                "model": "deepseek-chat",
                "tokens_used": 0,
                "finish_reason": "stop",
            }
        ]
    )
    result = run(AdventureKnowledgePlanner(llm).generate(request()))

    assert result.metadata.generation_mode == "fallback"
    assert result.metadata.raw_attempts == 1
    assert len(llm.calls) == 1
    assert result.metadata.warnings == ["planner_empty_output"]
