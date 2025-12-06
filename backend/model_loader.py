from __future__ import annotations

import functools
import logging
import os
import sys
import types
from dataclasses import dataclass
from pathlib import Path
from typing import Optional, Tuple

import torch

from .config import config


# Provide compatibility shim for basicsr expecting torchvision.transforms.functional_tensor
def _ensure_torchvision_compat() -> None:
    """Shim for basicsr expecting torchvision.transforms.functional_tensor.rgb_to_grayscale."""
    module_name = "torchvision.transforms.functional_tensor"
    if module_name in sys.modules:
        return
    try:
        from torchvision.transforms import functional as F  # type: ignore
    except Exception:
        return
    if not hasattr(F, "rgb_to_grayscale"):
        return
    shim = types.ModuleType(module_name)
    shim.rgb_to_grayscale = F.rgb_to_grayscale  # type: ignore[attr-defined]
    sys.modules[module_name] = shim


_ensure_torchvision_compat()

logger = logging.getLogger(__name__)


@dataclass
class DeviceInfo:
    name: str
    device: torch.device
    amp: bool
    half: bool
    vram_bytes: Optional[int] = None


@functools.lru_cache(maxsize=1)
def get_device(env_token: Optional[str] = None) -> DeviceInfo:
    """Select the best available device.

    Order of preference:
    1) Explicit env override via LUCIDFRAME_DEVICE (e.g., "cuda:1", "cpu", "xpu:0").
    2) Best CUDA device by VRAM.
    3) DirectML/XPU if available.
    4) CPU fallback.
    """

    # 1) Explicit override
    preferred = os.environ.get("LUCIDFRAME_DEVICE")
    if preferred:
        try:
            dev = torch.device(preferred)
            if dev.type == "cuda" and torch.cuda.is_available():
                idx = dev.index if dev.index is not None else torch.cuda.current_device(
                )
                props = torch.cuda.get_device_properties(idx)
                return DeviceInfo(
                    name=f"cuda:{idx} {props.name}",
                    device=torch.device(f"cuda:{idx}"),
                    amp=True,
                    half=config.use_fp16,
                    vram_bytes=getattr(props, "total_memory", None),
                )
            if dev.type == "xpu" and hasattr(
                    torch, "xpu") and torch.xpu.is_available():
                return DeviceInfo(name=str(dev),
                                  device=dev,
                                  amp=False,
                                  half=False)
            if dev.type == "cpu":
                return DeviceInfo(name="cpu",
                                  device=torch.device("cpu"),
                                  amp=False,
                                  half=False)
        except Exception as exc:  # noqa: BLE001
            logger.warning("LUCIDFRAME_DEVICE=%s is invalid; falling back: %s",
                           preferred, exc)

    # 2) CUDA: pick the GPU with the most VRAM to avoid tiny/default picks
    if torch.cuda.is_available() and torch.cuda.device_count() > 0:
        best_idx = 0
        best_mem = -1
        props_best = None
        for idx in range(torch.cuda.device_count()):
            try:
                props = torch.cuda.get_device_properties(idx)
                mem = getattr(props, "total_memory", 0) or 0
                if mem > best_mem:
                    best_mem = mem
                    best_idx = idx
                    props_best = props
            except Exception:  # noqa: BLE001
                continue

        if props_best:
            logger.info("Selecting CUDA device cuda:%s (%s, %.2f GB)",
                        best_idx, props_best.name, best_mem / 1e9)
            return DeviceInfo(
                name=f"cuda:{best_idx} {props_best.name}",
                device=torch.device(f"cuda:{best_idx}"),
                amp=True,
                half=config.use_fp16,
                vram_bytes=best_mem,
            )

    # 3) DirectML/XPU (torch-directml)
    if hasattr(torch, "xpu") and torch.xpu.is_available():
        # torch.xpu does not expose VRAM; keep settings conservative
        logger.info("Selecting DirectML/XPU device")
        return DeviceInfo(name="directml/xpu",
                          device=torch.device("xpu"),
                          amp=False,
                          half=False)

    # 4) CPU fallback
    logger.info("Selecting CPU device")
    return DeviceInfo(name="cpu",
                      device=torch.device("cpu"),
                      amp=False,
                      half=False,
                      vram_bytes=None)


@dataclass
class LoadedModels:
    realesrgan: Optional[object] = None
    gfpgan: Optional[object] = None


_models = LoadedModels()


def _tile_defaults(device_info: DeviceInfo) -> Tuple[int, int]:
    tile = config.tile_size
    pad = config.tile_overlap

    # Conservative reductions for lower memory devices
    if device_info.vram_bytes:
        gb = device_info.vram_bytes / 1e9
        if gb < 4:
            tile = 96
        elif gb < 6:
            tile = 128
        elif gb < 8:
            tile = 192
        else:
            tile = config.tile_size
    elif device_info.name.startswith("directml"):
        tile = min(tile, 192)
    elif device_info.name == "cpu":
        tile = min(tile, 128)

    tile = max(64, int(tile))
    return tile, pad


def load_realesrgan(model_path: Path, scale: int = 4):
    if _models.realesrgan is not None:
        return _models.realesrgan
    try:
        from realesrgan import RealESRGANer  # type: ignore
        from basicsr.archs.rrdbnet_arch import RRDBNet  # type: ignore
    except ImportError as exc:
        raise RuntimeError("realesrgan package not installed") from exc

    device_info = get_device()
    model = RRDBNet(num_in_ch=3,
                    num_out_ch=3,
                    num_feat=64,
                    num_block=23,
                    num_grow_ch=32,
                    scale=scale)
    tile_size, tile_pad = _tile_defaults(device_info)
    upsampler = RealESRGANer(
        scale=scale,
        model_path=str(model_path),
        model=model,
        tile=tile_size,
        tile_pad=tile_pad,
        pre_pad=0,
        half=device_info.half,
        device=device_info.device,
    )
    _models.realesrgan = upsampler
    return upsampler


def load_gfpgan(model_path: Path):
    if _models.gfpgan is not None:
        return _models.gfpgan
    try:
        from gfpgan import GFPGANer  # type: ignore
    except ImportError as exc:
        raise RuntimeError("gfpgan package not installed") from exc

    device_info = get_device()
    restorer = GFPGANer(
        model_path=str(model_path),
        upscale=1,
        arch="clean",
        channel_multiplier=2,
        device=device_info.device,
    )
    _models.gfpgan = restorer
    return restorer


def warm_models(scales: tuple[int, ...] = (2, 4), include_gfpgan: bool = True):
    """Preload models to keep them resident between requests."""
    for s in scales:
        mp = config.models_dir / "realesrgan" / (
            "RealESRGAN_x2plus.pth" if s == 2 else "RealESRGAN_x4plus.pth")
        if mp.exists():
            try:
                load_realesrgan(mp, scale=s)
            except Exception:
                pass
    if include_gfpgan:
        gfp = config.models_dir / "gfpgan" / "GFPGANv1.4.pth"
        if gfp.exists():
            try:
                load_gfpgan(gfp)
            except Exception:
                pass
