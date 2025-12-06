from __future__ import annotations

import shutil
from pathlib import Path

from fastapi import UploadFile

from .config import config
from .jobs import jobs
from .pipelines.video import VideoPipelineError, process_video


def _ensure_temp(job_id: str) -> Path:
    job_dir = config.temp_dir / job_id
    job_dir.mkdir(parents=True, exist_ok=True)
    return job_dir


def start_video_job(file: UploadFile, scale: int, face_restore: bool,
                    interpolate: bool):
    job = jobs.create("video", message="queued")
    job_dir = _ensure_temp(job.id)
    try:
        ext = Path(file.filename or "video").suffix or ".mp4"
        input_path = job_dir / f"input{ext}"
        with input_path.open("wb") as f:
            shutil.copyfileobj(file.file, f)

        output_path = job_dir / "output.mp4"
        jobs.update(job.id, status="running", message="processing")

        process_video(input_path,
                      output_path,
                      scale=scale,
                      interpolate=interpolate)
        jobs.update(job.id,
                    status="completed",
                    message="done",
                    result_path=str(output_path))
    except VideoPipelineError as exc:
        jobs.update(job.id, status="failed", message=str(exc))
        try:
            shutil.rmtree(job_dir)
        except Exception:
            pass
    except Exception as exc:  # noqa: BLE001
        jobs.update(job.id, status="failed", message=str(exc))
        try:
            shutil.rmtree(job_dir)
        except Exception:
            pass
    return job
