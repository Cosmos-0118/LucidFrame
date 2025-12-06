from pathlib import Path
from pydantic import BaseModel


class AppConfig(BaseModel):
    app_name: str = "hyperrestore-backend"
    version: str = "0.1.0"
    models_dir: Path = Path(__file__).resolve().parent.parent / "models"
    temp_dir: Path = Path(__file__).resolve().parent.parent / "data" / "tmp"
    ffmpeg_path: Path | None = Path(
        __file__).resolve().parent.parent / "bin" / "ffmpeg.exe"
    tile_size: int = 256  # upper target tile size
    tile_overlap: int = 24
    use_fp16: bool = True
    warm_models: bool = False
    job_ttl_minutes: int = 45
    cleanup_interval_minutes: int = 10
    max_jobs: int = 200
    max_concurrent_jobs: int = 1
    cors_origins: list[str] = ["*"]  # allow all origins for dev UI


config = AppConfig()
