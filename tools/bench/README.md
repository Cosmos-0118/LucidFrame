# Face-model benchmarks

Developer tooling that decided which face models LucidFrame ships and how the Restore pipeline uses them. Nothing here is
part of the app. Weights, datasets and outputs live in the git-ignored `.bench/` folder.

```bash
python -m venv .venv-tools && . .venv-tools/bin/activate        # Scripts\activate on Windows
pip install torch torchvision --index-url https://download.pytorch.org/whl/cpu
pip install onnxruntime-directml numpy pillow opencv-python-headless scikit-image lpips pyarrow onnx   # onnxruntime elsewhere
```

## What you need in `.bench/`

| Path | What | Where from |
| --- | --- | --- |
| `weights/*.onnx` | `gfpgan_1.4`, `codeformer`, `gpen_bfr_512`, `restoreformer_plus_plus`, `retinaface_10g`, `scrfd_2.5g`, `arcface_w600k_r50`, `bisenet_resnet_18` / `_34` (and `yunet_2023_mar`, `photo_shipped` copied from `models/`) | the [FaceFusion model assets](https://github.com/facefusion/facefusion-assets/releases) |
| `data/gt/*.png` | 512 px ground-truth faces | `extract_faces.py` on an FFHQ-512 Arrow shard (e.g. Hugging Face `luethan2025/FFHQ-512x512`) |
| `data/scenes/*.jpg` | real group photos | NASA Image Library (public domain), e.g. `iss030e267843`, `s79e5289` |

FFHQ, ArcFace and the candidate weights have research-oriented licences of their own: they are used here only to measure,
never shipped. See `NOTICES.md` for what the app itself contains.

## Scripts

| Script | Question it answers |
| --- | --- |
| `bench_restorers.py` | Which restorer is best on aligned 512 px crops? (PSNR, SSIM, LPIPS, ArcFace identity at three damage levels) |
| `bench_detectors.py` | Does a bigger face detector find more faces than YuNet once photos are small and compressed? |
| `bench_pipeline.py` | In a full detect → align → restore → paste flow, which restorer, mask, crop source and blend strength is best? |
| `compare_versions.py` | Old vs new app on the README's single-portrait example. |
| `compare_scenes.py` | Old vs new app through the real CLI on many faces in three damage regimes (the README table). |
| `make_figure.py` | Regenerates `docs/restore-compare.jpg` from real output. |

`compare_*.py` and `make_figure.py` take `--before <git worktree of the old commit, with its models>` and `--after <repo>`.

## Results that shaped the pipeline (30 faces × 3 damage levels; 12 scenes, 79–80 faces)

* **YuNet stays.** 96–99% recall down to 300 px wide, ~10× faster than SCRFD, MIT licensed. SCRFD was not meaningfully better.
* **No restorer dominates on aligned crops.** CodeFormer (w=0.8) is marginally best on LPIPS, RestoreFormer++ best at keeping
  identity at medium damage, GFPGAN 1.4 close behind; GPEN is clearly worse. CodeFormer's licence is non-commercial, so it is not shipped.
* **The pipeline around the model matters more than the model.** Restoring from the *source* pixels instead of the upscaler's
  output (identity +0.045, LPIPS −0.024), blending through a face-parsing mask instead of an ellipse (LPIPS −0.007, 92% of
  faces) and a 0.7 blend strength (best LPIPS, identity flat from 0.5 to 0.7) are the big levers.
