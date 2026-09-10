import asyncio
import sys
from pathlib import Path

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from database.models import Base, GeneratedItem, User, WorkspaceLearningEvent
from services.harvest_adventure import (
    advance_adventure,
    equip_adventure_reward,
    get_adventure_rewards,
    get_current_adventure,
    start_adventure,
    unequip_adventure_reward,
)


async def _database():
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    factory = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    async with factory() as db:
        user = User(username="manyou-user", password_hash="hash")
        db.add(user)
        await db.commit()
        await db.refresh(user)
        yield db, user.id
    await engine.dispose()


async def _to_method(db, user_id, strategy):
    game = await start_adventure(db, user_id, "机器学习模型评估", "wood", ["path-node-ml"], "thread-demo", "learning_path")
    game = await advance_adventure(db, user_id, game["run_id"], "continue", {})
    game = await advance_adventure(db, user_id, game["run_id"], "continue", {})
    return await advance_adventure(db, user_id, game["run_id"], "choose_strategy", {"choice": strategy})


def test_understanding_route_records_review_remedy_three_stage_boss_and_idempotent_summary():
    async def run():
        async for db, user_id in _database():
            game = await _to_method(db, user_id, "understanding")
            assert len(game["nodes"]) == 8
            assert game["state"] == "TRIAL"
            run_id = game["run_id"]

            game = await advance_adventure(db, user_id, run_id, "submit", {"answer": "只要训练分数高就行"})
            assert game["state"] == "SUPPLY"
            assert game["feedback"]["kind"] == "needs_review"
            assert next(node for node in game["nodes"] if node["id"] == "TRIAL")["status"] == "needs_review"

            remedy_answer = game["content"]["remedy"]["options"][0]
            game = await advance_adventure(db, user_id, run_id, "submit", {"answer": remedy_answer})
            assert game["state"] == "INTERLEAVE"
            interleave_answer = game["content"]["understanding"]["interleave"]["options"][0]
            game = await advance_adventure(db, user_id, run_id, "submit", {"answer": interleave_answer})
            assert game["state"] == "INTERLEAVE"
            assert game["archive"]["boss_ready"] is True
            assert game["feedback"]["kind"] == "success"

            game = await advance_adventure(db, user_id, run_id, "continue", {})
            assert game["state"] == "BOSS"
            assert game["archive"]["boss_ready"] is False

            game = await advance_adventure(db, user_id, run_id, "submit", {"answer": "泛化能力是模型在未见新数据上的预测表现"})
            assert game["archive"]["boss_stage"] == 1
            game = await advance_adventure(db, user_id, run_id, "submit", {"answer": game["content"]["boss"][1]["options"][0]})
            assert game["archive"]["boss_stage"] == 2
            game = await advance_adventure(db, user_id, run_id, "submit", {"answer": "这是过拟合，我会使用早停来改善泛化"})
            assert game["state"] == "TREASURY"

            completed = await advance_adventure(db, user_id, run_id, "claim", {})
            repeated = await advance_adventure(db, user_id, run_id, "claim", {})
            assert completed["artifact_id"] == repeated["artifact_id"]
            assert completed["state"] == "completed"
            assert (await db.scalar(select(func.count()).select_from(GeneratedItem))) == 1
            assert (await db.scalar(select(func.count()).select_from(WorkspaceLearningEvent))) == 9
            item = (await db.execute(select(GeneratedItem))).scalar_one()
            assert item.type == "adventure_summary"
            assert "拾光漫游纪要" in item.title
            assert completed["reward"]["catalog_id"] == "adventure_summary"
            assert completed["reward"]["collected"] is True
            assert completed["reward"]["equipped"] is False
            rewards = await get_adventure_rewards(db, user_id)
            assert rewards["catalog_count"] == 1
            assert rewards["owned_count"] == 1
            assert rewards["equipped"] is None
            assert rewards["items"][0]["artifact_id"] == completed["artifact_id"]
            assert rewards["items"][0]["acquired_reason"] == "你完成了解释、回忆与迁移三重验证，并在证据不足后补全了关键一步。"

    asyncio.run(run())


def test_practice_route_uses_a_distinct_task_and_merges_at_boss():
    async def run():
        async for db, user_id in _database():
            game = await _to_method(db, user_id, "practice")
            assert game["content"]["practice"]["trial"]["question"] != game["content"]["understanding"]["trial"]["question"]
            answer = game["content"]["practice"]["trial"]["options"][0]
            game = await advance_adventure(db, user_id, game["run_id"], "submit", {"answer": answer})
            assert game["state"] == "SUPPLY"
            game = await advance_adventure(db, user_id, game["run_id"], "continue", {})
            assert game["state"] == "INTERLEAVE"
            game = await advance_adventure(db, user_id, game["run_id"], "submit", {"answer": "我会用正则化减少过拟合"})
            assert game["state"] == "INTERLEAVE"
            assert game["archive"]["boss_ready"] is True
            game = await advance_adventure(db, user_id, game["run_id"], "continue", {})
            assert game["state"] == "BOSS"
            assert game["archive"]["branch_choice"] == "practice"

    asyncio.run(run())


def test_current_endpoint_service_restores_only_an_active_run():
    async def run():
        async for db, user_id in _database():
            assert await get_current_adventure(db, user_id) is None
            created = await start_adventure(db, user_id, "Python 循环", "wind", [], "thread-restore", "current_conversation")
            restored = await get_current_adventure(db, user_id)
            assert restored and restored["run_id"] == created["run_id"]
            assert restored["archive"]["source_type"] == "current_conversation"

    asyncio.run(run())


def test_reward_equipping_requires_explicit_replace_and_supports_unequip_with_user_isolation():
    async def run():
        async for db, user_id in _database():
            other = User(username="manyou-other", password_hash="hash")
            db.add(other)
            await db.flush()
            first = GeneratedItem(
                user_id=user_id,
                type="adventure_summary",
                title="第一次 · 拾光漫游纪要",
                content="{}",
                raw_data={"run_id": "adv_first", "topic": "第一次"},
            )
            second = GeneratedItem(
                user_id=user_id,
                type="adventure_summary",
                title="第二次 · 拾光漫游纪要",
                content="{}",
                raw_data={"run_id": "adv_second", "topic": "第二次"},
            )
            foreign = GeneratedItem(
                user_id=other.id,
                type="adventure_summary",
                title="他人的 · 拾光漫游纪要",
                content="{}",
                raw_data={"run_id": "adv_foreign", "topic": "他人的"},
            )
            db.add_all([first, second, foreign])
            await db.commit()
            await db.refresh(first)
            await db.refresh(second)
            await db.refresh(foreign)

            equipped = await equip_adventure_reward(db, user_id, first.id, replace_confirmed=False)
            assert equipped["status"] == "equipped"
            assert equipped["equipped"]["artifact_id"] == first.id

            comparison = await equip_adventure_reward(db, user_id, second.id, replace_confirmed=False)
            assert comparison["status"] == "replace_required"
            assert comparison["current_equipped"]["artifact_id"] == first.id
            assert comparison["candidate"]["artifact_id"] == second.id
            unchanged = await get_adventure_rewards(db, user_id)
            assert unchanged["equipped"]["artifact_id"] == first.id

            replaced = await equip_adventure_reward(db, user_id, second.id, replace_confirmed=True)
            assert replaced["status"] == "equipped"
            assert replaced["equipped"]["artifact_id"] == second.id
            assert sum(item["equipped"] for item in replaced["items"]) == 1

            removed = await unequip_adventure_reward(db, user_id, second.id)
            assert removed["status"] == "unequipped"
            assert removed["equipped"] is None
            assert sum(item["equipped"] for item in removed["items"]) == 0

            try:
                await equip_adventure_reward(db, user_id, foreign.id, replace_confirmed=True)
            except PermissionError:
                pass
            else:
                raise AssertionError("foreign rewards must not be equipable")

    asyncio.run(run())
