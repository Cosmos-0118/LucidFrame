from __future__ import annotations

import io
import time
from pathlib import Path
from typing import Literal

import cv2
import numpy as np
from fastapi import UploadFile

from ..config import config
from ..model_loader import get_device, load_gfpgan, load_realesrgan

Mode = Literal["photo", "anime"]


class ImagePipelineError(RuntimeError):
    pass


def _select_model_path(mode: Mode, scale: int) -> Path:
    base = config.models_dir
    if mode == "anime":
        return base / "realesrgan" / "RealESRGAN_x4plus_anime_6B.pth"
    if scale == 2:
        return base / "realesrgan" / "RealESRGAN_x2plus.pth"
    return base / "realesrgan" / "RealESRGAN_x4plus.pth"


def _validate_mode(mode: str) -> Mode:
    if mode not in ("photo", "anime"):
        raise ImagePipelineError("mode must be 'photo' or 'anime'")
    return mode  # type: ignore[return-value]


def _load_image_bytes(file: UploadFile) -> np.ndarray:
    data = file.file.read()
    arr = np.frombuffer(data, np.uint8)
    img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    if img is None:
        raise ImagePipelineError("failed to decode image")
    return img


def _maybe_denoise(img: np.ndarray, strength: float) -> np.ndarray:
    if strength <= 0:
        return img
    # Map 0..1 strength to OpenCV h parameters (conservative)
    h = max(3, int(10 * min(strength, 1.0)))
    return cv2.fastNlMeansDenoisingColored(img, None, h, h, 7, 21)


def process_image(
    file: UploadFile,
    mode: str = "photo",
    scale: int = 2,
    face_restore: bool = False,
    face_strength: float = 0.5,
    denoise_strength: float = 0.0,
):
    if scale not in (2, 4):
        raise ImagePipelineError("scale must be 2 or 4")
    mode_val = _validate_mode(mode)
    if not 0 <= face_strength <= 1:
        raise ImagePipelineError("face_strength must be between 0 and 1")
    if denoise_strength < 0:
        raise ImagePipelineError("denoise_strength must be >= 0")

    model_path = _select_model_path(mode_val, scale)
    if not model_path.exists():
        raise ImagePipelineError(f"model not found: {model_path}")

    img = _load_image_bytes(file)
    img = _maybe_denoise(img, denoise_strength)
    t0 = time.time()

    upsampler = load_realesrgan(model_path, scale=scale)
    if face_restore:
        # GFPGAN with RealESRGAN as background upsampler
        gfpgan = load_gfpgan(config.models_dir / "gfpgan" / "GFPGANv1.4.pth")
        _, _, restored_img = gfpgan.enhance(
            img,
            has_aligned=False,
            only_center_face=False,
            paste_back=True,
            weight=face_strength,
            bg_upsampler=upsampler,
            # match scale even though GFPGAN has its own upscale param; using 1 to keep control with bg upsampler
            upscale=1,
        )
        out = restored_img
    else:
        out, _ = upsampler.enhance(img, outscale=scale)

    dt = time.time() - t0
    _, buf = cv2.imencode(".png", out)
    return io.BytesIO(buf.tobytes()), dt, get_device()
