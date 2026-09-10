"""Real slide generation and PPTX export for the standalone AI workspace."""
from __future__ import annotations

import io
import json
from typing import Any, Mapping

from config import settings


def _text(value: Any, limit: int = 3000) -> str:
    return str(value or "").strip()[:limit]


def _extract_json(raw: Any) -> dict:
    text = _text(raw, 40000).replace("\ufeff", "")
    if text.startswith("```"):
        text = text.split("\n", 1)[-1].rsplit("```", 1)[0].strip()
    start, end = text.find("{"), text.rfind("}")
    if start < 0 or end <= start:
        raise ValueError("presentation agent returned no JSON object")
    value = json.loads(text[start:end + 1])
    if not isinstance(value, dict):
        raise ValueError("presentation agent returned invalid JSON")
    return value


def normalize_slide_deck(value: Mapping[str, Any], *, include_interactions: bool) -> dict:
    title = _text(value.get("title"), 200) or "AI 学习演示"
    source_slides = value.get("slides")
    if isinstance(source_slides, dict):
        source_slides = source_slides.get("slides")
    if not isinstance(source_slides, list) or not source_slides:
        raise ValueError("presentation agent returned no slides")
    slides = []
    for index, raw in enumerate(source_slides[:30]):
        if not isinstance(raw, Mapping):
            continue
        kind = _text(raw.get("type"), 30) or "content"
        slide = {
            "index": index,
            "type": kind,
            "title": _text(raw.get("title"), 200) or (title if index == 0 else f"第 {index + 1} 页"),
            "subtitle": _text(raw.get("subtitle"), 300),
            "body": _text(raw.get("body"), 4000),
            "items": [_text(item, 400) for item in (raw.get("items") or raw.get("points") or []) if _text(item, 400)],
            "code": _text(raw.get("code"), 5000),
            "language": _text(raw.get("lang") or raw.get("language"), 30),
            "narration": _text(raw.get("narration"), 5000),
        }
        question = _text(raw.get("question"), 500)
        options = [_text(item, 300) for item in (raw.get("options") or []) if _text(item, 300)]
        if include_interactions and question and len(options) >= 2:
            answer = raw.get("answer", raw.get("correct_index", 0))
            try:
                answer = int(answer)
            except (TypeError, ValueError):
                answer = 0
            if not 0 <= answer < len(options):
                answer = 0
            slide["interaction"] = {
                "question": question,
                "options": options,
                "correct_index": answer,
                "explanation": _text(raw.get("explanation"), 1000),
            }
        slides.append(slide)
    if not slides:
        raise ValueError("presentation agent returned no usable slides")
    return {"title": title, "slides": slides}


async def generate_workspace_presentation(
    *, topic: str, delivery_mode: str, learning_goal: str = "", level: str = "",
    duration_minutes: int | None = None, slide_count: int | None = None,
    presentation_style: str = "",
    source_context: str = "",
) -> dict:
    """Generate real slide data through the configured production LLM; never mock."""
    include_interactions = delivery_mode == "interactive_lesson"
    slide_hint = int(slide_count) if slide_count else max(5, min(16, int((duration_minutes or 6) * 1.2)))
    slide_requirement = (
        f"必须恰好 {slide_hint} 页"
        if slide_count else f"建议约 {slide_hint} 页"
    )
    interaction_rule = (
        "至少包含 1 页 quiz，每道互动题给出 options、answer(从0开始)和 explanation。"
        if include_interactions else
        "不要生成测验页，不要包含答案字段；这是供用户查看和导出的普通 PPT。"
    )
    prompt = f"""你是 PPT 与互动课堂内容生成智能体。请生成严格 JSON，不要输出 Markdown 代码围栏。
主题：{topic}
交付模式：{delivery_mode}
学习目标：{learning_goal or '按主题组织核心内容'}
学习水平：{level or '通用'}
预计时长：{duration_minutes or 6} 分钟
呈现风格：{presentation_style or '清晰、简洁、适合学习'}
页数要求：{slide_requirement}
来源资料：{source_context[:6000] if source_context else '无'}

输出结构：
{{"title":"标题","slides":[{{"type":"title|goals|content|code|quiz|summary","title":"页标题","subtitle":"可选","body":"可选正文","items":["要点"],"code":"可选代码","lang":"可选语言","narration":"本页自然讲解","question":"仅互动题","options":["选项"],"answer":0,"explanation":"答案讲解"}}]}}

要求：
- 每页都必须有 narration，内容与页面一致；
- 页面结构完整、事实可靠、中文自然；
- {interaction_rule}
- 只输出 JSON。"""
    from services.llm_service import get_llm_service
    llm = await get_llm_service()
    raw = await llm.generate(prompt, max_tokens=3600)
    deck = normalize_slide_deck(_extract_json(raw), include_interactions=include_interactions)
    deck["provider"] = str(getattr(settings, "LLM_PROVIDER", "unknown") or "unknown").lower()
    if deck["provider"] == "mock":
        raise RuntimeError("presentation generation requires a real LLM provider")
    return deck


async def revise_workspace_presentation(
    *, existing_deck: Mapping[str, Any], instruction: str, delivery_mode: str,
) -> dict:
    """Revise one persisted deck through the real provider, keeping its delivery contract."""
    include_interactions = delivery_mode == "interactive_lesson"
    existing_json = json.dumps(dict(existing_deck), ensure_ascii=False)[:18000]
    prompt = f"""你是 PPT 与互动课堂内容修改智能体。请根据修改要求更新现有产物。
只输出完整、严格的 JSON，不要输出 Markdown 代码围栏，也不要只输出变更片段。
交付模式：{delivery_mode}
修改要求：{_text(instruction, 1000)}
现有产物：{existing_json}

输出结构：
{{"title":"标题","slides":[{{"type":"title|goals|content|code|quiz|summary","title":"页标题","subtitle":"可选","body":"可选正文","items":["要点"],"code":"可选代码","lang":"可选语言","narration":"本页自然讲解","question":"仅互动题","options":["选项"],"answer":0,"explanation":"答案讲解"}}]}}

要求：
- 只执行用户要求的修改，保留未要求改变的主题与有效内容；
- 每页都保留或补全 narration；
- 互动课堂保留可作答结构，普通 PPT 不包含答案元数据；
- 只输出 JSON。"""
    from services.llm_service import get_llm_service
    llm = await get_llm_service()
    raw = await llm.generate(prompt, max_tokens=3600)
    deck = normalize_slide_deck(_extract_json(raw), include_interactions=include_interactions)
    deck["provider"] = str(getattr(settings, "LLM_PROVIDER", "unknown") or "unknown").lower()
    if deck["provider"] == "mock":
        raise RuntimeError("presentation revision requires a real LLM provider")
    return deck


def _slide_text(slide: Mapping[str, Any]) -> str:
    parts = []
    if slide.get("subtitle"):
        parts.append(_text(slide["subtitle"], 500))
    if slide.get("body"):
        parts.append(_text(slide["body"], 4000))
    parts.extend(f"• {_text(item, 500)}" for item in (slide.get("items") or []))
    if slide.get("code"):
        parts.append(_text(slide["code"], 5000))
    interaction = slide.get("interaction") or {}
    if interaction:
        parts.append(_text(interaction.get("question"), 500))
        parts.extend(f"{chr(65 + i)}. {_text(option, 300)}" for i, option in enumerate(interaction.get("options") or []))
    return "\n".join(part for part in parts if part)


def build_pptx_bytes(deck: Mapping[str, Any]) -> bytes:
    """Build a valid editable PPTX package from the persisted slide artifact."""
    from pptx import Presentation
    from pptx.util import Inches, Pt

    presentation = Presentation()
    presentation.slide_width = Inches(13.333)
    presentation.slide_height = Inches(7.5)
    for index, slide_data in enumerate(deck.get("slides") or []):
        layout = presentation.slide_layouts[0] if index == 0 else presentation.slide_layouts[1]
        slide = presentation.slides.add_slide(layout)
        slide.shapes.title.text = _text(slide_data.get("title"), 200)
        body_text = _slide_text(slide_data)
        if index == 0 and len(slide.placeholders) > 1:
            slide.placeholders[1].text = _text(slide_data.get("subtitle"), 500)
        elif len(slide.placeholders) > 1:
            frame = slide.placeholders[1].text_frame
            frame.clear()
            frame.text = body_text
            for paragraph in frame.paragraphs:
                paragraph.font.size = Pt(22)
        notes = _text(slide_data.get("narration"), 5000)
        if notes:
            try:
                slide.notes_slide.notes_text_frame.text = notes
            except Exception:
                pass
    payload = io.BytesIO()
    presentation.save(payload)
    return payload.getvalue()
