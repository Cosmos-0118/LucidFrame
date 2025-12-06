from __future__ import annotations

import logging
import shutil
import time
from pathlib import Path

from fastapi import UploadFile

from .config import config
from .jobs import jobs
from .pipelines.video import VideoPipelineError, process_video

logger = logging.getLogger("lucidframe")


def _ensure_temp(job_id: str) -> Path:
    job_dir = config.temp_dir / job_id
    job_dir.mkdir(parents=True, exist_ok=True)
    return job_dir


def cleanup_job_dir(job_id: str):
    job_dir = config.temp_dir / job_id
    try:
        shutil.rmtree(job_dir)
    except FileNotFoundError:
        return
    except Exception as exc:  # noqa: BLE001
        logger.warning("Failed to cleanup job dir %s: %s", job_dir, exc)


def start_video_job(file: UploadFile, scale: int, face_restore: bool,
                    interpolate: bool):
    job = jobs.create("video", message="queued")
    job_dir = _ensure_temp(job.id)
    started_at = time.perf_counter()
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
        duration = time.perf_counter() - started_at
        jobs.update(job.id,
                    status="completed",
                    message=f"done in {duration:.1f}s",
                    result_path=str(output_path))
        logger.info("Video job %s completed in %.2fs", job.id, duration)
    except VideoPipelineError as exc:
        jobs.update(job.id, status="failed", message=str(exc))
        cleanup_job_dir(job.id)
        logger.warning("Video job %s failed: %s", job.id, exc)
    except Exception as exc:  # noqa: BLE001
        jobs.update(job.id, status="failed", message=str(exc))
        cleanup_job_dir(job.id)
        logger.exception("Video job %s crashed", job.id)
    return job
