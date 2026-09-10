from __future__ import annotations

from pathlib import Path

import pytest
from fastapi import HTTPException
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from database.models import Base, GeneratedItem, User
from routers.items import (
    CreateItemVersionRequest,
    compare_item_versions,
    create_item_version,
    get_item,
    get_item_version,
    list_item_versions,
)


async def database(path: Path):
    engine = create_async_engine(f"sqlite+aiosqlite:///{path}")
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    factory = async_sessionmaker(engine, expire_on_commit=False)
    async with factory() as db:
        db.add_all([
            User(id=11, username="artifact_api_a", password_hash="synthetic"),
            User(id=12, username="artifact_api_b", password_hash="synthetic"),
            GeneratedItem(
                id=501, user_id=11, type="workspace_lecture", title="学习率讲义",
                chapter="梯度下降", content="# 第一版\n\n学习率决定步幅。",
                raw_data={
                    "kind": "lecture", "thread_id": "thread-api-a", "graph_id": "graph-api-a",
                    "graph_node_external_id": "node-step-size", "resource_plan_external_id": "plan-doc",
                    "export_formats": ["pdf", "docx"], "prompt": "private-prompt",
                },
            ),
        ])
        await db.commit()
    return engine, factory


@pytest.mark.asyncio
async def test_version_api_public_projection_and_history(tmp_path):
    engine, factory = await database(tmp_path / "artifact-api.db")
    async with factory() as db:
        current = await get_item(501, current_user_id=11, db=db)
        assert current["data"]["version_number"] == 1
        assert "private-prompt" not in str(current)
        created = await create_item_version(
            501,
            CreateItemVersionRequest(
                expected_version=1, idempotency_key="api-create-v2",
                content="# 第二版\n\n学习率过大会越过最低点。",
                public_data={"kind": "lecture", "graph_id": "graph-api-a"},
            ),
            current_user_id=11, db=db,
        )
        assert created["data"]["version_number"] == 2
        v1 = await get_item_version(501, 1, current_user_id=11, db=db)
        assert "第一版" in v1["data"]["content"]
        versions = await list_item_versions(501, current_user_id=11, db=db)
        assert [row["version_number"] for row in versions["data"]] == [1, 2]
        comparison = await compare_item_versions(501, 1, 2, current_user_id=11, db=db)
        assert comparison["data"]["summary"]["modified"] + comparison["data"]["summary"]["added"] > 0
    async with factory() as db:
        with pytest.raises(HTTPException) as denied:
            await get_item(501, current_user_id=12, db=db)
        assert denied.value.status_code == 404
    await engine.dispose()
