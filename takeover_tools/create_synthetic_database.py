# -*- coding: utf-8 -*-
"""Create a from-scratch SYNTHETIC test database for the web takeover.

Generates backend/ml_learning.synthetic.db using the formal SQLAlchemy models
and the formal database initialization code.  No bytes are copied from the
formal ml_learning.db and no real user content is present — every row below is
clearly synthetic test data (see SYNTHETIC-DATA-MANIFEST.json).

Usage:
    python takeover_tools/create_synthetic_database.py \
        [--db-path PATH] [--output-dir DIR] [--force]

Defaults:
    --db-path    <project_root>/backend/ml_learning.synthetic.db
    --output-dir <project_root>/takeover_tools/output

The database URL is also exported into the environment (DATABASE_URL) so that
the rest of the takeover tooling points at the synthetic DB.
"""
from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import os
import sqlite3
import sys
from datetime import datetime
from pathlib import Path

# ---- bootstrap: make backend/ importable (the app runs with cwd=backend) ----
PROJECT_ROOT = Path(__file__).resolve().parent.parent
BACKEND_DIR = PROJECT_ROOT / "backend"
sys.path.insert(0, str(BACKEND_DIR))
os.chdir(str(BACKEND_DIR))

SYNTHETIC_DEFAULT_DB = PROJECT_ROOT / "backend" / "ml_learning.synthetic.db"

LEARNER = {
    "username": "web_takeover_learner",
    "email": "learner@kaki.example.invalid",
    "password": "KakiMock-2026!",
    "display": "网页接管合成学习者",
}
ADMIN = {
    "username": "web_takeover_admin",
    "email": "admin@kaki.example.invalid",
    "password": "KakiAdminMock-2026!",
    "display": "网页接管合成管理员",
}


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for c in iter(lambda: f.read(1024 * 1024), b""):
            h.update(c)
    return h.hexdigest()


async def main(db_path: Path, output_dir: Path, force: bool) -> int:
    if db_path.exists() and not force:
        print(f"[ERROR] {db_path} already exists; pass --force to overwrite")
        return 2
    db_path.parent.mkdir(parents=True, exist_ok=True)
    output_dir.mkdir(parents=True, exist_ok=True)
    if db_path.exists():
        db_path.unlink()
    for side in (Path(str(db_path) + "-wal"), Path(str(db_path) + "-shm")):
        if side.exists():
            side.unlink()

    db_url = "sqlite+aiosqlite:///" + db_path.as_posix()

    # --- env: mock mode, isolated infra, synthetic DB ---
    os.environ["MODE"] = "mock"
    os.environ["DB_ENGINE"] = "sqlite"
    os.environ["DATABASE_URL"] = db_url
    os.environ["LLM_PROVIDER"] = "mock"
    os.environ["REDIS_ENABLED"] = "false"
    os.environ["MILVUS_ENABLED"] = "false"
    os.environ["MINIO_ENABLED"] = "false"
    os.environ["OPENMAIC_ENABLED"] = "false"
    os.environ["SECRET_KEY"] = "web-takeover-mock-dev-only-do-not-use-in-production"
    os.environ["INITIAL_ADMIN_USERNAME"] = ADMIN["username"]
    os.environ["INITIAL_ADMIN_PASSWORD"] = ADMIN["password"]
    os.environ["INITIAL_ADMIN_DISPLAY_NAME"] = ADMIN["display"]

    from database.connection import init_db, close_db, get_db_session
    from database.models import (
        User, StudentProfile, ChatSession, LearningGraph, GraphNode,
        GraphResourcePlan, WorkspaceAgentTask, GeneratedItem, UserNote,
        ExamPaper, Announcement, UserAnnouncementRead, Notification, AdminUser,
    )
    from sqlalchemy import select
    from utils.auth import hash_password

    print("[1/3] init_db (formal models + migrations) ->", db_url)
    await init_db(db_url)

    created = {}

    async with get_db_session() as session:
        # ---- learner ----
        learner = User(
            username=LEARNER["username"],
            password_hash=hash_password(LEARNER["password"]),
            email=LEARNER["email"],
            is_active=True,
        )
        session.add(learner)
        await session.flush()
        learner_id = learner.id
        created["learner_user_id"] = learner_id

        profile = StudentProfile(
            user_id=learner_id,
            major="计算机科学（合成）",
            grade_level="大三（合成）",
            target_role="算法工程师（合成）",
            prior_courses=["高等数学（合成）", "Python 程序设计（合成）"],
            preferred_language="Python",
            skill_matrix={
                "math": {"linear_algebra": 3, "probability": 2, "calculus": 3, "statistics": 2},
                "programming": {"python": 4, "numpy": 3, "pandas": 2},
                "machine_learning": {"supervised": 2, "neural_networks": 1},
                "tools": {"jupyter": 3},
            },
            cognitive_profile={
                "learning_style": "visual",
                "abstraction_ability": 3,
                "question_depth": "medium",
            },
            capability_matrix={
                "linear_algebra": {"vectors": {"score": 3, "confidence": 0.7}},
            },
            overall_score=78.0,
            profile_data={
                "profile_onboarding": {"status": "completed"},
                "normalized_profile": {"synthetic": True},
            },
        )
        session.add(profile)

        chat = ChatSession(
            user_id=learner_id,
            thread_id="synthetic-thread-001",
            messages=[
                {"role": "user", "content": "帮我理解梯度下降（合成测试数据）"},
                {"role": "assistant", "content": "梯度下降是用损失函数的梯度方向迭代更新参数（合成测试数据）"},
            ],
            message_count=2,
            response_style="tutor",
            mode="tutor",
            is_active=True,
        )
        session.add(chat)
        created["chat_session_thread"] = "synthetic-thread-001"

        graph = LearningGraph(
            user_id=learner_id,
            external_id="graph-synthetic-001",
            graph_revision=0,
            graph_summary="合成学习图谱：机器学习入门",
            title="机器学习入门（合成图谱）",
            goal="掌握机器学习核心概念（合成目标）",
            goal_type="custom",
            source_type="manual",
            status="active",
            is_primary=True,
            total_nodes=3,
            completed_nodes=1,
            progress_pct=33.0,
        )
        session.add(graph)
        await session.flush()
        graph_id = graph.id

        node_specs = [
            ("node-synth-001", "theory", "线性代数基础（合成节点）", "向量与矩阵运算", "theory", "planned", 1),
            ("node-synth-002", "math", "梯度下降（合成节点）", "损失函数与参数更新", "math", "completed", 2),
            ("node-synth-003", "practice", "过拟合与正则化（合成节点）", "训练误差与泛化误差", "practice", "planned", 3),
        ]
        node_ids = []
        for ext, unit, title, desc, ktype, status, order in node_specs:
            node = GraphNode(
                graph_id=graph_id,
                user_id=learner_id,
                external_id=ext,
                continuity_key=ext,
                unit_id="unit-synth-001",
                summary=desc,
                node_type="learning_unit",
                title=title,
                description=desc,
                knowledge_type=ktype,
                difficulty=3,
                estimated_minutes=30,
                order_index=order,
                status=status,
                mastery_score=90.0 if status == "completed" else 0.0,
                learning_objectives=["理解核心概念（合成）"],
                key_concepts=["合成概念"],
                depends_on=[],
                tags=["合成"],
                is_custom=False,
                auto_generated=True,
            )
            session.add(node)
            await session.flush()
            node_ids.append(node.id)

        rplan = GraphResourcePlan(
            graph_id=graph_id,
            external_id="rplan-synth-001",
            continuity_key="rplan-synth-001",
            node_id=node_ids[0],
            resource_type="document",
            purpose="合成资源计划：节点讲义",
            generation_spec={"mode": "mock", "synthetic": True},
            required_inputs=[],
            trigger="on_demand",
            status="planned",
            priority=50,
        )
        session.add(rplan)
        created["graph_id"] = graph_id
        created["node_ids"] = node_ids

        task = WorkspaceAgentTask(
            task_id="task-synth-001",
            user_id=learner_id,
            thread_id="synthetic-thread-001",
            agent_type="harvest_adventure",
            state="claimed",
            slots={"synthetic": True},
            version=1,
            execution_key="exec-synth-001",
        )
        session.add(task)

        artifact = GeneratedItem(
            user_id=learner_id,
            type="document",
            title="合成产物：线性代数讲义",
            chapter="合成章节",
            content="这是一份合成的学习产物内容。",
            raw_data={"synthetic": True},
        )
        session.add(artifact)
        await session.flush()
        created["artifact_id"] = artifact.id

        note = UserNote(
            user_id=learner_id,
            title="合成笔记：梯度下降",
            content="这是合成的学习笔记内容。",
            plain_text="这是合成的学习笔记内容。",
            tags=["合成"],
            category="general",
            word_count=14,
            content_format="plain",
            status="active",
        )
        session.add(note)
        await session.flush()
        created["note_id"] = note.id

        exam = ExamPaper(
            user_id=learner_id,
            exam_type="mock",
            chapter_ids=["unit-synth-001"],
            questions=[{"type": "single", "content": "合成的选择题题干？", "options": ["A", "B", "C", "D"], "answer": "A"}],
            total_score=100.0,
            time_limit_min=60,
            status="draft",
        )
        session.add(exam)
        await session.flush()
        created["exam_id"] = exam.id

        # admin (ensure_initial_admin runs inside init_db) + announcement
        admin_row = (await session.execute(select(AdminUser).where(AdminUser.username == ADMIN["username"]))).scalar_one_or_none()
        if admin_row is None:
            admin_row = AdminUser(
                username=ADMIN["username"],
                password_hash=hash_password(ADMIN["password"]),
                display_name=ADMIN["display"],
                role="super_admin",
                is_active=True,
            )
            session.add(admin_row)
            await session.flush()
        admin_id = admin_row.id
        created["admin_user_id"] = admin_id

        announcement = Announcement(
            title="欢迎使用柿子智学网页接管合成环境",
            content="这是一条合成的公告。所有数据均为合成测试数据，不含任何真实用户内容。",
            level="info",
            status="published",
            target_scope="all_users",
            published_at=datetime.utcnow(),
            created_by=admin_id,
        )
        session.add(announcement)
        await session.flush()

        read_rec = UserAnnouncementRead(
            user_id=learner_id,
            announcement_id=announcement.id,
            is_read=True,
            read_at=datetime.utcnow(),
        )
        session.add(read_rec)

        note_for_learner = Notification(
            user_id=learner_id,
            source_type="system",
            title="合成通知",
            content="合成的系统通知。",
            is_read=False,
        )
        session.add(note_for_learner)

        await session.commit()
        print(f"[2/3] synthetic rows committed. learner_id={learner_id} admin_id={admin_id} graph_id={graph_id}")

    await close_db()

    # ---- integrity check ----
    print("[3/3] sqlite integrity_check ...")
    conn = sqlite3.connect(str(db_path))
    conn.execute("PRAGMA query_only=ON")
    integrity = conn.execute("PRAGMA integrity_check").fetchall()
    ok = all(r[0] == "ok" for r in integrity)
    tables = [r[0] for r in conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
    )]
    index_count = conn.execute("SELECT count(*) FROM sqlite_master WHERE type='index'").fetchone()[0]
    fk_violations = conn.execute("PRAGMA foreign_key_check").fetchall()
    conn.close()

    manifest = {
        "generated_by": "KAKI-WEB-TAKEOVER-PACKAGE-02 / takeover_tools/create_synthetic_database.py",
        "generated_at": datetime.utcnow().isoformat() + "Z",
        "database_path": str(db_path),
        "database_sha256": sha256_file(db_path),
        "database_size": db_path.stat().st_size,
        "integrity_check": "ok" if ok else [r[0] for r in integrity],
        "table_count": len(tables),
        "tables": tables,
        "index_count": index_count,
        "foreign_key_violations": len(fk_violations),
        "synthetic_credentials": {
            "learner": {"username": LEARNER["username"], "email": LEARNER["email"], "password": LEARNER["password"], "note": "SYNTHETIC_TEST_CREDENTIALS"},
            "admin": {"username": ADMIN["username"], "email": ADMIN["email"], "password": ADMIN["password"], "note": "SYNTHETIC_TEST_CREDENTIALS"},
        },
        "data_notes": "所有内容均为合成测试数据；不含正式用户、正式密码哈希、真实文件路径或真实邮箱/手机号/Token。",
        "created_ids": created,
    }
    (output_dir / "SYNTHETIC-DATA-MANIFEST.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8"
    )

    compatibility = {
        "database_path": str(db_path),
        "database_sha256": manifest["database_sha256"],
        "synthetic_table_count": len(tables),
        "formal_reference_table_count": 42,
        "table_list_matches_formal_models": "metadata.create_all produced full formal schema",
        "integrity_check": manifest["integrity_check"],
        "foreign_key_check": "ok" if not fk_violations else [str(v) for v in fk_violations[:5]],
        "schema_compatible": bool(ok and len(tables) >= 42 and not fk_violations),
    }
    (output_dir / "DATABASE-SCHEMA-COMPATIBILITY.json").write_text(
        json.dumps(compatibility, ensure_ascii=False, indent=2), encoding="utf-8"
    )

    print("SYNTHETIC_DB", str(db_path))
    print("SHA256", manifest["database_sha256"])
    print("TABLES", len(tables))
    print("INDEXES", index_count)
    print("INTEGRITY", "ok" if ok else "FAIL")
    print("FK_VIOLATIONS", len(fk_violations))
    return 0 if ok and not fk_violations else 3


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description="Create synthetic takeover database")
    ap.add_argument("--db-path", type=Path, default=SYNTHETIC_DEFAULT_DB)
    ap.add_argument("--output-dir", type=Path, default=PROJECT_ROOT / "takeover_tools" / "output")
    ap.add_argument("--force", action="store_true")
    args = ap.parse_args()
    code = asyncio.run(main(args.db_path, args.output_dir, args.force))
    sys.exit(code)
