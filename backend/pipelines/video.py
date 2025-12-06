from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import cv2
import numpy as np

from ..config import config
from ..model_loader import load_realesrgan


class VideoPipelineError(RuntimeError):
    pass


def _ensure_dir(path: Path) -> Path:
    path.mkdir(parents=True, exist_ok=True)
    return path


def extract_frames(ffmpeg_path: Path, input_path: Path, frames_dir: Path):
    _ensure_dir(frames_dir)
    cmd = [
        str(ffmpeg_path),
        "-y",
        "-i",
        str(input_path),
        "-qscale:v",
        "2",
        str(frames_dir / "frame_%06d.png"),
    ]
    subprocess.run(cmd, check=True, capture_output=True)


def upscale_frames(frames_dir: Path, out_dir: Path, scale: int):
    _ensure_dir(out_dir)
    model_path = config.models_dir / "realesrgan" / (
        "RealESRGAN_x2plus.pth" if scale == 2 else "RealESRGAN_x4plus.pth")
    if not model_path.exists():
        raise VideoPipelineError(f"model not found: {model_path}")
    upsampler = load_realesrgan(model_path, scale=scale)
    for frame_path in sorted(frames_dir.glob("frame_*.png")):
        img = cv2.imread(str(frame_path))
        if img is None:
            raise VideoPipelineError(f"failed to read frame {frame_path}")
        out, _ = upsampler.enhance(img, outscale=scale)
        cv2.imwrite(str(out_dir / frame_path.name), out)


def interpolate_frames(frames_dir: Path, out_dir: Path):
    """Lightweight frame interpolation by midpoint blending.

    This doubles the frame count by inserting blended mid-frames between
    consecutive frames. It avoids external deps and is a safe fallback until a
    full RIFE integration is added.
    """

    _ensure_dir(out_dir)
    frame_paths = sorted(frames_dir.glob("frame_*.png"))
    if len(frame_paths) < 2:
        # nothing to interpolate
        shutil.copytree(frames_dir, out_dir, dirs_exist_ok=True)
        return

    idx = 1
    for i, frame_path in enumerate(frame_paths):
        img = cv2.imread(str(frame_path))
        if img is None:
            raise VideoPipelineError(f"failed to read frame {frame_path}")

        out_name = out_dir / f"frame_{idx:06d}.png"
        cv2.imwrite(str(out_name), img)
        idx += 1

        if i + 1 < len(frame_paths):
            nxt = cv2.imread(str(frame_paths[i + 1]))
            if nxt is None:
                raise VideoPipelineError(
                    f"failed to read frame {frame_paths[i + 1]}")
            # Midpoint blend; keep uint8
            mid = cv2.addWeighted(img, 0.5, nxt, 0.5, 0)
            mid_name = out_dir / f"frame_{idx:06d}.png"
            cv2.imwrite(str(mid_name), mid)
            idx += 1


def assemble_video(ffmpeg_path: Path,
                   frames_dir: Path,
                   input_path: Path,
                   output_path: Path,
                   framerate: int = 25):
    cmd = [
        str(ffmpeg_path),
        "-y",
        "-framerate",
        str(framerate),
        "-i",
        str(frames_dir / "frame_%06d.png"),
        "-i",
        str(input_path),
        "-map",
        "0:v:0",
        "-map",
        "1:a?",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "copy",
        str(output_path),
    ]
    subprocess.run(cmd, check=True, capture_output=True)


def process_video(input_path: Path,
                  output_path: Path,
                  scale: int = 2,
                  interpolate: bool = False):
    if scale not in (2, 4):
        raise VideoPipelineError("scale must be 2 or 4")
    ffmpeg_path = config.ffmpeg_path
    if ffmpeg_path is None or not ffmpeg_path.exists():
        raise VideoPipelineError("ffmpeg not found; set config.ffmpeg_path")

    job_dir = output_path.parent
    frames = job_dir / "frames"
    upscaled = job_dir / "frames_up"
    interp = job_dir / "frames_interp"

    extract_frames(ffmpeg_path, input_path, frames)
    upscale_frames(frames, upscaled, scale)

    if interpolate:
        interpolate_frames(upscaled, interp)
        frames_for_output = interp
        target_fps = 50
    else:
        frames_for_output = upscaled
        target_fps = 25

    assemble_video(ffmpeg_path,
                   frames_for_output,
                   input_path,
                   output_path,
                   framerate=target_fps)

    # Cleanup raw frames to save space
    try:
        shutil.rmtree(frames)
    except Exception:
        pass
    try:
        shutil.rmtree(upscaled)
    except Exception:
        pass
    if interpolate:
        try:
            shutil.rmtree(interp)
        except Exception:
            pass

    return output_path
