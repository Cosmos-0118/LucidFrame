from __future__ import annotations

import shutil
import uuid
from pathlib import Path

from fastapi import UploadFile

from .config import config
from .jobs import jobs


def _ensure_temp(job_id: str) -> Path:
    job_dir = config.temp_dir / job_id
    job_dir.mkdir(parents=True, exist_ok=True)
    return job_dir


def start_video_job(file: UploadFile, scale: int, face_restore: bool,
                    interpolate: bool):
    job = jobs.create("video", message="queued")
    job_dir = _ensure_temp(job.id)
    try:
        # Save upload to disk
        ext = Path(file.filename or "video").suffix or ".mp4"
        input_path = job_dir / f"input{ext}"
        with input_path.open("wb") as f:
            shutil.copyfileobj(file.file, f)

        # Placeholder processing: copy input to output
        output_path = job_dir / "output.mp4"
        shutil.copyfile(input_path, output_path)

        jobs.update(job.id,
                    status="completed",
                    message="video processing placeholder",
                    result_path=str(output_path))
    except Exception as exc:  # noqa: BLE001
        jobs.update(job.id, status="failed", message=str(exc))
        # best-effort cleanup
        try:
            shutil.rmtree(job_dir)
        except Exception:
            pass
    return job
