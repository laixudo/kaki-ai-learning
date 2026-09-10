"""Teaching-script generation through KAKI's existing LLM governance."""
from __future__ import annotations

import json
from typing import Any, Mapping

from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator

from .contracts import VideoGenerationRequest


class ScriptGenerationError(RuntimeError):
    code = "SCRIPT_GENERATION_FAILED"


class TeachingScript(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)
    title: str = Field(min_length=1, max_length=200)
    script: str = Field(min_length=20, max_length=8000)
    key_points: list[str] = Field(min_length=2, max_length=6)
    model: str = Field(min_length=1, max_length=120)

    @field_validator("title", "script", mode="before")
    @classmethod
    def clean_text(cls, value: Any) -> str:
        return str(value or "").strip()

    @field_validator("key_points", mode="before")
    @classmethod
    def clean_points(cls, value: Any) -> list[str]:
        if not isinstance(value, (list, tuple)):
            return []
        return [str(item or "").strip()[:160] for item in value if str(item or "").strip()][:6]


def build_local_teaching_script(request: VideoGenerationRequest) -> TeachingScript:
    """Topic-derived short talk used only when cloud avatar credentials are blocked."""
    topic = str(request.topic or "").strip()[:80] or "今天的知识点"
    seconds = max(15, min(int(request.duration_sec or 20), 20))
    evidence = request.evidence_context
    points: list[str] = []
    for candidate in (
        evidence.learning_goal, evidence.graph_node, evidence.next_action, request.instruction,
        f"先抓住「{topic}」要解决什么问题", "用一个生活例子把关系讲清楚",
    ):
        cleaned = str(candidate or "").strip()[:80]
        if cleaned and cleaned not in points:
            points.append(cleaned)
        if len(points) >= 4:
            break
    if len(points) < 2:
        points = [f"抓住「{topic}」的核心概念", "把关键步骤在脑子里过一遍"]
    script = (
        f"大家好，我是柿小吉。接下来用大约{seconds}秒，带你认识「{topic}」。"
        f"第一，先把问题看清楚。第二，{points[0]}。第三，{points[1]}。"
        "跟我一起把关键步骤过一遍，下课后再做一道同类型的题巩固。"
        "我是柿小吉，我们下次见。"
    )
    return TeachingScript(
        title=f"{topic}短讲", script=script, key_points=points[:4], model="local-script",
    )


def build_script_prompt(request: VideoGenerationRequest) -> str:
    style = request.style_context
    evidence = request.evidence_context
    style_lines = [
        f"- 语气：{style.tone}" if style.tone else "",
        f"- 节奏：{style.pace}" if style.pace else "",
        f"- 举例偏好：{style.example_preference}" if style.example_preference else "",
        f"- 视觉偏好：{style.visual_preference}" if style.visual_preference else "",
    ]
    evidence_lines = [
        f"- 当前学习目标：{evidence.learning_goal}" if evidence.learning_goal else "",
        f"- 当前图谱节点：{evidence.graph_node}" if evidence.graph_node else "",
        f"- 已验证理解偏差：{'；'.join(evidence.verified_weaknesses)}" if evidence.verified_weaknesses else "",
        f"- 下一学习动作：{evidence.next_action}" if evidence.next_action else "",
    ]
    source = request.source_context.strip()
    return "\n".join(filter(None, [
        f"为主题《{request.topic}》编写约 {request.duration_sec} 秒的中文短讲视频讲稿。",
        "表达偏好（只影响表达方式）：",
        *style_lines,
        "可信教学证据（只引用这里明确给出的事实）：",
        *evidence_lines,
        f"补充要求：{request.instruction}" if request.instruction else "",
        f"可信参考资料：\n{source}" if source else "",
        "输出 title、script、key_points；key_points 为 2-6 条简短要点。不得编造学生能力结论。",
    ]))


_FIELD_ALIASES = {
    "title": ("title", "标题"),
    "script": ("script", "讲稿", "正文"),
    "key_points": ("key_points", "keyPoints", "要点", "points"),
}


def _unwrap_payload(value: Any) -> Any:
    if isinstance(value, dict) and "content" in value and not (
        {"title", "script", "key_points"} & set(value)
    ):
        return _unwrap_payload(value["content"])
    if isinstance(value, str):
        text = value.strip()
        if text.startswith("```"):
            text = text.split("\n", 1)[-1].rsplit("```", 1)[0]
        return json.loads(text)
    return value


def _looks_like_json_schema(value: Mapping[str, Any]) -> bool:
    return str(value.get("type") or "") == "object" and isinstance(value.get("properties"), dict)


def _normalize_script_payload(value: Any) -> dict[str, Any]:
    raw = _unwrap_payload(value)
    if not isinstance(raw, dict):
        raise ValueError("script payload is not an object")
    data = {str(key): item for key, item in raw.items() if key != "_meta"}
    if _looks_like_json_schema(data):
        raise ValueError("model echoed the JSON schema instead of a teaching script")
    normalized: dict[str, Any] = {}
    for field, aliases in _FIELD_ALIASES.items():
        for alias in aliases:
            if alias in data and data[alias] not in (None, ""):
                normalized[field] = data[alias]
                break
    points = normalized.get("key_points")
    if isinstance(points, str):
        normalized["key_points"] = [
            part.strip()[:160] for part in points.replace("；", "\n").replace(";", "\n").splitlines()
            if part.strip()
        ]
    elif isinstance(points, list):
        cleaned: list[str] = []
        for item in points:
            if isinstance(item, dict):
                item = item.get("text") or item.get("point") or item.get("title") or ""
            text = str(item or "").strip()
            if text and text not in cleaned:
                cleaned.append(text[:160])
        normalized["key_points"] = cleaned
    return normalized


async def generate_teaching_script(
    request: VideoGenerationRequest, llm: Any, *, model_identifier: str,
) -> TeachingScript:
    prompt = build_script_prompt(request)
    system_prompt = (
        "你是柿子智学的教学讲稿生成器。严格使用后端提供的可信教学证据；"
        "画像只控制表达风格。按示例填入真实讲稿内容，不要回显 JSON Schema 或类型定义。"
        "script 必须是可口播的完整短讲，不少于 40 个汉字；key_points 至少 2 条。"
    )
    try:
        raw = await llm.structured_output(
            [{"role": "user", "content": prompt}],
            {
                "title": "短讲标题",
                "script": "可直接口播的完整中文讲稿",
                "key_points": ["要点一", "要点二"],
            },
            system_prompt=system_prompt,
            cache_user_id=request.user_id,
        )
        payload = _normalize_script_payload(raw)
        payload["model"] = str(model_identifier or "unknown")
        return TeachingScript.model_validate(payload)
    except (ValidationError, ValueError, TypeError, json.JSONDecodeError) as exc:
        raise ScriptGenerationError("讲稿模型返回了无效结构，未生成固定兜底内容。") from exc
    except ScriptGenerationError:
        raise
    except Exception as exc:
        raise ScriptGenerationError("讲稿生成服务当前不可用，未创建假讲稿。") from exc
