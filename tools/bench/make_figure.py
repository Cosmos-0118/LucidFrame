"""Build docs/restore-compare.jpg from real app output.

Takes the faces at the 25th, 50th and 75th percentile of improvement (old -> new Restore) from compare_scenes.py's
results, regime A, so the picture shows typical results instead of the best ones; runs both versions of the app
on those scenes again and lays the faces side by side.

    python tools/bench/make_figure.py --before <worktree of the old commit> --after <repo> --node <node.exe>
"""
from __future__ import annotations

import argparse
import json
import tempfile
from pathlib import Path

import cv2
import numpy as np

from compare_scenes import REGIMES, degrade, run
from common import ROOT
from detectors import YuNet, detect

TILE = 230


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--before", type=Path, required=True)
    ap.add_argument("--after", type=Path, default=ROOT)
    ap.add_argument("--node", required=True)
    ap.add_argument("--out", type=Path, default=ROOT / "docs" / "restore-compare.jpg")
    args = ap.parse_args()
    args.before, args.after = args.before.resolve(), args.after.resolve()

    regime = next(r for r in REGIMES if r.startswith("A"))
    width, blur, noise, quality = REGIMES[regime]
    rows = [r for r in json.loads((ROOT / ".bench" / "out" / "compare_scenes.json").read_text()) if r["regime"] == regime]
    by = {(r["scene"], r["face"], r["variant"]): r for r in rows}
    keys = sorted({(r["scene"], r["face"]) for r in rows}, key=lambda k: by[k + ("before",)]["lpips"] - by[k + ("after",)]["lpips"])
    picks, seen = [], set()
    for q in (0.75, 0.5, 0.25):  # most improved first
        i = int(q * (len(keys) - 1))
        while keys[i][0] in seen and i < len(keys) - 1:
            i += 1  # one face per scene
        picks.append(keys[i])
        seen.add(keys[i][0])
        print(f"percentile {q:.0%}: {keys[i][0]} face {keys[i][1]}  LPIPS gain {by[keys[i] + ('before',)]['lpips'] - by[keys[i] + ('after',)]['lpips']:+.3f}")

    det = YuNet()
    strips = []
    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        for scene, face_idx in picks:
            gt = np.ascontiguousarray(cv2.imread(str(ROOT / ".bench" / "data" / "scenes" / scene))[:, :, ::-1])
            s = width / gt.shape[1]
            faces = [x for x in detect(det, gt) if x["score"] > 0.8 and (x["box"][2] - x["box"][0]) * s >= 14]
            kps = np.array(faces[face_idx]["kps"])
            lq = degrade(gt, width, blur, noise, quality)
            src = tmp / f"{Path(scene).stem}.jpg"
            cv2.imwrite(str(src), lq[:, :, ::-1], [cv2.IMWRITE_JPEG_QUALITY, 98])
            outs = {
                "photo": run(args.node, args.after, src, tmp / "o1" / src.stem, ["--faces", "off"]),
                "before": run(args.node, args.before, src, tmp / "o2" / src.stem, []),
                "after": run(args.node, args.after, src, tmp / "o3" / src.stem, []),
            }
            cx, cy = kps.mean(0)
            half = max(np.ptp(kps[:, 0]), np.ptp(kps[:, 1])) * 1.7
            box = [int(max(0, cx - half)), int(max(0, cy - half)), int(min(gt.shape[1], cx + half)), int(min(gt.shape[0], cy + half))]
            crop = lambda im: cv2.resize(cv2.resize(im, (gt.shape[1], gt.shape[0]), interpolation=cv2.INTER_AREA)[box[1] : box[3], box[0] : box[2]], (TILE, TILE), interpolation=cv2.INTER_AREA)
            tiles = [crop(cv2.resize(lq, (gt.shape[1], gt.shape[0]), interpolation=cv2.INTER_CUBIC))]
            for k in ("photo", "before", "after"):
                tiles.append(crop(np.ascontiguousarray(cv2.imread(str(outs[k]))[:, :, ::-1])))
            tiles.append(crop(gt))
            strips.append(np.concatenate(tiles, axis=1))

    labels = ["Input (bicubic)", "Photo model only", "Previous Restore", "Restore now", "Original"]
    head = np.full((34, TILE * 5, 3), 255, np.uint8)
    for i, text in enumerate(labels):
        cv2.putText(head, text, (i * TILE + 10, 23), cv2.FONT_HERSHEY_SIMPLEX, 0.55, (30, 30, 30), 1, cv2.LINE_AA)
    sheet = np.concatenate([head] + strips, axis=0)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    cv2.imwrite(str(args.out), sheet[:, :, ::-1], [cv2.IMWRITE_JPEG_QUALITY, 90])
    print("wrote", args.out, sheet.shape)


if __name__ == "__main__":
    main()
