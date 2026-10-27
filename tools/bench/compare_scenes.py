"""Old vs new Restore pipeline through the real CLI, on many faces in several kinds of damage.

Each public-domain group photo (.bench/data/scenes) is degraded, then upscaled 4x by both versions of the app with
default options, i.e. including the JPEG/blur cleanup stage and the app's own decisions. Faces are scored against the
full-resolution original.

    python tools/bench/compare_scenes.py --before <worktree of the old commit> --after <repo> --node <node.exe>
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import tempfile
from pathlib import Path

import cv2
import numpy as np

from bench_pipeline import face_score
from common import ROOT, Metrics
from detectors import YuNet, detect

# name -> (width, blur sigma, noise sigma, jpeg quality)
REGIMES = {
    "A  640 px, JPEG q50": (640, 0.8, 3, 50),
    "B  640 px, soft (blur 2.0), JPEG q60": (640, 2.0, 3, 60),
    "C  960 px, JPEG q70": (960, 0.8, 3, 70),
}


def degrade(gt: np.ndarray, width: int, blur: float, noise: float, quality: int) -> np.ndarray:
    s = width / gt.shape[1]
    x = cv2.GaussianBlur(gt, (0, 0), blur)
    x = cv2.resize(x, (width, round(gt.shape[0] * s)), interpolation=cv2.INTER_AREA)
    x = np.clip(x.astype(np.float32) + np.random.default_rng(7).normal(0, noise, x.shape), 0, 255).astype(np.uint8)
    ok, enc = cv2.imencode(".jpg", np.ascontiguousarray(x[:, :, ::-1]), [cv2.IMWRITE_JPEG_QUALITY, quality])
    return cv2.imdecode(enc, cv2.IMREAD_COLOR)[:, :, ::-1]


def run(node: str, repo: Path, src: Path, out_dir: Path, extra: list[str]) -> Path:
    out_dir.mkdir(parents=True, exist_ok=True)
    cmd = [node, str(repo / "bin" / "lucidframe.js"), str(src), "-m", "photo", "-s", "4", "--format", "png", "--out-dir", str(out_dir), *extra]
    r = subprocess.run(cmd, cwd=repo, capture_output=True, text=True, env={**os.environ, "LUCIDFRAME_LOG_LEVEL": "error"})
    if r.returncode != 0:
        raise SystemExit(f"{' '.join(cmd)}\n{r.stdout}\n{r.stderr}")
    return next(out_dir.glob(f"{src.stem}_lucid_4x*.png"))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--before", type=Path, required=True)
    ap.add_argument("--after", type=Path, default=ROOT)
    ap.add_argument("--node", required=True)
    ap.add_argument("--scenes", type=int, default=12)
    ap.add_argument("--regimes", nargs="*", default=list(REGIMES))
    args = ap.parse_args()
    args.before, args.after = args.before.resolve(), args.after.resolve()

    metrics, det = Metrics(), YuNet()
    scenes = sorted((ROOT / ".bench" / "data" / "scenes").glob("*.jpg"))[: args.scenes]
    rows = []
    for regime in args.regimes:
        width, blur, noise, quality = REGIMES[regime]
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            for f in scenes:
                gt = np.ascontiguousarray(cv2.imread(str(f))[:, :, ::-1])
                s = width / gt.shape[1]
                gt_faces = [x for x in detect(det, gt) if x["score"] > 0.8 and (x["box"][2] - x["box"][0]) * s >= 14]
                if not gt_faces:
                    continue
                src = tmp / f"{f.stem}.jpg"
                cv2.imwrite(str(src), degrade(gt, width, blur, noise, quality)[:, :, ::-1], [cv2.IMWRITE_JPEG_QUALITY, 98])
                # the source is re-encoded at q98 on top of the degradation; the degradation itself already is the JPEG
                outputs = {
                    "photo model, no faces": run(args.node, args.after, src, tmp / "o_nofaces" / f.stem, ["--faces", "off"]),
                    "before": run(args.node, args.before, src, tmp / "o_before" / f.stem, []),
                    "after": run(args.node, args.after, src, tmp / "o_after" / f.stem, []),
                }
                imgs = {k: np.ascontiguousarray(cv2.imread(str(p))[:, :, ::-1]) for k, p in outputs.items()}
                for i, g in enumerate(gt_faces):
                    for k, im in imgs.items():
                        sc = face_score(metrics, im, gt, g["kps"], 1 / s)
                        if sc:
                            rows.append({"regime": regime, "scene": f.name, "face": i, "variant": k, **sc})
                print(f"{regime[:1]} {f.name}: {len(gt_faces)} faces", flush=True)

    out = ROOT / ".bench" / "out" / "compare_scenes.json"
    out.write_text(json.dumps(rows, indent=1))
    for regime in args.regimes:
        sel = [r for r in rows if r["regime"] == regime]
        keys = sorted({(r["scene"], r["face"]) for r in sel})
        by = {(r["scene"], r["face"], r["variant"]): r for r in sel}
        print(f"\n== {regime}: {len(keys)} faces")
        print(f"{'variant':<24}{'LPIPS':>8}{'ID-sim':>8}")
        for v in ("photo model, no faces", "before", "after"):
            print(f"{v:<24}{np.mean([by[k + (v,)]['lpips'] for k in keys]):8.3f}{np.mean([by[k + (v,)]['id'] for k in keys]):8.3f}")
        for m, better in (("lpips", lambda d: d < 0), ("id", lambda d: d > 0)):
            d = np.array([by[k + ("after",)][m] - by[k + ("before",)][m] for k in keys])
            print(f"  after - before, {m:<5} {d.mean():+.4f} ± {1.96 * d.std(ddof=1) / len(d) ** 0.5:.4f}   after better on {better(d).mean():.0%} of faces")


if __name__ == "__main__":
    main()
