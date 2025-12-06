"""Entry point for the frozen backend service.
Runs uvicorn against backend.main:app and respects environment overrides.
"""
from __future__ import annotations

import multiprocessing
import os
import sys
from pathlib import Path

import uvicorn

# Avoid TBB dependency in numba when running the frozen backend.
os.environ.setdefault("NUMBA_THREADING_LAYER", "workqueue")


def _ensure_backend_on_path():
    """Add bundled backend and bundled deps to sys.path when frozen."""
    if getattr(sys, "frozen", False):
        base_dir = Path(sys._MEIPASS)  # type: ignore[attr-defined]
    else:
        base_dir = Path(__file__).resolve().parent

    for rel in ("backend", "basicsr", "realesrgan"):
        candidate = base_dir / rel
        if candidate.exists():
            sys.path.insert(0, str(candidate))


_ensure_backend_on_path()
from backend.main import app  # noqa: E402  # after path fix


def main() -> None:
    host = os.getenv("LUCIDFRAME_HOST", "127.0.0.1")
    port = int(os.getenv("LUCIDFRAME_PORT", "8000"))
    workers = int(os.getenv("LUCIDFRAME_WORKERS", "1"))

    uvicorn.run(
        app,
        host=host,
        port=port,
        workers=workers,
        log_config=None,
    )


if __name__ == "__main__":
    multiprocessing.freeze_support()
    main()
