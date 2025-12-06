from __future__ import annotations

import functools
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

import torch

from .config import config


@dataclass
class DeviceInfo:
    name: str
    device: torch.device
    amp: bool
    half: bool


@functools.lru_cache(maxsize=1)
def get_device() -> DeviceInfo:
    # Prefer CUDA, then DirectML, then CPU
    if torch.cuda.is_available():
        device = torch.device("cuda")
        name = torch.cuda.get_device_name(device)
        return DeviceInfo(name=name,
                          device=device,
                          amp=True,
                          half=config.use_fp16)
    # torch-directml exposes torch.xpu if installed; fallback to CPU when not found
    if hasattr(torch, "xpu") and torch.xpu.is_available():
        device = torch.device("xpu")
        name = "directml/xpu"
        return DeviceInfo(name=name, device=device, amp=False, half=False)
    return DeviceInfo(name="cpu",
                      device=torch.device("cpu"),
                      amp=False,
                      half=False)


@dataclass
class LoadedModels:
    realesrgan: Optional[object] = None
    gfpgan: Optional[object] = None


_models = LoadedModels()


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
    upsampler = RealESRGANer(
        scale=scale,
        model_path=str(model_path),
        model=model,
        tile=config.tile_size,
        tile_pad=config.tile_overlap,
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
