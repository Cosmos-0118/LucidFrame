"""Old vs new Restore pipeline on the README's example: the public-domain portrait, degraded four ways.

Both versions are run through their own CLI (`bin/lucidframe.js`), so what is measured is what users get.

    python tools/bench/compare_versions.py --before <worktree of the old commit> --after <this repo> --node <node.exe>

LPIPS (lower is better) and ArcFace identity similarity (higher is better) are computed against the original photo,
with the 4x results brought back to the original size. "Face" is the face box of the fixture.
"""
from __future__ import annotations

import argparse
import subprocess
import tempfile
from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageFilter

from common import ARCFACE_112, ROOT, Metrics
from detectors import YuNet, detect

FACE = (179, 63, 91, 111)  # left, top, width, height in the 512x512 fixture


def make_input(gt: Image.Image, name: str, out: Path) -> Path:
    if name == "192 px wide, JPEG q20":
        im, q = gt.resize((192, 192), Image.LANCZOS), 20
    elif name == "320 px wide, JPEG q15":
        im, q = gt.resize((320, 320), Image.LANCZOS), 15
    elif name == "Out of focus, JPEG q60":
        im, q = gt.resize((256, 256), Image.LANCZOS).filter(ImageFilter.GaussianBlur(2.5)), 60
    else:
        im, q = gt.resize((384, 384), Image.LANCZOS), 70
    path = out / (name.replace(" ", "_").replace(",", "") + ".jpg")
    im.save(path, quality=q)
    return path


def run(node: str, repo: Path, src: Path, out_dir: Path, extra: list[str]) -> Path:
    out_dir.mkdir(parents=True, exist_ok=True)
    cmd = [node, str(repo / "bin" / "lucidframe.js"), str(src), "-m", "photo", "-s", "4", "--format", "png", "--out-dir", str(out_dir), *extra]
    r = subprocess.run(cmd, cwd=repo, capture_output=True, text=True, env={**__import__("os").environ, "LUCIDFRAME_LOG_LEVEL": "error"})
    if r.returncode != 0:
        raise SystemExit(f"{' '.join(cmd)}\n{r.stdout}\n{r.stderr}")
    return next(out_dir.glob(f"{src.stem}_lucid_4x*.png"))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--before", type=Path, required=True)
    ap.add_argument("--after", type=Path, default=ROOT)
    ap.add_argument("--node", required=True)
    args = ap.parse_args()
    args.before, args.after = args.before.resolve(), args.after.resolve()

    gt_path = ROOT / "tests" / "fixtures" / "portrait.jpg"
    gt = Image.open(gt_path).convert("RGB")
    gt_np = np.asarray(gt)
    metrics = Metrics()
    kps = np.array(max(detect(YuNet(), gt_np), key=lambda f: f["score"])["kps"], np.float32)  # landmarks of the real face
    warp, _ = cv2.estimateAffinePartial2D(kps, ARCFACE_112, method=cv2.LMEDS)

    def identity(a: np.ndarray, b: np.ndarray) -> float:
        # the portrait is not FFHQ-aligned, so align both images by the real landmarks (outputs share its geometry)
        emb = lambda im: (lambda e: e / np.linalg.norm(e))(metrics.arc.run(None, {metrics.arc.get_inputs()[0].name: ((cv2.warpAffine(im, warp, (112, 112), flags=cv2.INTER_AREA).astype(np.float32) - 127.5) / 127.5).transpose(2, 0, 1)[None]})[0][0])
        return float(np.dot(emb(a), emb(b)))

    l, t, w, h = FACE
    cases = ["192 px wide, JPEG q20", "320 px wide, JPEG q15", "Out of focus, JPEG q60", "384 px wide, JPEG q70 (mild)"]
    print(f"{'input':<30}{'method':<26}{'face LPIPS':>11}{'whole LPIPS':>12}{'face ID':>9}")
    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        for case in cases:
            src = make_input(gt, case, tmp)
            lq = np.asarray(Image.open(src).convert("RGB"))
            rows = [("Bicubic", cv2.resize(lq, (512, 512), interpolation=cv2.INTER_CUBIC))]
            for label, repo, extra, sub in (
                ("Photo model only", args.after, ["--cleanup", "off", "--faces", "off"], "photo"),
                ("Restore, before", args.before, [], "before"),
                ("Restore, after", args.after, [], "after"),
            ):
                out = run(args.node, repo, src, tmp / sub / case.split(",")[0].replace(" ", "_"), extra)
                rows.append((label, cv2.resize(np.asarray(Image.open(out).convert("RGB")), (512, 512), interpolation=cv2.INTER_AREA)))
            for label, img in rows:
                face_lp = metrics.lp(cv2.resize(img[t : t + h, l : l + w], (128, 128), interpolation=cv2.INTER_AREA), cv2.resize(gt_np[t : t + h, l : l + w], (128, 128), interpolation=cv2.INTER_AREA))
                whole_lp = metrics.lp(img, gt_np)
                ident = identity(img, gt_np)
                print(f"{case:<30}{label:<26}{face_lp:11.3f}{whole_lp:12.3f}{ident:9.3f}", flush=True)
            print()


if __name__ == "__main__":
    main()
