import pytest

from services.workspace_semantic_router import route_semantically
from services.workspace_task_contracts import AgentTask, AgentType, TaskState


class _SemanticLlm:
    async def chat(self, **_kwargs):
        return {
            "content": (
                '{"action":"new_task","agent_type":"lecture",'
                '"artifact_operation":null,"slot_updates":{'
                '"topic":"函数单调性与导数","source_artifact_kind":"material",'
                '"source_artifact_id":999},"confidence":0.96,'
                '"reason_code":"generate_lecture_from_uploaded_material"}'
            )
        }


class _ChatMisrouteLlm:
    async def chat(self, **_kwargs):
        return {
            "content": (
                '{"action":"normal_chat","agent_type":null,'
                '"artifact_operation":null,"slot_updates":{},'
                '"confidence":0.88,"reason_code":"material_followup"}'
            )
        }


@pytest.mark.asyncio
async def test_untrusted_model_lecture_source_is_removed_before_task_adapter():
    route = await route_semantically(
        message="请基于刚才上传的资料生成一份简短讲义",
        current_task=None,
        active_artifact=None,
        artifact_candidates=[],
        related_context=[],
        llm=_SemanticLlm(),
    )

    assert route.agent_type.value == "lecture"
    assert route.slot_updates["topic"] == "函数单调性与导数"
    assert "source_artifact_kind" not in route.slot_updates
    assert "source_artifact_id" not in route.slot_updates


@pytest.mark.asyncio
async def test_lecture_source_identity_is_replaced_with_trusted_active_artifact():
    route = await route_semantically(
        message="根据这份讲义生成一份新的复习讲义",
        current_task=None,
        active_artifact={"kind": "lecture", "artifact_id": 42, "title": "可信讲义"},
        artifact_candidates=[],
        related_context=[],
        llm=_SemanticLlm(),
    )

    assert route.slot_updates["source_artifact_kind"] == "lecture"
    assert route.slot_updates["source_artifact_id"] == 42


@pytest.mark.asyncio
async def test_explicit_generate_lecture_cannot_fall_through_to_chat():
    route = await route_semantically(
        message="请基于刚才上传的资料生成一份简短讲义，并保存为学习产物。",
        current_task=None,
        active_artifact=None,
        artifact_candidates=[],
        related_context=[],
        llm=_ChatMisrouteLlm(),
    )

    assert route.action.value == "new_task"
    assert route.agent_type.value == "lecture"


@pytest.mark.asyncio
async def test_explicit_confirmation_recovers_model_chat_misroute_for_pending_task():
    task = AgentTask(
        user_id=21,
        thread_id="thread-task15-confirm",
        agent_type=AgentType.LECTURE,
        state=TaskState.AWAITING_CONFIRMATION,
        slots={"topic": "函数单调性与导数"},
        version=2,
    )
    route = await route_semantically(
        message="确认生成并保存。",
        current_task=task,
        active_artifact=None,
        artifact_candidates=[],
        related_context=[],
        llm=_ChatMisrouteLlm(),
    )

    assert route.action.value == "confirm"
    assert route.agent_type == AgentType.LECTURE
