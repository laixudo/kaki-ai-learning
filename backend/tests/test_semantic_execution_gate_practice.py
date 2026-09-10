"""Regression: contextual practice requests must pass the execution gate.

The post-call follow-up failure showed that natural practice phrasing whose
topic lives in conversation context ("练一下", "考考我") was vetoed by the
execution gate even when the LLM router selected a task action.  These tests
pin the generic practice-verb patterns without naming any single user
sentence.
"""
from __future__ import annotations

from services.workspace_semantic_router import (
    _has_explicit_task_execution,
    _looks_like_discussion,
)


class TestPracticeExecutionGate:
    def test_contextual_practice_requests_pass(self):
        samples = [
            "根据刚才聊的内容，针对我不会的地方出5道题",
            "根据刚才说的给我出几道题",
            "针对我刚才不会的地方练一下",
            "用我们刚聊的内容考考我",
            "出几道题测测我",
            "围绕这个主题来一组题",
        ]
        for text in samples:
            assert _has_explicit_task_execution(text), text

    def test_practice_requests_are_not_discussion(self):
        for text in ["针对我刚才不会的地方练一下", "用我们刚聊的内容考考我"]:
            assert not _looks_like_discussion(text), text

    def test_plain_discussion_still_blocked(self):
        blocked = [
            "这道题为什么选B",
            "你觉得这个练习难不难",
            "我刚才说的练习是什么意思",
            "我们刚才聊了些什么",
        ]
        for text in blocked:
            assert not _has_explicit_task_execution(text), text
