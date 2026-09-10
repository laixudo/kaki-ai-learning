from __future__ import annotations

import asyncio
import sys
import types
from pathlib import Path

from agents.adventure_planner import AdventureKnowledgePlanner, PlannerRequest
from services.llm_base import DeepSeekLLMService, LLMConfig, _make_cache_payload


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


def test_generation_requests_json_object_mode():
    llm = RecordingLLM([FIXTURE])
    result = run(AdventureKnowledgePlanner(llm).generate(request()))

    assert result.metadata.generation_mode == "model"
    assert llm.calls[0]["kwargs"]["response_format"] == {"type": "json_object"}


def test_repair_requests_json_object_mode_too():
    llm = RecordingLLM(["not json", FIXTURE])
    result = run(AdventureKnowledgePlanner(llm).generate(request()))

    assert result.metadata.generation_mode == "repair"
    assert len(llm.calls) == 2
    assert all(
        call["kwargs"]["response_format"] == {"type": "json_object"}
        for call in llm.calls
    )


def test_finish_reason_stop_is_preserved_as_safe_diagnostic():
    llm = RecordingLLM(
        [
            {
                "content": FIXTURE,
                "model": "deepseek-chat",
                "tokens_used": 4256,
                "finish_reason": "stop",
            }
        ]
    )
    result = run(AdventureKnowledgePlanner(llm).generate(request()))

    assert result.metadata.generation_mode == "model"
    assert "model_finish_reason:stop" in result.metadata.diagnostics


def test_truncated_generation_is_repaired_once():
    llm = RecordingLLM(
        [
            {
                "content": FIXTURE,
                "model": "deepseek-chat",
                "tokens_used": 5200,
                "finish_reason": "length",
            },
            {
                "content": FIXTURE,
                "model": "deepseek-chat",
                "tokens_used": 4200,
                "finish_reason": "stop",
            },
        ]
    )
    result = run(AdventureKnowledgePlanner(llm).generate(request()))

    assert result.metadata.generation_mode == "repair"
    assert result.metadata.raw_attempts == 2
    assert "planner_output_truncated" in result.metadata.warnings
    assert "model_finish_reason:length" in result.metadata.diagnostics
    assert "repair_finish_reason:stop" in result.metadata.diagnostics


def test_truncated_repair_falls_back_with_specific_warning():
    llm = RecordingLLM(
        [
            {
                "content": FIXTURE,
                "model": "deepseek-chat",
                "tokens_used": 5200,
                "finish_reason": "length",
            },
            {
                "content": FIXTURE,
                "model": "deepseek-chat",
                "tokens_used": 5200,
                "finish_reason": "length",
            },
        ]
    )
    result = run(AdventureKnowledgePlanner(llm).generate(request()))

    assert result.metadata.generation_mode == "fallback"
    assert "planner_output_truncated" in result.metadata.warnings
    assert "planner_repair_failed" in result.metadata.warnings
    assert result.metadata.raw_attempts == 2


def test_empty_output_has_specific_warning_and_skips_repair():
    llm = RecordingLLM(
        [
            {
                "content": "   ",
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


def test_deepseek_client_forwards_json_mode_and_finish_reason():
    class FakeCacheService:
        @staticmethod
        async def get_llm_cache(*_args, **_kwargs):
            return None

        @staticmethod
        async def set_llm_cache(*_args, **_kwargs):
            return None

    cache_module = types.ModuleType("services.cache_service")
    cache_module.CacheService = FakeCacheService
    previous_cache_module = sys.modules.get("services.cache_service")
    sys.modules["services.cache_service"] = cache_module

    class FakeResponse:
        def raise_for_status(self):
            return None

        def json(self):
            return {
                "choices": [
                    {
                        "finish_reason": "stop",
                        "message": {"content": '{"status":"ready"}'},
                    }
                ],
                "usage": {"total_tokens": 321},
            }

    class FakeHTTPClient:
        def __init__(self):
            self.payload = None

        async def post(self, _url, *, headers, json):
            assert headers["Authorization"] == "Bearer test-key"
            self.payload = json
            return FakeResponse()

        async def aclose(self):
            return None

    async def scenario():
        client = DeepSeekLLMService(
            LLMConfig(
                api_key="test-key",
                model="deepseek-chat",
                base_url="https://example.invalid/v1/chat/completions",
            )
        )
        await client.client.aclose()
        fake_http = FakeHTTPClient()
        client.client = fake_http
        try:
            result = await client.chat(
                [{"role": "user", "content": "return json"}],
                use_cache=False,
                write_cache=False,
                response_format={"type": "json_object"},
            )
        finally:
            await client.close()
        return result, fake_http.payload

    try:
        result, payload = run(scenario())
    finally:
        if previous_cache_module is None:
            sys.modules.pop("services.cache_service", None)
        else:
            sys.modules["services.cache_service"] = previous_cache_module

    assert payload["response_format"] == {"type": "json_object"}
    assert result["finish_reason"] == "stop"
    assert result["tokens_used"] == 321
    assert _make_cache_payload([], None, 0.2, 5200) != _make_cache_payload(
        [],
        None,
        0.2,
        5200,
        {"type": "json_object"},
    )
