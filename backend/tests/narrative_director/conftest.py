from __future__ import annotations

import copy
import json
from pathlib import Path

import pytest

from agents.narrative_director.adapter import build_narrative_request
from agents.narrative_director.enums import TeachingMode
from agents.narrative_director.fallback import build_fallback_blueprint


@pytest.fixture
def planner_result() -> dict:
    def task(question: str, interaction: str, *, kind: str = "short_answer") -> dict:
        payload = {
            "kind": kind,
            "interaction_kind": interaction,
            "question": question,
            "hint": "回到规则与条件，再检查一次。",
            "academic_rationale": "用于验证当前知识目标。",
            "rubric": {"bands": []},
            "remediation": {"third_attempt_full_solution": "PRIVATE_SOLUTION"},
        }
        if kind == "multiple_choice":
            payload.update({"options": ["A", "B", "C"], "correct_option": 1})
        else:
            payload.update({"accepted_groups": [["PRIVATE_ACCEPTED"]]})
        return payload

    return {
        "schema_version": "1.1",
        "status": "ready",
        "clarification": None,
        "plan": {
            "topic": "为什么学习率过大会导致梯度下降在最优点附近震荡",
            "specific_confusion": "方向正确为什么仍然会震荡",
            "domain": "programming",
            "difficulty": "standard",
            "difficulty_reason": "需要区分方向与更新步幅。",
            "preview": {
                "theme": "学习率、步幅与震荡",
                "goals": [
                    {"kind": "understand", "text": "理解学习率如何控制每次参数更新的步幅"},
                    {"kind": "distinguish", "text": "区分方向错误与步幅过大造成的不同现象"},
                    {"kind": "transfer", "text": "把步幅与稳定性的关系用于新的优化情境"},
                ],
            },
            "source_grounding": [],
            "source_note": "当前题目与对话",
            "confirmed_fact_ids": [],
            "prerequisites": [],
            "core_concepts": [
                {
                    "name": "学习率与更新步幅",
                    "explanation": "学习率决定每次沿梯度方向更新参数的幅度；学习率过大时，即使方向总体正确，也可能反复跨过最优点而产生震荡。",
                    "applicability": "适用于梯度下降及相关迭代优化方法的稳定性分析",
                }
            ],
            "relationships": [],
            "misconceptions": [
                {
                    "mistaken_claim": "只要梯度方向正确，学习率大小就不会影响是否收敛",
                    "correction": "方向正确不代表更新稳定；学习率过大仍可能反复跨过最优点",
                    "diagnostic_cue": "能否区分方向错误与更新步幅过大的轨迹表现",
                }
            ],
            "teaching_strategy": ["比较", "操作"],
            "worked_example": {"scenario": "轨迹比较", "steps": ["观察", "比较"], "conclusion": "步幅会影响稳定性"},
            "challenges": {
                "understanding_trial": task("比较两条轨迹，说明它们为什么不同", "compare"),
                "practice_trial": task("选择更合适的更新步幅并说明理由", "application", kind="multiple_choice"),
                "remedy": task("补全方向、步幅和越过目标之间的关系", "step_completion"),
                "understanding_interleave": task("在新的轨迹中找出导致震荡的关键错误", "find_error"),
                "practice_interleave": task("把步幅控制原则用于新的优化曲面", "application"),
                "boss": [
                    {"kind": "understand", "label": "解释", "task": task("解释学习率为什么影响震荡", "explain")},
                    {"kind": "distinguish", "label": "辨析", "task": task("区分方向错误与学习率过大", "compare")},
                    {"kind": "transfer", "label": "迁移", "task": task("将规律用于新的参数更新情境", "application")},
                ],
            },
            "completion_summary": None,
            "completion_criteria": ["解释", "辨析", "迁移"],
            "next_step": "完成新的应用任务",
        },
        "metadata": {
            "generation_mode": "model",
            "request_fingerprint": "request-fingerprint-001",
            "content_fingerprint": "content-fingerprint-001",
            "model": "deepseek-v4-flash",
            "tokens_used": 1200,
            "warnings": [],
            "diagnostics": [],
            "difficulty_trace": [],
            "raw_attempts": 1,
            "draft_revision": 1,
            "adjustment_count": 0,
            "plan_state": "draft",
        },
    }


@pytest.fixture
def narrative_request(planner_result):
    return build_narrative_request(
        copy.deepcopy(planner_result),
        teaching_mode=TeachingMode.MISCONCEPTION_DISTINCTION,
        plan_id="advplan_test_001",
        plan_revision=1,
    )


@pytest.fixture
def fallback_blueprint(narrative_request):
    return build_fallback_blueprint(narrative_request)


@pytest.fixture
def valid_blueprint_payload(fallback_blueprint):
    return fallback_blueprint.model_dump(mode="json")


class FakeLLM:
    def __init__(self, responses):
        self.responses = list(responses)
        self.calls = []

    async def chat(self, messages, system_prompt=None, temperature=None, max_tokens=None, **kwargs):
        self.calls.append({
            "messages": messages,
            "system_prompt": system_prompt,
            "temperature": temperature,
            "max_tokens": max_tokens,
            "kwargs": kwargs,
        })
        if not self.responses:
            raise RuntimeError("no fake response left")
        value = self.responses.pop(0)
        if isinstance(value, Exception):
            raise value
        if isinstance(value, dict) and "content" in value:
            return value
        return {
            "content": json.dumps(value, ensure_ascii=False),
            "model": "fake-model",
            "tokens_used": 100,
            "finish_reason": "stop",
        }


@pytest.fixture
def fake_llm_cls():
    return FakeLLM
