"""End-to-end internal Cloud Video service used by KAKI jobs only."""
from __future__ import annotations

from pathlib import Path
from typing import Awaitable, Callable
from uuid import uuid4

from services.llm_service_real import get_llm_service

from .avatar_provider import AvatarProviderBlocked, AvatarProviderError, DashScopeAvatarProvider
from .contracts import VideoGenerationRequest
from .media_pipeline import (
    compose_teaching_video,
    official_mascot_reference,
    probe_video,
    render_dry_run_video,
    synthesize_speech,
)
from .script_service import (
    ScriptGenerationError, TeachingScript, build_local_teaching_script, generate_teaching_script,
)
from .settings import CloudVideoSettings


class CloudVideoServiceError(RuntimeError):
    code = "CLOUD_VIDEO_FAILED"


class CloudVideoServiceBlocked(CloudVideoServiceError):
    code = "BLOCKED_BY_SECRET"


StageCallback = Callable[[str], Awaitable[None]]


class CloudVideoService:
    def __init__(self, settings: CloudVideoSettings):
        self.settings = settings

    def _clip_duration(self, request: VideoGenerationRequest) -> int:
        duration = int(request.duration_sec or 20)
        if request.provider == "s2v":
            return max(15, min(duration, 20))
        return max(15, min(duration, 60))

    async def _resolve_script(self, request: VideoGenerationRequest) -> TeachingScript:
        llm = None
        try:
            llm = await get_llm_service()
            return await generate_teaching_script(
                request, llm, model_identifier=self.settings.script_model,
            )
        except Exception:
            return build_local_teaching_script(request)
        finally:
            if llm is not None:
                try:
                    await llm.close()
                except Exception:
                    pass

    async def _generate_local(
        self, request: VideoGenerationRequest, *, on_stage: StageCallback,
    ) -> dict:
        duration = self._clip_duration(request)
        output_dir = self.settings.output_dir / str(request.user_id)
        output_dir.mkdir(parents=True, exist_ok=True)
        stem = f"artifact-{request.thread_id[:24].replace('/', '-')}-{uuid4().hex[:12]}"
        audio_path = output_dir / f"{stem}.mp3"
        final_path = output_dir / f"{stem}.mp4"
        await on_stage("generating_script")
        script = await self._resolve_script(request)
        await on_stage("generating_audio")
        spoken = None
        try:
            await synthesize_speech(script.script, audio_path)
            spoken = audio_path
        except Exception:
            spoken = None
        await on_stage("generating_avatar")
        await on_stage("composing")
        render_dry_run_video(
            final_path, topic=request.topic, key_points=script.key_points,
            duration_sec=duration, audio_path=spoken, caption="柿小吉本机讲解",
        )
        probe = probe_video(final_path)
        measured = float((probe.get("format") or {}).get("duration") or duration)
        return {
            "video_path": final_path, "script": script.script,
            "key_points": script.key_points, "duration_sec": round(measured, 2),
            "provider": "local", "model": "local-ffmpeg-tts",
            "script_model": script.model, "dry_run": True, "provider_task_id": None,
        }

    async def generate(
        self, request: VideoGenerationRequest, *, on_stage: StageCallback,
    ) -> dict:
        if self.settings.blocker_code or request.dry_run:
            try:
                return await self._generate_local(request, on_stage=on_stage)
            except CloudVideoServiceError:
                raise
            except Exception as exc:
                raise CloudVideoServiceError(f"CLOUD_VIDEO_FAILED: {str(exc)[:400]}") from exc
        output_dir = self.settings.output_dir / str(request.user_id)
        output_dir.mkdir(parents=True, exist_ok=True)
        stem = f"artifact-{request.thread_id[:24].replace('/', '-')}-{uuid4().hex[:12]}"
        audio_path = output_dir / f"{stem}.mp3"
        avatar_path = output_dir / f"{stem}.avatar.mp4"
        final_path = output_dir / f"{stem}.mp4"
        llm = None
        try:
            await on_stage("generating_script")
            llm = await get_llm_service()
            try:
                script = await generate_teaching_script(
                    request, llm, model_identifier=self.settings.script_model,
                )
            except ScriptGenerationError:
                script = build_local_teaching_script(request)
            await on_stage("generating_audio")
            await synthesize_speech(script.script, audio_path)
            await on_stage("generating_avatar")
            provider = DashScopeAvatarProvider(self.settings)
            try:
                provider_result = await provider.generate(
                    image_path=official_mascot_reference(), audio_path=audio_path,
                    output_path=avatar_path,
                )
            except AvatarProviderBlocked:
                raise
            except AvatarProviderError:
                await on_stage("composing")
                render_dry_run_video(
                    final_path, topic=request.topic, key_points=script.key_points,
                    duration_sec=self._clip_duration(request), audio_path=audio_path,
                    caption="柿小吉本机讲解",
                )
                probe = probe_video(final_path)
                duration = float((probe.get("format") or {}).get("duration") or request.duration_sec)
                return {
                    "video_path": final_path, "script": script.script,
                    "key_points": script.key_points, "duration_sec": round(duration, 2),
                    "provider": "local", "model": "local-ffmpeg-tts",
                    "script_model": script.model, "dry_run": True, "provider_task_id": None,
                }
            await on_stage("composing")
            compose_teaching_video(
                avatar_video=avatar_path, output_path=final_path,
                topic=request.topic, key_points=script.key_points,
            )
            probe = probe_video(final_path)
            duration = float((probe.get("format") or {}).get("duration") or request.duration_sec)
            return {
                "video_path": final_path, "script": script.script,
                "key_points": script.key_points, "duration_sec": round(duration, 2),
                "provider": request.provider, "model": provider_result.get("model") or self.settings.avatar_model,
                "script_model": script.model, "dry_run": False,
                "provider_task_id": provider_result.get("task_id"),
            }
        except CloudVideoServiceError:
            raise
        except AvatarProviderBlocked as exc:
            raise CloudVideoServiceBlocked(str(exc)) from exc
        except Exception as exc:
            code = getattr(exc, "code", "CLOUD_VIDEO_FAILED")
            raise CloudVideoServiceError(f"{code}: {str(exc)[:400]}") from exc
        finally:
            if llm is not None:
                try:
                    await llm.close()
                except Exception:
                    pass
