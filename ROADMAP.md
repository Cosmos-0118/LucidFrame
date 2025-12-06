# LucidFrame Implementation Roadmap

A pragmatic, step-by-step plan with checkboxes you can tick off. Ordered for quickest demo value while keeping reliability high.

## 0) Project Skeleton

- [x] Step 0.1: Create repo structure
  - `backend/` (FastAPI service), `frontend/` (Tauri/Electron app), `models/` (weights), `bin/` (FFmpeg), `scripts/` (utility scripts), `data/tmp/` (temp frames)
  - Add `.gitignore` for models, outputs, venv, build artifacts
- [x] Step 0.2: Pin runtime basics
  - Python 3.10/3.11, Node LTS; create `requirements.txt` and `package.json`
- [x] Step 0.3: Add `download_models.ps1` and a `models/manifest.json` stub
  - Keep URLs + optional SHA256 for Real-ESRGAN, GFPGAN, RIFE

## 1) Environment & Tooling

- [x] Step 1.1: Install core Python deps
  - `fastapi`, `uvicorn`, `pydantic`, `numpy`, `torch` (CUDA if available), `opencv-python`, `tqdm`
- [x] Step 1.2: Install model wrappers
  - `realesrgan` (or load weights manually via torch), `gfpgan`, `rife-ncnn` or torch-based RIFE
- [x] Step 1.3: Vendor FFmpeg
  - Place `ffmpeg.exe` in `bin/` or ensure PATH; add a startup check in backend

## 2) Backend API (FastAPI)

- [x] Step 2.1: App scaffold
  - `backend/main.py` with health endpoint and version info; load configs from `.env`/`config.yaml`
- [x] Step 2.2: Model loader service
  - Lazy-load models; support CPU/GPU detection; tile size config; half-precision toggle when CUDA available
- [x] Step 2.3: Image upscale endpoint
  - POST `/image/upscale` with file + params: mode (`photo|anime`), scale (`2|4`), `face_restore` (bool)
  - Return processed image bytes + basic timing
- [x] Step 2.4: Video upscale job endpoint
  - POST `/video/upscale` with file or path, params: scale (`2` for MVP), `face_restore` (false for MVP), `interpolate` (false for MVP)
  - Create job id; respond immediately; include polling endpoint `/jobs/{id}` for status + preview
- [x] Step 2.5: Job runner
  - Extract frames via FFmpeg -> `data/tmp/{job}/frames`
  - Process frames with Real-ESRGAN (tile-based if needed)
  - Reassemble video + audio via FFmpeg -> `data/tmp/{job}/output.mp4`
  - Generate short preview clip (first 3–5s) for UI
- [x] Step 2.6: Error handling & timeouts
  - Clear messages for missing GPU/VRAM; cleanup temp dirs on completion/failure

## 3) Core ML Pipelines

- [x] Step 3.1: Image pipeline module `backend/pipelines/image.py`
  - Load Real-ESRGAN model by preset; optional denoise/deblock strength; optional GFPGAN face restore blend
- [x] Step 3.2: Face restore integration
  - Run GFPGAN on detected faces; blend back into upscaled image; expose strength parameter (0–1)
- [x] Step 3.3: Video pipeline module `backend/pipelines/video.py`
  - Frame extraction, batch processing, progress callback; supports tile processing to fit VRAM
- [x] Step 3.4: Interpolation (later)
  - Add RIFE step guarded by flag; skip for MVP if time is short

## 4) Frontend (Tauri/Electron + React/Svelte)

- [x] Step 4.1: App shell
  - Drag-and-drop area; mode selectors (Photo/Anime, 2x/4x), face toggle; backend URL config
- [x] Step 4.2: Image flow UI
  - Upload, show spinner, then before/after slider; download button
- [x] Step 4.3: Video flow UI
  - Upload, start job, show progress + ETA; side-by-side player using preview clip; download final when ready
- [x] Step 4.4: Settings
  - Model directory path, FFmpeg path, GPU/CPU status, tile size, FP16 toggle

## 5) Reliability & Performance

- [x] Step 5.1: Tile-based inference defaults
  - Configure tile size (e.g., 200–256) and overlap to avoid seams; auto-adjust based on VRAM detection
- [x] Step 5.2: Caching/warm models
  - Keep models loaded between requests; reuse PyTorch device
- [x] Step 5.3: Resource cleanup
  - Temp folder GC; job TTL; capped concurrent jobs
- [x] Step 5.4: Logging & metrics
  - Basic request logs, durations, failure reasons; optional simple web dashboard for job statuses

## 6) Packaging

- [x] Step 6.1: One-liner setup scripts
  - `scripts/setup.ps1` to create venv, install deps, fetch models via manifest, verify FFmpeg
- [x] Step 6.2: Desktop packaging
  - Tauri/Electron build per OS; bundle FFmpeg or prompt user to install; include model download on first run
- [x] Step 6.3: Licenses and notices
  - Include notices for Real-ESRGAN, GFPGAN, RIFE, FFmpeg (see `NOTICES.md` and README credits)

## few touch up

- [x] Quick “Advanced” panel (per-request overrides)
  - Exposure/brightness, contrast, saturation sliders (0.5–1.5x)
  - Auto-enhance preset (applies mild denoise + sharpen + gamma lift)
  - Highlight text-safe preset for documents (disable face restore, boost sharpness)
- [x] Tone/lighting presets
  - “Night fix” (lift shadows, reduce color noise)
  - “Portrait clean” (light skin smoothing, gentle sharpen)
  - “Print-ready” (strong sharpen + neutral contrast)
- [x] Safeguards for wrong inputs
  - Detect tiny inputs and suggest upscale path; warn on huge >12MP with auto tile-downscale
  - Hash-based “same file” detection to skip re-upload and reuse cached result
- [x] Faster first-paint UX
  - Inline tiny skeleton shimmer for previews; optimistic status updates while backend warms

## 7) Demo Prep

- [ ] Step 7.1: Curate demo assets
  - A 240p clip and one face photo; store in `demo/`
- [ ] Step 7.2: Measure benchmarks
  - Time-to-result on target GPU and CPU; note limits (VRAM needed for 4x video)
- [ ] Step 7.3: Scripted flow
  - Pre-run models to warm cache; have outputs ready as backup

## 8) Stretch (post-MVP)

- [ ] Face clustering for “Old Memories” mode (simple DBSCAN on embeddings)
- [ ] Interpolation default-on for short clips; toggle in UI
- [ ] Batch processing queues; watch a folder for new media
- [ ] Auto-updater for models and app builds
