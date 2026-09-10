from pathlib import Path

import pytest
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from database.models import Base, GeneratedItem, User
from services.video_generation_jobs import (
    VideoJobAccessError,
    complete_video_job,
    create_video_job,
    fail_interrupted_video_jobs,
    fail_video_job,
    get_owned_video_job,
    project_video_job,
    update_video_job_status,
)


async def database(path: Path):
    engine = create_async_engine(f"sqlite+aiosqlite:///{path}")
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    factory = async_sessionmaker(engine, expire_on_commit=False)
    async with factory() as db:
        db.add_all([
            User(id=1, username="video_a", password_hash="synthetic"),
            User(id=2, username="video_b", password_hash="synthetic"),
        ])
        await db.commit()
    return engine, factory


@pytest.mark.asyncio
async def test_job_uses_one_owner_bound_artifact_for_all_stages(tmp_path: Path):
    engine, factory = await database(tmp_path / "jobs.db")
    async with factory() as db:
        item = await create_video_job(
            db, user_id=1, thread_id="thread-a", topic="勾股定理", duration_sec=20,
            instruction="用几何图形解释", source_material_ids=["m1"], provider="s2v",
            source_context="仅供服务端生成使用的材料正文",
            source_citations=[{"material_id": "m1", "chunk_id": "c1"}],
        )
        artifact_id = item.id
        queued = project_video_job(item)
        assert queued["status"] == "queued"
        assert queued["summary"]
        assert "source_context" not in queued
        assert item.raw_data["source_context"] == "仅供服务端生成使用的材料正文"
        for status in ("generating_script", "generating_audio", "generating_avatar", "composing"):
            item = await update_video_job_status(db, user_id=1, artifact_id=artifact_id, status=status)
            assert item.id == artifact_id
            assert project_video_job(item)["status"] == status
        video = tmp_path / "owner.mp4"
        video.write_bytes(b"real-file-placeholder-for-unit-test")
        ready = await complete_video_job(
            db, user_id=1, artifact_id=artifact_id, video_path=video,
            script="这是一个足够长且来自受控测试生成器的讲稿内容。",
            key_points=["直角三角形", "平方关系"], duration_sec=20,
            provider="s2v", model="wan2.2-s2v", dry_run=False,
        )
        assert ready.id == artifact_id
        assert project_video_job(ready)["status"] == "ready"
        count = await db.scalar(select(func.count(GeneratedItem.id)).where(GeneratedItem.user_id == 1))
        assert count == 1
        assert ready.current_version_number == 1
    await engine.dispose()


@pytest.mark.asyncio
async def test_cross_user_lookup_is_hidden_and_failure_is_persistent(tmp_path: Path):
    engine, factory = await database(tmp_path / "isolation.db")
    async with factory() as db:
        item = await create_video_job(
            db, user_id=1, thread_id="thread-a", topic="二次函数", duration_sec=20,
            provider="s2v",
        )
        with pytest.raises(VideoJobAccessError):
            await get_owned_video_job(db, user_id=2, artifact_id=item.id)
        failed = await fail_video_job(
            db, user_id=1, artifact_id=item.id,
            error_code="BLOCKED_BY_SECRET", safe_error="需要轮换后的本机凭据。",
        )
        payload = project_video_job(failed)
        assert payload["status"] == "failed"
        assert payload["error_code"] == "BLOCKED_BY_SECRET"
        assert "api_key" not in str(payload).lower()
    async with factory() as restarted:
        restored = await get_owned_video_job(restarted, user_id=1, artifact_id=item.id)
        assert project_video_job(restored)["status"] == "failed"
    await engine.dispose()


@pytest.mark.asyncio
async def test_restart_reconciliation_marks_nonterminal_jobs_failed(tmp_path: Path):
    engine, factory = await database(tmp_path / "restart.db")
    async with factory() as db:
        first = await create_video_job(db, user_id=1, thread_id="t", topic="极限", duration_sec=20, provider="s2v")
        second = await create_video_job(db, user_id=1, thread_id="t", topic="导数", duration_sec=20, provider="s2v")
        await update_video_job_status(db, user_id=1, artifact_id=second.id, status="generating_script")
        await update_video_job_status(db, user_id=1, artifact_id=second.id, status="generating_audio")
        changed = await fail_interrupted_video_jobs(db)
        assert changed == 2
    async with factory() as restarted:
        for artifact_id in (first.id, second.id):
            item = await get_owned_video_job(restarted, user_id=1, artifact_id=artifact_id)
            payload = project_video_job(item)
            assert payload["status"] == "failed"
            assert payload["error_code"] == "INTERRUPTED_BY_RESTART"
    await engine.dispose()
