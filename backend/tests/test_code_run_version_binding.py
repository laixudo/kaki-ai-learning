from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import pytest
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from database.models import Base, ChatSession, GeneratedItem, GeneratedItemCodeRun, GeneratedItemVersion, User
from services.workspace_artifact_versions import create_new_version, ensure_initial_version
from services.workspace_code_runs import (
    CodeRunConflict,
    CodeRunNotFound,
    execute_code_version,
    list_code_runs,
)


@dataclass
class FakeResult:
    stdout: str = "ok\n"
    stderr: str = ""
    exit_code: int = 0
    timed_out: bool = False
    duration_ms: int = 12
    error_category: str = ""
    error_message: str = ""

    def to_dict(self):
        return self.__dict__.copy()


async def database(path: Path):
    engine = create_async_engine(f"sqlite+aiosqlite:///{path}")
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    factory = async_sessionmaker(engine, expire_on_commit=False)
    async with factory() as db:
        db.add_all([
            User(id=1, username="code_a", password_hash="synthetic"),
            User(id=2, username="code_b", password_hash="synthetic"),
            ChatSession(id=1, user_id=1, thread_id="thread-code", messages=[], message_count=0),
            GeneratedItem(
                id=101, user_id=1, type="workspace_code", title="学习率实验", chapter="梯度下降",
                content="print('v1')\n", raw_data={
                    "kind": "code", "thread_id": "thread-code", "language": "python",
                    "graph_id": "graph-a", "graph_node_external_id": "node-a",
                },
            ),
        ])
        await db.commit()
        item = await db.get(GeneratedItem, 101)
        v1 = await ensure_initial_version(db, item)
        await db.commit()
        v2, _ = await create_new_version(
            db, user_id=1, artifact_id=101, expected_version=1,
            idempotency_key="make-v2", content="print('v2')\n",
            public_data={"kind": "code", "thread_id": "thread-code", "language": "python"},
        )
        await db.commit()
    return engine, factory, v1.id, v2.id


@pytest.mark.asyncio
async def test_v2_run_idempotency_and_collision(tmp_path):
    engine, factory, _, v2_id = await database(tmp_path / "code-run.db")
    async with factory() as db:
        run, replayed = await execute_code_version(
            db, user_id=1, thread_id="thread-code", artifact_id=101,
            artifact_version_id=v2_id, execution_request_id="request-1",
            idempotency_key="run-key", parameters={"seed": 1},
            executor=lambda **_: FakeResult(stdout="loss=1.0\nloss=1.2\n"),
            observation_status="UNEXPECTED",
        )
        await db.commit()
        assert replayed is False
        assert run["run_number"] == 1
        assert run["artifact_version_number"] == 2
        assert run["status"] == "SUCCEEDED"
        assert run["observation_status"] == "UNEXPECTED"
        assert run["exit_code"] == 0
    async with factory() as db:
        replay, replayed = await execute_code_version(
            db, user_id=1, thread_id="thread-code", artifact_id=101,
            artifact_version_id=v2_id, execution_request_id="request-1",
            idempotency_key="run-key", parameters={"seed": 1},
            executor=lambda **_: (_ for _ in ()).throw(AssertionError("must not execute")),
        )
        await db.commit()
        assert replayed is True and replay["run_id"] == run["run_id"]
    async with factory() as db:
        with pytest.raises(CodeRunConflict):
            await execute_code_version(
                db, user_id=1, thread_id="thread-code", artifact_id=101,
                artifact_version_id=v2_id, execution_request_id="request-1",
                idempotency_key="run-key", parameters={"seed": 2}, executor=lambda **_: FakeResult(),
            )
        await db.rollback()
    await engine.dispose()


@pytest.mark.asyncio
async def test_run_history_is_bound_to_immutable_versions(tmp_path):
    engine, factory, _, v2_id = await database(tmp_path / "code-version-run.db")
    async with factory() as db:
        v2_run, _ = await execute_code_version(
            db, user_id=1, thread_id="thread-code", artifact_id=101,
            artifact_version_id=v2_id, execution_request_id="v2-run",
            idempotency_key="v2-run", executor=lambda **_: FakeResult(stdout="v2"),
        )
        await db.commit()
    async with factory() as db:
        v3, _ = await create_new_version(
            db, user_id=1, artifact_id=101, expected_version=2,
            idempotency_key="make-v3", content="print('v3')\n",
            public_data={"kind": "code", "thread_id": "thread-code", "language": "python"},
        )
        await db.commit()
        assert await list_code_runs(db, user_id=1, artifact_id=101, artifact_version_id=v3.id) == []
        v3_run, _ = await execute_code_version(
            db, user_id=1, thread_id="thread-code", artifact_id=101,
            artifact_version_id=v3.id, execution_request_id="v3-run",
            idempotency_key="v3-run", executor=lambda **_: FakeResult(stdout="v3"),
        )
        await db.commit()
        assert v3_run["run_number"] == 1
        assert v3_run["artifact_version_id"] == v3.id
        assert v3_run["artifact_version_number"] == 3
        assert v2_run["artifact_version_id"] == v2_id
        assert v2_run["artifact_version_number"] == 2
        assert v2_run["artifact_version_id"] != v3_run["artifact_version_id"]
    async with factory() as db:
        v2_rows = await list_code_runs(db, user_id=1, artifact_id=101, artifact_version_id=v2_id)
        v3_rows = await list_code_runs(db, user_id=1, artifact_id=101, artifact_version_id=v3.id)
        assert [row["stdout"] for row in v2_rows] == ["v2"]
        assert [row["artifact_version_number"] for row in v2_rows] == [2]
        assert [row["stdout"] for row in v3_rows] == ["v3"]
        assert [row["artifact_version_number"] for row in v3_rows] == [3]
    await engine.dispose()


@pytest.mark.asyncio
async def test_process_terminal_states_and_public_redaction(tmp_path):
    engine, factory, _, v2_id = await database(tmp_path / "code-states.db")
    cases = [
        ("failed", FakeResult(stderr="Traceback /tmp/private/runner.py line 9 API_KEY=secret", exit_code=1, error_category="runtime_error"), "FAILED"),
        ("timeout", FakeResult(stderr="timeout", exit_code=124, timed_out=True, error_category="timeout"), "TIMED_OUT"),
        ("sandbox", FakeResult(stderr="spawn", exit_code=1, error_category="spawn_failed"), "SANDBOX_UNAVAILABLE"),
    ]
    async with factory() as db:
        for key, fake, expected in cases:
            run, _ = await execute_code_version(
                db, user_id=1, thread_id="thread-code", artifact_id=101,
                artifact_version_id=v2_id, execution_request_id=key,
                idempotency_key=key, executor=lambda _fake=fake, **_: _fake,
            )
            assert run["status"] == expected
            assert "secret" not in run["stderr"]
            assert "/tmp/private" not in run["stderr"]
            assert "execution_key_digest" not in run
        await db.commit()
    await engine.dispose()


@pytest.mark.asyncio
async def test_cross_user_and_new_session_recovery(tmp_path):
    engine, factory, _, v2_id = await database(tmp_path / "code-owner.db")
    async with factory() as db:
        run, _ = await execute_code_version(
            db, user_id=1, thread_id="thread-code", artifact_id=101,
            artifact_version_id=v2_id, execution_request_id="persist",
            idempotency_key="persist", executor=lambda **_: FakeResult(stdout="persisted"),
        )
        await db.commit()
    async with factory() as db:
        rows = await list_code_runs(db, user_id=1, artifact_id=101, artifact_version_id=v2_id)
        assert rows[0]["run_id"] == run["run_id"]
        with pytest.raises(CodeRunNotFound):
            await list_code_runs(db, user_id=2, artifact_id=101, artifact_version_id=v2_id)
    await engine.dispose()


@pytest.mark.asyncio
async def test_run_insert_failure_does_not_change_artifact_version(tmp_path):
    engine, factory, _, v2_id = await database(tmp_path / "code-rollback.db")
    async with factory() as db:
        original_flush = db.flush
        calls = 0
        async def failing_flush(*args, **kwargs):
            nonlocal calls
            calls += 1
            if any(isinstance(row, GeneratedItemCodeRun) for row in db.new):
                raise RuntimeError("controlled run write failure")
            return await original_flush(*args, **kwargs)
        db.flush = failing_flush  # type: ignore[method-assign]
        with pytest.raises(RuntimeError, match="controlled run write failure"):
            await execute_code_version(
                db, user_id=1, thread_id="thread-code", artifact_id=101,
                artifact_version_id=v2_id, execution_request_id="fail-write",
                idempotency_key="fail-write", executor=lambda **_: FakeResult(),
            )
        await db.rollback()
    async with factory() as db:
        item = await db.get(GeneratedItem, 101)
        count = await db.scalar(select(func.count(GeneratedItemCodeRun.id)))
        assert item.current_version_number == 2
        assert count == 0
    await engine.dispose()

@pytest.mark.asyncio
async def test_real_project_python_sandbox_executes_exact_version(tmp_path):
    engine, factory, _, v2_id = await database(tmp_path / "code-real-sandbox.db")
    async with factory() as db:
        run, replayed = await execute_code_version(
            db, user_id=1, thread_id="thread-code", artifact_id=101,
            artifact_version_id=v2_id, execution_request_id="real-sandbox",
            idempotency_key="real-sandbox", parameters={},
        )
        await db.commit()
        assert replayed is False
        assert run["status"] == "SUCCEEDED"
        assert run["exit_code"] == 0
        assert "v2" in run["stdout"]
    await engine.dispose()
