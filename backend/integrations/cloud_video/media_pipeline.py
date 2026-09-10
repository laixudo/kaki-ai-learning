"""KAKI teaching-scene renderer and local evidence pipeline."""
from __future__ import annotations

import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import Iterable

from PIL import Image, ImageDraw, ImageFont


def prepare_s2v_audio(source: Path, output_path: Path, max_sec: float = 19.0) -> Path:
    """Re-encode speech as a real .mp3 under the S2V duration cap."""
    ffmpeg = shutil.which("ffmpeg")
    output_path = output_path.resolve()
    output_path.parent.mkdir(parents=True, exist_ok=True)
    duration = max(1.0, min(float(max_sec), 19.0))
    if not ffmpeg:
        if source.suffix.lower() not in {".mp3", ".wav"}:
            raise RuntimeError("ffmpeg 未安装，无法转换数字人音频。")
        if source.resolve() != output_path:
            shutil.copyfile(source, output_path)
        return output_path
    command = [
        ffmpeg, "-y", "-nostdin", "-i", str(source), "-t", str(duration),
        "-ac", "1", "-ar", "24000", "-c:a", "libmp3lame", "-b:a", "128k",
        str(output_path),
    ]
    completed = subprocess.run(command, capture_output=True, text=True, encoding="utf-8", errors="replace")
    if completed.returncode != 0 or not output_path.exists() or output_path.stat().st_size == 0:
        raise RuntimeError("数字人音频转码失败：" + (completed.stderr or "")[-400:])
    return output_path


async def synthesize_speech(text: str, output_path: Path, voice: str = "zh-CN-XiaoxiaoNeural") -> Path:
    import edge_tts

    output_path.parent.mkdir(parents=True, exist_ok=True)
    await edge_tts.Communicate(str(text), voice=voice).save(str(output_path))
    if not output_path.exists() or output_path.stat().st_size == 0:
        raise RuntimeError("语音服务未生成可用音频。")
    return output_path


def project_root() -> Path:
    return Path(__file__).resolve().parents[3]


def official_mascot_reference() -> Path:
    return project_root() / "frontend" / "src" / "assets" / "brand" / "shixiaoji-official.jpg"


def _font(size: int, *, bold: bool = False) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    candidates = [
        Path("C:/Windows/Fonts/msyhbd.ttc" if bold else "C:/Windows/Fonts/msyh.ttc"),
        Path("C:/Windows/Fonts/simhei.ttf"),
    ]
    for candidate in candidates:
        if candidate.exists():
            return ImageFont.truetype(str(candidate), size)
    return ImageFont.load_default()


def render_scene_frame(
    output_path: Path, *, topic: str, key_points: Iterable[str], mascot_path: Path | None = None,
    include_mascot: bool = True, caption: str = "柿小吉本机讲解",
) -> Path:
    width, height = 1280, 720
    canvas = Image.new("RGB", (width, height), "#fbf6ee")
    draw = ImageDraw.Draw(canvas, "RGBA")
    draw.ellipse((-190, 500, 620, 980), fill=(222, 143, 90, 20))
    draw.ellipse((760, -290, 1510, 310), fill=(112, 126, 90, 16))
    draw.line((70, 84, 1210, 84), fill=(214, 93, 48, 150), width=3)
    draw.rounded_rectangle((66, 118, 820, 654), radius=36, fill=(255, 253, 249, 244), outline=(112, 82, 61, 42), width=2)
    draw.text((104, 150), "柿子智学 · AI 短讲", font=_font(24, bold=True), fill="#cf5f32")
    draw.text((104, 205), str(topic)[:28], font=_font(48, bold=True), fill="#47382f")
    y = 304
    for index, point in enumerate(list(key_points)[:4], 1):
        draw.ellipse((104, y + 9, 126, y + 31), fill="#dd6f3c")
        draw.text((145, y), str(point)[:34], font=_font(29), fill="#59483e")
        y += 78
    draw.text((104, 601), str(caption or "柿小吉本机讲解")[:42], font=_font(18), fill="#8a7567")

    if include_mascot:
        mascot = Image.open(mascot_path or official_mascot_reference()).convert("RGB")
        mascot.thumbnail((342, 450), Image.Resampling.LANCZOS)
        mascot_layer = Image.new("RGB", (350, 470), "#fbf6ee")
        x = (mascot_layer.width - mascot.width) // 2
        y = (mascot_layer.height - mascot.height) // 2
        mascot_layer.paste(mascot, (x, y))
        canvas.paste(mascot_layer, (875, 150))
        draw = ImageDraw.Draw(canvas, "RGBA")
        draw.rounded_rectangle((904, 610, 1194, 658), radius=24, fill=(215, 99, 52, 232))
        draw.text((959, 621), "柿小吉讲解准备中", font=_font(19, bold=True), fill="#fffaf3")
    output_path.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(output_path, format="PNG")
    return output_path


def probe_video(path: Path) -> dict:
    import json

    ffprobe = shutil.which("ffprobe")
    if not ffprobe:
        raise RuntimeError("ffprobe 未安装，无法验证生成视频。")
    completed = subprocess.run(
        [ffprobe, "-v", "error", "-show_format", "-show_streams", "-of", "json", str(path)],
        capture_output=True, text=True, encoding="utf-8", errors="replace",
    )
    if completed.returncode != 0:
        raise RuntimeError("ffprobe 无法解析生成视频。")
    data = json.loads(completed.stdout)
    types = {str(stream.get("codec_type") or "") for stream in data.get("streams", [])}
    if not {"video", "audio"}.issubset(types):
        raise RuntimeError("生成文件缺少视频流或音轨。")
    return data


def media_duration_sec(path: Path) -> float:
    return video_timing(path)[0]


def video_timing(path: Path) -> tuple[float, int, str]:
    import json

    ffprobe = shutil.which("ffprobe")
    if not ffprobe:
        raise RuntimeError("ffprobe 未安装，无法读取媒体时长。")
    completed = subprocess.run(
        [ffprobe, "-v", "error", "-show_format", "-show_streams", "-of", "json", str(path)],
        capture_output=True, text=True, encoding="utf-8", errors="replace",
    )
    if completed.returncode != 0:
        raise RuntimeError("ffprobe 无法读取媒体时长。")
    data = json.loads(completed.stdout) or {}
    video = next(
        (stream for stream in data.get("streams") or [] if stream.get("codec_type") == "video"),
        {},
    )
    duration = float((data.get("format") or {}).get("duration") or video.get("duration") or 0)
    frames = int(str(video.get("nb_frames") or "0") or 0)
    fps = str(video.get("r_frame_rate") or "16/1")
    if frames <= 0:
        try:
            numerator, denominator = fps.split("/", 1)
            frames = max(1, int(round(duration * float(numerator) / float(denominator or 1))))
        except (TypeError, ValueError, ZeroDivisionError):
            frames = max(1, int(round(duration * 16)))
    if duration <= 0:
        raise RuntimeError("媒体时长无效。")
    duration = max(0.4, min(duration, 20.0))
    frames = max(1, min(frames, 640))
    return duration, frames, fps


def compose_teaching_video(
    *, avatar_video: Path, output_path: Path, topic: str, key_points: Iterable[str],
    timeout_sec: int = 90,
) -> Path:
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        raise RuntimeError("ffmpeg 未安装，无法合成教学视频。")
    output_path = output_path.resolve()
    output_path.parent.mkdir(parents=True, exist_ok=True)
    duration, frames, fps = video_timing(avatar_video)
    with tempfile.TemporaryDirectory(prefix="kaki-compose-") as temp_dir:
        scene = render_scene_frame(
            Path(temp_dir) / "scene.png", topic=topic, key_points=key_points,
            include_mascot=False,
        )
        command = [
            ffmpeg, "-y", "-nostdin", "-loop", "1", "-framerate", fps, "-i", str(scene),
            "-i", str(avatar_video),
            "-filter_complex",
            "[0:v]scale=850:720,crop=850:720:0:0[left];"
            "[1:v]scale=430:720:force_original_aspect_ratio=increase,crop=430:720[right];"
            "[left][right]hstack=inputs=2:shortest=1,format=yuv420p[v]",
            "-map", "[v]", "-map", "1:a?", "-frames:v", str(frames),
            "-c:v", "libx264", "-preset", "veryfast", "-crf", "22",
            "-c:a", "aac", "-b:a", "128k", "-t", f"{duration:.3f}",
            str(output_path),
        ]
        try:
            completed = subprocess.run(
                command, capture_output=True, text=True, encoding="utf-8", errors="replace",
                timeout=max(30, int(timeout_sec)),
            )
        except subprocess.TimeoutExpired as exc:
            raise RuntimeError("ffmpeg 教学场景合成超时。") from exc
        if completed.returncode != 0:
            raise RuntimeError("ffmpeg 教学场景合成失败：" + completed.stderr[-800:])
    if not output_path.exists() or output_path.stat().st_size == 0:
        raise RuntimeError("教学场景合成未产生视频文件。")
    probe_video(output_path)
    return output_path


def render_dry_run_video(
    output_path: Path, *, topic: str, key_points: Iterable[str], duration_sec: int = 3,
    audio_path: Path | None = None, caption: str = "柿小吉本机讲解",
) -> Path:
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        raise RuntimeError("ffmpeg 未安装，无法生成本地视频证据。")
    duration = max(1, min(int(duration_sec), 30))
    output_path = output_path.resolve()
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="kaki-video-") as temp_dir:
        frame = render_scene_frame(
            Path(temp_dir) / "scene.png", topic=topic, key_points=key_points, caption=caption,
        )
        frames = duration * 30
        zoom = (
            f"[0:v]zoompan=z='min(zoom+0.00045,1.028)':x='iw/2-(iw/zoom/2)':"
            f"y='ih/2-(ih/zoom/2)':d={frames}:s=1280x720:fps=30,format=yuv420p[v]"
        )
        if audio_path and Path(audio_path).exists() and Path(audio_path).stat().st_size > 0:
            command = [
                ffmpeg, "-y", "-nostdin", "-loop", "1", "-i", str(frame), "-i", str(audio_path),
                "-filter_complex", f"{zoom};[1:a]apad=whole_dur={duration}[a]",
                "-map", "[v]", "-map", "[a]", "-t", str(duration),
                "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
                "-c:a", "aac", "-b:a", "128k", str(output_path),
            ]
        else:
            command = [
                ffmpeg, "-y", "-nostdin", "-loop", "1", "-i", str(frame),
                "-f", "lavfi", "-i", f"sine=frequency=523:sample_rate=48000:duration={duration}",
                "-filter_complex", zoom,
                "-map", "[v]", "-map", "1:a", "-t", str(duration),
                "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
                "-c:a", "aac", "-b:a", "128k", "-shortest", str(output_path),
            ]
        completed = subprocess.run(command, capture_output=True, text=True, encoding="utf-8", errors="replace")
        if completed.returncode != 0:
            raise RuntimeError("ffmpeg 合成失败：" + completed.stderr[-800:])
    if not output_path.exists() or output_path.stat().st_size == 0:
        raise RuntimeError("ffmpeg 未生成可用视频文件。")
    return output_path
