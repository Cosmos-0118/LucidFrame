"""Shared pieces of the face-model benchmark: degradations, metrics and ONNX model wrappers.

Developer tooling only (see tools/bench/README.md). Weights and datasets live in the git-ignored `.bench/` folder.
"""
from __future__ import annotations

from pathlib import Path

import cv2
import numpy as np
import onnxruntime as ort

ROOT = Path(__file__).resolve().parent.parent.parent
WEIGHTS = ROOT / ".bench" / "weights"
ort.set_default_logger_severity(4)

# Landmarks GFPGAN/CodeFormer/GPEN expect on a 512 crop (the FFHQ alignment) and ArcFace expects on a 112 crop.
FFHQ_512 = np.array([[192.98138, 239.94708], [318.90277, 240.1936], [256.63416, 314.01935], [201.26117, 371.41043], [313.08905, 371.15118]], np.float32)
ARCFACE_112 = np.array([[38.2946, 51.6963], [73.5318, 51.5014], [56.0252, 71.7366], [41.5493, 92.3655], [70.7299, 92.2041]], np.float32)

# name -> (blur sigma, downscale, gaussian noise sigma, jpeg quality): the usual blind-face-restoration recipe.
LEVELS = {
    "mild": (1.5, 2, 3, 70),
    "medium": (3.0, 4, 6, 45),
    "severe": (5.0, 8, 10, 25),
}


def degrade(gt: np.ndarray, level: str, seed: int) -> np.ndarray:
    """RGB uint8 HxWx3 -> degraded RGB uint8 of the same size (low quality, upsampled back)."""
    sigma, down, noise, quality = LEVELS[level]
    rng = np.random.default_rng(seed)
    h, w = gt.shape[:2]
    x = cv2.GaussianBlur(gt, (0, 0), sigma)
    x = cv2.resize(x, (w // down, h // down), interpolation=cv2.INTER_AREA)
    x = np.clip(x.astype(np.float32) + rng.normal(0, noise, x.shape), 0, 255).astype(np.uint8)
    ok, enc = cv2.imencode(".jpg", x[:, :, ::-1], [cv2.IMWRITE_JPEG_QUALITY, quality])
    x = cv2.imdecode(enc, cv2.IMREAD_COLOR)[:, :, ::-1]
    return np.ascontiguousarray(cv2.resize(x, (w, h), interpolation=cv2.INTER_CUBIC))


# ───────────────────────────── metrics ─────────────────────────────

def psnr(a: np.ndarray, b: np.ndarray) -> float:
    mse = float(np.mean((a.astype(np.float64) - b.astype(np.float64)) ** 2))
    return 99.0 if mse == 0 else 10 * np.log10(255.0**2 / mse)


class Metrics:
    """PSNR, SSIM, LPIPS (lower is better) and ArcFace identity similarity (higher is better)."""

    def __init__(self):
        import lpips
        import torch

        self.torch = torch
        self.lpips = lpips.LPIPS(net="alex", verbose=False).eval()
        self.arc = ort.InferenceSession(str(WEIGHTS / "arcface_w600k_r50.onnx"), providers=["CPUExecutionProvider"])
        m, _ = cv2.estimateAffinePartial2D(FFHQ_512, ARCFACE_112, method=cv2.LMEDS)
        self.arc_warp = m

    def embed(self, img: np.ndarray) -> np.ndarray:
        crop = cv2.warpAffine(img, self.arc_warp, (112, 112), flags=cv2.INTER_AREA)
        blob = ((crop.astype(np.float32) - 127.5) / 127.5).transpose(2, 0, 1)[None]
        e = self.arc.run(None, {self.arc.get_inputs()[0].name: blob})[0][0]
        return e / np.linalg.norm(e)

    def lp(self, a: np.ndarray, b: np.ndarray) -> float:
        t = lambda x: self.torch.from_numpy(x.astype(np.float32) / 127.5 - 1).permute(2, 0, 1)[None]
        with self.torch.no_grad():
            return float(self.lpips(t(a), t(b)).item())

    def score(self, out: np.ndarray, gt: np.ndarray, gt_embed: np.ndarray | None = None) -> dict:
        from skimage.metrics import structural_similarity

        ge = self.embed(gt) if gt_embed is None else gt_embed
        return {
            "psnr": psnr(out, gt),
            "ssim": float(structural_similarity(out, gt, channel_axis=2)),
            "lpips": self.lp(out, gt),
            "id": float(np.dot(self.embed(out), ge)),
        }


# ───────────────────────────── restorers ─────────────────────────────

def session(name: str, providers=("CPUExecutionProvider",), threads: int = 0) -> ort.InferenceSession:
    so = ort.SessionOptions()
    so.log_severity_level = 4
    if threads:
        so.intra_op_num_threads = threads
    return ort.InferenceSession(str(WEIGHTS / f"{name}.onnx"), so, providers=list(providers))


class Restorer:
    """An aligned-512-crop face restorer behind one call: RGB uint8 512x512 -> RGB uint8 512x512."""

    def __init__(self, name: str, onnx: str, size: int = 512, providers=("CPUExecutionProvider",), **extra):
        self.name, self.size, self.extra = name, size, extra
        self.sess = session(onnx, providers)
        self.in_name = self.sess.get_inputs()[0].name
        self.has_weight = any(i.name == "weight" for i in self.sess.get_inputs())

    def __call__(self, img: np.ndarray) -> np.ndarray:
        x = img
        if x.shape[0] != self.size:
            x = cv2.resize(x, (self.size, self.size), interpolation=cv2.INTER_AREA)
        blob = ((x.astype(np.float32) / 255 - 0.5) / 0.5).transpose(2, 0, 1)[None]
        feeds = {self.in_name: blob}
        if self.has_weight:
            feeds["weight"] = np.array(self.extra.get("weight", 0.5), np.float64)
        y = self.sess.run(None, feeds)[0][0]
        y = np.clip((y.transpose(1, 2, 0) + 1) / 2, 0, 1)
        out = (y * 255 + 0.5).astype(np.uint8)
        if out.shape[0] != img.shape[0]:
            out = cv2.resize(out, (img.shape[1], img.shape[0]), interpolation=cv2.INTER_CUBIC)
        return out


def candidates(providers=("CPUExecutionProvider",)) -> dict[str, Restorer]:
    return {
        "gfpgan-1.4": Restorer("gfpgan-1.4", "gfpgan_1.4", providers=providers),
        "codeformer-w0.5": Restorer("codeformer-w0.5", "codeformer", providers=providers, weight=0.5),
        "codeformer-w0.8": Restorer("codeformer-w0.8", "codeformer", providers=providers, weight=0.8),
        "gpen-512": Restorer("gpen-512", "gpen_bfr_512", providers=providers),
        "restoreformer++": Restorer("restoreformer++", "restoreformer_plus_plus", providers=providers),
    }
