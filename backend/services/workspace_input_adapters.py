"""Real OCR and speech-to-text adapters for the standalone AI workspace."""

from __future__ import annotations

import asyncio
import importlib.util
import os
import tempfile
import threading
from dataclasses import dataclass
from io import BytesIO
from pathlib import Path
from typing import Iterable, Optional

import numpy as np
from PIL import Image, UnidentifiedImageError


MAX_IMAGE_BYTES = 10 * 1024 * 1024
MAX_AUDIO_BYTES = 20 * 1024 * 1024

ALLOWED_IMAGE_TYPES = {"image/png", "image/jpeg", "image/webp"}
ALLOWED_AUDIO_TYPES = {
    "audio/webm",
    "audio/ogg",
    "audio/mp4",
    "audio/mpeg",
    "audio/wav",
    "audio/x-wav",
}


class InputAdapterError(ValueError):
    """A safe, user-facing validation or recognition error."""


@dataclass(frozen=True)
class OCRTextResult:
    text: str
    engine: str
    confidence: float
    line_count: int


@dataclass(frozen=True)
class TranscriptionResult:
    text: str
    engine: str
    language: str
    duration_seconds: float


_ocr_engine = None
_ocr_lock = threading.Lock()
_whisper_model = None
_whisper_lock = threading.Lock()


def input_adapter_capabilities() -> dict:
    """Report install-time capability without loading heavyweight models."""
    return {
        "ocr": {
            "available": importlib.util.find_spec("rapidocr_onnxruntime") is not None,
            "provider": "rapidocr",
        },
        "asr": {
            "available": importlib.util.find_spec("faster_whisper") is not None,
            "provider": "faster-whisper",
        },
    }


def validate_upload_size(size: int, limit: int, label: str) -> None:
    if size <= 0:
        raise InputAdapterError(f"{label}内容为空。")
    if size > limit:
        raise InputAdapterError(f"{label}不能超过 {limit // (1024 * 1024)} MB。")


def _get_ocr_engine():
    global _ocr_engine
    if _ocr_engine is None:
        with _ocr_lock:
            if _ocr_engine is None:
                try:
                    from rapidocr_onnxruntime import RapidOCR
                except ImportError as exc:  # pragma: no cover - environment guard
                    raise InputAdapterError("OCR 服务尚未安装，请联系管理员。") from exc
                _ocr_engine = RapidOCR()
    return _ocr_engine


def ocr_image_bytes(payload: bytes, *, content_type: str) -> OCRTextResult:
    content_type = (content_type or "").split(";", 1)[0].lower()
    if content_type not in ALLOWED_IMAGE_TYPES:
        raise InputAdapterError("图片格式不支持，请上传 PNG、JPG 或 WebP。")
    validate_upload_size(len(payload), MAX_IMAGE_BYTES, "图片")

    try:
        with Image.open(BytesIO(payload)) as source:
            source.load()
            image = np.asarray(source.convert("RGB"))
    except (UnidentifiedImageError, OSError, ValueError) as exc:
        raise InputAdapterError("图片无法读取，请重新选择有效图片。") from exc

    try:
        rows, _elapsed = _get_ocr_engine()(image)
    except InputAdapterError:
        raise
    except Exception as exc:
        raise InputAdapterError("OCR 识别失败，请稍后重试。") from exc

    lines = []
    scores = []
    for row in rows or []:
        if len(row) < 3:
            continue
        text = str(row[1] or "").strip()
        if not text:
            continue
        lines.append(text)
        try:
            scores.append(float(row[2]))
        except (TypeError, ValueError):
            pass
    if not lines:
        raise InputAdapterError("没有识别到图片文字，请换一张更清晰的图片。")
    confidence = sum(scores) / len(scores) if scores else 0.0
    return OCRTextResult(
        text="\n".join(lines),
        engine="rapidocr",
        confidence=round(confidence, 4),
        line_count=len(lines),
    )


def join_transcription_segments(segments: Iterable[object]) -> str:
    parts = [str(getattr(segment, "text", "") or "").strip() for segment in segments]
    return " ".join(part for part in parts if part).strip()


def _get_whisper_model():
    global _whisper_model
    if _whisper_model is None:
        with _whisper_lock:
            if _whisper_model is None:
                try:
                    from faster_whisper import WhisperModel
                except ImportError as exc:  # pragma: no cover - environment guard
                    raise InputAdapterError("语音转写服务尚未安装，请联系管理员。") from exc
                _whisper_model = WhisperModel(
                    os.getenv("WORKSPACE_WHISPER_MODEL", "tiny"),
                    device=os.getenv("WORKSPACE_WHISPER_DEVICE", "cpu"),
                    compute_type=os.getenv("WORKSPACE_WHISPER_COMPUTE_TYPE", "int8"),
                )
    return _whisper_model


def _transcribe_file(path: str) -> TranscriptionResult:
    try:
        segments, info = _get_whisper_model().transcribe(
            path,
            beam_size=5,
            vad_filter=True,
            # The product language is Mandarin; the hint keeps the decoder on
            # simplified Chinese instead of drifting to traditional variants.
            initial_prompt="以下是普通话简体中文的日常学习对话。",
        )
        text = join_transcription_segments(segments)
    except InputAdapterError:
        raise
    except Exception as exc:
        raise InputAdapterError("语音转写失败，请检查录音后重试。") from exc
    if not text:
        raise InputAdapterError("没有识别到语音，请靠近麦克风后重试。")
    return TranscriptionResult(
        text=text,
        engine=f"faster-whisper-{os.getenv('WORKSPACE_WHISPER_MODEL', 'tiny')}",
        language=str(getattr(info, "language", "") or "unknown"),
        duration_seconds=round(float(getattr(info, "duration", 0.0) or 0.0), 2),
    )


async def transcribe_audio_bytes(
    payload: bytes,
    *,
    content_type: str,
    suffix: str,
    temp_dir: Optional[Path] = None,
) -> TranscriptionResult:
    content_type = (content_type or "").split(";", 1)[0].lower()
    if content_type not in ALLOWED_AUDIO_TYPES:
        raise InputAdapterError("音频格式不支持，请使用 WebM、Ogg、MP4、MP3 或 WAV。")
    validate_upload_size(len(payload), MAX_AUDIO_BYTES, "音频")

    safe_suffixes = {".webm", ".ogg", ".mp4", ".m4a", ".mp3", ".wav"}
    normalized_suffix = suffix.lower() if suffix else ""
    if normalized_suffix not in safe_suffixes:
        normalized_suffix = {
            "audio/webm": ".webm",
            "audio/ogg": ".ogg",
            "audio/mp4": ".mp4",
            "audio/mpeg": ".mp3",
            "audio/wav": ".wav",
            "audio/x-wav": ".wav",
        }[content_type]

    temporary_path = ""
    try:
        with tempfile.NamedTemporaryFile(
            mode="wb",
            suffix=normalized_suffix,
            dir=str(temp_dir) if temp_dir else None,
            delete=False,
        ) as temporary:
            temporary.write(payload)
            temporary_path = temporary.name
        return await asyncio.to_thread(_transcribe_file, temporary_path)
    finally:
        if temporary_path:
            try:
                Path(temporary_path).unlink(missing_ok=True)
            except OSError:
                pass
