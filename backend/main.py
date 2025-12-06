from __future__ import annotations

import logging
import threading
import time
from pathlib import Path

from fastapi import BackgroundTasks, FastAPI, File, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse

from .config import config
from .jobs import jobs
from .model_loader import get_device, warm_models
from .pipelines.image import ImagePipelineError, process_image
from .video_tasks import cleanup_job_dir, start_video_job

logging.basicConfig(level=logging.INFO,
                    format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("hyperrestore")

app = FastAPI(title=config.app_name, version=config.version)

app.add_middleware(
    CORSMiddleware,
    allow_origins=config.cors_origins,
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def log_requests(request: Request, call_next):
    start = time.perf_counter()
    try:
        response = await call_next(request)
    except Exception as exc:  # noqa: BLE001
        duration = time.perf_counter() - start
        logger.exception("%s %s failed in %.3fs", request.method,
                         request.url.path, duration)
        raise
    duration = time.perf_counter() - start
    response.headers.setdefault("X-Request-Time", f"{duration:.3f}")
    logger.info("%s %s -> %s in %.3fs", request.method, request.url.path,
                response.status_code, duration)
    return response


def _cleanup_orphan_dirs(max_age_minutes: int):
    removed = []
    cutoff = time.time() - (max_age_minutes * 60)
    if not config.temp_dir.exists():
        return removed
    for entry in config.temp_dir.iterdir():
        try:
            if not entry.is_dir():
                continue
            mtime = entry.stat().st_mtime
            if mtime < cutoff:
                cleanup_job_dir(entry.name)
                removed.append(entry.name)
        except Exception:  # noqa: BLE001
            continue
    return removed


def _cleanup_loop():
    while True:
        try:
            expired = jobs.prune_expired()
            for jid in expired:
                cleanup_job_dir(jid)
            removed = _cleanup_orphan_dirs(config.job_ttl_minutes)
            if expired or removed:
                logger.info("Cleanup removed jobs=%s dirs=%s", len(expired),
                            len(removed))
        except Exception:  # noqa: BLE001
            logger.exception("Cleanup loop error")
        time.sleep(config.cleanup_interval_minutes * 60)


def _start_cleanup_daemon():
    config.temp_dir.mkdir(parents=True, exist_ok=True)
    thread = threading.Thread(target=_cleanup_loop,
                              name="cleanup-daemon",
                              daemon=True)
    thread.start()


@app.on_event("startup")
async def _maybe_warm():
    _start_cleanup_daemon()
    if config.warm_models:
        warm_models()


@app.get("/health")
def health():
    dev = get_device()
    return {
        "status": "ok",
        "device": dev.name,
        "amp": dev.amp,
        "half": dev.half,
        "version": config.version,
    }


@app.get("/")
def root():
    return {"app": config.app_name, "version": config.version}


@app.post("/image/upscale")
async def image_upscale(
    file: UploadFile = File(...),
    mode: str = "photo",
    scale: int = 2,
    face_restore: bool = False,
    face_strength: float = 0.5,
    denoise_strength: float = 0.0,
    sharpen_strength: float = 0.0,
    text_mode: bool = False,
):
    try:
        buf, dt, dev = process_image(file,
                                     mode=mode,
                                     scale=scale,
                                     face_restore=face_restore,
                                     face_strength=face_strength,
                                     denoise_strength=denoise_strength,
                                     sharpen_strength=sharpen_strength,
                                     text_mode=text_mode)
    except ImagePipelineError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    headers = {
        "X-Process-Time": f"{dt:.3f}",
        "X-Device": dev.name,
    }
    return StreamingResponse(buf, media_type="image/png", headers=headers)


@app.post("/video/upscale")
async def video_upscale(
    file: UploadFile = File(...),
    scale: int = 2,
    face_restore: bool = False,
    interpolate: bool = False,
    background_tasks: BackgroundTasks = None,
):
    if jobs.running_count() >= config.max_concurrent_jobs:
        raise HTTPException(status_code=429,
                            detail="too many concurrent jobs; try again later")
    try:
        job = start_video_job(file,
                              scale=scale,
                              face_restore=face_restore,
                              interpolate=interpolate)
    except RuntimeError as exc:
        raise HTTPException(status_code=429, detail=str(exc))
    return {"job_id": job.id, "status": job.status, "message": job.message}


@app.get("/jobs")
async def jobs_summary():
    return jobs.summary()


@app.get("/jobs/{job_id}")
async def job_status(job_id: str):
    job = jobs.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="job not found")
    return job.to_dict()


@app.get("/jobs/{job_id}/result")
async def job_result(job_id: str):
    job = jobs.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="job not found")
    if not job.result_path:
        raise HTTPException(status_code=404, detail="result not ready")

    output_path = Path(job.result_path)
    try:
        if not output_path.resolve().is_relative_to(config.temp_dir.resolve()):
            raise HTTPException(status_code=400, detail="invalid result path")
    except Exception:
        raise HTTPException(status_code=400, detail="invalid result path")
    if not output_path.exists() or not output_path.is_file():
        raise HTTPException(status_code=404, detail="result file missing")

    media_type = "video/mp4" if output_path.suffix.lower(
    ) == ".mp4" else "application/octet-stream"
    return FileResponse(path=output_path,
                        media_type=media_type,
                        filename=output_path.name)
