# LucidFrame

Offline-first image and video upscaler with Real-ESRGAN + GFPGAN, packaged for desktop (Electron) with a FastAPI backend.

## Features

- Image upscale with before/after reveal slider (2x/4x, photo/anime/clean, optional face restore, sharpen/text-safe). Clean mode uses ESRNet for lower-artifact 4x.
- Video upscale jobs with polling, optional face restore/interpolation toggle, preview and download. Interpolation currently inserts blended mid-frames (no external deps) and doubles FPS.
- GPU auto-selection with CUDA preference and FP16 toggle; falls back to DirectML/CPU.
- Packaged builds include backend exe, models folder, and ffmpeg binary.

## Quickstart (dev)

1. Requirements: Node 18+, Python 3.11, Git, and (optional) CUDA-enabled GPU drivers.
2. Install deps: `npm install` (frontend/Electron) and `python -m venv .venv && .venv/Scripts/pip install -r requirements.txt`.
3. Fetch models/ffmpeg: `powershell -ExecutionPolicy Bypass -File scripts/setup.ps1`.
4. Run backend for dev: `uvicorn backend.main:app --host 127.0.0.1 --port 8000` (env uses `.venv`).
5. Run frontend dev: `npm run dev` (serves Vite at 5173). In another shell: `npm run dev:electron` to open the desktop app.

## Build & Package

- One-shot build (clean → frontend → backend exe → Windows installer): `node scripts/build-all.js`
- Individual steps:
  - Frontend: `npm run build:front`
  - Backend exe: `npm run build:backend`
  - Windows app: `npm run dist:win`

## Runtime Notes

- Backend env overrides: `LUCIDFRAME_DEVICE` (e.g., `cuda:0`, `cpu`), `LUCIDFRAME_MODELS`, `LUCIDFRAME_FFMPEG`, `LUCIDFRAME_TEMP`, `LUCIDFRAME_FP16`.
- Models live in `models/`; ffmpeg binary is `bin/ffmpeg.exe` (bundled into builds).
- App stores user resources under `%APPDATA%/LucidFrame/resources` when packaged.

## Credits & Notices

- Real-ESRGAN (MIT): https://github.com/xinntao/Real-ESRGAN
- GFPGAN (Apache-2.0): https://github.com/TencentARC/GFPGAN
- RIFE (Apache-2.0): https://github.com/megvii-research/ECCV2022-RIFE
- FFmpeg (LGPL/GPL): https://ffmpeg.org/ (binary from https://github.com/BtbN/FFmpeg-Builds)

See `NOTICES.md` for the consolidated notices and licensing details.
