"""Compare face detectors on real group photos.

Reference faces = what the strongest detector finds in the full-resolution scene (confirmed by the union of all
detectors with a score above 0.8). Each detector is then scored on the same scene shrunk and degraded, which is the
situation face restoration actually has to handle: small, soft, compressed faces.

    python tools/bench/bench_detectors.py
"""
from __future__ import annotations

import json
import time

import cv2
import numpy as np

from common import ROOT
from detectors import Scrfd, YuNet, detect, nms


def center(b):
    return ((b[0] + b[2]) / 2, (b[1] + b[3]) / 2)


def matches(face, refs, scale):
    cx, cy = center(face["box"])
    for r in refs:
        rx, ry = center([v * scale for v in r["box"]])
        rw = (r["box"][2] - r["box"][0]) * scale
        if abs(cx - rx) < rw * 0.5 and abs(cy - ry) < rw * 0.5:
            return True
    return False


def main():
    scenes = sorted((ROOT / ".bench" / "data" / "scenes").glob("*.jpg"))
    dets = [YuNet(), Scrfd("scrfd_2.5g"), Scrfd("retinaface_10g")]
    dets[1].name, dets[2].name = "scrfd-2.5g", "scrfd-10g"

    results = {d.name: {"recall": [], "extra": [], "t": 0.0, "n": 0} for d in dets}
    ref_total = 0
    for f in scenes:
        img = cv2.imread(str(f))[:, :, ::-1]
        found = {d.name: detect(d, img) for d in dets}
        # reference: faces the strongest model sees plus anything two detectors agree on at high confidence
        refs = [x for x in found["scrfd-10g"] if x["score"] > 0.6]
        for d in dets:
            if d.name == "scrfd-10g":
                continue
            for x in found[d.name]:
                if x["score"] > 0.8 and not matches(x, refs, 1.0):
                    refs.append(x)
        refs = nms(refs)
        ref_total += len(refs)
        print(f"{f.name:<28} reference faces {len(refs):>2} | " + "  ".join(f"{d.name} {len(found[d.name])}" for d in dets), flush=True)

        for width, quality in ((900, 70), (480, 45), (300, 30)):
            s = width / img.shape[1]
            if s >= 1:
                continue
            small = cv2.resize(img, (width, round(img.shape[0] * s)), interpolation=cv2.INTER_AREA)
            ok, enc = cv2.imencode(".jpg", small[:, :, ::-1], [cv2.IMWRITE_JPEG_QUALITY, quality])
            small = cv2.imdecode(enc, cv2.IMREAD_COLOR)[:, :, ::-1]
            # only faces still at least 14 px wide are fair to ask for
            fair = [r for r in refs if (r["box"][2] - r["box"][0]) * s >= 14]
            for d in dets:
                t = time.perf_counter()
                got = detect(d, small)
                results[d.name]["t"] += time.perf_counter() - t
                results[d.name]["n"] += 1
                hit = sum(1 for r in fair if any(matches(g, [r], s) for g in got))
                extra = sum(1 for g in got if not matches(g, refs, s))
                results[d.name]["recall"].append((width, hit, len(fair)))
                results[d.name]["extra"].append((width, extra))

    print(f"\n{ref_total} reference faces in {len(scenes)} scenes")
    print(f"{'detector':<12}" + "".join(f"{'recall@' + str(w) + 'px':>16}{'false+':>8}" for w in (900, 480, 300)) + f"{'sec/img':>9}")
    for d in dets:
        r = results[d.name]
        row = f"{d.name:<12}"
        for w in (900, 480, 300):
            hit = sum(h for ww, h, n in r["recall"] if ww == w)
            tot = sum(n for ww, h, n in r["recall"] if ww == w)
            fp = sum(e for ww, e in r["extra"] if ww == w)
            row += f"{100 * hit / max(1, tot):>15.1f}%{fp:>8}"
        print(row + f"{r['t'] / max(1, r['n']):>9.2f}")
    (ROOT / ".bench" / "out" / "detectors.json").write_text(json.dumps(results, indent=1))


if __name__ == "__main__":
    main()
