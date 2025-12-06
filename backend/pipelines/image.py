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


def _load_image_bytes(file: UploadFile) -> np.ndarray:
    data = file.file.read()
    arr = np.frombuffer(data, np.uint8)
    img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    if img is None:
        raise ImagePipelineError("failed to decode image")
    return img


def process_image(file: UploadFile,
                  mode: Mode = "photo",
                  scale: int = 2,
                  face_restore: bool = False):
    if scale not in (2, 4):
        raise ImagePipelineError("scale must be 2 or 4")
    model_path = _select_model_path(mode, scale)
    if not model_path.exists():
        raise ImagePipelineError(f"model not found: {model_path}")

    img = _load_image_bytes(file)
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
            weight=0.5,
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
