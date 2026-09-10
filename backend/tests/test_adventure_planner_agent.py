import asyncio
import copy
import json
import sys
from pathlib import Path

import pytest
from pydantic import ValidationError

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from agents.adventure_planner.adapter import plan_to_existing_content
from agents.adventure_planner.context_builder import build_model_context
from agents.adventure_planner.difficulty import decide_difficulty
from agents.adventure_planner.llm_protocol import UnavailableLLM
from agents.adventure_planner.models import DifficultyLevel, LLMPlanEnvelope, PlannerRequest
from agents.adventure_planner.planner import AdventureKnowledgePlanner, PlannerConfig
from agents.adventure_planner.validators import validate_plan


class FakeLLM:
    def __init__(self, outputs):
        self.outputs = list(outputs)
        self.calls = []

    async def chat(self, messages, system_prompt=None, **kwargs):
        self.calls.append({"messages": messages, "system_prompt": system_prompt, "kwargs": kwargs})
        if not self.outputs:
            raise RuntimeError("no fake output")
        output = self.outputs.pop(0)
        if isinstance(output, Exception):
            raise output
        return {"content": output, "tokens_used": 123, "model": "fake-model"}


def request(**updates):
    base = {
        "topic_hint": "梯度下降为什么沿负梯度更新",
        "explicit_confusion": "我理解梯度是增长最快方向，但不懂为什么更新要取负号",
        "recent_turns": [
            {"role": "user", "content": "梯度到底表示什么？", "recency_rank": 2},
            {"role": "assistant", "content": "它描述局部变化率。", "recency_rank": 1},
        ],
        "learning_evidence": [
            {
                "kind": "self_explanation",
                "summary": "用户能说明梯度与局部增长有关",
                "confidence": 0.8,
                "difficulty_signal": 0.4,
            }
        ],
    }
    base.update(updates)
    return PlannerRequest.model_validate(base)


def remediation(hint, solution="完整解释需要同时说明方向导数、增长方向和最小化目标之间的关系。"):
    return {
        "first_attempt_hint": hint,
        "second_attempt_explanation": "把‘函数沿哪个方向增长’和‘参数要往哪里更新’分成两个问题。",
        "second_attempt_scaffold": ["先判断梯度指向", "再判断优化目标", "最后比较正负方向"],
        "third_attempt_full_solution": solution,
        "third_attempt_confirmation": {
            "question": "最小化时为什么不沿正梯度更新？",
            "accepted_groups": [["增长", "增大"], ["负梯度", "反方向"]],
            "academic_rationale": "完整讲解后检查用户是否理解增长方向与下降方向的区别。",
        },
    }


def rubric():
    return {
        "bands": [
            {
                "band": "correct",
                "criteria": ["说明梯度方向", "说明最小化目标"],
                "feedback_focus": "指出完整关系并进入下一步。",
            },
            {
                "band": "partial",
                "criteria": ["方向正确但缺少理由"],
                "feedback_focus": "先认可方向，再补关键理由。",
            },
            {
                "band": "remediation",
                "criteria": ["把增长方向当成下降方向"],
                "feedback_focus": "定位混淆并给最小提示。",
            },
        ]
    }


def short_question(text, interaction="explain", hint="比较单位方向上的方向导数。"):
    return {
        "kind": "short_answer",
        "interaction_kind": interaction,
        "question": text,
        "hint": hint,
        "accepted_groups": [["方向导数", "点积"], ["最大", "增长最快"]],
        "academic_rationale": "检验梯度几何意义。",
        "verification_method": "用方向导数公式和单位向量点积关系检查推理。",
        "answer_boundary": "允许不同措辞，但必须说明梯度方向和局部最大增长率。",
        "rubric": rubric(),
        "remediation": remediation(hint),
    }


def choice_question(text, interaction="compare", hint="梯度指向增长方向。"):
    return {
        "kind": "multiple_choice",
        "interaction_kind": interaction,
        "question": text,
        "hint": hint,
        "options": ["负梯度方向", "正梯度方向", "任意垂直方向"],
        "correct_option": 0,
        "academic_rationale": "辨析增长方向与最小化更新方向。",
        "verification_method": "用一阶近似比较正负梯度方向的函数值变化。",
        "answer_boundary": "只有负梯度方向在局部一阶近似下使目标函数下降。",
        "rubric": rubric(),
        "remediation": remediation(hint),
    }


def valid_envelope(difficulty="standard_plus"):
    def unique(payload, suffix):
        item = copy.deepcopy(payload)
        item["question"] += suffix
        item["remediation"]["third_attempt_confirmation"]["question"] += suffix
        return item

    q_short = short_question("用方向导数解释梯度为什么对应局部增长最快方向。")
    q_choice = choice_question("最小化目标函数时，哪一个更新方向能在局部使函数值下降？")
    return {
        "status": "ready",
        "clarification": None,
        "plan": {
            "topic": "梯度下降为什么沿负梯度更新",
            "specific_confusion": "用户混淆梯度增长方向与参数最小化更新方向",
            "domain": "math",
            "difficulty": difficulty,
            "difficulty_reason": "用户已有梯度方向基础，因此采用标准偏进取难度。",
            "preview": {
                "theme": "负梯度为何让目标函数下降",
                "goals": [
                    {"kind": "understand", "text": "理解梯度与局部增长最快方向的关系"},
                    {"kind": "distinguish", "text": "辨析增长方向和最小化更新方向"},
                    {"kind": "transfer", "text": "把负梯度原则用于新的优化情境"},
                ],
            },
            "source_grounding": [],
            "source_note": "基于当前对话中的梯度困惑",
            "source_conflict_note": None,
            "confirmed_fact_ids": [],
            "prerequisites": [
                {"name": "方向导数", "why_needed": "用于比较不同方向的局部变化率", "required": True}
            ],
            "core_concepts": [
                {
                    "name": "梯度",
                    "explanation": "梯度与单位方向的点积给出方向导数，点积在同向时最大。",
                    "applicability": "用于可微函数局部的一阶变化分析。",
                }
            ],
            "relationships": [
                {"from_concept": "梯度", "relation": "决定", "to_concept": "局部最大方向导数"}
            ],
            "misconceptions": [
                {
                    "mistaken_claim": "梯度下降应该沿梯度方向更新。",
                    "correction": "梯度是增长最快方向，最小化要沿其反方向。",
                    "diagnostic_cue": "把函数增长方向和参数更新目标混为一谈。",
                }
            ],
            "teaching_strategy": ["先比较方向导数", "再区分增长与最小化", "最后迁移到新函数"],
            "worked_example": {
                "scenario": "在二维碗形函数的一点比较正梯度与负梯度的一阶变化。",
                "steps": ["写出局部一阶近似", "比较两个相反方向的符号"],
                "conclusion": "负梯度方向使一阶变化最负，因此局部下降最快。",
            },
            "challenges": {
                "understanding_trial": unique(q_short, "（初试）"),
                "practice_trial": unique(q_choice, "（实战）"),
                "remedy": unique(q_choice, "（补救）"),
                "understanding_interleave": unique(q_choice, "（理解交错）"),
                "practice_interleave": unique(short_question("把负梯度原则用于另一个函数。", "application"), "（实战交错）"),
                "boss": [
                    {"kind": "understand", "label": "解释", "task": unique(q_short, "（守关解释）")},
                    {"kind": "distinguish", "label": "辨析", "task": unique(q_choice, "（守关辨析）")},
                    {
                        "kind": "transfer",
                        "label": "迁移",
                        "task": unique(short_question("在新的优化情境中说明更新方向。", "application"), "（守关迁移）"),
                    },
                ],
            },
            "completion_summary": "能解释梯度方向、辨认关键误区，并迁移到新优化情境。",
            "completion_criteria": [
                "能解释梯度的方向意义",
                "能区分增长方向和下降更新方向",
                "能把负梯度原则迁移到新情境",
            ],
            "next_step": "用另一个二维函数画出梯度和负梯度方向。",
        },
    }


def run(coro):
    return asyncio.run(coro)


def test_valid_model_output_and_legacy_adapter():
    result = run(AdventureKnowledgePlanner(FakeLLM([json.dumps(valid_envelope(), ensure_ascii=False)])).generate(request()))
    assert result.status == "ready"
    assert result.schema_version == "1.1"
    assert result.metadata.generation_mode == "model"
    assert result.plan.difficulty == DifficultyLevel.STANDARD_PLUS
    assert result.metadata.content_fingerprint
    content = plan_to_existing_content(result)
    assert content["boss"][0]["label"] == "解释"
    assert content["boss"][2]["interaction_kind"] == "application"
    assert content["planner_meta"]["draft_revision"] == 1


def test_fenced_json_is_accepted():
    raw = "```json\n" + json.dumps(valid_envelope(), ensure_ascii=False) + "\n```"
    result = run(AdventureKnowledgePlanner(FakeLLM([raw])).generate(request()))
    assert result.metadata.generation_mode == "model"


def test_invalid_first_output_is_repaired_once():
    invalid = valid_envelope(difficulty="standard")
    valid = valid_envelope()
    llm = FakeLLM([json.dumps(invalid, ensure_ascii=False), json.dumps(valid, ensure_ascii=False)])
    result = run(AdventureKnowledgePlanner(llm).generate(request()))
    assert result.metadata.generation_mode == "repair"
    assert result.metadata.raw_attempts == 2
    assert "planner_semantic_validation_failed" in result.metadata.warnings


def test_two_invalid_outputs_fall_back_with_specific_codes():
    result = run(AdventureKnowledgePlanner(FakeLLM(["not json", "still not json"])).generate(request()))
    assert result.metadata.generation_mode == "fallback"
    assert "planner_invalid_json" in result.metadata.warnings
    assert "planner_repair_failed" in result.metadata.warnings
    assert len(result.plan.challenges.boss) == 3


def test_timeout_falls_back_with_timeout_code():
    planner = AdventureKnowledgePlanner(FakeLLM([asyncio.TimeoutError()]), PlannerConfig(timeout_seconds=0.1))
    result = run(planner.generate(request()))
    assert result.metadata.generation_mode == "fallback"
    assert result.metadata.warnings == ["planner_timeout"]


def test_unconfigured_provider_has_distinct_warning():
    result = run(AdventureKnowledgePlanner(UnavailableLLM()).generate(request()))
    assert result.metadata.generation_mode == "fallback"
    assert result.metadata.warnings == ["planner_provider_unconfigured"]
    assert result.metadata.diagnostics == ["provider_unconfigured"]


def test_context_uses_max_six_relevant_turns_and_four_thousand_chars():
    turns = [
        {"role": "user" if index % 2 == 0 else "assistant", "content": str(index) * 900}
        for index in range(10)
    ]
    context = build_model_context(request(recent_turns=turns))
    selected = context["recent_related_turns"]
    assert len(selected) <= 6
    assert sum(len(item["content"]) for item in selected) <= 4000
    assert selected[-1]["content"].endswith("9")


def test_current_item_only_excludes_conversation_and_older_summary():
    context = build_model_context(request(context_mode="current_item_only", older_context_summary="旧内容"))
    assert context["recent_related_turns"] == []
    assert context["older_context_summary"] is None


def test_slight_positive_evidence_uses_standard_plus():
    assert decide_difficulty(request()).level == DifficultyLevel.STANDARD_PLUS


def test_clear_stuck_signal_retreats_immediately():
    req = request(
        previous_difficulty="challenging",
        explicit_confusion="我完全不懂，彻底卡住了",
        learning_evidence=[
            {
                "kind": "remediation_needed",
                "summary": "连续两次需要补救",
                "confidence": 1.0,
                "difficulty_signal": -1.0,
            }
        ],
    )
    assert decide_difficulty(req).level == DifficultyLevel.STANDARD_PLUS


def test_clarification_is_allowed_only_once():
    clarification = {
        "status": "needs_clarification",
        "clarification": {
            "reason": "conflicting_topics",
            "question": "这次更想探索梯度方向，还是学习率大小？",
            "options": ["梯度方向", "学习率大小"],
        },
        "plan": None,
    }
    first = run(AdventureKnowledgePlanner(FakeLLM([json.dumps(clarification, ensure_ascii=False)])).generate(request()))
    assert first.status == "needs_clarification"

    second = run(
        AdventureKnowledgePlanner(FakeLLM([json.dumps(clarification, ensure_ascii=False), "bad"])).generate(
            request(clarification_count=1)
        )
    )
    assert second.status == "ready"
    assert second.metadata.generation_mode == "fallback"


def test_unresolved_source_conflict_gets_deterministic_clarification():
    req = request(
        selected_sources=[
            {"source_id": "s1", "source_type": "note", "title": "课堂笔记", "excerpt": "版本一"},
            {"source_id": "s2", "source_type": "course", "title": "课程材料", "excerpt": "版本二"},
        ],
        source_conflicts=[
            {
                "conflict_id": "c1",
                "source_ids": ["s1", "s2"],
                "issue": "两个资料对同一公式的适用条件表述冲突。",
                "resolved": False,
            }
        ],
    )
    llm = FakeLLM([json.dumps(valid_envelope(), ensure_ascii=False)])
    result = run(AdventureKnowledgePlanner(llm).generate(req))
    assert result.status == "needs_clarification"
    assert result.metadata.generation_mode == "deterministic"
    assert result.metadata.raw_attempts == 0
    assert result.clarification.options == ["课堂笔记", "课程材料"]
    assert llm.calls == []


def test_locked_confirmed_facts_must_be_preserved():
    payload = valid_envelope()
    req = request(confirmed_facts=[{"fact_id": "f1", "statement": "梯度是方向导数组成的向量。", "locked": True}])
    result = run(AdventureKnowledgePlanner(FakeLLM([json.dumps(payload, ensure_ascii=False), "bad"])).generate(req))
    assert result.metadata.generation_mode == "fallback"
    assert result.plan.confirmed_fact_ids == ["f1"]


def test_unknown_source_id_is_rejected():
    payload = valid_envelope()
    payload["plan"]["source_grounding"] = ["invented-source"]
    req = request(
        selected_sources=[
            {"source_id": "real-source", "source_type": "note", "title": "梯度笔记", "excerpt": "梯度与方向导数"}
        ]
    )
    result = run(AdventureKnowledgePlanner(FakeLLM([json.dumps(payload, ensure_ascii=False), "bad"])).generate(req))
    assert result.metadata.generation_mode == "fallback"
    assert result.plan.source_grounding == ["real-source"]


def test_preview_rejects_backstage_terms():
    payload = valid_envelope()
    payload["plan"]["preview"]["theme"] = "系统评分规则"
    result = run(AdventureKnowledgePlanner(FakeLLM([json.dumps(payload, ensure_ascii=False), "bad"])).generate(request()))
    assert result.metadata.generation_mode == "fallback"


def test_plan_requires_one_core_concept_and_one_misconception():
    payload = valid_envelope()
    payload["plan"]["core_concepts"].append(copy.deepcopy(payload["plan"]["core_concepts"][0]))
    envelope = LLMPlanEnvelope.model_validate(payload)
    errors = validate_plan(envelope, request(), DifficultyLevel.STANDARD_PLUS)
    assert "plan must focus on exactly one core concept" in errors


def test_at_least_two_interaction_forms_are_required():
    payload = valid_envelope()
    for question in [
        payload["plan"]["challenges"]["understanding_trial"],
        payload["plan"]["challenges"]["practice_trial"],
        payload["plan"]["challenges"]["remedy"],
        payload["plan"]["challenges"]["understanding_interleave"],
        payload["plan"]["challenges"]["practice_interleave"],
        *(stage["task"] for stage in payload["plan"]["challenges"]["boss"]),
    ]:
        question["interaction_kind"] = "explain"
    envelope = LLMPlanEnvelope.model_validate(payload)
    errors = validate_plan(envelope, request(), DifficultyLevel.STANDARD_PLUS)
    assert "an adventure must use at least two different interaction forms" in errors


def test_programming_plan_requires_code_or_debug_task():
    payload = valid_envelope()
    payload["plan"]["domain"] = "programming"
    envelope = LLMPlanEnvelope.model_validate(payload)
    errors = validate_plan(envelope, request(), DifficultyLevel.STANDARD_PLUS)
    assert "programming plan requires at least one code_task or find_error interaction" in errors


def test_adjustment_revision_is_bounded_and_consistent():
    adjusted = request(focus_adjustment="多举例，少讲定义", adjustment_count=1, draft_revision=2)
    assert adjusted.adjustment_count == 1
    with pytest.raises(ValidationError):
        request(focus_adjustment="继续改", adjustment_count=2, draft_revision=2)
    with pytest.raises(ValidationError):
        request(focus_adjustment="第三次调整", adjustment_count=3, draft_revision=4)


def test_v01_private_result_can_still_be_parsed_with_defaults():
    payload = valid_envelope()
    for question in [
        payload["plan"]["challenges"]["understanding_trial"],
        payload["plan"]["challenges"]["practice_trial"],
        payload["plan"]["challenges"]["remedy"],
        payload["plan"]["challenges"]["understanding_interleave"],
        payload["plan"]["challenges"]["practice_interleave"],
        *(stage["task"] for stage in payload["plan"]["challenges"]["boss"]),
    ]:
        for key in ("interaction_kind", "verification_method", "answer_boundary", "rubric", "remediation"):
            question.pop(key, None)
    payload["plan"].pop("completion_summary", None)
    payload["plan"].pop("source_conflict_note", None)
    payload["plan"].pop("confirmed_fact_ids", None)
    old_result = {
        "schema_version": "1.0",
        "status": "ready",
        "clarification": None,
        "plan": payload["plan"],
        "metadata": {
            "generation_mode": "fallback",
            "request_fingerprint": "123456789012",
            "model": None,
            "tokens_used": 0,
            "warnings": ["old_warning"],
            "difficulty_trace": [],
            "raw_attempts": 1,
        },
    }
    from agents.adventure_planner.models import PlannerResult

    parsed = PlannerResult.model_validate(old_result)
    assert parsed.schema_version == "1.0"
    assert parsed.plan.challenges.understanding_trial.interaction_kind.value == "explain"


def test_custom_academic_verifier_can_block_model_output():
    from agents.adventure_planner.academic_verifier import AcademicFinding

    class RejectingVerifier:
        def verify(self, plan, request):
            return [AcademicFinding("external_math_check_failed", "外部数学校验未通过")]

    result = run(
        AdventureKnowledgePlanner(
            FakeLLM([
                json.dumps(valid_envelope(), ensure_ascii=False),
                json.dumps(valid_envelope(), ensure_ascii=False),
            ]),
            academic_verifier=RejectingVerifier(),
        ).generate(request())
    )
    assert result.metadata.generation_mode == "fallback"
    assert "planner_semantic_validation_failed" in result.metadata.warnings
    assert "planner_repair_failed" in result.metadata.warnings


def test_fallbacks_pass_default_academic_verifier_for_all_domains():
    from agents.adventure_planner.academic_verifier import DefaultAcademicVerifier
    from agents.adventure_planner.fallback import build_fallback_plan

    topics = [
        "梯度下降",
        "Python 循环报错",
        "英语表达语气",
        "细胞呼吸",
        "历史因果分析",
        "如何判断一个观点合理",
    ]
    verifier = DefaultAcademicVerifier()
    for topic in topics:
        req = PlannerRequest(topic_hint=topic)
        plan = build_fallback_plan(req, DifficultyLevel.STANDARD)
        assert verifier.verify(plan, req) == []


def test_mismatched_first_hint_is_normalized_without_repair():
    payload = valid_envelope()
    question = payload["plan"]["challenges"]["understanding_trial"]
    question["remediation"]["first_attempt_hint"] = "先从目标函数的一阶变化符号想一想。"
    llm = FakeLLM([json.dumps(payload, ensure_ascii=False)])

    result = run(AdventureKnowledgePlanner(llm).generate(request()))

    normalized = result.plan.challenges.understanding_trial
    assert result.metadata.generation_mode == "model"
    assert len(llm.calls) == 1
    assert "planner_hint_normalized" in result.metadata.warnings
    assert "normalized_hint_pairs:1" in result.metadata.diagnostics
    assert normalized.remediation.first_attempt_hint == normalized.hint


def test_multiple_hint_mismatches_emit_one_nonblocking_warning():
    payload = valid_envelope()
    challenges = payload["plan"]["challenges"]
    targets = [
        challenges["understanding_trial"],
        challenges["practice_trial"],
        challenges["boss"][2]["task"],
    ]
    for index, question in enumerate(targets, start=1):
        question["remediation"]["first_attempt_hint"] = f"模型生成的另一种提示 {index}"

    result = run(
        AdventureKnowledgePlanner(FakeLLM([json.dumps(payload, ensure_ascii=False)])).generate(request())
    )

    assert result.metadata.generation_mode == "model"
    assert result.metadata.warnings.count("planner_hint_normalized") == 1
    assert "normalized_hint_pairs:3" in result.metadata.diagnostics
    assert all(
        question.remediation.first_attempt_hint == question.hint
        for question in (
            result.plan.challenges.understanding_trial,
            result.plan.challenges.practice_trial,
            result.plan.challenges.boss[2].task,
        )
    )


def test_hint_normalization_does_not_hide_other_semantic_errors():
    payload = valid_envelope()
    payload["plan"]["challenges"]["understanding_trial"]["remediation"][
        "first_attempt_hint"
    ] = "另一种提示"
    payload["plan"]["preview"]["theme"] = "系统评分规则"

    result = run(
        AdventureKnowledgePlanner(
            FakeLLM([json.dumps(payload, ensure_ascii=False), "still invalid"])
        ).generate(request())
    )

    assert result.metadata.generation_mode == "fallback"
    assert "planner_hint_normalized" in result.metadata.warnings
    assert "planner_semantic_validation_failed" in result.metadata.warnings
    assert "planner_repair_failed" in result.metadata.warnings

