import io
from types import SimpleNamespace
from pathlib import Path

import cv2
import numpy as np
import pytest
from starlette.datastructures import UploadFile

from backend.pipelines import image as image_pipeline


@pytest.fixture()
def stubbed_models(tmp_path, monkeypatch):
    """Create dummy model files and stub heavy loaders so tweaks can be tested fast."""

    # Point models_dir to a temporary location with expected file names.
    models_dir = tmp_path / "models"
    realesrgan_dir = models_dir / "realesrgan"
    realesrgan_dir.mkdir(parents=True, exist_ok=True)
    dummy = realesrgan_dir / "RealESRGAN_x2plus.pth"
    dummy.touch()

    monkeypatch.setattr(image_pipeline.config, "models_dir", models_dir)

    class FakeUpsampler:

        def __init__(self):
            self.tile = 256

        def enhance(self, img, outscale):  # pragma: no cover - trivial stub
            return img.copy(), None

    monkeypatch.setattr(image_pipeline, "load_realesrgan",
                        lambda *args, **kwargs: FakeUpsampler())
    monkeypatch.setattr(image_pipeline, "load_gfpgan",
                        lambda *args, **kwargs: None)
    monkeypatch.setattr(
        image_pipeline, "get_device", lambda *args, **kwargs: SimpleNamespace(
            name="cpu", amp=False, half=False))

    return models_dir


def _make_upload(img: np.ndarray) -> UploadFile:
    ok, buf = cv2.imencode(".png", img)
    assert ok, "Failed to encode test image"
    bio = io.BytesIO(buf.tobytes())
    return UploadFile(filename="test.png", file=bio)


def _run_and_decode(**kwargs) -> tuple[np.ndarray, dict]:
    buf, _dt, _dev, meta = image_pipeline.process_image(**kwargs)
    out = cv2.imdecode(np.frombuffer(buf.getbuffer(), np.uint8),
                       cv2.IMREAD_COLOR)
    return out, meta


def test_brightness_increases_output_mean(stubbed_models):
    # Base mid-gray image
    base_img = np.full((16, 16, 3), 100, dtype=np.uint8)

    out_neutral, meta_neutral = _run_and_decode(file=_make_upload(base_img),
                                                brightness=1.0)
    out_bright, meta_bright = _run_and_decode(file=_make_upload(base_img),
                                              brightness=1.4)

    assert out_neutral is not None and out_bright is not None
    assert out_bright.mean() > out_neutral.mean()
    # Pipeline should still emit metadata
    assert "mp" in meta_bright


def test_brightness_respects_validation_bounds(stubbed_models):
    with pytest.raises(image_pipeline.ImagePipelineError):
        _run_and_decode(file=_make_upload(np.zeros((4, 4, 3), dtype=np.uint8)),
                        brightness=0.1)

    with pytest.raises(image_pipeline.ImagePipelineError):
        _run_and_decode(file=_make_upload(np.zeros((4, 4, 3), dtype=np.uint8)),
                        brightness=2.2)
