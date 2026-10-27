"""End-to-end face restoration on real, unaligned photos: detect -> align -> restore -> paste back.

The app's JS pipeline is prototyped here so that restorer / mask / colour choices can be compared on the same
upscaled image. Every scene is degraded (shrunk, blurred, compressed), upscaled with the shipped photo model,
then each variant redraws the faces. Faces are scored against the original full-resolution photo.

    python tools/bench/bench_pipeline.py --width 360
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import cv2
import numpy as np

from common import ARCFACE_112, FFHQ_512, ROOT, Metrics, Restorer, session
from detectors import YuNet, detect

OUT = ROOT / ".bench" / "out" / "pipeline"


# ───────────────────────────── upscaling (shipped model) ─────────────────────────────

class Upscaler:
    def __init__(self, providers=("DmlExecutionProvider", "CPUExecutionProvider")):
        self.s = session("photo_shipped", providers)

    def __call__(self, rgb: np.ndarray, tile=192, pad=16) -> np.ndarray:
        h, w = rgb.shape[:2]
        out = np.zeros((h * 4, w * 4, 3), np.float32)
        wsum = np.zeros((h * 4, w * 4, 1), np.float32)
        step = tile - 2 * pad
        for y in range(0, h, step):
            for x in range(0, w, step):
                y0, x0 = max(0, y - pad), max(0, x - pad)
                y1, x1 = min(h, y + step + pad), min(w, x + step + pad)
                blob = (rgb[y0:y1, x0:x1].astype(np.float32) / 255).transpose(2, 0, 1)[None]
                res = self.s.run(None, {self.s.get_inputs()[0].name: blob})[0][0].transpose(1, 2, 0)
                # drop the context margin, keep the tile interior
                ty0, tx0 = (y - y0) * 4, (x - x0) * 4
                ty1, tx1 = ty0 + min(step, h - y) * 4, tx0 + min(step, w - x) * 4
                out[y * 4 : y * 4 + (ty1 - ty0), x * 4 : x * 4 + (tx1 - tx0)] += res[ty0:ty1, tx0:tx1]
                wsum[y * 4 : y * 4 + (ty1 - ty0), x * 4 : x * 4 + (tx1 - tx0)] += 1
        return np.clip(out / np.maximum(wsum, 1) * 255 + 0.5, 0, 255).astype(np.uint8)


# ───────────────────────────── masks and colour ─────────────────────────────

def ellipse_mask(size=512) -> np.ndarray:
    """The mask the app uses today: head-wide ellipse easing to 0 at the crop edge."""
    y, x = np.mgrid[0:size, 0:size].astype(np.float32)
    d = np.hypot((x - size * 0.5) / (size * 0.5), (y - size * 0.53) / (size * 0.52))
    t = np.clip((1 - d) / (1 - 0.66), 0, 1)
    return t * t * (3 - 2 * t)


class Parser:
    """BiSeNet face parsing (CelebAMask-HQ labels) -> soft mask of the facial region."""

    SKIN_AND_FEATURES = (1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13)  # skin, brows, eyes, glasses, ears, nose, mouth, lips
    WITH_HAIR = SKIN_AND_FEATURES + (14, 17)  # + neck, hair

    def __init__(self, name="bisenet_resnet_18"):
        self.s = session(name)
        self.mean = np.array([0.485, 0.456, 0.406], np.float32)
        self.std = np.array([0.229, 0.224, 0.225], np.float32)

    def labels(self, crop512: np.ndarray) -> np.ndarray:
        blob = ((crop512.astype(np.float32) / 255 - self.mean) / self.std).transpose(2, 0, 1)[None]
        return self.s.run(None, {self.s.get_inputs()[0].name: blob})[0][0].argmax(0)

    def mask(self, crop512: np.ndarray, keep, blur=21, erode=12) -> np.ndarray:
        m = np.isin(self.labels(crop512), keep).astype(np.float32)
        if erode:
            m = cv2.erode(m, np.ones((erode, erode), np.uint8))
        m = cv2.GaussianBlur(m, (0, 0), blur / 2)
        # never reach the crop border: the restorer's context there is poor
        border = np.ones_like(m)
        border[:24], border[-24:], border[:, :24], border[:, -24:] = 0, 0, 0, 0
        return m * cv2.GaussianBlur(border, (0, 0), 12)


def keep_colours(restored: np.ndarray, original: np.ndarray, radius=8, amount=0.85) -> np.ndarray:
    """restored + amount * (lowpass(original) - lowpass(restored)), as faces.js does."""
    low = lambda a: cv2.blur(cv2.blur(cv2.blur(a, (2 * radius + 1,) * 2), (2 * radius + 1,) * 2), (2 * radius + 1,) * 2)
    r, o = restored.astype(np.float32), original.astype(np.float32)
    return np.clip(r + amount * (low(o) - low(r)), 0, 255)


def paste(image: np.ndarray, crop_m: np.ndarray, restored: np.ndarray, mask: np.ndarray, weight=1.0) -> np.ndarray:
    h, w = image.shape[:2]
    inv = cv2.invertAffineTransform(crop_m)
    back = cv2.warpAffine(restored.astype(np.float32), inv, (w, h), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT)
    m = cv2.warpAffine(mask, inv, (w, h), flags=cv2.INTER_LINEAR)[:, :, None] * weight
    return np.clip(image.astype(np.float32) * (1 - m) + back * m + 0.5, 0, 255).astype(np.uint8)


# ───────────────────────────── scoring ─────────────────────────────

def face_score(metrics: Metrics, out, gt, kps_gt, scale):
    """Score one face: crop a padded box around the landmarks in both images at GT resolution, then LPIPS + identity."""
    k = np.array(kps_gt, np.float32)
    cx, cy = k.mean(0)
    half = max(np.ptp(k[:, 0]), np.ptp(k[:, 1])) * 1.35
    x0, y0, x1, y1 = [int(round(v)) for v in (cx - half, cy - half, cx + half, cy + half)]
    x0, y0 = max(0, x0), max(0, y0)
    x1, y1 = min(gt.shape[1], x1), min(gt.shape[0], y1)
    if x1 - x0 < 24 or y1 - y0 < 24:
        return None
    g = gt[y0:y1, x0:x1]
    o = cv2.resize(out, (gt.shape[1], gt.shape[0]), interpolation=cv2.INTER_AREA)[y0:y1, x0:x1]
    size = 256
    g2, o2 = cv2.resize(g, (size, size), interpolation=cv2.INTER_AREA), cv2.resize(o, (size, size), interpolation=cv2.INTER_AREA)
    # identity: align GT landmarks onto the ArcFace template for both images
    m, _ = cv2.estimateAffinePartial2D(k, ARCFACE_112, method=cv2.LMEDS)
    emb = lambda im: (lambda e: e / np.linalg.norm(e))(metrics.arc.run(None, {metrics.arc.get_inputs()[0].name: ((cv2.warpAffine(im, m, (112, 112), flags=cv2.INTER_AREA).astype(np.float32) - 127.5) / 127.5).transpose(2, 0, 1)[None]})[0][0])
    full_o = cv2.resize(out, (gt.shape[1], gt.shape[0]), interpolation=cv2.INTER_AREA)
    return {"lpips": metrics.lp(o2, g2), "id": float(np.dot(emb(full_o), emb(gt)))}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--width", type=int, default=360, help="width the scene is shrunk to before degrading (smaller = smaller faces)")
    ap.add_argument("--quality", type=int, default=40)
    ap.add_argument("--scenes", type=int, default=12)
    ap.add_argument("--variants", default="main", choices=["main", "sweep", "strength", "general"])
    args = ap.parse_args()
    OUT.mkdir(parents=True, exist_ok=True)

    metrics = Metrics()
    det = YuNet(thr=0.6)
    up = Upscaler()
    ell = ellipse_mask()
    parser = Parser()
    restorers = {
        "gfpgan": Restorer("gfpgan", "gfpgan_1.4"),
        "codeformer": Restorer("codeformer", "codeformer", weight=0.7),
        "restoreformer++": Restorer("restoreformer++", "restoreformer_plus_plus"),
        "gpen": Restorer("gpen", "gpen_bfr_512"),
    }
    # variant name -> (restorer, mask kind, colour keeping, crop source, strength)
    variants = {
        "gfpgan|ellipse|colour (today)": ("gfpgan", "ellipse", True, "out", 1.0),
        "gfpgan|parse-face|colour": ("gfpgan", "face", True, "out", 1.0),
        "rf++|parse-face|colour": ("restoreformer++", "face", True, "out", 1.0),
        "gfpgan|parse-face|colour|src=lq": ("gfpgan", "face", True, "lq", 1.0),
        "rf++|parse-face|colour|src=lq": ("restoreformer++", "face", True, "lq", 1.0),
        "codeformer|parse-face|colour|src=lq": ("codeformer", "face", True, "lq", 1.0),
        "rf++|parse-face|colour|src=lq|0.7": ("restoreformer++", "face", True, "lq", 0.7),
        "rf++|parse-face|colour|src=out|0.7": ("restoreformer++", "face", True, "out", 0.7),
    }
    if args.variants == "strength":
        variants = {
            "gfpgan|ellipse|colour (today)": ("gfpgan", "ellipse", True, "out", 1.0),
            **{f"rf++|face|lq|{w}": ("restoreformer++", "face", True, "lq", w) for w in (0.5, 0.6, 0.7, 0.85)},
        }
    if args.variants == "general":
        variants = {
            "gfpgan|ellipse|colour (today)": ("gfpgan", "ellipse", True, "out", 1.0),
            "rf++|face|lq|0.7": ("restoreformer++", "face", True, "lq", 0.7),
            "rf++|face|out|0.7": ("restoreformer++", "face", True, "out", 0.7),
        }
    if args.variants == "sweep":
        variants = {
            "gfpgan|ellipse|colour (today)": ("gfpgan", "ellipse", True, "out", 1.0),
            **{f"rf++|face|lq|{w}": ("restoreformer++", "face", True, "lq", w) for w in (0.5, 0.6, 0.7, 0.8, 0.9)},
            "rf++|face|lq|0.7|no-colour": ("restoreformer++", "face", False, "lq", 0.7),
            "rf++|hair|lq|0.7": ("restoreformer++", "hair", True, "lq", 0.7),
            "codeformer|face|lq|0.7": ("codeformer", "face", True, "lq", 0.7),
        }
    rows = []
    for f in sorted((ROOT / ".bench" / "data" / "scenes").glob("*.jpg"))[: args.scenes]:
        gt = cv2.imread(str(f))[:, :, ::-1]
        gt = np.ascontiguousarray(gt)
        s = args.width / gt.shape[1]
        lq = cv2.resize(cv2.GaussianBlur(gt, (0, 0), 0.8), (args.width, round(gt.shape[0] * s)), interpolation=cv2.INTER_AREA)
        lq = np.clip(lq.astype(np.float32) + np.random.default_rng(7).normal(0, 3, lq.shape), 0, 255).astype(np.uint8)
        ok, enc = cv2.imencode(".jpg", lq[:, :, ::-1], [cv2.IMWRITE_JPEG_QUALITY, args.quality])
        lq = cv2.imdecode(enc, cv2.IMREAD_COLOR)[:, :, ::-1]
        cache = OUT / f"cache_{f.stem}_w{args.width}_q{args.quality}.npy"
        if cache.exists():
            upscaled = np.load(cache)
        else:
            upscaled = up(lq)
            np.save(cache, upscaled)
        # faces in the ground truth give reference landmarks; faces in the LQ image are what the app would find
        gt_faces = [x for x in detect(det, gt) if x["score"] > 0.8]
        faces = [x for x in detect(det, lq) if x["score"] > 0.7 and x["box"][2] - x["box"][0] >= 12]
        k = upscaled.shape[1] / lq.shape[1]
        print(f"{f.name}: {len(faces)} faces found in {lq.shape[1]}px input ({len(gt_faces)} in the original)", flush=True)

        def faces_pairs():
            for fc in faces:
                cx, cy = np.mean(fc["box"][0::2]), np.mean(fc["box"][1::2])
                best = min(gt_faces, key=lambda g: np.hypot(np.mean(g["box"][0::2]) - cx / s * 1, np.mean(g["box"][1::2]) - cy / s * 1), default=None)
                if best is None:
                    continue
                if np.hypot(np.mean(best["box"][0::2]) - cx / s, np.mean(best["box"][1::2]) - cy / s) > (best["box"][2] - best["box"][0]) * 0.6:
                    continue
                yield fc, best

        pairs = list(faces_pairs())
        bicubic = cv2.resize(lq, (upscaled.shape[1], upscaled.shape[0]), interpolation=cv2.INTER_CUBIC)
        outputs = {"bicubic": bicubic, "photo model only": upscaled}
        for vname, (rname, mkind, colour, src, weight) in variants.items():
            img = upscaled.copy()
            for fc, _ in pairs:
                kps_out = np.array([[(x + 0.5) * k - 0.5, (y + 0.5) * k - 0.5] for x, y in fc["kps"]], np.float32)
                m, _ = cv2.estimateAffinePartial2D(kps_out, FFHQ_512, method=cv2.LMEDS)
                if src == "lq":
                    # the crop comes from the original pixels (landmarks in source coordinates), not the upscaler's output
                    m_src, _ = cv2.estimateAffinePartial2D(np.array(fc["kps"], np.float32), FFHQ_512, method=cv2.LMEDS)
                    crop = cv2.warpAffine(lq, m_src, (512, 512), flags=cv2.INTER_CUBIC, borderMode=cv2.BORDER_REPLICATE)
                else:
                    crop = cv2.warpAffine(img, m, (512, 512), flags=cv2.INTER_AREA if np.hypot(m[0, 0], m[0, 1]) < 1 else cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
                rest = restorers[rname](crop)
                if colour:
                    rest = np.clip(keep_colours(rest, crop) + 0.5, 0, 255).astype(np.uint8)
                mask = ell if mkind == "ellipse" else parser.mask(rest, Parser.WITH_HAIR if mkind == "hair" else Parser.SKIN_AND_FEATURES)
                img = paste(img, m, rest, mask, weight)
            outputs[vname] = img
        for name, img in outputs.items():
            for fc, g in pairs:
                sc = face_score(metrics, img, gt, g["kps"], 1 / s)
                if sc:
                    rows.append({"scene": f.name, "variant": name, **sc})
        if pairs:
            wanted = ["bicubic", "photo model only", "gfpgan|ellipse|colour (today)", "rf++|parse-face|colour", "rf++|parse-face|colour|src=lq", "codeformer|parse-face|colour|src=lq", "rf++|face|lq|0.7", "codeformer|face|lq|0.7"]
            order = [n for n in wanted if n in outputs]
            tiles = []
            for fc, g in pairs[:3]:
                cx, cy = np.mean(g["kps"], 0)
                half = max(np.ptp(np.array(g["kps"])[:, 0]), np.ptp(np.array(g["kps"])[:, 1])) * 1.6
                box = [int(max(0, cx - half)), int(max(0, cy - half)), int(min(gt.shape[1], cx + half)), int(min(gt.shape[0], cy + half))]
                row = []
                for n in order:
                    im = cv2.resize(outputs[n], (gt.shape[1], gt.shape[0]), interpolation=cv2.INTER_AREA)[box[1] : box[3], box[0] : box[2]]
                    row.append(cv2.resize(im, (200, 200), interpolation=cv2.INTER_AREA))
                row.append(cv2.resize(gt[box[1] : box[3], box[0] : box[2]], (200, 200), interpolation=cv2.INTER_AREA))
                tiles.append(np.concatenate(row, axis=1))
            cv2.imwrite(str(OUT / f"{f.stem}_w{args.width}.jpg"), np.concatenate(tiles, axis=0)[:, :, ::-1], [cv2.IMWRITE_JPEG_QUALITY, 92])

    (OUT / f"results_w{args.width}_q{args.quality}_{args.variants}.json").write_text(json.dumps(rows, indent=1))
    names = list(dict.fromkeys(r["variant"] for r in rows))
    print(f"\n{len({(r['scene']) for r in rows})} scenes, {len([r for r in rows if r['variant'] == names[0]])} faces, input {args.width}px wide, JPEG q{args.quality}")
    print(f"{'variant':<40}{'LPIPS':>8}{'ID-sim':>9}")
    for n in names:
        sel = [r for r in rows if r["variant"] == n]
        print(f"{n:<40}{np.mean([r['lpips'] for r in sel]):8.3f}{np.mean([r['id'] for r in sel]):9.3f}")


if __name__ == "__main__":
    main()
