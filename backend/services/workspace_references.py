"""Trusted message-level references for workspace chat and agent operations."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Iterable

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from database.models import (
    ChatSession,
    ExamPaper,
    GeneratedItem,
    WorkspaceConversationMaterial,
    WorkspaceMaterial,
)
from services.workspace_artifact_versions import ensure_initial_version, get_version


class ReferenceAccessError(ValueError):
    """A reference is missing, stale, or outside the authenticated conversation."""


@dataclass(frozen=True)
class ResolvedWorkspaceReferences:
    primary_kind: str | None = None
    material_ids: list[str] = field(default_factory=list)
    attachment_refs: list[dict[str, Any]] = field(default_factory=list)
    reply_context: dict[str, Any] | None = None
    artifact_context: dict[str, Any] | None = None


def _material_ids(refs: Iterable[Any]) -> list[str]:
    result = []
    for item in refs or []:
        material_id = item.get("material_id") if isinstance(item, dict) else getattr(item, "material_id", None)
        if material_id and material_id not in result:
            result.append(str(material_id))
    return result


async def _resolve_materials(
    db: AsyncSession, *, user_id: int, thread_id: str, attachment_refs: Iterable[Any]
) -> tuple[list[str], list[dict[str, Any]]]:
    requested = _material_ids(attachment_refs)
    if not requested:
        return [], []
    rows = (await db.execute(
        select(WorkspaceMaterial, WorkspaceConversationMaterial)
        .join(
            WorkspaceConversationMaterial,
            WorkspaceConversationMaterial.material_id == WorkspaceMaterial.material_id,
        )
        .where(
            WorkspaceMaterial.user_id == user_id,
            WorkspaceMaterial.material_id.in_(requested),
            WorkspaceConversationMaterial.user_id == user_id,
            WorkspaceConversationMaterial.thread_id == thread_id,
            WorkspaceConversationMaterial.is_active.is_(True),
        )
    )).all()
    by_id = {material.material_id: material for material, _binding in rows}
    missing = [material_id for material_id in requested if material_id not in by_id]
    if missing:
        raise ReferenceAccessError("附件不属于当前会话或已被移除。")
    canonical = []
    for material_id in requested:
        material = by_id[material_id]
        canonical.append({
            "material_id": material.material_id,
            "file_name": material.file_name,
            "type": material.file_type,
            "parse_status": material.parse_status,
            "page_count": material.page_count,
        })
    return requested, canonical


async def _resolve_reply(
    db: AsyncSession, *, user_id: int, thread_id: str, message_id: str | None
) -> dict[str, Any] | None:
    if not message_id:
        return None
    session = (await db.execute(select(ChatSession).where(
        ChatSession.user_id == user_id,
        ChatSession.thread_id == thread_id,
    ))).scalar_one_or_none()
    message = next(
        (item for item in (session.messages if session else []) if str(item.get("id") or "") == str(message_id)),
        None,
    )
    if message is None:
        return None
    return {
        "message_id": message_id,
        "role": message.get("role"),
        "content": str(message.get("content") or "")[:16000],
        "attachment_refs": list(message.get("attachment_refs") or []),
    }


def _exam_paper_context(paper: ExamPaper) -> dict[str, Any]:
    completed = str(paper.status or "") == "completed"
    questions = []
    for question in list(paper.questions or [])[:20]:
        item = {
            "id": question.get("id"),
            "type": question.get("type"),
            "content": question.get("content") or question.get("title"),
            "options": question.get("options") or [],
            "points": question.get("points"),
        }
        if completed:
            item["correct_answer"] = question.get("answer")
            item["explanation"] = question.get("explanation")
        questions.append(item)
    score = paper.score if completed else None
    total = paper.total_score
    title = "练习结果" if completed else "练习题"
    summary = f"{title}：{len(questions)} 道题"
    if completed and score is not None:
        summary += f"，得分 {score}/{total if total is not None else '—'}"
    return {
        "artifact_id": paper.id,
        "version_id": None,
        "version_number": None,
        "artifact_kind": "exam_result" if completed else "exam",
        "title": title,
        "topic": None,
        "content": summary,
        "raw_data": {
            "exam_id": paper.id,
            "status": paper.status,
            "questions": questions,
            "answers": paper.answers if completed else None,
            "score": score,
            "total_score": total,
        },
    }


async def _resolve_artifact(
    db: AsyncSession, *, user_id: int, thread_id: str,
    artifact_id: int | None, version_id: int | None,
) -> dict[str, Any] | None:
    if not artifact_id:
        return None
    item = (await db.execute(select(GeneratedItem).where(
        GeneratedItem.id == artifact_id,
        GeneratedItem.user_id == user_id,
    ))).scalar_one_or_none()
    if item is None:
        paper = (await db.execute(select(ExamPaper).where(
            ExamPaper.id == artifact_id,
            ExamPaper.user_id == user_id,
        ))).scalar_one_or_none()
        return _exam_paper_context(paper) if paper is not None else None
    metadata = dict(item.raw_data or {}) if item else {}
    if str(metadata.get("thread_id") or "") != thread_id:
        return None
    current = await ensure_initial_version(db, item)
    selected = current
    if version_id:
        try:
            selected = await get_version(db, item=item, version_id=int(version_id))
        except Exception:
            # A1 clients historically sent version_number in target_version_id.
            try:
                selected = await get_version(db, item=item, version_number=int(version_id))
            except Exception as exc:
                raise ReferenceAccessError("被引用的产物版本不存在或已变化，请重新选择。") from exc
    return {
        "artifact_id": item.id,
        "version_id": selected.id,
        "version_number": selected.version_number,
        "artifact_kind": item.type,
        "title": selected.title_snapshot,
        "topic": selected.chapter_snapshot,
        "content": str(selected.content_snapshot or "")[:16000],
        "raw_data": dict(selected.public_data_snapshot or {}),
    }


async def resolve_workspace_references(
    db: AsyncSession,
    *,
    user_id: int,
    thread_id: str,
    attachment_refs: Iterable[Any] = (),
    reply_to_message_id: str | None = None,
    target_artifact_id: int | None = None,
    target_version_id: int | None = None,
) -> ResolvedWorkspaceReferences:
    """Resolve trusted refs while preserving the documented target priority."""
    material_ids, canonical_refs = await _resolve_materials(
        db, user_id=user_id, thread_id=thread_id, attachment_refs=attachment_refs,
    )
    reply = await _resolve_reply(
        db, user_id=user_id, thread_id=thread_id, message_id=reply_to_message_id,
    )
    artifact = await _resolve_artifact(
        db, user_id=user_id, thread_id=thread_id,
        artifact_id=target_artifact_id, version_id=target_version_id,
    )
    primary_kind = "material" if material_ids else "message" if reply else "artifact" if artifact else None
    return ResolvedWorkspaceReferences(
        primary_kind=primary_kind,
        material_ids=material_ids,
        attachment_refs=canonical_refs,
        reply_context=reply,
        artifact_context=artifact,
    )


def _normalized_selection_text(value: str) -> str:
    return " ".join(str(value or "").replace("\x00", "").split())


def attach_trusted_selection_context(
    context: dict[str, Any] | None,
    resolved: ResolvedWorkspaceReferences,
    selection_context: Any | None,
) -> dict[str, Any] | None:
    """Attach a bounded selection only when it belongs to the trusted artifact/version.

    The selected text remains request-scoped. It is not copied into the artifact, graph,
    profile, or workspace event stores by this adapter.
    """
    if selection_context is None:
        return context
    artifact = resolved.artifact_context
    if not artifact or not context or context.get("reference_kind") != "artifact":
        raise ReferenceAccessError("选中文本缺少有效的当前资源，请重新选择。")
    selected_text = getattr(selection_context, "selected_text", None)
    if selected_text is None and isinstance(selection_context, dict):
        selected_text = selection_context.get("selected_text")
    selected_text = str(selected_text or "").replace("\x00", "").strip()
    normalized_selected = _normalized_selection_text(selected_text)
    normalized_artifact = _normalized_selection_text(artifact.get("content") or "")
    if not normalized_selected or normalized_selected not in normalized_artifact:
        raise ReferenceAccessError("选中文本不属于当前资源或版本已变化，请重新选择。")
    range_label = getattr(selection_context, "range_label", None)
    purpose = getattr(selection_context, "purpose", None)
    if isinstance(selection_context, dict):
        range_label = selection_context.get("range_label")
        purpose = selection_context.get("purpose")
    result = dict(context)
    selection_payload = {
        "selected_text": selected_text[:1200],
        "range_label": str(range_label or "选中内容")[:120],
        "purpose": str(purpose or "解释选中内容")[:80],
        "artifact_id": artifact["artifact_id"],
        "version_id": artifact["version_id"],
        "ephemeral": True,
    }
    if artifact.get("version_number") is not None:
        selection_payload["version_number"] = artifact["version_number"]
    result["selection"] = selection_payload
    return result


def build_reference_question_context(resolved: ResolvedWorkspaceReferences) -> dict[str, Any] | None:
    """Return a bounded context block for the most explicit non-material target."""
    if resolved.primary_kind == "material":
        return None
    if resolved.reply_context:
        return {
            "reference_kind": "message",
            "reply_to_message_id": resolved.reply_context["message_id"],
            "role": resolved.reply_context["role"],
            "content": resolved.reply_context["content"],
        }
    if resolved.artifact_context:
        item = resolved.artifact_context
        kind = str(item.get("artifact_kind") or "")
        if kind in {"exam", "exam_result"}:
            exam = dict(item.get("raw_data") or {})
            exam.update({
                "reference_kind": "exam",
                "exam_id": item["artifact_id"],
                "artifact_kind": kind,
                "title": item.get("title"),
                "content": item.get("content"),
            })
            return exam
        return {
            "reference_kind": "artifact",
            "artifact_id": item["artifact_id"],
            "version_id": item.get("version_id"),
            "version_number": item.get("version_number"),
            "artifact_kind": item["artifact_kind"],
            "title": item["title"],
            "topic": item["topic"],
            "content": item["content"],
        }
    return None
