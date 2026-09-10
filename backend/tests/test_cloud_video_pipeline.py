import json
import shutil
import subprocess
from pathlib import Path

import pytest

from integrations.cloud_video.avatar_provider import (
    AvatarProviderBlocked,
    DashScopeAvatarProvider,
    _extract_video_url,
    oss_object_key,
    safe_media_filename,
)
from integrations.cloud_video.contracts import VideoGenerationRequest
from integrations.cloud_video.media_pipeline import (
    compose_teaching_video,
    official_mascot_reference,
    render_dry_run_video,
)
from integrations.cloud_video.service import CloudVideoService
from integrations.cloud_video.settings import CloudVideoSettings


def test_official_mascot_reference_is_the_accepted_project_asset():
    path = official_mascot_reference()
    assert path.name == "shixiaoji-official.jpg"
    assert path.exists()
    assert "teacher_sample" not in str(path).lower()


def test_provider_blocks_without_confirmed_rotated_dashscope_key(tmp_path: Path):
    settings = CloudVideoSettings(output_dir=tmp_path, keys_rotated=False)
    provider = DashScopeAvatarProvider(settings)
    with pytest.raises(AvatarProviderBlocked, match="BLOCKED_BY_SECRET"):
        provider.assert_available()


def test_extract_video_url_accepts_dashscope_http_result_payload():
    url = _extract_video_url({
        "output": {
            "task_status": "SUCCEEDED",
            "results": {
                "video_url": "http://dashscope-result-hz.oss-cn-hangzhou.aliyuncs.com/demo/avatar.mp4?Expires=1",
            },
        }
    })
    assert url.startswith("https://dashscope-result-hz.oss-cn-hangzhou.aliyuncs.com/demo/avatar.mp4")


def test_safe_audio_filename_keeps_mp3_extension():
    assert safe_media_filename(Path("artifact-abc.mp3"), "audio") == "speech.mp3"
    assert oss_object_key("dashscope-instant/demo", "speech.mp3").endswith("/speech.mp3")
    assert oss_object_key("dashscope-instant/demo", "speech.mp3").startswith("dashscope-instant/")


def test_provider_error_is_sanitized_and_never_contains_authorization_value(tmp_path: Path):
    settings = CloudVideoSettings(
        dashscope_api_key="rotated-private-value", llm_api_key="rotated-llm-value",
        output_dir=tmp_path, keys_rotated=True,
    )
    provider = DashScopeAvatarProvider(settings)
    message = provider.sanitize_error(
        "request failed Authorization: Bearer rotated-private-value; api_key=rotated-private-value"
    )
    assert "rotated-private-value" not in message
    assert "Bearer" not in message
    assert "[REDACTED]" in message


def test_dry_run_generates_parseable_mp4_with_video_and_audio(tmp_path: Path):
    output = tmp_path / "dry-run.mp4"
    result = render_dry_run_video(
        output,
        topic="勾股定理",
        key_points=["直角三角形", "a² + b² = c²", "先确认直角"],
        duration_sec=2,
    )
    assert result == output
    assert output.stat().st_size > 0

    probe = subprocess.run(
        ["ffprobe", "-v", "error", "-show_streams", "-of", "json", str(output)],
        check=True, capture_output=True, text=True, encoding="utf-8",
    )
    streams = json.loads(probe.stdout)["streams"]
    assert {stream["codec_type"] for stream in streams} == {"video", "audio"}
    video = next(stream for stream in streams if stream["codec_type"] == "video")
    assert (video["width"], video["height"]) == (1280, 720)


def test_compose_teaching_video_stops_at_avatar_duration(tmp_path: Path):
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        pytest.skip("ffmpeg is required for teaching-scene compose")
    avatar = tmp_path / "avatar.mp4"
    made = subprocess.run(
        [
            ffmpeg, "-y", "-nostdin", "-f", "lavfi", "-i", "color=c=orange:s=512x512:d=1",
            "-f", "lavfi", "-i", "sine=frequency=440:duration=1",
            "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "-shortest",
            str(avatar),
        ],
        capture_output=True, text=True, encoding="utf-8", errors="replace",
    )
    assert made.returncode == 0, made.stderr[-400:]
    output = tmp_path / "composed.mp4"
    compose_teaching_video(
        avatar_video=avatar, output_path=output, topic="柿小吉",
        key_points=["口型同步"], timeout_sec=40,
    )
    probe = subprocess.run(
        ["ffprobe", "-v", "error", "-show_format", "-show_streams", "-of", "json", str(output)],
        check=True, capture_output=True, text=True, encoding="utf-8",
    )
    data = json.loads(probe.stdout)
    duration = float((data.get("format") or {}).get("duration") or 0)
    assert 0.4 <= duration <= 3.0
    assert output.stat().st_size < 2_000_000
    assert {stream["codec_type"] for stream in data["streams"]} == {"video", "audio"}


@pytest.mark.asyncio
async def test_blocked_cloud_renders_labelled_local_teaching_video(tmp_path: Path, monkeypatch):
    async def unavailable_llm():
        raise RuntimeError("llm unavailable in unit test")

    async def unavailable_speech(text, output_path, voice="zh-CN-XiaoxiaoNeural"):
        raise RuntimeError("tts unavailable in unit test")

    monkeypatch.setattr("integrations.cloud_video.service.get_llm_service", unavailable_llm)
    monkeypatch.setattr("integrations.cloud_video.service.synthesize_speech", unavailable_speech)

    service = CloudVideoService(CloudVideoSettings(output_dir=tmp_path, keys_rotated=False))
    stages: list[str] = []

    async def on_stage(status: str) -> None:
        stages.append(status)

    result = await service.generate(
        VideoGenerationRequest(topic="勾股定理", user_id=1, thread_id="thread-local", duration_sec=15),
        on_stage=on_stage,
    )
    assert result["dry_run"] is True
    assert result["provider"] == "local"
    assert "勾股定理" in result["script"]
    assert Path(result["video_path"]).exists()
    assert Path(result["video_path"]).stat().st_size > 0
    assert stages == [
        "generating_script", "generating_audio", "generating_avatar", "composing",
    ]
