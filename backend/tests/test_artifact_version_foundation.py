from __future__ import annotations

import asyncio
from pathlib import Path

import pytest
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from database.models import Base, GeneratedItem, GeneratedItemVersion, User
from services.workspace_artifact_versions import (
    ArtifactOperationConflict,
    ArtifactVersionConflict,
    ArtifactVersionNotFound,
    build_public_projection,
    compare_versions,
    create_new_version,
    ensure_initial_version,
)
from services.workspace_references import (
    ReferenceAccessError,
    attach_trusted_selection_context,
    build_reference_question_context,
    resolve_workspace_references,
)


async def make_database(path: Path):
    engine = create_async_engine(f"sqlite+aiosqlite:///{path}")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    factory = async_sessionmaker(engine, expire_on_commit=False)
    async with factory() as db:
        db.add_all([
            User(id=1, username="user_a", password_hash="synthetic"),
            User(id=2, username="user_b", password_hash="synthetic"),
        ])
        item = GeneratedItem(
            id=101,
            user_id=1,
            type="workspace_lecture",
            title="学习率与震荡",
            chapter="梯度下降",
            content="# v1\n\n学习率决定每一步的步幅。\n\n## 易错点\n不要把震荡误认为进程失败。",
            raw_data={
                "thread_id": "thread-a",
                "kind": "lecture",
                "graph_id": "graph-a",
                "graph_node_external_id": "node-step-size",
                "graph_node_title": "学习率决定步幅",
                "resource_plan_external_id": "plan-doc",
                "export_formats": ["pdf", "docx"],
                "prompt": "must-not-leak",
                "provider_response": {"private": True},
                "api_key": "must-not-leak",
            },
        )
        db.add(item)
        await db.commit()
    return engine, factory


@pytest.mark.asyncio
async def test_v1_migration_is_idempotent_and_public_projection_is_safe(tmp_path):
    engine, factory = await make_database(tmp_path / "artifact-v1.db")
    async with factory() as db:
        item = await db.get(GeneratedItem, 101)
        first = await ensure_initial_version(db, item)
        second = await ensure_initial_version(db, item)
        await db.commit()
        assert first.id == second.id
        assert first.version_number == 1
    async with factory() as db:
        count = await db.scalar(select(func.count(GeneratedItemVersion.id)).where(GeneratedItemVersion.artifact_id == 101))
        projection = await build_public_projection(db, user_id=1, artifact_id=101)
        await db.commit()
        assert count == 1
        assert projection["artifact_id"] == 101
        assert projection["version_number"] == 1
        assert projection["graph_node_id"] == "node-step-size"
        dumped = str(projection)
        assert "must-not-leak" not in dumped
        assert "provider_response" not in dumped
        assert "api_key" not in dumped
    await engine.dispose()


@pytest.mark.asyncio
async def test_create_v2_preserves_v1_and_updates_current_projection_atomically(tmp_path):
    engine, factory = await make_database(tmp_path / "artifact-v2.db")
    async with factory() as db:
        item = await db.get(GeneratedItem, 101)
        v1 = await ensure_initial_version(db, item)
        await db.commit()
        v1_content = v1.content_snapshot
    async with factory() as db:
        row, replayed = await create_new_version(
            db, user_id=1, artifact_id=101, expected_version=1,
            idempotency_key="revise-101-v1", content="# v2\n\n步幅过大会越过最低点。",
            public_data={"thread_id": "thread-a", "kind": "lecture", "graph_id": "graph-a"},
        )
        await db.commit()
        assert replayed is False
        assert row.version_number == 2
    async with factory() as db:
        item = await db.get(GeneratedItem, 101)
        versions = list((await db.execute(select(GeneratedItemVersion).where(
            GeneratedItemVersion.artifact_id == 101
        ).order_by(GeneratedItemVersion.version_number))).scalars())
        assert [v.version_number for v in versions] == [1, 2]
        assert versions[0].content_snapshot == v1_content
        assert versions[1].content_snapshot != versions[0].content_snapshot
        assert item.current_version_id == versions[1].id
        assert item.current_version_number == 2
        assert item.content == versions[1].content_snapshot
        assert item.raw_data["version_id"] == versions[1].id
    await engine.dispose()


@pytest.mark.asyncio
async def test_idempotent_replay_and_collision_guard(tmp_path):
    engine, factory = await make_database(tmp_path / "artifact-replay.db")
    async with factory() as db:
        await ensure_initial_version(db, await db.get(GeneratedItem, 101)); await db.commit()
    async with factory() as db:
        first, replay = await create_new_version(
            db, user_id=1, artifact_id=101, expected_version=1,
            idempotency_key="same-key", content="v2 content",
        )
        await db.commit(); assert replay is False
    async with factory() as db:
        second, replay = await create_new_version(
            db, user_id=1, artifact_id=101, expected_version=1,
            idempotency_key="same-key", content="v2 content",
        )
        await db.commit(); assert replay is True and second.id == first.id
    async with factory() as db:
        with pytest.raises(ArtifactOperationConflict):
            await create_new_version(
                db, user_id=1, artifact_id=101, expected_version=1,
                idempotency_key="same-key", content="different content",
            )
        await db.rollback()
    async with factory() as db:
        count = await db.scalar(select(func.count(GeneratedItemVersion.id)).where(GeneratedItemVersion.artifact_id == 101))
        assert count == 2
    await engine.dispose()


@pytest.mark.asyncio
async def test_expected_version_conflict_and_cross_user_isolation(tmp_path):
    engine, factory = await make_database(tmp_path / "artifact-conflict.db")
    async with factory() as db:
        await ensure_initial_version(db, await db.get(GeneratedItem, 101)); await db.commit()
    async with factory() as db:
        with pytest.raises(ArtifactVersionConflict):
            await create_new_version(
                db, user_id=1, artifact_id=101, expected_version=9,
                idempotency_key="stale", content="no write",
            )
        await db.rollback()
    async with factory() as db:
        with pytest.raises(ArtifactVersionNotFound):
            await build_public_projection(db, user_id=2, artifact_id=101)
        await db.rollback()
    await engine.dispose()


@pytest.mark.asyncio
async def test_concurrent_cas_allows_only_one_writer(tmp_path):
    engine, factory = await make_database(tmp_path / "artifact-concurrent.db")
    async with factory() as db:
        await ensure_initial_version(db, await db.get(GeneratedItem, 101)); await db.commit()

    async def writer(key: str, content: str):
        async with factory() as db:
            try:
                row, _ = await create_new_version(
                    db, user_id=1, artifact_id=101, expected_version=1,
                    idempotency_key=key, content=content,
                )
                await db.commit()
                return ("ok", row.id)
            except ArtifactVersionConflict:
                await db.rollback()
                return ("conflict", None)

    results = await asyncio.gather(writer("writer-a", "v2 A"), writer("writer-b", "v2 B"))
    assert sorted(value[0] for value in results) == ["conflict", "ok"]
    async with factory() as db:
        versions = list((await db.execute(select(GeneratedItemVersion).where(
            GeneratedItemVersion.artifact_id == 101
        ))).scalars())
        assert len(versions) == 2
        assert len([v for v in versions if v.version_number == 2]) == 1
    await engine.dispose()


@pytest.mark.asyncio
async def test_save_failure_rolls_back_claim_and_version(tmp_path):
    engine, factory = await make_database(tmp_path / "artifact-rollback.db")
    async with factory() as db:
        await ensure_initial_version(db, await db.get(GeneratedItem, 101)); await db.commit()
    async with factory() as db:
        original_flush = db.flush
        async def failing_flush(*args, **kwargs):
            if any(isinstance(value, GeneratedItemVersion) and value.version_number == 2 for value in db.new):
                raise RuntimeError("controlled save failure")
            return await original_flush(*args, **kwargs)
        db.flush = failing_flush  # type: ignore[method-assign]
        with pytest.raises(RuntimeError, match="controlled save failure"):
            await create_new_version(
                db, user_id=1, artifact_id=101, expected_version=1,
                idempotency_key="save-fails", content="must rollback",
            )
        await db.rollback()
    async with factory() as db:
        item = await db.get(GeneratedItem, 101)
        count = await db.scalar(select(func.count(GeneratedItemVersion.id)).where(GeneratedItemVersion.artifact_id == 101))
        assert item.current_version_number == 1
        assert count == 1
        assert "must rollback" not in item.content
    await engine.dispose()


@pytest.mark.asyncio
async def test_restart_session_restores_versions_and_diff(tmp_path):
    engine, factory = await make_database(tmp_path / "artifact-restart.db")
    async with factory() as db:
        await ensure_initial_version(db, await db.get(GeneratedItem, 101)); await db.commit()
    async with factory() as db:
        await create_new_version(
            db, user_id=1, artifact_id=101, expected_version=1,
            idempotency_key="restart-v2",
            content="# v2\n\n学习率决定步幅。\n\n新增：步幅过大会越过最低点。",
        )
        await db.commit()
    # New Session is the reload/restart-equivalent durable read.
    async with factory() as db:
        latest = await build_public_projection(db, user_id=1, artifact_id=101)
        old = await build_public_projection(db, user_id=1, artifact_id=101, version_number=1)
        diff = await compare_versions(db, user_id=1, artifact_id=101, from_version=1, to_version=2)
        assert latest["version_number"] == 2
        assert old["version_number"] == 1
        assert diff["summary"]["added"] + diff["summary"]["modified"] > 0
    await engine.dispose()


@pytest.mark.asyncio
async def test_selection_is_bound_to_specific_version_and_stale_text_degrades_safely(tmp_path):
    engine, factory = await make_database(tmp_path / "artifact-selection.db")
    async with factory() as db:
        item = await db.get(GeneratedItem, 101)
        v1 = await ensure_initial_version(db, item); await db.commit()
    async with factory() as db:
        row, _ = await create_new_version(
            db, user_id=1, artifact_id=101, expected_version=1,
            idempotency_key="selection-v2", content="# v2\n\n完全不同的新段落。",
        )
        await db.commit()
        v2_id = row.id
    async with factory() as db:
        refs_v1 = await resolve_workspace_references(
            db, user_id=1, thread_id="thread-a", target_artifact_id=101, target_version_id=v1.id,
        )
        context_v1 = build_reference_question_context(refs_v1)
        trusted = attach_trusted_selection_context(
            context_v1, refs_v1, {"selected_text": "学习率决定每一步的步幅。", "range_label": "第一段"},
        )
        assert trusted["selection"]["version_id"] == v1.id
        refs_v2 = await resolve_workspace_references(
            db, user_id=1, thread_id="thread-a", target_artifact_id=101, target_version_id=v2_id,
        )
        context_v2 = build_reference_question_context(refs_v2)
        with pytest.raises(ReferenceAccessError):
            attach_trusted_selection_context(
                context_v2, refs_v2, {"selected_text": "学习率决定每一步的步幅。", "range_label": "旧段落"},
            )
    await engine.dispose()
