import asyncio
import sys
from pathlib import Path

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from database.models import Base, User, UserMemory
from services.memory_service import (
    detect_memory_candidate,
    persist_memory_action,
    resolve_memory_action_candidates,
)


def test_natural_request_for_more_concise_speech_creates_a_confirmable_candidate():
    candidate = detect_memory_candidate("我想要你说话更简洁", "thread-memory", "message-1")
    assert candidate is not None
    assert candidate["key"] == "response_style"
    assert candidate["value"] == "concise"
    assert candidate["authorization"] == "confirm"


def test_remembered_question_resolves_the_latest_user_preference_not_only_the_assistant_paraphrase():
    candidates = resolve_memory_action_candidates(
        "记住了吗",
        [
            {"id": "message-1", "role": "user", "content": "我想要你说话更简洁"},
            {"id": "message-2", "role": "assistant", "content": "好的，明白了。以后我会尽量简洁回答。"},
        ],
        "thread-memory",
        "message-3",
    )
    assert len(candidates) == 1
    assert candidates[0]["key"] == "response_style"
    assert candidates[0]["value"] == "concise"
    assert candidates[0]["evidence_text"] == "我想要你说话更简洁"


def test_remembered_question_persists_then_confirms_the_actual_saved_value():
    async def run():
        engine = create_async_engine("sqlite+aiosqlite:///:memory:")
        async with engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)
        factory = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
        async with factory() as db:
            user = User(username="memory-regression-user", password_hash="hash")
            db.add(user)
            await db.commit()
            await db.refresh(user)
            result = await persist_memory_action(
                db, user.id, "记住了吗",
                [
                    {"id": "message-1", "role": "user", "content": "我想要你说话更简洁"},
                    {"id": "message-2", "role": "assistant", "content": "好的，明白了。以后我会尽量简洁回答。"},
                ],
                "thread-memory", "message-3",
            )
            assert result is not None
            assert result["confirmation"] == "记住了：交流时偏好简短直接的回答。"
            item = (await db.execute(select(UserMemory))).scalar_one()
            assert item.key == "response_style"
            assert item.value == "concise"
            assert item.status == "confirmed"
        await engine.dispose()

    asyncio.run(run())
