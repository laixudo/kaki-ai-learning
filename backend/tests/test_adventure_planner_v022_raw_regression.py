from __future__ import annotations

import asyncio
from pathlib import Path

from agents.adventure_planner import AdventureKnowledgePlanner, PlannerRequest


class _RawFixtureLLM:
    def __init__(self, output: str):
        self.output = output
        self.calls = 0

    async def chat(self, *_args, **_kwargs):
        self.calls += 1
        return {
            "content": self.output,
            "model": "deepseek-chat",
            "tokens_used": 4256,
        }


def test_real_deepseek_output_with_hint_mismatches_is_accepted_without_repair():
    raw = (
        Path(__file__).parent
        / "fixtures"
        / "v022-deepseek-valid-json-hint-mismatch.json"
    ).read_text(encoding="utf-8")
    llm = _RawFixtureLLM(raw)
    request = PlannerRequest(
        topic_hint="梯度下降方向",
        explicit_confusion="梯度不是函数增长最快的方向吗？我主要不懂为什么梯度下降要取负号。",
    )

    result = asyncio.run(AdventureKnowledgePlanner(llm).generate(request))

    assert result.status == "ready"
    assert result.metadata.generation_mode == "model"
    assert result.metadata.raw_attempts == 1
    assert llm.calls == 1
    assert "planner_hint_normalized" in result.metadata.warnings
    assert "planner_semantic_validation_failed" not in result.metadata.warnings
    assert "planner_repair_failed" not in result.metadata.warnings
    assert any(item.startswith("normalized_hint_pairs:") for item in result.metadata.diagnostics)
