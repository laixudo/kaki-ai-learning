from __future__ import annotations

from typing import Any

from .models import KnowledgePlan, PlannerResult, Question, QuestionKind


def _question_to_legacy(question: Question) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "type": question.kind.value,
        "interaction_kind": question.interaction_kind.value if question.interaction_kind else None,
        "question": question.question,
        "hint": question.hint,
    }
    if question.kind == QuestionKind.MULTIPLE_CHOICE:
        payload["options"] = list(question.options or [])
        payload["correct_option"] = int(question.correct_option or 0)
    else:
        payload["accepted_groups"] = [list(group) for group in question.accepted_groups or []]
    return payload


def knowledge_plan_to_deck(plan: KnowledgePlan) -> dict[str, Any]:
    challenge = plan.challenges
    boss = []
    for stage in challenge.boss:
        task = _question_to_legacy(stage.task)
        task["label"] = stage.label
        boss.append(task)
    return {
        "source_note": plan.source_note,
        "rule": plan.core_concepts[0].explanation,
        "example": "；".join(plan.worked_example.steps) + "。" + plan.worked_example.conclusion,
        "understanding": {
            "trial": _question_to_legacy(challenge.understanding_trial),
            "interleave": _question_to_legacy(challenge.understanding_interleave),
        },
        "practice": {
            "trial": _question_to_legacy(challenge.practice_trial),
            "interleave": _question_to_legacy(challenge.practice_interleave),
        },
        "remedy": _question_to_legacy(challenge.remedy),
        "boss": boss,
    }


def plan_to_existing_content(result: PlannerResult) -> dict[str, Any]:
    if result.status != "ready" or result.plan is None:
        raise ValueError("cannot adapt a clarification result to adventure content")
    plan = result.plan
    deck = knowledge_plan_to_deck(plan)
    return {
        "title": f"{plan.preview.theme[:36]} · 拾光漫游",
        "subtitle": "用十分钟，完成一次有始有终的学习小旅程。",
        "topic": plan.topic,
        "source_note": deck["source_note"],
        "plan_preview": plan.preview.model_dump(mode="json"),
        "completion_summary": plan.completion_summary,
        "planner_meta": {
            "schema_version": result.schema_version,
            "generation_mode": result.metadata.generation_mode,
            "difficulty": plan.difficulty.value,
            "request_fingerprint": result.metadata.request_fingerprint,
            "content_fingerprint": result.metadata.content_fingerprint,
            "draft_revision": result.metadata.draft_revision,
            "adjustment_count": result.metadata.adjustment_count,
            "plan_state": result.metadata.plan_state,
            "warnings": list(result.metadata.warnings),
        },
        "scroll": {"rule": deck["rule"], "example": deck["example"]},
        "routes": deck["understanding"] | {"practice": deck["practice"]},
        "understanding": deck["understanding"],
        "practice": deck["practice"],
        "remedy": deck["remedy"],
        "boss": deck["boss"],
    }
