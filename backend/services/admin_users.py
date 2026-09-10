"""管理端用户查询与状态管理服务"""
from datetime import datetime, timedelta
from typing import Optional, List
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func, and_, desc, asc

from database.models import (
    User, StudentProfile, ChatSession, AgentInvocation,
    GeneratedItem, WorkspaceMaterial
)
from services.admin_privacy import mask_email, safe_agent_label


async def list_users(
    db: AsyncSession,
    page: int = 1,
    page_size: int = 20,
    keyword: Optional[str] = None,
    status_filter: Optional[str] = None,
    profile_filter: Optional[str] = None,
    sort_by: str = "created_at",
    sort_order: str = "desc",
) -> tuple[List[dict], int]:
    conditions = []
    if keyword:
        conditions.append(User.username.contains(keyword))
    if status_filter == "active":
        conditions.append(User.is_active == True)
    elif status_filter == "disabled":
        conditions.append(User.is_active == False)
    if profile_filter == "has_profile":
        conditions.append(User.profile.has())
    elif profile_filter == "no_profile":
        conditions.append(~User.profile.has())

    count_q = select(func.count(User.id))
    if conditions:
        count_q = count_q.where(and_(*conditions))
    total_r = await db.execute(count_q)
    total = total_r.scalar() or 0

    sort_col = User.created_at
    if sort_by == "last_active_at":
        sort_col = User.updated_at
    elif sort_by == "username":
        sort_col = User.username

    order_fn = desc(sort_col) if sort_order == "desc" else asc(sort_col)

    q = select(User).order_by(order_fn)
    if conditions:
        q = q.where(and_(*conditions))
    q = q.offset((page - 1) * page_size).limit(page_size)
    users_r = await db.execute(q)
    users = users_r.scalars().all()

    user_ids = [u.id for u in users]

    profile_counts = {}
    if user_ids:
        profile_rows = (await db.execute(
            select(StudentProfile.user_id).where(StudentProfile.user_id.in_(user_ids))
        )).all()
        profile_set = {r[0] for r in profile_rows}
        for uid in user_ids:
            profile_counts[uid] = uid in profile_set

    chat_counts = {}
    if user_ids:
        chat_rows = (await db.execute(
            select(ChatSession.user_id, func.count(ChatSession.id))
            .where(ChatSession.user_id.in_(user_ids))
            .group_by(ChatSession.user_id)
        )).all()
        chat_counts = {r[0]: r[1] for r in chat_rows}

    task_counts = {}
    if user_ids:
        task_rows = (await db.execute(
            select(AgentInvocation.user_id, func.count(AgentInvocation.id))
            .where(AgentInvocation.user_id.in_(user_ids))
            .group_by(AgentInvocation.user_id)
        )).all()
        task_counts = {r[0]: r[1] for r in task_rows}

    item_counts = {}
    if user_ids:
        item_rows = (await db.execute(
            select(GeneratedItem.user_id, func.count(GeneratedItem.id))
            .where(GeneratedItem.user_id.in_(user_ids))
            .group_by(GeneratedItem.user_id)
        )).all()
        item_counts = {r[0]: r[1] for r in item_rows}

    items = []
    for u in users:
        has_p = profile_counts.get(u.id, False)
        items.append({
            "user_id": u.id,
            "username": u.username,
            "is_active": u.is_active,
            "has_profile": has_p,
            "profile_completeness": None,
            "created_at": u.created_at.isoformat() if u.created_at else None,
            "last_active_at": u.updated_at.isoformat() if u.updated_at else None,
            "chat_count": chat_counts.get(u.id, 0),
            "task_count": task_counts.get(u.id, 0),
            "item_count": item_counts.get(u.id, 0),
        })

    return items, total


async def get_user_detail(db: AsyncSession, user_id: int) -> Optional[dict]:
    u_r = await db.execute(select(User).where(User.id == user_id))
    user = u_r.scalar_one_or_none()
    if not user:
        return None

    # Admin only needs existence; never hydrate profile content.
    p_r = await db.execute(select(func.count(StudentProfile.id)).where(StudentProfile.user_id == user_id))
    has_profile = bool(p_r.scalar() or 0)

    chat_r = await db.execute(
        select(func.count(ChatSession.id)).where(ChatSession.user_id == user_id)
    )
    chat_count = chat_r.scalar() or 0

    task_r = await db.execute(
        select(func.count(AgentInvocation.id)).where(AgentInvocation.user_id == user_id)
    )
    task_count = task_r.scalar() or 0

    success_r = await db.execute(
        select(func.count(AgentInvocation.id)).where(
            and_(AgentInvocation.user_id == user_id, AgentInvocation.status == "success")
        )
    )
    success_tasks = success_r.scalar() or 0

    failed_r = await db.execute(
        select(func.count(AgentInvocation.id)).where(
            and_(AgentInvocation.user_id == user_id, AgentInvocation.status == "failed")
        )
    )
    failed_tasks = failed_r.scalar() or 0

    item_r = await db.execute(
        select(func.count(GeneratedItem.id)).where(GeneratedItem.user_id == user_id)
    )
    item_count = item_r.scalar() or 0

    material_r = await db.execute(
        select(func.count(WorkspaceMaterial.id)).where(WorkspaceMaterial.user_id == user_id)
    )
    material_count = material_r.scalar() or 0

    timeline = []
    recent_tasks = (await db.execute(
        select(
            AgentInvocation.agent_name,
            AgentInvocation.output_type,
            AgentInvocation.status,
            AgentInvocation.created_at,
        ).where(AgentInvocation.user_id == user_id)
        .order_by(AgentInvocation.created_at.desc()).limit(10)
    )).all()
    for t in recent_tasks:
        timeline.append({
            "event_type": f"agent_{t.status}",
            "event_label": f"{safe_agent_label(t.agent_name, t.output_type)} · {t.status}",
            "time": t.created_at.isoformat() if t.created_at else None,
        })

    recent_sessions = (await db.execute(
        select(ChatSession.created_at).where(ChatSession.user_id == user_id)
        .order_by(ChatSession.created_at.desc()).limit(5)
    )).scalars().all()
    for created_at in recent_sessions:
        timeline.append({
            "event_type": "chat_session",
            "event_label": "发生 AI 会话",
            "time": created_at.isoformat() if created_at else None,
        })

    timeline.sort(key=lambda x: x["time"] or "", reverse=True)
    timeline = timeline[:15]

    return {
        "user_id": user.id,
        "username": user.username,
        "email": mask_email(user.email),
        "is_active": user.is_active,
        "created_at": user.created_at.isoformat() if user.created_at else None,
        "last_active_at": user.updated_at.isoformat() if user.updated_at else None,
        "has_profile": has_profile,
        "profile_completeness": None,
        "chat_count": chat_count,
        "task_count": task_count,
        "success_tasks": success_tasks,
        "failed_tasks": failed_tasks,
        "item_count": item_count,
        "material_count": material_count,
        "activity_timeline": timeline,
    }


async def set_user_status(db: AsyncSession, user_id: int, is_active: bool) -> bool:
    u_r = await db.execute(select(User).where(User.id == user_id))
    user = u_r.scalar_one_or_none()
    if not user:
        return False
    user.is_active = is_active
    user.updated_at = datetime.utcnow()
    await db.commit()
    return True
