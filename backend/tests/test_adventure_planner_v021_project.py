from __future__ import annotations

import asyncio

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from database.models import Base, ChatSession, User
from services.harvest_adventure import _build_planner_request


async def _database():
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    factory = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    async with factory() as db:
        first = User(username="planner-context-owner", password_hash="hash")
        second = User(username="planner-context-other", password_hash="hash")
        db.add_all([first, second])
        await db.commit()
        await db.refresh(first)
        await db.refresh(second)
        yield db, first.id, second.id
    await engine.dispose()


def test_build_request_reads_only_current_users_current_thread():
    async def run():
        async for db, owner_id, other_id in _database():
            thread_id = "workspace-planner-context"
            db.add_all(
                [
                    ChatSession(
                        user_id=owner_id,
                        thread_id=thread_id,
                        messages=[
                            {"role": "user", "content": "梯度为什么表示增长最快方向？"},
                            {"role": "assistant", "content": "可以从方向导数与点积的最大值理解。"},
                            {"role": "user", "content": "那为什么更新时要取负号？"},
                        ],
                        message_count=3,
                    ),
                    ChatSession(
                        user_id=other_id,
                        thread_id=thread_id,
                        messages=[
                            {"role": "user", "content": "另一个用户的私有内容不应被读取"},
                        ],
                        message_count=1,
                    ),
                ]
            )
            await db.commit()

            payload = await _build_planner_request(
                db,
                owner_id,
                "梯度下降",
                explicit_confusion="为什么参数更新要沿负梯度方向？",
                thread_id=thread_id,
            )
            turns = payload.get("recent_turns") or []
            assert 1 <= len(turns) <= 6
            assert sum(len(turn["content"]) for turn in turns) <= 4000
            assert any("增长最快" in turn["content"] for turn in turns)
            assert not any("另一个用户" in turn["content"] for turn in turns)

    asyncio.run(run())


def test_current_item_only_does_not_load_saved_history():
    async def run():
        async for db, owner_id, _other_id in _database():
            thread_id = "workspace-current-item-only"
            db.add(
                ChatSession(
                    user_id=owner_id,
                    thread_id=thread_id,
                    messages=[{"role": "user", "content": "这条历史不应进入计划"}],
                    message_count=1,
                )
            )
            await db.commit()

            payload = await _build_planner_request(
                db,
                owner_id,
                "当前代数题",
                explicit_confusion="只根据这道题，不要参考之前的对话",
                thread_id=thread_id,
            )
            assert payload["context_mode"] == "current_item_only"
            assert payload.get("recent_turns") in (None, [])

    asyncio.run(run())
