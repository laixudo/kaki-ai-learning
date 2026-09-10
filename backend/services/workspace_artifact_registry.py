"""Unified read model for workspace artifacts without duplicating their data."""
from __future__ import annotations

from datetime import datetime
from typing import Literal, Optional

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from database.models import ChatSession, ExamPaper, GeneratedItem, TutorSession


ArtifactScope = Literal["conversation", "tutor", "all"]

_GENERATED_KINDS = {
    "workspace_lecture": "lecture",
    "workspace_code": "code",
    "workspace_mindmap": "mindmap",
    "workspace_presentation": "presentation",
    "workspace_interactive_lesson": "interactive_lesson",
    "workspace_question": "question",
    "workspace_video": "video",
}
_FILTER_ALIASES = {
    "ppt": "presentation",
    "classroom": "interactive_lesson",
    "question": "exam",
}
_OPEN_ACTIONS = {
    "lecture": "open",
    "exam": "answer",
    "code": "inspect",
    "mindmap": "open",
    "presentation": "open",
    "interactive_lesson": "start",
    "question": "open",
    "video": "open",
}


def _normalise_filter(value: Optional[str]) -> str:
    selected = str(value or "all").strip().lower()
    return _FILTER_ALIASES.get(selected, selected)


def _message_exam_references(chats: list[ChatSession]) -> dict[int, dict]:
    references: dict[int, dict] = {}
    for chat in chats:
        for message in list(chat.messages or []):
            artifact = message.get("artifact") if isinstance(message, dict) else None
            if not isinstance(artifact, dict) or artifact.get("kind") not in {"exam", "exam_result"}:
                continue
            artifact_id = int(artifact.get("artifact_id") or 0)
            if artifact_id:
                references[artifact_id] = {
                    "thread_id": chat.thread_id,
                    "title": artifact.get("title"),
                    "kind": "exam",
                    "source_material_ids": list(artifact.get("source_material_ids") or []),
                }
    return references


async def list_artifact_summaries(
    db: AsyncSession,
    *,
    user_id: int,
    thread_id: Optional[str] = None,
    tutor_session_id: Optional[str] = None,
    scope: ArtifactScope = "conversation",
    artifact_type: Optional[str] = None,
    limit: int = 60,
) -> list[dict]:
    """Return one user-owned list across GeneratedItem and ExamPaper."""
    selected_kind = _normalise_filter(artifact_type)
    effective_thread_id = str(thread_id or "")
    if scope == "tutor" and tutor_session_id:
        tutor = (await db.execute(select(TutorSession).where(
            TutorSession.user_id == user_id,
            TutorSession.session_id == tutor_session_id,
        ))).scalar_one_or_none()
        if tutor is None:
            return []
        effective_thread_id = tutor.thread_id

    chats_query = select(ChatSession).where(ChatSession.user_id == user_id)
    if scope in {"conversation", "tutor"}:
        if not effective_thread_id:
            return []
        chats_query = chats_query.where(ChatSession.thread_id == effective_thread_id)
    chats = list((await db.execute(chats_query)).scalars().all())
    exam_references = _message_exam_references(chats)

    rows = list((await db.execute(select(GeneratedItem).where(
        GeneratedItem.user_id == user_id,
        GeneratedItem.type.in_(tuple(_GENERATED_KINDS)),
    ))).scalars().all())
    result: list[dict] = []
    for item in rows:
        metadata = dict(item.raw_data or {})
        kind = _GENERATED_KINDS[item.type]
        if scope == "conversation" and str(metadata.get("thread_id") or "") != effective_thread_id:
            continue
        if scope == "tutor" and str(metadata.get("tutor_session_id") or "") != str(tutor_session_id or ""):
            continue
        if selected_kind != "all" and selected_kind != kind:
            continue
        result.append({
            "artifact_id": item.id,
            "kind": kind,
            "type": item.type,
            "title": item.title,
            "summary": item.chapter or "",
            "thread_id": metadata.get("thread_id"),
            "tutor_session_id": metadata.get("tutor_session_id"),
            "graph_node_id": metadata.get("graph_node_id"),
            "version": int(metadata.get("version") or 1),
            "source_material_ids": list(metadata.get("source_material_ids") or []),
            "open_action": _OPEN_ACTIONS[kind],
            "source_table": "generated_items",
            "created_at": item.created_at,
        })

    if selected_kind in {"all", "exam"}:
        exams = list((await db.execute(select(ExamPaper).where(
            ExamPaper.user_id == user_id,
        ))).scalars().all())
        for exam in exams:
            reference = exam_references.get(exam.id)
            if scope in {"conversation", "tutor"} and reference is None:
                continue
            topics = [str(value).strip() for value in list(exam.chapter_ids or []) if str(value).strip()]
            topic = "、".join(topics[:2]) or "学习"
            result.append({
                "artifact_id": exam.id,
                "kind": "exam",
                "type": "workspace_exam",
                "title": (reference or {}).get("title") or f"{topic}练习题",
                "summary": f"{len(exam.questions or [])} 道题 · {exam.status}",
                "thread_id": (reference or {}).get("thread_id"),
                "tutor_session_id": tutor_session_id if scope == "tutor" else None,
                "graph_node_id": None,
                "version": 1,
                "source_material_ids": list((reference or {}).get("source_material_ids") or []),
                "open_action": _OPEN_ACTIONS["exam"],
                "source_table": "exam_papers",
                "created_at": exam.created_at,
            })

    result.sort(key=lambda row: row.get("created_at") or datetime.min, reverse=True)
    for row in result:
        row["created_at"] = str(row.get("created_at") or "")
    return result[:max(1, min(int(limit), 200))]
