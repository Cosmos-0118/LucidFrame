from pathlib import Path
from pydantic import BaseModel


class AppConfig(BaseModel):
    app_name: str = "hyperrestore-backend"
    version: str = "0.1.0"
    models_dir: Path = Path(__file__).resolve().parent.parent / "models"
    temp_dir: Path = Path(__file__).resolve().parent.parent / "data" / "tmp"
    ffmpeg_path: Path | None = Path(
        __file__).resolve().parent.parent / "bin" / "ffmpeg.exe"
    tile_size: int = 256
    tile_overlap: int = 16
    use_fp16: bool = True
    cors_origins: list[str] = [
        "http://localhost:5173",
        "http://127.0.0.1:5173",
    ]


config = AppConfig()
