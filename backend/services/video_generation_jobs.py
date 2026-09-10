"""Durable lifecycle stored on the one canonical workspace_video Artifact."""
from __future__ import annotations

from datetime import datetime
from pathlib import Path
from typing import Any, Iterable

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from database.models import GeneratedItem
from services.workspace_artifact_versions import ensure_initial_version


NONTERMINAL_STATES = {
    "queued", "generating_script", "generating_audio", "generating_avatar", "composing",
}
TERMINAL_STATES = {"ready", "failed"}
ALL_STATES = NONTERMINAL_STATES | TERMINAL_STATES
TRANSITIONS = {
    "queued": {"generating_script", "failed"},
    "generating_script": {"generating_audio", "failed"},
    "generating_audio": {"generating_avatar", "failed"},
    "generating_avatar": {"composing", "failed"},
    "composing": {"ready", "failed"},
    "failed": {"queued"},
    "ready": set(),
}


class VideoJobError(RuntimeError):
    code = "VIDEO_JOB_ERROR"


class VideoJobAccessError(VideoJobError):
    code = "VIDEO_JOB_NOT_FOUND"


class VideoJobTransitionError(VideoJobError):
    code = "VIDEO_JOB_INVALID_TRANSITION"


def _utcnow() -> datetime:
    return datetime.utcnow()


async def create_video_job(
    db: AsyncSession, *, user_id: int, thread_id: str, topic: str, duration_sec: int,
    provider: str, instruction: str = "", source_material_ids: Iterable[str] = (),
    source_context: str = "", source_citations: Iterable[dict[str, Any]] = (),
    style_context: dict[str, Any] | None = None,
    evidence_context: dict[str, Any] | None = None,
    task_id: str | None = None,
) -> GeneratedItem:
    clean_topic = str(topic or "").strip()
    if not clean_topic:
        raise ValueError("topic 不能为空")
    now = _utcnow().isoformat() + "Z"
    item = GeneratedItem(
        user_id=int(user_id), type="workspace_video", title=f"{clean_topic}教学视频"[:200],
        chapter=clean_topic[:120], content="",
        raw_data={
            "kind": "video", "status": "queued", "thread_id": str(thread_id),
            "topic": clean_topic, "duration_sec": int(duration_sec),
            "instruction": str(instruction or "")[:500],
            "provider": str(provider or "s2v"), "model": "", "dry_run": False,
            "source_material_ids": [str(value) for value in source_material_ids][:8],
            "source_context": str(source_context or "")[:12000],
            "source_citations": [dict(value) for value in source_citations][:20],
            "style_context": dict(style_context or {}),
            "evidence_context": dict(evidence_context or {}),
            "task_id": task_id, "created_at": now, "status_updated_at": now,
            "generation_provenance": "KAKI workspace -> internal Cloud Video adapter",
            "error_code": None, "safe_error": None, "video_path": None,
            "key_points": [], "version": 1,
        },
    )
    db.add(item)
    await db.commit()
    await db.refresh(item)
    return item


async def get_owned_video_job(
    db: AsyncSession, *, user_id: int, artifact_id: int,
) -> GeneratedItem:
    item = (await db.execute(select(GeneratedItem).where(
        GeneratedItem.id == int(artifact_id),
        GeneratedItem.user_id == int(user_id),
        GeneratedItem.type == "workspace_video",
    ))).scalar_one_or_none()
    if item is None:
        raise VideoJobAccessError("video artifact not found")
    return item


async def update_video_job_status(
    db: AsyncSession, *, user_id: int, artifact_id: int, status: str,
) -> GeneratedItem:
    if status not in ALL_STATES:
        raise VideoJobTransitionError(f"unknown video status: {status}")
    item = await get_owned_video_job(db, user_id=user_id, artifact_id=artifact_id)
    metadata = dict(item.raw_data or {})
    current = str(metadata.get("status") or "queued")
    if status != current and status not in TRANSITIONS.get(current, set()):
        raise VideoJobTransitionError(f"invalid video status transition: {current} -> {status}")
    metadata.update(status=status, status_updated_at=_utcnow().isoformat() + "Z")
    if status != "failed":
        metadata.update(error_code=None, safe_error=None)
    item.raw_data = metadata
    item.updated_at = _utcnow()
    await db.commit()
    await db.refresh(item)
    return item


async def fail_video_job(
    db: AsyncSession, *, user_id: int, artifact_id: int,
    error_code: str, safe_error: str,
) -> GeneratedItem:
    item = await get_owned_video_job(db, user_id=user_id, artifact_id=artifact_id)
    metadata = dict(item.raw_data or {})
    metadata.update(
        status="failed", error_code=str(error_code or "VIDEO_GENERATION_FAILED")[:80],
        safe_error=str(safe_error or "视频生成失败，请稍后重试。")[:400],
        status_updated_at=_utcnow().isoformat() + "Z", video_path=None,
    )
    item.raw_data = metadata
    item.updated_at = _utcnow()
    await db.commit()
    await db.refresh(item)
    return item


async def complete_video_job(
    db: AsyncSession, *, user_id: int, artifact_id: int, video_path: Path,
    script: str, key_points: Iterable[str], duration_sec: int,
    provider: str, model: str, dry_run: bool,
) -> GeneratedItem:
    item = await get_owned_video_job(db, user_id=user_id, artifact_id=artifact_id)
    metadata = dict(item.raw_data or {})
    current = str(metadata.get("status") or "queued")
    if current != "composing":
        raise VideoJobTransitionError(f"video can finish only from composing, got {current}")
    resolved = Path(video_path).resolve()
    if not resolved.exists() or resolved.stat().st_size <= 0:
        raise VideoJobError("video output is missing or empty")
    metadata.update(
        status="ready", status_updated_at=_utcnow().isoformat() + "Z",
        duration_sec=int(duration_sec), provider=str(provider), model=str(model),
        dry_run=bool(dry_run), video_path=str(resolved),
        video_url=f"/api/chat/tasks/videos/{item.id}/media",
        transcript=str(script or ""), key_points=[str(value)[:160] for value in key_points][:6],
        error_code=None, safe_error=None,
    )
    item.content = str(script or "")
    item.raw_data = metadata
    item.updated_at = _utcnow()
    await db.flush()
    await ensure_initial_version(db, item)
    await db.commit()
    await db.refresh(item)
    return item


async def retry_video_job(
    db: AsyncSession, *, user_id: int, artifact_id: int,
) -> GeneratedItem:
    return await update_video_job_status(
        db, user_id=user_id, artifact_id=artifact_id, status="queued",
    )


async def fail_interrupted_video_jobs(db: AsyncSession) -> int:
    rows = list((await db.execute(select(GeneratedItem).where(
        GeneratedItem.type == "workspace_video",
    ))).scalars())
    changed = 0
    now = _utcnow().isoformat() + "Z"
    for item in rows:
        metadata = dict(item.raw_data or {})
        if str(metadata.get("status") or "") not in NONTERMINAL_STATES:
            continue
        metadata.update(
            status="failed", error_code="INTERRUPTED_BY_RESTART",
            safe_error="服务重启中断了本次生成，可从原产物重试。",
            status_updated_at=now, video_path=None,
        )
        item.raw_data = metadata
        item.updated_at = _utcnow()
        changed += 1
    if changed:
        await db.commit()
    return changed


def project_video_job(item: GeneratedItem) -> dict[str, Any]:
    metadata = dict(item.raw_data or {})
    status = str(metadata.get("status") or "queued")
    stage_copy = {
        "queued": "视频任务已进入队列。",
        "generating_script": "正在生成教学讲稿。",
        "generating_audio": "正在合成讲解音频。",
        "generating_avatar": "正在生成柿小吉讲解画面，云端口型通常需要 1 到 4 分钟。",
        "composing": "正在合成最终教学视频。",
        "ready": (
            "本机讲解视频已经生成，可以打开播放。云端数字人仍需确认凭据后才会启用。"
            if metadata.get("dry_run") else
            "教学视频已经生成，可以打开播放并查看讲稿。"
        ),
        "failed": str(metadata.get("safe_error") or "视频生成失败，可以从同一产物重试。"),
    }
    return {
        "artifact_id": item.id,
        "artifact_version_id": item.current_version_id,
        "artifact_version_number": int(item.current_version_number or 0),
        "kind": "video", "type": "workspace_video", "title": item.title,
        "topic": item.chapter or metadata.get("topic") or "",
        "thread_id": metadata.get("thread_id"), "status": status,
        "summary": stage_copy.get(status, "视频任务状态已更新。"),
        "duration_sec": int(metadata.get("duration_sec") or 20),
        "video_url": metadata.get("video_url") if status == "ready" else None,
        "transcript": metadata.get("transcript") or item.content or "",
        "key_points": list(metadata.get("key_points") or []),
        "provider": metadata.get("provider") or "unknown",
        "model": metadata.get("model") or "",
        "dry_run": bool(metadata.get("dry_run", False)),
        "source_material_ids": list(metadata.get("source_material_ids") or []),
        "error_code": metadata.get("error_code") if status == "failed" else None,
        "safe_error": metadata.get("safe_error") if status == "failed" else None,
        "created_at": item.created_at.isoformat() if item.created_at else str(metadata.get("created_at") or ""),
        "updated_at": item.updated_at.isoformat() if item.updated_at else str(metadata.get("status_updated_at") or ""),
        "retryable": status == "failed",
    }


async def execute_video_job(*, artifact_id: int, user_id: int) -> None:
    """Run one queued job outside the request and persist every stage."""
    from config import settings as app_settings
    from database.connection import get_db_session
    from database.models import ChatSession, WorkspaceAgentTask
    from integrations.cloud_video.contracts import (
        EvidenceTeachingContext, StyleContext, VideoGenerationRequest,
    )
    from integrations.cloud_video.service import (
        CloudVideoService, CloudVideoServiceBlocked, CloudVideoServiceError,
    )
    from integrations.cloud_video.settings import CloudVideoSettings
    from services.workspace_agents import build_thread_artifact_message
    from services.workspace_runtime import complete_runtime_operation, fail_runtime_operation

    async with get_db_session() as db:
        try:
            item = await get_owned_video_job(db, user_id=user_id, artifact_id=artifact_id)
        except VideoJobAccessError:
            return
        metadata = dict(item.raw_data or {})
        request = VideoGenerationRequest(
            topic=str(metadata.get("topic") or item.chapter or ""),
            user_id=user_id,
            thread_id=str(metadata.get("thread_id") or ""),
            duration_sec=max(15, min(int(metadata.get("duration_sec") or 20), 20)),
            provider=str(metadata.get("provider") or "s2v"),
            instruction=str(metadata.get("instruction") or ""),
            source_context=str(metadata.get("source_context") or ""),
            style_context=StyleContext.model_validate(metadata.get("style_context") or {}),
            evidence_context=EvidenceTeachingContext.model_validate(metadata.get("evidence_context") or {}),
        )
        task_id = str(metadata.get("task_id") or "")

    async def on_stage(status: str) -> None:
        async with get_db_session() as stage_db:
            await update_video_job_status(
                stage_db, user_id=user_id, artifact_id=artifact_id, status=status,
            )

    service = CloudVideoService(CloudVideoSettings.from_app_settings(app_settings))
    try:
        result = await service.generate(request, on_stage=on_stage)
        async with get_db_session() as db:
            item = await complete_video_job(
                db, user_id=user_id, artifact_id=artifact_id,
                video_path=Path(result["video_path"]), script=str(result["script"]),
                key_points=list(result.get("key_points") or []),
                duration_sec=int(round(float(result.get("duration_sec") or request.duration_sec))),
                provider=str(result.get("provider") or request.provider),
                model=str(result.get("model") or "unknown"),
                dry_run=bool(result.get("dry_run")),
            )
            if task_id:
                task = (await db.execute(select(WorkspaceAgentTask).where(
                    WorkspaceAgentTask.task_id == task_id,
                    WorkspaceAgentTask.user_id == user_id,
                ))).scalar_one_or_none()
                if task:
                    task.state = "completed"; task.artifact_id = artifact_id; task.error_code = None
            chat = (await db.execute(select(ChatSession).where(
                ChatSession.user_id == user_id,
                ChatSession.thread_id == request.thread_id,
            ))).scalar_one_or_none()
            if chat:
                message = build_thread_artifact_message(
                    request.thread_id, "video", artifact_id, item.title,
                    f"《{item.title}》已经生成，可以打开播放并查看讲稿。",
                )
                message["artifact"].update(project_video_job(item))
                messages = list(chat.messages or []); messages.append(message)
                chat.messages = messages; chat.message_count = len(messages)
            await db.commit()
        complete_runtime_operation(user_id, request.thread_id)
    except (CloudVideoServiceBlocked, CloudVideoServiceError) as exc:
        error_code = str(getattr(exc, "code", "CLOUD_VIDEO_FAILED"))[:80]
        safe_error = str(exc)[:400]
        cloud_settings = CloudVideoSettings.from_app_settings(app_settings)
        for secret in (cloud_settings.dashscope_api_key, cloud_settings.llm_api_key):
            if secret:
                safe_error = safe_error.replace(secret, "[REDACTED]")
        async with get_db_session() as db:
            await fail_video_job(
                db, user_id=user_id, artifact_id=artifact_id,
                error_code=error_code, safe_error=safe_error,
            )
            if task_id:
                task = (await db.execute(select(WorkspaceAgentTask).where(
                    WorkspaceAgentTask.task_id == task_id,
                    WorkspaceAgentTask.user_id == user_id,
                ))).scalar_one_or_none()
                if task:
                    task.state = "failed"; task.error_code = error_code
            await db.commit()
        fail_runtime_operation(user_id, request.thread_id, error_code)
    except Exception:
        async with get_db_session() as db:
            await fail_video_job(
                db, user_id=user_id, artifact_id=artifact_id,
                error_code="CLOUD_VIDEO_FAILED",
                safe_error="视频生成失败，未创建假视频；可以从原产物重试。",
            )
        fail_runtime_operation(user_id, request.thread_id, "CLOUD_VIDEO_FAILED")
