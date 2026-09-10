"""Convert the silent Playwright WebM recording to an MP4 container."""

from __future__ import annotations

import sys
from pathlib import Path

import cv2


def main() -> int:
    if len(sys.argv) != 3:
        print("usage: transcode-video.py <input.webm> <output.mp4>", file=sys.stderr)
        return 2

    source = Path(sys.argv[1]).resolve()
    target = Path(sys.argv[2]).resolve()
    capture = cv2.VideoCapture(str(source))
    if not capture.isOpened():
        print(f"cannot open source video: {source}", file=sys.stderr)
        return 3

    fps = capture.get(cv2.CAP_PROP_FPS) or 25.0
    width = int(capture.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT))
    target.parent.mkdir(parents=True, exist_ok=True)

    writer = None
    selected_codec = ""
    for codec in ("avc1", "mp4v"):
        candidate = cv2.VideoWriter(
            str(target), cv2.VideoWriter_fourcc(*codec), fps, (width, height)
        )
        if candidate.isOpened():
            writer = candidate
            selected_codec = codec
            break
        candidate.release()

    if writer is None:
        capture.release()
        print("no compatible MP4 encoder is available", file=sys.stderr)
        return 4

    frames = 0
    while True:
        ok, frame = capture.read()
        if not ok:
            break
        writer.write(frame)
        frames += 1

    capture.release()
    writer.release()
    if frames == 0 or not target.is_file() or target.stat().st_size == 0:
        print("MP4 conversion produced no usable frames", file=sys.stderr)
        return 5

    print(f"MP4_CODEC={selected_codec}")
    print(f"MP4_FRAMES={frames}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
