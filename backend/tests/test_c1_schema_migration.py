from pathlib import Path

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine

from database.connection import _ensure_column


@pytest.mark.asyncio
async def test_existing_version_table_gets_private_snapshot_column_idempotently(tmp_path: Path):
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'old.db'}")
    async with engine.begin() as conn:
        await conn.execute(text("CREATE TABLE generated_item_versions (id INTEGER PRIMARY KEY, artifact_id INTEGER NOT NULL)"))
    await _ensure_column(engine, "generated_item_versions", "private_data_snapshot", "JSON")
    await _ensure_column(engine, "generated_item_versions", "private_data_snapshot", "JSON")
    async with engine.begin() as conn:
        columns = {row[1] for row in (await conn.execute(text("PRAGMA table_info(generated_item_versions)"))).fetchall()}
    assert "private_data_snapshot" in columns
    await engine.dispose()
