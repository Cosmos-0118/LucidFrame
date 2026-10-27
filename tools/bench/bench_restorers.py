"""Benchmark aligned-face restorers on degraded FFHQ faces.

    python tools/bench/bench_restorers.py --n 24 --out .bench/out/restorers

Writes results.json (per image and per model), a summary table, and side-by-side montages for eyeballing.
"""
from __future__ import annotations

import argparse
import json
import time
from pathlib import Path

import cv2
import numpy as np

from common import LEVELS, ROOT, Metrics, candidates, degrade


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--gt", type=Path, default=ROOT / ".bench" / "data" / "gt")
    ap.add_argument("--out", type=Path, default=ROOT / ".bench" / "out" / "restorers")
    ap.add_argument("--n", type=int, default=24)
    ap.add_argument("--montage", type=int, default=6, help="how many images get a montage")
    args = ap.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)

    files = sorted(args.gt.glob("*.png"))[: args.n]
    metrics = Metrics()
    models = candidates()
    rows = []
    t_model = {k: 0.0 for k in models}
    calls = {k: 0 for k in models}

    for idx, f in enumerate(files):
        gt = cv2.imread(str(f))[:, :, ::-1]
        ge = metrics.embed(gt)
        for level in LEVELS:
            lq = degrade(gt, level, seed=1000 + idx)
            outs = {"input (bicubic)": lq}
            for name, m in models.items():
                t = time.perf_counter()
                outs[name] = m(lq)
                t_model[name] += time.perf_counter() - t
                calls[name] += 1
            for name, o in outs.items():
                rows.append({"image": f.name, "level": level, "model": name, **metrics.score(o, gt, ge)})
            if idx < args.montage:
                strip = np.concatenate([lq] + [o for k, o in outs.items() if k != "input (bicubic)"] + [gt], axis=1)
                cv2.imwrite(str(args.out / f"{f.stem}_{level}.jpg"), strip[:, :, ::-1], [cv2.IMWRITE_JPEG_QUALITY, 90])
        print(f"{idx + 1}/{len(files)} {f.name}", flush=True)

    (args.out / "results.json").write_text(json.dumps(rows, indent=1))
    names = list(dict.fromkeys(r["model"] for r in rows))
    print("\nmodels in montage order: input |", " | ".join(n for n in names if n != "input (bicubic)"), "| ground truth\n")
    for level in LEVELS:
        print(f"== {level} (blur/down/noise/jpeg = {LEVELS[level]})")
        print(f"{'model':<20}{'PSNR':>7}{'SSIM':>7}{'LPIPS':>8}{'ID-sim':>8}")
        for n in names:
            sel = [r for r in rows if r["level"] == level and r["model"] == n]
            avg = lambda k: np.mean([r[k] for r in sel])
            print(f"{n:<20}{avg('psnr'):7.2f}{avg('ssim'):7.3f}{avg('lpips'):8.3f}{avg('id'):8.3f}")
    print("\nCPU seconds per 512 crop:", {k: round(t_model[k] / max(1, calls[k]), 2) for k in models})


if __name__ == "__main__":
    main()
