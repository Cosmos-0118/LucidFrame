from __future__ import annotations

import io
import subprocess
import tempfile
import time
import warnings
from pathlib import Path
from typing import Any, Literal

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


def _apply_tone(img: np.ndarray, exposure: float, contrast: float,
                saturation: float) -> np.ndarray:
    out = img.astype(np.float32) / 255.0
    if exposure != 1.0:
        out = np.clip(out * exposure, 0.0, 1.0)
    if contrast != 1.0:
        out = np.clip((out - 0.5) * contrast + 0.5, 0.0, 1.0)
    if saturation != 1.0:
        hsv = cv2.cvtColor((out * 255).astype(np.uint8), cv2.COLOR_BGR2HSV)
        h, s, v = cv2.split(hsv)
        s = np.clip(s.astype(np.float32) * saturation, 0, 255).astype(np.uint8)
        hsv = cv2.merge([h, s, v])
        out = cv2.cvtColor(hsv, cv2.COLOR_HSV2BGR) / 255.0
    return np.clip(out * 255.0, 0, 255).astype(np.uint8)


def _waifu2x_upscale(img: np.ndarray, scale: int,
                     noise_level: int) -> np.ndarray:
    """Run waifu2x-ncnn-vulkan for anime 2x upscaling."""

    exe = config.waifu2x_path
    if exe is None or not exe.exists():
        raise ImagePipelineError(
            "waifu2x binary not found; set LUCIDFRAME_WAIFU2X or place waifu2x-ncnn-vulkan.exe in bin/"
        )

    models_dir = config.models_dir / "waifu2x" / "models-upconv_7_anime_style_art_rgb"
    if not models_dir.exists():
        raise ImagePipelineError(f"waifu2x models not found: {models_dir}")

    # Ensure temp root exists before creating a subdir
    config.temp_dir.mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory(dir=config.temp_dir) as tmpdir:
        tmpdir_path = Path(tmpdir)
        inp = tmpdir_path / "waifu2x_in.png"
        out = tmpdir_path / "waifu2x_out.png"
        if not cv2.imwrite(str(inp), img):
            raise ImagePipelineError("failed to write temp image for waifu2x")

        cmd = [
            str(exe),
            "-i",
            str(inp),
            "-o",
            str(out),
            "-s",
            str(scale),
            "-n",
            str(noise_level),
            "-m",
            str(models_dir),
        ]
        try:
            subprocess.run(cmd, check=True, capture_output=True)
        except subprocess.CalledProcessError as exc:  # noqa: BLE001
            err = exc.stderr.decode(
                errors="ignore") if exc.stderr else str(exc)
            raise ImagePipelineError(f"waifu2x failed: {err}") from exc

        result = cv2.imread(str(out))
        if result is None:
            raise ImagePipelineError("waifu2x produced no output")
        return result


def process_image(
    file: UploadFile,
    mode: str = "photo",
    scale: int = 2,
    face_restore: bool = False,
    face_strength: float = 0.5,
    denoise_strength: float = 0.0,
    sharpen_strength: float = 0.0,
    text_mode: bool = False,
    brightness: float = 1.0,
    exposure: float = 1.0,
    contrast: float = 1.0,
    saturation: float = 1.0,
    auto_enhance: bool = False,
):
    # Silence noisy torch/vision future warnings about weights_only and pretrained flags
    with warnings.catch_warnings():
        warnings.filterwarnings("ignore",
                                category=FutureWarning,
                                message=".*weights_only=False.*")
        warnings.filterwarnings("ignore",
                                category=UserWarning,
                                message=".*pretrained.*deprecated.*")

    if scale not in (2, 4):
        raise ImagePipelineError("scale must be 2 or 4")
    mode_val = _validate_mode(mode)
    if mode_val == "clean" and scale != 4:
        # Clean model is 4x-only
        scale = 4
    if not 0 <= face_strength <= 1:
        raise ImagePipelineError("face_strength must be between 0 and 1")
    if denoise_strength < 0:
        raise ImagePipelineError("denoise_strength must be >= 0")
    if sharpen_strength < 0:
        raise ImagePipelineError("sharpen_strength must be >= 0")
    if text_mode and face_restore:
        raise ImagePipelineError(
            "text_mode cannot be combined with face restoration")
    for name, val in (("brightness", brightness), ("exposure", exposure),
                      ("contrast", contrast), ("saturation", saturation)):
        if not 0.2 <= val <= 2.0:
            raise ImagePipelineError(f"{name} must be between 0.2 and 2.0")

    # User-facing presets
    if auto_enhance:
        denoise_strength = max(denoise_strength, 0.12)
        sharpen_strength = max(sharpen_strength, 0.18)
        exposure = min(max(exposure * 1.1, 0.2), 1.5)
        contrast = min(max(contrast * 1.1, 0.2), 1.5)
        saturation = min(max(saturation * 1.08, 0.2), 1.4)

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
        exposure = min(exposure, 1.2)
        contrast = min(contrast, 1.15)
        saturation = min(saturation, 1.1)

    use_waifu2x = mode_val == "anime" and scale == 2

    if face_restore and use_waifu2x:
        raise ImagePipelineError(
            "face restoration is not supported with waifu2x 2x anime mode")

    model_path = None
    if not use_waifu2x:
        model_path = _select_model_path(mode_val, scale)
        if not model_path.exists():
            raise ImagePipelineError(f"model not found: {model_path}")

    img = _load_image_bytes(file)
    h, w = img.shape[:2]
    megapixels = round((h * w) / 1e6, 2)
    tile_override = None
    warning = ""
    if megapixels > 12.0:
        tile_override = 128
        warning = "Large input detected (>12MP); using smaller tiles to reduce VRAM load"
    elif megapixels < 0.25:
        warning = "Tiny input detected; consider 4x upscale for best quality"

    img = _maybe_denoise(img, denoise_strength)
    t0 = time.time()

    tile_info = None
    upsampler: Any | None = None
    if use_waifu2x:
        noise_level = int(max(0, min(3, round(denoise_strength * 3))))
        out = _waifu2x_upscale(img, scale=scale, noise_level=noise_level)
    else:
        assert model_path is not None
        upsampler = load_realesrgan(model_path,
                                    scale=scale,
                                    tile_override=tile_override)
        tile_info = getattr(upsampler, "tile", None)
        if face_restore:
            # GFPGAN with RealESRGAN as background upsampler when supported; fallback if API differs.
            gfpgan: Any = load_gfpgan(config.models_dir / "gfpgan" /
                                      "GFPGANv1.4.pth")
            try:
                _, _, restored_img = gfpgan.enhance(
                    img,
                    has_aligned=False,
                    only_center_face=False,
                    paste_back=True,
                    weight=face_strength,
                    bg_upsampler=upsampler,
                    upscale=scale,
                )
            except TypeError:
                _, _, restored_img = gfpgan.enhance(
                    img,
                    has_aligned=False,
                    only_center_face=False,
                    paste_back=True,
                    weight=face_strength,
                )
            out = restored_img
        else:
            out, _ = upsampler.enhance(img, outscale=scale)

    out = _apply_tone(out,
                      exposure=exposure,
                      contrast=contrast,
                      saturation=saturation)

    if text_mode:
        edge_mask = _edge_mask(out, thresh=8)

    out = _maybe_sharpen(out,
                         sharpen_strength,
                         clamp=clamp,
                         edge_mask=edge_mask,
                         blend_original=blend_original)

    # Apply brightness as a final, visible gain; keeps text-safe clamps intact
    if brightness != 1.0:
        out = cv2.convertScaleAbs(out, alpha=float(brightness), beta=0)
        # Gentle gamma tweak to lift/darken midtones so the change is obvious
        gamma = 0.85 if brightness > 1.0 else 1.12
        lut = np.array([((i / 255.0)**gamma) * 255 for i in range(256)],
                       dtype=np.uint8)
        out = cv2.LUT(out, lut)

    dt = time.time() - t0
    _, buf = cv2.imencode(".png", out)
    meta = {
        "mp": megapixels,
        "warning": warning,
        "tile": tile_info,
        "params": {
            "brightness": brightness,
            "exposure": exposure,
            "contrast": contrast,
            "saturation": saturation,
            "denoise": denoise_strength,
            "sharpen": sharpen_strength,
            "text_mode": text_mode,
            "auto_enhance": auto_enhance,
        },
    }
    return io.BytesIO(buf.tobytes()), dt, get_device(), meta
