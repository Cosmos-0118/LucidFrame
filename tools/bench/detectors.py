"""Face detectors for the benchmark: YuNet (what the app ships) and SCRFD-family ONNX models.

Every detector returns a list of {score, box:[x0,y0,x1,y1], kps:[[x,y]*5]} in image pixels, searched over the
whole image and over overlapping native-resolution tiles so small faces are not lost to the 640 px input.
"""
from __future__ import annotations

import cv2
import numpy as np

from common import session

SIZE = 640


def nms(faces, thr=0.4):
    keep = []
    for f in sorted(faces, key=lambda f: -f["score"]):
        ok = True
        for k in keep:
            a, b = f["box"], k["box"]
            iw = min(a[2], b[2]) - max(a[0], b[0])
            ih = min(a[3], b[3]) - max(a[1], b[1])
            if iw > 0 and ih > 0:
                inter = iw * ih
                union = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter
                if inter / union > thr:
                    ok = False
                    break
        if ok:
            keep.append(f)
    return keep


class YuNet:
    name = "yunet"

    def __init__(self, thr=0.6):
        self.s, self.thr = session("yunet_2023_mar"), thr

    def window(self, img):
        h, w = img.shape[:2]
        canvas = np.zeros((SIZE, SIZE, 3), np.float32)
        canvas[:h, :w] = img[:, :, ::-1]  # BGR, 0..255
        out = self.s.run(None, {self.s.get_inputs()[0].name: canvas.transpose(2, 0, 1)[None]})
        names = [o.name for o in self.s.get_outputs()]
        o = dict(zip(names, out))
        faces = []
        for stride in (8, 16, 32):
            cols = SIZE // stride
            cls, obj, bbox, kps = (o[f"{k}_{stride}"][0] for k in ("cls", "obj", "bbox", "kps"))
            score = np.sqrt(np.clip(cls[:, 0], 0, 1) * np.clip(obj[:, 0], 0, 1))
            for i in np.nonzero(score >= self.thr)[0]:
                r, c = divmod(int(i), cols)
                cx, cy = (c + bbox[i, 0]) * stride, (r + bbox[i, 1]) * stride
                bw, bh = np.exp(bbox[i, 2]) * stride, np.exp(bbox[i, 3]) * stride
                pts = [[(kps[i, 2 * k] + c) * stride, (kps[i, 2 * k + 1] + r) * stride] for k in range(5)]
                faces.append({"score": float(score[i]), "box": [cx - bw / 2, cy - bh / 2, cx + bw / 2, cy + bh / 2], "kps": pts})
        return faces


class Scrfd:
    def __init__(self, onnx, thr=0.5):
        self.name, self.s, self.thr = onnx, session(onnx), thr

    def window(self, img):
        h, w = img.shape[:2]
        canvas = np.zeros((SIZE, SIZE, 3), np.float32)
        canvas[:h, :w] = img  # RGB
        blob = ((canvas - 127.5) / 128.0).transpose(2, 0, 1)[None]
        out = self.s.run(None, {self.s.get_inputs()[0].name: blob})
        faces = []
        for idx, stride in enumerate((8, 16, 32)):
            scores, bbox, kps = out[idx][:, 0], out[idx + 3] * stride, out[idx + 6] * stride
            n = SIZE // stride
            ys, xs = np.mgrid[0:n, 0:n]
            centers = np.stack([xs, ys], -1).reshape(-1, 2).astype(np.float32) * stride
            centers = np.repeat(centers, 2, axis=0)  # two anchors per cell
            for i in np.nonzero(scores >= self.thr)[0]:
                c = centers[i]
                box = [c[0] - bbox[i, 0], c[1] - bbox[i, 1], c[0] + bbox[i, 2], c[1] + bbox[i, 3]]
                pts = [[c[0] + kps[i, 2 * k], c[1] + kps[i, 2 * k + 1]] for k in range(5)]
                faces.append({"score": float(scores[i]), "box": box, "kps": pts})
        return faces


def detect(det, rgb: np.ndarray):
    """Whole image shrunk to fit, plus native-resolution tiles when it is larger than the detector input."""
    h, w = rgb.shape[:2]
    found = []

    def run(x, y, ww, hh, scale):
        crop = rgb[y : y + hh, x : x + ww]
        if scale != 1:
            crop = cv2.resize(crop, (max(1, round(ww * scale)), max(1, round(hh * scale))), interpolation=cv2.INTER_AREA if scale < 1 else cv2.INTER_CUBIC)
        for f in det.window(crop):
            found.append({"score": f["score"], "box": [f["box"][0] / scale + x, f["box"][1] / scale + y, f["box"][2] / scale + x, f["box"][3] / scale + y],
                          "kps": [[px / scale + x, py / scale + y] for px, py in f["kps"]]})

    long = max(w, h)
    run(0, 0, w, h, min(1.0, SIZE / long))
    if long <= SIZE:
        if long >= 160:
            run(0, 0, w, h, 0.5)
    else:
        step = int(SIZE * 0.75)
        for y in range(0, h, step):
            for x in range(0, w, step):
                ww, hh = min(SIZE, w - x), min(SIZE, h - y)
                if ww >= 48 and hh >= 48:
                    run(x, y, ww, hh, 1.0)
    return nms([f for f in found if f["box"][2] - f["box"][0] > 6])
