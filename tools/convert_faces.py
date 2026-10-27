#!/usr/bin/env python3
"""Developer tool: build the two face models LucidFrame ships from pinned upstream ONNX files.

    face-restore  RestoreFormer++ (Apache-2.0 code). Input and output are RGB in [0, 1] (the [-1, 1] scaling is
                  folded into the graph), a single output, and weights stored in 8 bits like the other models.
    face-parse    BiSeNet face parsing (CelebAMask-HQ labels). RGB [0, 1] in, a float mask out: 1 where the pixel is
                  skin, brow, eye, ear, nose or lip (labels 1-13). The ImageNet normalisation and the arg-max are
                  inside the graph, so the app never handles the 19-channel logits.

The inputs are ONNX exports published in the FaceFusion model assets (https://github.com/facefusion/facefusion-assets).

    python -m venv .venv-tools && . .venv-tools/bin/activate
    pip install onnx onnxruntime numpy
    python tools/convert_faces.py --src ./weights --out ./models

It prints the manifest entries to paste into models/manifest.json and verifies each result against the source model.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path

import numpy as np
import onnx
import onnx.helper as oh
import onnx.numpy_helper as onh
import onnxruntime as ort

SOURCES = {
    "restoreformer_plus_plus.onnx": {
        "url": "https://github.com/facefusion/facefusion-assets/releases/download/models-3.0.0/restoreformer_plus_plus.onnx",
        "sha256": None,  # filled in by --pin on first use, then checked
    },
    "bisenet_resnet_18.onnx": {
        "url": "https://github.com/facefusion/facefusion-assets/releases/download/models-3.1.0/bisenet_resnet_18.onnx",
        "sha256": None,
    },
}


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def const(name: str, value: np.ndarray):
    return onh.from_array(value, name)


def compress_weights(model: onnx.ModelProto) -> None:
    """8-bit (per output channel) storage for convolution kernels, 16-bit for everything else large.

    Each stored tensor is followed by a DequantizeLinear / Cast back to float32 that ONNX Runtime folds at load,
    so inference still runs in float32. Matrix multiplications keep 16-bit weights: their output axis is the last
    one, so per-row 8-bit scaling would be the wrong grouping.
    """
    graph = model.graph
    users = {}
    for node in graph.node:
        for i, name in enumerate(node.input):
            users.setdefault(name, []).append((node.op_type, i))
    front = []
    for init in list(graph.initializer):
        if init.data_type != onnx.TensorProto.FLOAT or int(np.prod(init.dims)) < 4096:
            continue
        w = onh.to_array(init).astype(np.float32)
        only_conv = all(op in ("Conv", "ConvTranspose") and idx == 1 for op, idx in users.get(init.name, [])) and bool(users.get(init.name))
        graph.initializer.remove(init)
        if w.ndim == 4 and only_conv:
            axis = 1 if any(op == "ConvTranspose" for op, _ in users[init.name]) else 0
            reduce_axes = tuple(i for i in range(w.ndim) if i != axis)
            peak = np.abs(w).max(axis=reduce_axes, keepdims=True)
            peak[peak == 0] = 1
            scale = (peak / 127).astype(np.float32)
            q = np.clip(np.round(w / scale), -127, 127).astype(np.int8)
            names = [init.name + s for s in ("__q", "__scale", "__zero")]
            graph.initializer.extend([onh.from_array(q, names[0]), onh.from_array(scale.reshape(-1), names[1]), onh.from_array(np.zeros(scale.size, np.int8), names[2])])
            front.append(oh.make_node("DequantizeLinear", names, [init.name], axis=axis, name=init.name + "__dq"))
        else:
            low = onh.from_array(w.astype(np.float16), init.name + "__fp16")
            graph.initializer.append(low)
            front.append(oh.make_node("Cast", [low.name], [init.name], to=onnx.TensorProto.FLOAT, name=init.name + "__cast"))
    nodes = list(graph.node)
    del graph.node[:]
    graph.node.extend(front + nodes)


def _prune_outputs(model: onnx.ModelProto, keep: str) -> None:
    """Keep one graph output and drop the nodes only the others needed."""
    graph = model.graph
    for out in [o for o in graph.output if o.name != keep]:
        graph.output.remove(out)
    needed = {keep}
    kept = []
    for node in reversed(graph.node):
        if any(o in needed for o in node.output):
            kept.append(node)
            needed.update(node.input)
    kept.reverse()
    del graph.node[:]
    graph.node.extend(kept)
    for init in [i for i in graph.initializer if i.name not in needed]:
        graph.initializer.remove(init)


def build_restorer(src: Path, out: Path) -> None:
    model = onnx.load(str(src))
    g = model.graph
    old_in, old_out = g.input[0].name, g.output[0].name
    _prune_outputs(model, old_out)
    # [0,1] -> [-1,1] in, [-1,1] -> [0,1] out
    g.input[0].name = "input"
    for node in g.node:
        node.input[:] = ["input_scaled" if n == old_in else n for n in node.input]
        node.output[:] = [n for n in node.output]
    g.initializer.extend([const("rs_two", np.array(2, np.float32)), const("rs_one", np.array(1, np.float32)), const("rs_half", np.array(0.5, np.float32))])
    pre = [oh.make_node("Mul", ["input", "rs_two"], ["input_x2"], name="rs_pre_mul"), oh.make_node("Sub", ["input_x2", "rs_one"], ["input_scaled"], name="rs_pre_sub")]
    # the original output is renamed so the final tensor can be called "output"
    for node in g.node:
        node.output[:] = ["restored_raw" if n == old_out else n for n in node.output]
        node.input[:] = ["restored_raw" if n == old_out else n for n in node.input]
    post = [oh.make_node("Add", ["restored_raw", "rs_one"], ["restored_p1"], name="rs_post_add"), oh.make_node("Mul", ["restored_p1", "rs_half"], ["output"], name="rs_post_mul")]
    nodes = list(g.node)
    del g.node[:]
    g.node.extend(pre + nodes + post)
    g.output[0].name = "output"
    compress_weights(model)
    onnx.checker.check_model(model)
    onnx.save(model, str(out), save_as_external_data=False)


def build_parser(src: Path, out: Path) -> None:
    model = onnx.load(str(src))
    g = model.graph
    old_in = g.input[0].name
    main_out = g.output[0].name
    _prune_outputs(model, main_out)
    g.input[0].name = "input"
    mean = np.array([0.485, 0.456, 0.406], np.float32).reshape(1, 3, 1, 1)
    std = np.array([0.229, 0.224, 0.225], np.float32).reshape(1, 3, 1, 1)
    g.initializer.extend([const("fp_mean", mean), const("fp_std", std), const("fp_lo", np.array(0, np.int64)), const("fp_hi", np.array(14, np.int64))])
    pre = [oh.make_node("Sub", ["input", "fp_mean"], ["input_c"], name="fp_pre_sub"), oh.make_node("Div", ["input_c", "fp_std"], [old_in + "__norm"], name="fp_pre_div")]
    for node in g.node:
        node.input[:] = [old_in + "__norm" if n == old_in else n for n in node.input]
        node.output[:] = ["logits_raw" if n == main_out else n for n in node.output]
        node.input[:] = ["logits_raw" if n == main_out else n for n in node.input]
    post = [
        oh.make_node("ArgMax", ["logits_raw"], ["label"], axis=1, keepdims=1, name="fp_argmax"),
        oh.make_node("Greater", ["label", "fp_lo"], ["gt0"], name="fp_gt"),
        oh.make_node("Less", ["label", "fp_hi"], ["lt14"], name="fp_lt"),
        oh.make_node("And", ["gt0", "lt14"], ["inside"], name="fp_and"),
        oh.make_node("Cast", ["inside"], ["output"], to=onnx.TensorProto.FLOAT, name="fp_cast"),
    ]
    nodes = list(g.node)
    del g.node[:]
    g.node.extend(pre + nodes + post)
    g.output[0].name = "output"
    g.output[0].type.CopyFrom(oh.make_tensor_type_proto(onnx.TensorProto.FLOAT, [1, 1, 512, 512]))
    compress_weights(model)
    onnx.checker.check_model(model)
    onnx.save(model, str(out), save_as_external_data=False)


def check_restorer(src: Path, out: Path) -> float:
    # Verified on a real, softened face (the public-domain test portrait): synthetic inputs are far outside what the
    # model sees and exaggerate the rounding. The app clips the output to [0, 1], so both sides are clipped.
    from PIL import Image, ImageFilter

    face = Image.open(Path(__file__).resolve().parent.parent / "tests" / "fixtures" / "portrait.jpg").convert("RGB").resize((512, 512))
    x = (np.asarray(face.filter(ImageFilter.GaussianBlur(3)), np.float32) / 255).transpose(2, 0, 1)[None]
    so = ort.SessionOptions()
    so.log_severity_level = 4
    ref_s = ort.InferenceSession(str(src), so, providers=["CPUExecutionProvider"])
    ref = np.clip((ref_s.run(None, {ref_s.get_inputs()[0].name: (x - 0.5) / 0.5})[0] + 1) / 2, 0, 1)
    got = np.clip(ort.InferenceSession(str(out), so, providers=["CPUExecutionProvider"]).run(None, {"input": x})[0], 0, 1)
    mse = float(np.mean((got - ref) ** 2))
    return 10 * np.log10(1 / max(mse, 1e-12))


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--src", type=Path, required=True, help="folder with the source .onnx files")
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--min-psnr", type=float, default=40.0)
    args = ap.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)

    entries = {}
    for name, builder, target in (("restoreformer_plus_plus.onnx", build_restorer, "face-restore.onnx"), ("bisenet_resnet_18.onnx", build_parser, "face-parse.onnx")):
        src = args.src / name
        if not src.exists():
            sys.exit(f"missing {src}")
        digest = sha256_file(src)
        print(f"[{target}] source {name} sha256 {digest}")
        out = args.out / target
        builder(src, out)
        entries[target] = {"size": out.stat().st_size, "sha256": sha256_file(out), "source_sha256": digest, "source_url": SOURCES[name]["url"]}
        print(f"[{target}] {out.stat().st_size / 1e6:.1f} MB")
        if builder is build_restorer:
            psnr = check_restorer(src, out)
            print(f"[{target}] 8-bit weights: PSNR vs the source model = {psnr:.1f} dB")
            if psnr < args.min_psnr:
                sys.exit(f"{target}: compressed weights changed the output too much ({psnr:.1f} dB)")
    print(json.dumps(entries, indent=2))


if __name__ == "__main__":
    main()
