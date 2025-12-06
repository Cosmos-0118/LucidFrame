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

Mode = Literal["photo", "anime", "clean"]


class ImagePipelineError(RuntimeError):
    pass


def _select_model_path(mode: Mode, scale: int) -> Path:
    base = config.models_dir
    if mode == "anime":
        return base / "realesrgan" / "RealESRGAN_x4plus_anime_6B.pth"
    if mode == "clean":
        return base / "realesrgan" / "RealESRNet_x4plus.pth"
    if scale == 2:
        return base / "realesrgan" / "RealESRGAN_x2plus.pth"
    return base / "realesrgan" / "RealESRGAN_x4plus.pth"


def _validate_mode(mode: str) -> Mode:
    if mode not in ("photo", "anime", "clean"):
        raise ImagePipelineError("mode must be 'photo', 'anime', or 'clean'")
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


def _edge_mask(img: np.ndarray, thresh: int = 8) -> np.ndarray:
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    gx = cv2.Sobel(gray, cv2.CV_32F, 1, 0, ksize=3)
    gy = cv2.Sobel(gray, cv2.CV_32F, 0, 1, ksize=3)
    mag = cv2.magnitude(gx, gy)
    mask = np.clip((mag - thresh) / max(thresh, 1), 0, 1)
    return mask.astype(np.float32)


def _maybe_sharpen(img: np.ndarray,
                   strength: float,
                   clamp: int | None = None,
                   edge_mask: np.ndarray | None = None,
                   blend_original: float = 0.0) -> np.ndarray:
    if strength <= 0:
        return img
    amount = min(strength, 1.0) * 0.7  # keep gentle even at max
    # Work in luminance to avoid color fringes on text/UI
    ycrcb = cv2.cvtColor(img, cv2.COLOR_BGR2YCrCb)
    y, cr, cb = cv2.split(ycrcb)
    blurred = cv2.GaussianBlur(y, (0, 0), sigmaX=1.0)
    y_sharp = cv2.addWeighted(y, 1 + amount, blurred, -amount, 0)
    ycrcb = cv2.merge([y_sharp, cr, cb])
    out = cv2.cvtColor(ycrcb, cv2.COLOR_YCrCb2BGR)
    diff = out.astype(np.int32) - img.astype(np.int32)
    if edge_mask is not None:
        mask = np.expand_dims(edge_mask, axis=2)
        diff = (diff.astype(np.float32) * mask).astype(np.int32)
    if clamp is not None:
        diff = np.clip(diff, -clamp, clamp)
    out = np.clip(img.astype(np.int32) + diff, 0, 255).astype(np.uint8)
    if blend_original > 0:
        alpha = np.clip(blend_original, 0.0, 1.0)
        out = cv2.addWeighted(out, 1 - alpha, img, alpha, 0)
    return out


def process_image(
    file: UploadFile,
    mode: str = "photo",
    scale: int = 2,
    face_restore: bool = False,
    face_strength: float = 0.5,
    denoise_strength: float = 0.0,
    sharpen_strength: float = 0.0,
    text_mode: bool = False,
):
    if scale not in (2, 4):
        raise ImagePipelineError("scale must be 2 or 4")
    mode_val = _validate_mode(mode)
    if mode_val in {"anime", "clean"} and scale != 4:
        # Keep it reliable: anime and clean models are 4x-only
        scale = 4
    if not 0 <= face_strength <= 1:
        raise ImagePipelineError("face_strength must be between 0 and 1")
    if denoise_strength < 0:
        raise ImagePipelineError("denoise_strength must be >= 0")
    if sharpen_strength < 0:
        raise ImagePipelineError("sharpen_strength must be >= 0")

    # Text-safe preset: avoid hallucinations and apply gentle crisping
    clamp = None
    edge_mask = None
    blend_original = 0.0
    if text_mode:
        mode_val = "photo"
        face_restore = False
        face_strength = 0.0
        denoise_strength = min(denoise_strength, 0.02)
        # Keep sharpening modest and bounded for UI/text
        sharpen_strength = min(max(sharpen_strength, 0.15), 0.35)
        clamp = 12
        blend_original = 0.15

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

    if text_mode:
        edge_mask = _edge_mask(out, thresh=8)

    out = _maybe_sharpen(out,
                         sharpen_strength,
                         clamp=clamp,
                         edge_mask=edge_mask,
                         blend_original=blend_original)

    dt = time.time() - t0
    _, buf = cv2.imencode(".png", out)
    return io.BytesIO(buf.tobytes()), dt, get_device()
