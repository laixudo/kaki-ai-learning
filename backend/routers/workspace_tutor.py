"""Authenticated graph-driven tutor sessions and artifact collection."""

import logging
from typing import Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from database.dependencies import get_db
from database.models import ChatSession, GeneratedItem, TutorSession, WorkspaceLearningEvent
from services.tutor_orchestrator import (
    DEFAULT_GRAPH_CATALOG,
    ensure_tutor_plan_alignment,
    record_tutor_event,
    start_tutor_session,
    tutor_plan_payload,
)
from services.learning_evaluator_integration import auto_consume_exam_submission_event
from services.tutor_core import (
    decide_tutor_action,
    prepare_tutor_decision_task,
    resolve_tutor_context,
    task_public_payload,
    latest_tutor_task_public,
    tutor_user_projection,
)
from services.workspace_artifact_registry import list_artifact_summaries
from utils.auth import get_current_user_id

router = APIRouter(prefix="/api/chat", tags=["workspace-tutor"])
catalog = DEFAULT_GRAPH_CATALOG
logger = logging.getLogger(__name__)


class ConversationModeRequest(BaseModel):
    mode: Literal["assistant", "tutor"]


class TutorStartRequest(BaseModel):
    thread_id: str = Field(min_length=4, max_length=100)
    goal: str = Field(min_length=2, max_length=300)
    duration_days: int = Field(default=3, ge=1, le=180)
    daily_minutes: int = Field(default=40, ge=10, le=480)


class TutorEventRequest(BaseModel):
    event_type: Literal["lesson_completed", "quiz_completed", "resource_opened"]
    payload: dict = Field(default_factory=dict)


class TutorNextActionRequest(BaseModel):
    message: str = Field(default="开始", min_length=1, max_length=300)
    active_artifact_id: Optional[int] = None
    material_ids: list[str] = Field(default_factory=list)


async def _owned_chat(db: AsyncSession, user_id: int, thread_id: str) -> ChatSession:
    chat = (await db.execute(select(ChatSession).where(
        ChatSession.user_id == user_id, ChatSession.thread_id == thread_id,
    ))).scalar_one_or_none()
    if chat is None:
        raise HTTPException(status_code=404, detail="会话不存在。")
    return chat


async def _refresh_tutor_decision(
    db: AsyncSession,
    *,
    session: TutorSession,
    user_id: int,
    message: str = "",
    active_artifact_id: int | None = None,
    material_ids: list[str] | None = None,
):
    context = await resolve_tutor_context(
        db,
        user_id=user_id,
        thread_id=session.thread_id,
        session=session,
        active_artifact_id=active_artifact_id,
        requested_material_ids=material_ids or (),
    )
    decision = decide_tutor_action(context, message)
    session.next_action = decision.public_payload()
    await db.commit()
    await db.refresh(session)
    return session, context, decision




async def _attach_user_facing_projection(
    db: AsyncSession, *, session: TutorSession, user_id: int, context, decision, data: dict,
) -> dict:
    task = await latest_tutor_task_public(
        db, user_id=user_id, thread_id=session.thread_id, tutor_session_id=session.session_id,
    )
    data["tutor_task"] = task
    data["tutor_public"] = tutor_user_projection(context=context, decision=decision, task=task)
    return data


def _workspace_event_id(ref: object) -> int | None:
    text = str(ref or "").strip()
    if text.isdigit():
        return int(text)
    for prefix in ("workspace-event:", "workspace-event-"):
        if text.startswith(prefix) and text[len(prefix):].isdigit():
            return int(text[len(prefix):])
    return None


async def _attempt_pending_exam_evaluation_recovery(
    db: AsyncSession, *, session: TutorSession, user_id: int, context,
) -> dict:
    """Bounded write-path retry for one durable exam evidence event.

    Reads never call this helper.  The authoritative exam/event already exists;
    this only gives the existing Evaluator one later chance to consume the exact
    same server-owned event when the user explicitly returns through next-action.
    """
    evidence = dict(context.evidence_status or {})
    if evidence.get("state") != "evidence_pending":
        return {"attempted": False, "evaluation_status": "not_needed", "workspace_event_id": None}

    pending_ids = [
        event_id for event_id in (_workspace_event_id(ref) for ref in evidence.get("pending_event_refs") or [])
        if event_id is not None
    ]
    if not pending_ids:
        return {"attempted": False, "evaluation_status": "no_pending_exam", "workspace_event_id": None}

    graph_refs = {str((context.graph or {}).get("id") or ""), str((context.graph or {}).get("external_id") or "")} - {""}
    node_refs = {str((context.node or {}).get("id") or ""), str((context.node or {}).get("external_id") or "")} - {""}
    rows = list((await db.execute(
        select(WorkspaceLearningEvent).where(
            WorkspaceLearningEvent.id.in_(pending_ids),
            WorkspaceLearningEvent.user_id == user_id,
            WorkspaceLearningEvent.thread_id == session.thread_id,
            WorkspaceLearningEvent.event_type == "exam_submitted",
        ).order_by(WorkspaceLearningEvent.id.desc())
    )).scalars().all())

    target = None
    for row in rows:
        payload = dict(row.payload or {})
        event_graph = str(payload.get("graph_id") or "")
        event_node = str(payload.get("graph_node_external_id") or payload.get("graph_node_id") or "")
        if graph_refs and event_graph not in graph_refs:
            continue
        if node_refs and event_node not in node_refs:
            continue
        target = row
        break
    if target is None:
        return {"attempted": False, "evaluation_status": "no_matching_pending_exam", "workspace_event_id": None}

    try:
        result = await auto_consume_exam_submission_event(
            db, user_id=user_id, workspace_event_id=int(target.id),
        )
        return {
            "attempted": True,
            "evaluation_status": str(result.get("evaluation_status") or "evaluated"),
            "evaluation_revision": result.get("evaluation_revision"),
            "workspace_event_id": int(target.id),
            "idempotent_replay": bool(result.get("idempotent_replay")),
        }
    except Exception as exc:
        # The exam/event are already durable.  A later evaluator conflict or
        # outage must remain conservative and must not create another task.
        logger.info(
            "tutor pending exam recovery remains pending user=%s session=%s event=%s type=%s",
            user_id, session.session_id, target.id, type(exc).__name__,
        )
        return {
            "attempted": True,
            "evaluation_status": "evaluation_pending",
            "evaluation_revision": None,
            "workspace_event_id": int(target.id),
            "error_type": type(exc).__name__,
        }

@router.patch("/conversations/{thread_id}/mode")
async def set_conversation_mode(thread_id: str, request: ConversationModeRequest,
    current_user_id: int = Depends(get_current_user_id), db: AsyncSession = Depends(get_db)):
    chat = await _owned_chat(db, current_user_id, thread_id)
    chat.mode = request.mode
    await db.commit()
    return {"success": True, "data": {"thread_id": thread_id, "mode": chat.mode}}


@router.post("/tutor/sessions")
async def create_tutor_session(request: TutorStartRequest,
    current_user_id: int = Depends(get_current_user_id), db: AsyncSession = Depends(get_db)):
    await _owned_chat(db, current_user_id, request.thread_id)
    session = await start_tutor_session(
        db, catalog=catalog, user_id=current_user_id, thread_id=request.thread_id,
        goal=request.goal, duration_days=request.duration_days, daily_minutes=request.daily_minutes,
    )
    try:
        session, context, decision = await _refresh_tutor_decision(
            db, session=session, user_id=current_user_id,
        )
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc
    data = tutor_plan_payload(session)
    data["tutor_context"] = context.public_payload()
    data["tutor_decision"] = decision.public_payload()
    data = await _attach_user_facing_projection(
        db, session=session, user_id=current_user_id, context=context, decision=decision, data=data,
    )
    return {"success": True, "data": data}


@router.get("/tutor/sessions/current")
async def get_current_tutor_session(thread_id: str = Query(min_length=4, max_length=100),
    current_user_id: int = Depends(get_current_user_id), db: AsyncSession = Depends(get_db)):
    session = (await db.execute(select(TutorSession).where(
        TutorSession.user_id == current_user_id, TutorSession.thread_id == thread_id,
    ))).scalar_one_or_none()
    if session is not None:
        session = await ensure_tutor_plan_alignment(db, catalog=catalog, session=session)
        try:
            session, context, decision = await _refresh_tutor_decision(
                db, session=session, user_id=current_user_id,
            )
        except PermissionError as exc:
            raise HTTPException(status_code=403, detail=str(exc)) from exc
        data = tutor_plan_payload(session)
        data["tutor_context"] = context.public_payload()
        data["tutor_decision"] = decision.public_payload()
        data = await _attach_user_facing_projection(
            db, session=session, user_id=current_user_id, context=context, decision=decision, data=data,
        )
        return {"success": True, "data": data}
    return {"success": True, "data": None}


@router.post("/tutor/sessions/{session_id}/events")
async def create_tutor_event(session_id: str, request: TutorEventRequest,
    current_user_id: int = Depends(get_current_user_id), db: AsyncSession = Depends(get_db)):
    session = (await db.execute(select(TutorSession).where(
        TutorSession.session_id == session_id, TutorSession.user_id == current_user_id,
    ))).scalar_one_or_none()
    if session is None:
        raise HTTPException(status_code=404, detail="导师计划不存在。")
    try:
        session = await record_tutor_event(db, session=session, event_type=request.event_type, payload=request.payload)
        session, context, decision = await _refresh_tutor_decision(
            db, session=session, user_id=current_user_id,
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc
    data = tutor_plan_payload(session)
    data["tutor_context"] = context.public_payload()
    data["tutor_decision"] = decision.public_payload()
    data = await _attach_user_facing_projection(
        db, session=session, user_id=current_user_id, context=context, decision=decision, data=data,
    )
    return {"success": True, "data": data}


@router.post("/tutor/sessions/{session_id}/next-action")
async def prepare_tutor_next_action(session_id: str, request: TutorNextActionRequest,
    current_user_id: int = Depends(get_current_user_id), db: AsyncSession = Depends(get_db)):
    session = (await db.execute(select(TutorSession).where(
        TutorSession.session_id == session_id, TutorSession.user_id == current_user_id,
    ))).scalar_one_or_none()
    if session is None:
        raise HTTPException(status_code=404, detail="导师计划不存在。")
    session = await ensure_tutor_plan_alignment(db, catalog=catalog, session=session)
    try:
        session, context, decision = await _refresh_tutor_decision(
            db,
            session=session,
            user_id=current_user_id,
            message=request.message,
            active_artifact_id=request.active_artifact_id,
            material_ids=request.material_ids,
        )
        recovery = await _attempt_pending_exam_evaluation_recovery(
            db, session=session, user_id=current_user_id, context=context,
        )
        if recovery.get("evaluation_status") == "evaluated":
            session, context, decision = await _refresh_tutor_decision(
                db,
                session=session,
                user_id=current_user_id,
                message=request.message,
                active_artifact_id=request.active_artifact_id,
                material_ids=request.material_ids,
            )

        if (context.evidence_status or {}).get("state") == "evidence_pending":
            data = {
                "task_id": None,
                "task_version": None,
                "version": None,
                "kind": "tutor_recovery",
                "agent_type": None,
                "state": "evidence_pending",
                "status": "evidence_pending",
                "artifact_id": None,
                "error_code": None,
                "recovery_only": True,
                "evaluation_recovery": recovery,
            }
            data["tutor_context"] = context.public_payload()
            data["tutor_decision"] = decision.public_payload()
            data = await _attach_user_facing_projection(
                db, session=session, user_id=current_user_id, context=context, decision=decision, data=data,
            )
            return {"success": True, "data": data}

        task, runtime = await prepare_tutor_decision_task(
            db, session=session, context=context, decision=decision,
        )
        runtime["evaluation_recovery"] = recovery
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    data = task_public_payload(task, runtime)
    data["tutor_context"] = context.public_payload()
    data["tutor_decision"] = decision.public_payload()
    data = await _attach_user_facing_projection(
        db, session=session, user_id=current_user_id, context=context, decision=decision, data=data,
    )
    return {"success": True, "data": data}


@router.get("/artifacts")
async def list_workspace_artifacts(thread_id: Optional[str] = None, tutor_session_id: Optional[str] = None,
    scope: Literal["conversation", "tutor", "all"] = "conversation", artifact_type: Optional[str] = None,
    current_user_id: int = Depends(get_current_user_id), db: AsyncSession = Depends(get_db)):
    result = await list_artifact_summaries(
        db,
        user_id=current_user_id,
        thread_id=thread_id,
        tutor_session_id=tutor_session_id,
        scope=scope,
        artifact_type=artifact_type,
    )
    return {"success": True, "data": result}
