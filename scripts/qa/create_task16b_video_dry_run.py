"""Create an explicitly labelled local video Artifact for Task16B acceptance.

This script never calls a cloud provider. It exists only to prove the KAKI media,
Artifact, ownership, persistence, and authenticated playback path independently of
external credentials.
"""
from __future__ import annotations

import argparse
import asyncio
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
BACKEND = ROOT / "backend"
sys.path.insert(0, str(BACKEND))

from config import settings as app_settings  # noqa: E402
from database.connection import get_db_session, init_db  # noqa: E402
from database.models import User  # noqa: E402
from integrations.cloud_video.media_pipeline import render_dry_run_video  # noqa: E402
from integrations.cloud_video.settings import CloudVideoSettings  # noqa: E402
from services.video_generation_jobs import (  # noqa: E402
    complete_video_job,
    create_video_job,
    project_video_job,
    update_video_job_status,
)
from sqlalchemy import select  # noqa: E402


async def main(username: str) -> None:
    await init_db(app_settings.DATABASE_URL)
    async with get_db_session() as db:
        user = await db.scalar(select(User).where(User.username == username))
        if user is None:
            raise SystemExit("synthetic acceptance user not found")
        item = await create_video_job(
            db, user_id=user.id, thread_id="task16b_dry_run",
            topic="勾股定理", duration_sec=3, provider="s2v",
            instruction="本地媒体与产物链路验收，不代表云生成成功。",
        )
        for state in ("generating_script", "generating_audio", "generating_avatar", "composing"):
            await update_video_job_status(db, user_id=user.id, artifact_id=item.id, status=state)
        root = CloudVideoSettings.from_app_settings(app_settings).output_dir / str(user.id)
        output = root / f"artifact-{item.id}-dry-run.mp4"
        render_dry_run_video(
            output, topic="勾股定理",
            key_points=["识别直角三角形", "理解 a² + b² = c²", "用平方关系求未知边"],
            duration_sec=3,
        )
        ready = await complete_video_job(
            db, user_id=user.id, artifact_id=item.id, video_path=output,
            script="这是本地 dry-run 教学视频，用来验证受保护媒体、音视频流和统一学习产物链路。",
            key_points=["直角三角形", "平方关系", "求未知边"],
            duration_sec=3, provider="s2v", model="local-ffmpeg-evidence", dry_run=True,
        )
        payload = project_video_job(ready)
        print(f"artifact_id={payload['artifact_id']} status={payload['status']} dry_run={payload['dry_run']}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--username", required=True)
    args = parser.parse_args()
    asyncio.run(main(args.username))
