import sys
import types

# The web executor does not have the optional Redis client installed. This test
# exercises pure reference validation and stubs only that unrelated import edge.
redis_module = types.ModuleType("redis")
redis_asyncio = types.ModuleType("redis.asyncio")
class _Redis: pass
redis_asyncio.Redis = _Redis
redis_asyncio.from_url = lambda *args, **kwargs: None
redis_module.asyncio = redis_asyncio
sys.modules.setdefault("redis", redis_module)
sys.modules.setdefault("redis.asyncio", redis_asyncio)

import pytest

from schemas.chat import SelectionContext
from services.workspace_references import (
    ReferenceAccessError,
    ResolvedWorkspaceReferences,
    attach_trusted_selection_context,
    build_reference_question_context,
)


def artifact_refs(content: str = "learning_rate = 0.9\nloss.backward()") -> ResolvedWorkspaceReferences:
    return ResolvedWorkspaceReferences(
        primary_kind="artifact",
        artifact_context={
            "artifact_id": 101,
            "version_id": 2,
            "artifact_kind": "workspace_code",
            "title": "代码实验",
            "topic": "学习率震荡",
            "content": content,
            "raw_data": {"thread_id": "thread-a", "version": 2},
        },
    )


def test_trusted_selection_is_bounded_and_attached_to_verified_artifact():
    refs = artifact_refs()
    context = attach_trusted_selection_context(
        build_reference_question_context(refs),
        refs,
        SelectionContext(selected_text="learning_rate = 0.9", range_label="代码第 1 行"),
    )
    assert context["artifact_id"] == 101
    assert context["version_id"] == 2
    assert context["selection"] == {
        "selected_text": "learning_rate = 0.9",
        "range_label": "代码第 1 行",
        "purpose": "解释选中内容",
        "artifact_id": 101,
        "version_id": 2,
        "ephemeral": True,
    }


def test_selection_from_another_artifact_or_version_is_rejected():
    refs = artifact_refs()
    with pytest.raises(ReferenceAccessError, match="不属于当前资源"):
        attach_trusted_selection_context(
            build_reference_question_context(refs),
            refs,
            SelectionContext(selected_text="secret_from_another_artifact"),
        )


def test_selection_without_a_server_verified_artifact_is_rejected():
    refs = ResolvedWorkspaceReferences(primary_kind=None)
    with pytest.raises(ReferenceAccessError, match="缺少有效的当前资源"):
        attach_trusted_selection_context({}, refs, SelectionContext(selected_text="anything"))
