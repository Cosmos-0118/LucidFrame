#!/usr/bin/env python3
"""Developer tool: convert upstream super-resolution weights into the ONNX
files LucidFrame ships in ``models/`` and (re)write ``models/manifest.json``.

End users never run this. The app itself has no Python dependency; it only
loads the resulting ONNX files with onnxruntime.

    python -m venv .venv-tools && . .venv-tools/bin/activate
    pip install torch --index-url https://download.pytorch.org/whl/cpu
    pip install spandrel safetensors onnx onnxruntime numpy
    python tools/convert_models.py --weights ./weights

``--weights`` is a directory of downloaded .safetensors files (see SOURCES for
the exact upstream revision each one is pinned to). Every export is checked
against the PyTorch reference before it is accepted.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path

import numpy as np
import onnx
import onnxruntime as ort
import torch
from spandrel import ModelLoader

ROOT = Path(__file__).resolve().parent.parent

# id -> everything the app needs to present and run the model.
# `source` pins the exact upstream revision + file hash the ONNX was built from.
SOURCES = [
    {
        "id": "photo",
        "name": "Photo",
        "tagline": "Best quality for photographs",
        "description": "RealPLKSR trained on web photography with realistic noise, "
                       "lens blur and JPEG/WebP compression. Sharp, natural detail.",
        "kind": "quality",
        "weights": "4xNomosWebPhoto_RealPLKSR.safetensors",
        "license": "CC-BY-4.0",
        "author": "Philip Hofmann (Phhofm)",
        "source": {
            "url": "https://huggingface.co/Phips/4xNomosWebPhoto_RealPLKSR",
            "revision": "49d5da19489e645e870eb076ea84815471f27ef4",
            "sha256": "9be0228f98156a100d6636d99b373ed2785b999723f9adc4cca504329ab157f2",
        },
    },
    {
        "id": "anime",
        "name": "Anime & Art",
        "tagline": "Best quality for anime, cartoons and illustrations",
        "description": "RealPLKSR (DySample) trained on frames from modern anime films. "
                       "Clean lines, no ringing, removes compression.",
        "kind": "quality",
        "weights": "4xHFA2k_ludvae_realplksr_dysample.safetensors",
        "license": "CC-BY-4.0",
        "author": "Philip Hofmann (Phhofm)",
        "source": {
            "url": "https://huggingface.co/Phips/4xHFA2k_ludvae_realplksr_dysample",
            "revision": "96c2a2e13fee3f9926a13c8d80c6923fcc9d15bc",
            "sha256": "392c1e812c1092ec3947a45d04c62f5a1b07c2e5c317b7796cd8d6f095e5a03b",
        },
    },
    {
        "id": "fast",
        "name": "Fast",
        "tagline": "Quick general-purpose 2× — good for video",
        "description": "Compact network trained on mixed content with JPEG degradation. "
                       "Roughly 25× faster than the quality models and, on our fidelity "
                       "checks, more accurate than the larger SPAN variant it replaced.",
        "kind": "fast",
        "weights": "2xNomosUni_compact_multijpg.safetensors",
        "license": "CC-BY-4.0",
        "author": "Philip Hofmann (Phhofm)",
        "source": {
            "url": "https://huggingface.co/Phips/2xNomosUni_compact_multijpg",
            "revision": "4774921957bcbd222e7e4861728b02ebb3502c31",
            "sha256": "ea51bc7aa05c801e42c85aa84007b8bb1dcd3f11d85d5979b26b29e4c8610401",
        },
    },
    {
        "id": "fast-anime",
        "name": "Fast Anime",
        "tagline": "Quick anime 2× — good for video",
        "description": "Compact anime upscaler trained on HFA2k with compression and blur "
                       "degradations. Tiny and very fast.",
        "kind": "fast",
        "weights": "2xHFA2kCompact.safetensors",
        "license": "CC-BY-4.0",
        "author": "Philip Hofmann (Phhofm)",
        "source": {
            "url": "https://huggingface.co/Phips/2xHFA2kCompact",
            "revision": "09a1cc48be61cbb4a97d82ae440ad2fa06cb4a5c",
            "sha256": "c20226f86e4f2a0c601e56776cce537336dcbb95c633bca011e801553e3833ff",
        },
    },
]


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _dysample_forward(self, x: torch.Tensor) -> torch.Tensor:
    """DySample.forward with the sampling grid derived from tensor ops.

    Upstream builds the grid with ``torch.arange(H)`` / ``torch.tensor([W, H])``,
    which the tracer freezes at the export size and silently breaks every other
    input size. cumsum-of-ones keeps H and W symbolic and is numerically
    identical.
    """
    offset = self.offset(x) * self.scope(x).sigmoid() * 0.5 + self.init_pos
    B, _, H, W = offset.shape
    offset = offset.view(B, 2, -1, H, W)

    ones_row = torch.ones_like(x[:1, :1, :, :1])  # (1,1,H,1)
    ones_col = torch.ones_like(x[:1, :1, :1, :])  # (1,1,1,W)
    zeros = torch.zeros_like(x[:1, :1])           # (1,1,H,W)
    ys = torch.cumsum(ones_row, 2) - 0.5 + zeros
    xs = torch.cumsum(ones_col, 3) - 0.5 + zeros
    coords = torch.stack([xs, ys], dim=1)         # (1,2,1,H,W)
    normalizer = torch.stack([ones_col.sum(), ones_row.sum()]).view(1, 2, 1, 1, 1)
    coords = 2 * (coords + offset) / normalizer - 1

    coords = (
        torch.nn.functional.pixel_shuffle(coords.reshape(B, -1, H, W), self.scale)
        .view(B, 2, -1, self.scale * H, self.scale * W)
        .permute(0, 2, 3, 4, 1)
        .contiguous()
        .flatten(0, 1)
    )
    output = torch.nn.functional.grid_sample(
        x.reshape(B * self.groups, -1, H, W),
        coords,
        mode="bilinear",
        align_corners=False,
        padding_mode="border",
    ).view(B, -1, self.scale * H, self.scale * W)
    if self.end_convolution:
        output = self.end_conv(output)
    return output


def _patch_dysample(module: torch.nn.Module) -> int:
    patched = 0
    for sub in module.modules():
        if type(sub).__name__ == "DySample":
            sub.forward = _dysample_forward.__get__(sub)
            patched += 1
    return patched


def convert(entry: dict, weights_dir: Path, out_dir: Path) -> dict:
    src = weights_dir / entry["weights"]
    if not src.exists():
        sys.exit(f"missing weights: {src}")
    digest = sha256_file(src)
    if digest != entry["source"]["sha256"]:
        sys.exit(f"{src.name}: sha256 {digest} != pinned {entry['source']['sha256']}")

    descriptor = ModelLoader().load_from_file(src)
    torch_model = descriptor.model.eval()
    scale = int(descriptor.scale)
    assert descriptor.input_channels == 3 and descriptor.output_channels == 3
    print(f"[{entry['id']}] {descriptor.architecture.name} x{scale} "
          f"({sum(p.numel() for p in torch_model.parameters()) / 1e6:.2f}M params)")

    # Reference outputs come from the *unpatched* module so the patch is
    # verified, not assumed.
    reference = {}
    rng = np.random.default_rng(0)
    probes = [rng.random((1, 3, h, w), dtype=np.float32) for h, w in ((64, 64), (96, 80), (128, 128))]
    with torch.no_grad():
        for i, x in enumerate(probes):
            reference[i] = torch_model(torch.from_numpy(x)).numpy()
    if _patch_dysample(torch_model):
        print(f"[{entry['id']}] patched DySample for dynamic shapes")

    out = out_dir / f"{entry['id']}.onnx"
    dummy = torch.rand(1, 3, 64, 64)
    torch.onnx.export(
        torch_model,
        dummy,
        str(out),
        input_names=["input"],
        output_names=["output"],
        dynamic_axes={"input": {2: "h", 3: "w"}, "output": {2: "oh", 3: "ow"}},
        opset_version=18,
        dynamo=False,
    )
    # Fold everything into a single self-contained file (no external .data).
    model = onnx.load(str(out), load_external_data=True)
    onnx.checker.check_model(model)
    onnx.save(model, str(out), save_as_external_data=False)

    # Verify against the PyTorch reference on shapes the app will not use at
    # export time (different size, non-square) to prove the dynamic axes work.
    sess = ort.InferenceSession(str(out), providers=["CPUExecutionProvider"])
    worst = 0.0
    for i, x in enumerate(probes):
        h, w = x.shape[2:]
        got = sess.run(None, {"input": x})[0]
        assert got.shape == (1, 3, h * scale, w * scale), (got.shape, h, w, scale)
        worst = max(worst, float(np.abs(reference[i] - got).max()))
    print(f"[{entry['id']}] max |onnx - torch| = {worst:.2e}")
    if worst > 1e-3:
        sys.exit(f"{entry['id']}: ONNX output diverges from PyTorch ({worst})")

    return {
        "id": entry["id"],
        "name": entry["name"],
        "tagline": entry["tagline"],
        "description": entry["description"],
        "kind": entry["kind"],
        "scale": scale,
        "file": out.name,
        "size": out.stat().st_size,
        "sha256": sha256_file(out),
        "license": entry["license"],
        "author": entry["author"],
        "source": entry["source"],
    }


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--weights", type=Path, required=True)
    ap.add_argument("--out", type=Path, default=ROOT / "models")
    ap.add_argument("--only", nargs="*", help="model ids to (re)convert")
    args = ap.parse_args()

    args.out.mkdir(parents=True, exist_ok=True)
    manifest_path = args.out / "manifest.json"
    existing = {}
    if manifest_path.exists():
        existing = {m["id"]: m for m in json.loads(manifest_path.read_text())["models"]}

    models = []
    for entry in SOURCES:
        if args.only and entry["id"] not in args.only and entry["id"] in existing:
            models.append(existing[entry["id"]])
            continue
        models.append(convert(entry, args.weights, args.out))

    manifest = {"version": 2, "models": models}
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")
    print(f"wrote {manifest_path}")


if __name__ == "__main__":
    main()
