import pytest

from integrations.cloud_video.contracts import (
    EvidenceTeachingContext,
    StyleContext,
    VideoGenerationRequest,
)
from integrations.cloud_video.script_service import (
    ScriptGenerationError,
    build_local_teaching_script,
    build_script_prompt,
    generate_teaching_script,
)


def request() -> VideoGenerationRequest:
    return VideoGenerationRequest(
        topic="导数的几何意义", user_id=7, thread_id="thread-7", duration_sec=20,
        style_context=StyleContext(tone="耐心", example_preference="先举生活例子"),
        evidence_context=EvidenceTeachingContext(
            learning_goal="解释切线斜率", graph_node="瞬时变化率",
            verified_weaknesses=["混淆平均变化率和瞬时变化率"],
            next_action="完成一道切线题",
        ),
    )


def test_prompt_separates_style_from_evidence_and_has_no_mastery_source():
    prompt = build_script_prompt(request())
    assert "表达偏好" in prompt and "可信教学证据" in prompt
    assert "混淆平均变化率和瞬时变化率" in prompt
    assert "耐心" in prompt
    assert "skill_matrix" not in prompt
    assert "misconception_archive" not in prompt
    assert "mastery" not in prompt.lower()


def test_local_script_is_derived_from_the_requested_topic():
    script = build_local_teaching_script(request())
    assert "导数的几何意义" in script.script
    assert script.model == "local-script"
    assert len(script.key_points) >= 2
    assert "勾股定理" not in script.script


@pytest.mark.asyncio
async def test_valid_structured_llm_result_is_accepted_without_model_rebranding():
    class FakeLLM:
        async def structured_output(self, messages, output_schema, system_prompt=None, cache_user_id=0):
            assert messages and output_schema and system_prompt
            return {
                "title": "导数的几何意义",
                "script": "先观察一段路程随时间变化的曲线，再把割线逐步逼近切线。",
                "key_points": ["平均变化率对应割线", "瞬时变化率对应切线", "导数表示切线斜率"],
            }

    result = await generate_teaching_script(request(), FakeLLM(), model_identifier="deepseek-chat")
    assert result.model == "deepseek-chat"
    assert result.key_points[-1] == "导数表示切线斜率"
    assert "V4 Flash" not in repr(result)


@pytest.mark.asyncio
async def test_structured_output_meta_envelope_is_stripped():
    class MetaLLM:
        async def structured_output(self, *args, **kwargs):
            return {
                "title": "导数的几何意义",
                "script": "先观察一段路程随时间变化的曲线，再把割线逐步逼近切线。",
                "key_points": ["平均变化率对应割线", "瞬时变化率对应切线", "导数表示切线斜率"],
                "_meta": {"tokens_used": 342},
            }

    result = await generate_teaching_script(request(), MetaLLM(), model_identifier="deepseek-chat")
    assert result.title == "导数的几何意义"
    assert result.model == "deepseek-chat"
    assert "_meta" not in result.model_dump()


@pytest.mark.asyncio
async def test_schema_echo_is_rejected_as_invalid_structure():
    class SchemaEchoLLM:
        async def structured_output(self, *args, **kwargs):
            return {
                "type": "object",
                "properties": {
                    "title": {"type": "string"},
                    "script": {"type": "string"},
                    "key_points": {"type": "array", "items": {"type": "string"}},
                },
                "required": ["title", "script", "key_points"],
                "additionalProperties": False,
                "_meta": {"tokens_used": 342},
            }

    with pytest.raises(ScriptGenerationError):
        await generate_teaching_script(request(), SchemaEchoLLM(), model_identifier="deepseek-chat")


@pytest.mark.asyncio
async def test_invalid_llm_result_fails_instead_of_emitting_fixed_fallback():
    class EmptyLLM:
        async def structured_output(self, *args, **kwargs):
            return {"title": "", "script": "", "key_points": []}

    with pytest.raises(ScriptGenerationError):
        await generate_teaching_script(request(), EmptyLLM(), model_identifier="deepseek-chat")
