#!/usr/bin/env python3
"""Developer tool: convert upstream super-resolution weights into the ONNX
files LucidFrame ships in ``models/`` and (re)write ``models/manifest.json``.

End users never run this. The app itself has no Python dependency; it only
loads the resulting ONNX files with onnxruntime.

    python -m venv .venv-tools && . .venv-tools/bin/activate
    pip install torch --index-url https://download.pytorch.org/whl/cpu
    pip install spandrel safetensors onnx onnxruntime numpy
    python tools/convert_models.py --weights ./weights

``--weights`` is a directory of downloaded weight files (see SOURCES and TOOLS
for the exact upstream revision each one is pinned to). Every export is checked
against the PyTorch reference before it is accepted.

``SOURCES`` are the upscalers a user picks from. ``TOOLS`` are the stages the
Restore pipeline chains around them: JPEG-artifact cleanup, a face detector and
a face restorer.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path

import numpy as np
import onnx
import onnx.numpy_helper
import onnx.helper
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


TOOLS = [
    {
        "id": "dejpeg",
        "role": "cleanup",
        "name": "JPEG cleanup",
        "description": "RealPLKSR (1x) trained to remove JPEG blocking and ringing. Runs before "
                       "upscaling so the upscaler never mistakes compression blocks for detail.",
        "weights": "1xDeJPG_realplksr_otf.safetensors",
        "license": "CC-BY-4.0",
        "author": "Philip Hofmann (Phhofm)",
        "source": {
            "url": "https://huggingface.co/Phips/1xDeJPG_realplksr_otf",
            "revision": "9e7edaab3a849ec206b622bad1fe61826c40777d",
            "sha256": "bfc0b9a1163bf20eb18479e1f4faa0ece1b4d5ce59759be8b843d6ef32d1890f",
        },
    },
    {
        "id": "face-detect",
        "role": "face-detect",
        "name": "Face detector",
        "description": "YuNet, a tiny CNN face detector (about 230 KB) that also reports five facial "
                       "landmarks, used to align faces for restoration.",
        "weights": "face_detection_yunet_2023mar.onnx",
        "copy": True,  # upstream already ships ONNX; used as-is
        "license": "MIT",
        "author": "Shiqi Yu et al. (libfacedetection / OpenCV Zoo)",
        "source": {
            "url": "https://huggingface.co/opencv/face_detection_yunet",
            "revision": "3cc26e7f1014a5ee5d74a42acee58bafc9d0a310",
            "sha256": "8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4",
        },
    },
    {
        "id": "face-restore",
        "role": "face-restore",
        "name": "Face restoration",
        "description": "GFPGAN v1.4 (StyleGAN2 facial prior) rebuilds eyes, skin and hair on aligned "
                       "512 px face crops. Weights are stored in 8 bits to keep the download small.",
        "weights": "GFPGANv1.4.pth",
        "face": True,
        "license": "Apache-2.0",
        "author": "Tencent ARC Lab (Xintao Wang et al.)",
        "source": {
            "url": "https://github.com/TencentARC/GFPGAN/releases/download/v1.3.0/GFPGANv1.4.pth",
            "revision": "v1.3.0",
            "sha256": "e2cd4703ab14f4d01fd1383a8a8b266f9a5833dacee8e6a79d3bf21a1b6be5ad",
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
    src = check_pinned(entry, weights_dir)

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

    return manifest_entry(entry, out, scale)


def manifest_entry(entry: dict, out: Path, scale: int) -> dict:
    """What the app reads about one shipped file. Upscalers carry a `kind`, pipeline stages a `role`."""
    item = {"id": entry["id"], "name": entry["name"]}
    if "role" in entry:
        item["role"] = entry["role"]
    else:
        item["tagline"] = entry["tagline"]
    item["description"] = entry["description"]
    if "kind" in entry:
        item["kind"] = entry["kind"]
    item.update({
        "scale": scale,
        "file": out.name,
        "size": out.stat().st_size,
        "sha256": sha256_file(out),
        "license": entry["license"],
        "author": entry["author"],
        "source": entry["source"],
    })
    return item


def check_pinned(entry: dict, weights_dir: Path) -> Path:
    src = weights_dir / entry["weights"]
    if not src.exists():
        sys.exit(f"missing weights: {src}")
    digest = sha256_file(src)
    if digest != entry["source"]["sha256"]:
        sys.exit(f"{src.name}: sha256 {digest} != pinned {entry['source']['sha256']}")
    return src


def copy_onnx(entry: dict, weights_dir: Path, out_dir: Path) -> dict:
    """Upstream already ships this one as ONNX: verify the pin, prove it loads, copy it."""
    src = check_pinned(entry, weights_dir)
    out = out_dir / f"{entry['id']}.onnx"
    out.write_bytes(src.read_bytes())
    onnx.checker.check_model(onnx.load(str(out)))
    ort.InferenceSession(str(out), providers=["CPUExecutionProvider"])
    print(f"[{entry['id']}] copied {out.stat().st_size / 1e3:.0f} KB")
    return manifest_entry(entry, out, 1)


def compress_weights(path: Path) -> None:
    """Store weights in 8 bits (per output channel) and everything else large in 16 bits.

    The file shrinks 4x (GitHub also refuses files over 100 MB). Each weight is followed in the graph by a
    DequantizeLinear / Cast back to float32 that ONNX Runtime constant-folds at load, so inference still
    runs in float32; only the *stored* values are rounded (verified against the fp32 export below).
    """
    model = onnx.load(str(path))
    graph = model.graph
    front = []
    for init in list(graph.initializer):
        if init.data_type != onnx.TensorProto.FLOAT or int(np.prod(init.dims)) < 4096:
            continue
        w = onnx.numpy_helper.to_array(init).astype(np.float32)
        graph.initializer.remove(init)
        if w.ndim >= 2:
            axis = 0 if w.shape[0] > 1 else 1  # StyleGAN's modulated weights are (1, out, in, k, k)
            reduce_axes = tuple(i for i in range(w.ndim) if i != axis)
            peak = np.abs(w).max(axis=reduce_axes, keepdims=True)
            peak[peak == 0] = 1
            scale = (peak / 127).astype(np.float32)
            q = np.clip(np.round(w / scale), -127, 127).astype(np.int8)
            names = [init.name + suffix for suffix in ("__q", "__scale", "__zero")]
            graph.initializer.extend([
                onnx.numpy_helper.from_array(q, names[0]),
                onnx.numpy_helper.from_array(scale.reshape(-1), names[1]),
                onnx.numpy_helper.from_array(np.zeros(scale.size, np.int8), names[2]),
            ])
            front.append(onnx.helper.make_node("DequantizeLinear", names, [init.name], axis=axis, name=init.name + "__dq"))
        else:
            low = onnx.numpy_helper.from_array(w.astype(np.float16), init.name + "__fp16")
            graph.initializer.append(low)
            front.append(onnx.helper.make_node("Cast", [low.name], [init.name], to=onnx.TensorProto.FLOAT, name=init.name + "__cast"))
    nodes = list(graph.node)  # the dequantisers feed everything else, so they go first
    del graph.node[:]
    graph.node.extend(front + nodes)
    onnx.checker.check_model(model)
    onnx.save(model, str(path), save_as_external_data=False)


class _GFPGANOnnx(torch.nn.Module):
    """[0,1] RGB in, [0,1] RGB out; deterministic (fixed noise) so repeated runs agree."""

    def __init__(self, net: torch.nn.Module):
        super().__init__()
        self.net = net

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        y = self.net((x - 0.5) / 0.5, return_rgb=False, randomize_noise=False)[0]
        return (y + 1) * 0.5


def convert_face(entry: dict, weights_dir: Path, out_dir: Path) -> dict:
    src = check_pinned(entry, weights_dir)
    descriptor = ModelLoader().load_from_file(src)
    net = descriptor.model.eval()
    # StyleGAN2 noise inputs are random buffers that are not in the checkpoint; pin them to a seed
    # so the exported constants (and therefore every restoration) are reproducible.
    gen = torch.Generator().manual_seed(1234)
    for name, buf in net.stylegan_decoder.noises.named_buffers():
        buf.copy_(torch.randn(buf.shape, generator=gen))
    wrapped = _GFPGANOnnx(net).eval()
    print(f"[{entry['id']}] GFPGAN ({sum(p.numel() for p in net.parameters()) / 1e6:.1f}M params)")

    rng = np.random.default_rng(0)
    probe = np.clip(rng.normal(0.5, 0.2, (1, 3, 512, 512)), 0, 1).astype(np.float32)
    with torch.no_grad():
        reference = wrapped(torch.from_numpy(probe)).numpy()

    out = out_dir / f"{entry['id']}.onnx"
    torch.onnx.export(wrapped, torch.from_numpy(probe), str(out), input_names=["input"], output_names=["output"],
                      opset_version=18, dynamo=False)
    model = onnx.load(str(out), load_external_data=True)
    onnx.save(model, str(out), save_as_external_data=False)
    sess = ort.InferenceSession(str(out), providers=["CPUExecutionProvider"])
    exact = float(np.abs(sess.run(None, {"input": probe})[0] - reference).max())
    print(f"[{entry['id']}] fp32 max |onnx - torch| = {exact:.2e}")
    if exact > 1e-3:
        sys.exit(f"{entry['id']}: ONNX output diverges from PyTorch ({exact})")

    compress_weights(out)
    sess = ort.InferenceSession(str(out), providers=["CPUExecutionProvider"])
    got = sess.run(None, {"input": probe})[0]
    mse = float(np.mean((got - reference) ** 2))
    psnr = 10 * np.log10(1 / max(mse, 1e-12))
    print(f"[{entry['id']}] 8-bit weights: PSNR vs fp32 = {psnr:.1f} dB, {out.stat().st_size / 1e6:.0f} MB")
    if psnr < 40:  # on noise, the harshest input; 56 dB on a real face crop
        sys.exit(f"{entry['id']}: compressed weights changed the output too much ({psnr:.1f} dB)")
    return manifest_entry(entry, out, 1)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--weights", type=Path, required=True)
    ap.add_argument("--out", type=Path, default=ROOT / "models")
    ap.add_argument("--only", nargs="*", help="model ids to (re)convert")
    ap.add_argument("--release", help="GitHub release tag the finished files will be uploaded to (default: keep the manifest's)")
    args = ap.parse_args()

    args.out.mkdir(parents=True, exist_ok=True)
    manifest_path = args.out / "manifest.json"
    existing = existing_tools = {}
    release = args.release
    if manifest_path.exists():
        previous = json.loads(manifest_path.read_text())
        existing = {m["id"]: m for m in previous["models"]}
        existing_tools = {m["id"]: m for m in previous.get("tools", [])}
        release = release or previous.get("release")

    models = []
    for entry in SOURCES:
        if args.only and entry["id"] not in args.only and entry["id"] in existing:
            models.append(existing[entry["id"]])
            continue
        models.append(convert(entry, args.weights, args.out))

    tools = []
    for entry in TOOLS:
        if args.only and entry["id"] not in args.only and entry["id"] in existing_tools:
            tools.append(existing_tools[entry["id"]])
            continue
        build = copy_onnx if entry.get("copy") else convert_face if entry.get("face") else convert
        tools.append(build(entry, args.weights, args.out))

    if not release:
        sys.exit("pass --release <tag>: the GitHub release the converted files will be uploaded to, e.g. models-1")
    manifest = {"version": 4, "release": release, "models": models, "tools": tools}
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")
    print(f"wrote {manifest_path}")
    print(f"Next: upload the .onnx files in {args.out} as assets of release '{release}', commit manifest.json.")


if __name__ == "__main__":
    main()
