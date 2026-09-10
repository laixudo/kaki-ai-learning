from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from database.dependencies import get_db
from database.models import AnswerRecord, ExamPaper
from services.exam_service import (
    EXAM_TYPE_CONFIG,
    create_exam,
    get_exam,
    get_user_exams,
    submit_exam,
)
from services.profile_rules import apply as apply_profile_rules
from services.profile_service import load_existing_profile, save_answer_records, save_profile
from utils.auth import get_current_user_id, require_self

router = APIRouter(prefix="/api/exam", tags=["exam"])


class CreateExamRequest(BaseModel):
    user_id: int
    exam_type: str
    chapter_ids: List[str]
    difficulty: Optional[str] = None  # 全部 / 简单 / 中等 / 困难
    question_types: Optional[List[str]] = None  # 单选题 / 多选题 / 判断题 / 填空题 / 简答题 / 编程题
    count: Optional[int] = None  # 题目数量 30-80


class SubmitExamRequest(BaseModel):
    answers: List
    time_spent_sec: int = 0


@router.get("/types")
async def list_exam_types():
    return {
        "success": True,
        "data": {
            key: {"label": value["label"], "time_min": value["time_min"]}
            for key, value in EXAM_TYPE_CONFIG.items()
        },
    }


@router.post("/create")
async def api_create_exam(
    req: CreateExamRequest,
    current_user_id: int = Depends(get_current_user_id),
    db: AsyncSession = Depends(get_db),
):
    if req.user_id != current_user_id:
        raise HTTPException(status_code=403, detail="cannot create exam for another user")

    try:
        exam = await create_exam(
            db,
            req.user_id,
            req.exam_type,
            req.chapter_ids,
            difficulty=req.difficulty,
            question_types=req.question_types,
            count=req.count,
        )
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc))

    return {
        "success": True,
        "data": {
            "id": exam.id,
            "exam_type": exam.exam_type,
            "chapter_ids": exam.chapter_ids,
            "questions": exam.questions,
            "time_limit_min": exam.time_limit_min,
            "total_score": exam.total_score,
            "status": exam.status,
        },
    }


@router.get("/{exam_id}")
async def api_get_exam(
    exam_id: int,
    current_user_id: int = Depends(get_current_user_id),
    db: AsyncSession = Depends(get_db),
):
    exam = await get_exam(db, exam_id)
    if not exam or exam.user_id != current_user_id:
        raise HTTPException(404, "exam not found")

    response = {
        "id": exam.id,
        "exam_type": exam.exam_type,
        "chapter_ids": exam.chapter_ids,
        "questions": exam.questions,
        "time_limit_min": exam.time_limit_min,
        "total_score": exam.total_score,
        "status": exam.status,
    }
    if exam.status == "completed":
        response["answers"] = exam.answers
        response["score"] = exam.score
        response["time_spent_sec"] = exam.time_spent_sec
    return {"success": True, "data": response}


@router.post("/{exam_id}/submit")
async def api_submit_exam(
    exam_id: int,
    req: SubmitExamRequest,
    current_user_id: int = Depends(get_current_user_id),
    db: AsyncSession = Depends(get_db),
):
    owner = await db.execute(select(ExamPaper.user_id).where(ExamPaper.id == exam_id))
    exam_owner_id = owner.scalar_one_or_none()
    if exam_owner_id is None or exam_owner_id != current_user_id:
        raise HTTPException(404, "exam not found")

    result = await submit_exam(db, exam_id, req.answers, req.time_spent_sec)
    if "error" in result:
        raise HTTPException(404, result["error"])

    answers_with_topic = [
        {
            "question_id": str(item.get("question_id", "")),
            "topic": item.get("topic", ""),
            "correct": bool(item.get("correct", False)),
            "time_spent_sec": float(item.get("time_spent_sec", req.time_spent_sec or 0)),
        }
        for item in result.get("grading", [])
    ]
    await save_answer_records(db, current_user_id, answers_with_topic, "exam")

    existing = await load_existing_profile(db, current_user_id) or {}
    updated = apply_profile_rules(existing, answers_with_topic)
    await save_profile(db, current_user_id, {"profile_data": updated})
    result["profile_update"] = updated

    return {"success": True, "data": result}


@router.get("/list/{user_id}")
async def api_list_exams(
    user_id: int,
    current_user_id: int = Depends(get_current_user_id),
    exam_type: Optional[str] = None,
    db: AsyncSession = Depends(get_db),
):
    require_self(user_id, current_user_id)
    if user_id <= 0:
        raise HTTPException(status_code=400, detail="invalid user_id")

    exams = await get_user_exams(db, user_id, exam_type)
    return {
        "success": True,
        "data": [
            {
                "id": exam.id,
                "exam_type": exam.exam_type,
                "chapter_ids": exam.chapter_ids,
                "score": exam.score,
                "total_score": exam.total_score,
                "status": exam.status,
                "time_limit_min": exam.time_limit_min,
                "time_spent_sec": exam.time_spent_sec or 0,
                "question_count": len(exam.questions or []),
                "created_at": str(exam.created_at),
                "completed_at": str(exam.completed_at) if exam.completed_at else None,
            }
            for exam in exams
        ],
    }


@router.get("/wrong-questions/{user_id}")
async def api_wrong_questions(
    user_id: int,
    current_user_id: int = Depends(get_current_user_id),
    limit: int = 50,
    db: AsyncSession = Depends(get_db),
):
    require_self(user_id, current_user_id)
    result = await db.execute(
        select(AnswerRecord)
        .where(AnswerRecord.user_id == user_id, AnswerRecord.correct == False)
        .order_by(AnswerRecord.created_at.desc())
        .limit(limit)
    )
    records = result.scalars().all()

    by_topic = {}
    for record in records:
        topic = record.topic or "uncategorized"
        by_topic.setdefault(topic, []).append(
            {
                "question_id": record.question_id,
                "time_spent_sec": record.time_spent_sec,
                "source": record.source,
                "created_at": record.created_at.isoformat() if record.created_at else "",
            }
        )

    return {"success": True, "data": {"total": len(records), "by_topic": by_topic}}
