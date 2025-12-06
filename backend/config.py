import os
from pathlib import Path
from pydantic import BaseModel


def _env_path(key: str, default: Path) -> Path:
    value = os.environ.get(key)
    if value:
        return Path(value)
    return default


def _env_bool(key: str, default: bool) -> bool:
    value = os.environ.get(key)
    if value is None:
        return default
    return value.lower() in {"1", "true", "yes", "on"}


class AppConfig(BaseModel):
    app_name: str = "lucidframe-backend"
    version: str = "1.0.0"
    models_dir: Path = _env_path(
        "LUCIDFRAME_MODELS",
        Path(__file__).resolve().parent.parent / "models")
    temp_dir: Path = _env_path(
        "LUCIDFRAME_TEMP",
        Path(__file__).resolve().parent.parent / "data" / "tmp")
    ffmpeg_path: Path | None = _env_path(
        "LUCIDFRAME_FFMPEG",
        Path(__file__).resolve().parent.parent / "bin" / "ffmpeg.exe")
    tile_size: int = 256  # upper target tile size
    tile_overlap: int = 24
    use_fp16: bool = _env_bool("LUCIDFRAME_FP16", True)
    warm_models: bool = _env_bool("LUCIDFRAME_WARM", False)
    job_ttl_minutes: int = 45
    cleanup_interval_minutes: int = 10
    max_jobs: int = 200
    max_concurrent_jobs: int = 1
    cors_origins: list[str] = ["*"]  # allow all origins for dev UI


config = AppConfig()
