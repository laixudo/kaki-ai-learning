from __future__ import annotations

import asyncio
import time
from types import SimpleNamespace

from agents.adventure_planner import PlannerRequest
from agents.adventure_planner.llm_protocol import UnavailableLLM
from integrations.adventure_planner_adapter import (
    build_adventure_planner,
    inspect_planner_provider,
)
from integrations.adventure_planner_context import (
    load_planner_recent_turns,
    resolve_context_mode,
    select_relevant_chat_turns,
)


def run(coro):
    return asyncio.run(coro)


def request() -> PlannerRequest:
    return PlannerRequest(
        topic_hint="梯度下降",
        explicit_confusion="为什么参数更新要沿负梯度方向？",
        learning_evidence=[
            {
                "kind": "explicit_confusion",
                "summary": "不理解负号的几何意义",
                "confidence": 0.95,
                "difficulty_signal": -0.3,
                "recency_rank": 1,
            }
        ],
    )


def settings(**overrides):
    base = {
        "MODE": "mock",
        "LLM_PROVIDER": "mock",
        "DEEPSEEK_API_KEY": "",
        "XUNFEI_API_PASSWORD": "",
    }
    base.update(overrides)
    return SimpleNamespace(**base)


def test_non_production_mode_short_circuits_without_factory_call():
    called = False

    async def factory():
        nonlocal called
        called = True
        raise AssertionError("factory must not be called")

    start = time.perf_counter()
    planner = run(
        build_adventure_planner(
            settings_obj=settings(MODE="mock", LLM_PROVIDER="deepseek", DEEPSEEK_API_KEY="sk-present"),
            llm_factory=factory,
        )
    )
    result = run(planner.generate(request()))
    elapsed = time.perf_counter() - start

    assert called is False
    assert isinstance(planner.llm, UnavailableLLM)
    assert result.metadata.generation_mode == "fallback"
    assert result.metadata.warnings == ["planner_provider_unconfigured"]
    assert elapsed < 1.0


def test_missing_production_credential_short_circuits():
    status = inspect_planner_provider(
        settings(MODE="production", LLM_PROVIDER="deepseek", DEEPSEEK_API_KEY="")
    )
    assert status.ready is False
    assert status.reason_code == "credential_missing"


def test_supported_production_provider_uses_factory_once():
    class FakeLLM:
        async def chat(self, *_args, **_kwargs):
            return "{}"

    fake = FakeLLM()
    calls = 0

    async def factory():
        nonlocal calls
        calls += 1
        return fake

    planner = run(
        build_adventure_planner(
            settings_obj=settings(MODE="production", LLM_PROVIDER="deepseek", DEEPSEEK_API_KEY="sk-present"),
            llm_factory=factory,
        )
    )
    assert calls == 1
    assert planner.llm is fake


def test_context_mode_honours_current_item_only_language():
    assert resolve_context_mode("relevant_recent", "梯度", "只根据这道题来设计") == "current_item_only"
    assert resolve_context_mode("relevant_recent", "梯度", "我想多看几何解释") == "relevant_recent"


def test_relevant_turn_selection_filters_internal_and_unrelated_messages():
    messages = [
        {"role": "system", "content": "隐藏系统提示"},
        {"role": "user", "content": "今天天气怎么样？"},
        {"role": "assistant", "content": "今天多云。"},
        {"role": "user", "content": "梯度为什么表示增长最快方向？", "id": "u1"},
        {"role": "assistant", "content": "可以从方向导数与点积的最大值理解。", "id": "a1"},
        {"role": "assistant", "content": '{"type":"agent_start","agent":"planner"}'},
        {"role": "assistant", "content": "内部工具结果", "tool_calls": [{"name": "x"}]},
        {"role": "user", "content": "那为什么更新时要取负号？", "id": "u2"},
    ]
    turns = select_relevant_chat_turns(
        messages,
        topic_hint="梯度下降",
        explicit_confusion="为什么更新时要取负号？",
    )
    contents = [item["content"] for item in turns]

    assert not any("天气" in content for content in contents)
    assert not any("agent_start" in content for content in contents)
    assert not any("内部工具" in content for content in contents)
    assert any("增长最快" in content for content in contents)
    assert contents[-1] == "为什么更新时要取负号？"
    assert turns[-1]["relevance_score"] == 1.0


def test_context_selection_is_bounded_to_six_turns_and_four_thousand_chars():
    messages = [
        {
            "role": "user" if index % 2 == 0 else "assistant",
            "content": f"梯度下降相关内容[{index}]" + (chr(65 + index) * 1000),
        }
        for index in range(12)
    ]
    turns = select_relevant_chat_turns(messages, topic_hint="梯度下降")
    assert len(turns) <= 6
    assert sum(len(item["content"]) for item in turns) <= 4000
    assert turns[-1]["content"].startswith("梯度下降相关内容[11]")


def test_current_item_only_excludes_all_history_even_with_explicit_confusion():
    turns = select_relevant_chat_turns(
        [{"role": "user", "content": "梯度下降是什么？"}],
        topic_hint="当前题目",
        explicit_confusion="只看这道题，不要参考之前",
        context_mode="relevant_recent",
    )
    assert turns == []


def test_history_loader_receives_authenticated_user_and_thread_only():
    calls = []

    async def loader(_db, user_id, thread_id):
        calls.append((user_id, thread_id))
        return [
            {"role": "user", "content": "梯度方向是什么？"},
            {"role": "assistant", "content": "梯度给出局部增长最快方向。"},
        ]

    result = run(
        load_planner_recent_turns(
            object(),
            42,
            "workspace-safe-thread",
            topic_hint="梯度下降",
            explicit_confusion="为什么要沿负梯度？",
            history_loader=loader,
        )
    )
    assert calls == [(42, "workspace-safe-thread")]
    assert result.history_loaded is True
    assert result.history_message_count == 2
    assert result.turns


def test_legacy_or_missing_thread_never_queries_history():
    async def loader(*_args):
        raise AssertionError("legacy thread must not query chat history")

    for thread_id in (None, "", "default", "qa-legacy"):
        result = run(
            load_planner_recent_turns(
                object(),
                7,
                thread_id,
                topic_hint="梯度下降",
                history_loader=loader,
            )
        )
        assert result.history_loaded is False
        assert result.turns == []
