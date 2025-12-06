from __future__ import annotations

from fastapi import BackgroundTasks, FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pathlib import Path

from fastapi import BackgroundTasks, FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse

from .config import config
from .model_loader import get_device
from .jobs import jobs
from .pipelines.image import ImagePipelineError, process_image
from .video_tasks import start_video_job

app = FastAPI(title=config.app_name, version=config.version)

app.add_middleware(
    CORSMiddleware,
    allow_origins=config.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


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
):
    try:
        buf, dt, dev = process_image(file,
                                     mode=mode,
                                     scale=scale,
                                     face_restore=face_restore,
                                     face_strength=face_strength,
                                     denoise_strength=denoise_strength)
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
    job = start_video_job(file,
                          scale=scale,
                          face_restore=face_restore,
                          interpolate=interpolate)
    return {"job_id": job.id, "status": job.status, "message": job.message}


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
