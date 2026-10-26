# Notices and attributions

LucidFrame itself is released under the [MIT License](LICENSE). It bundles or depends on the third-party works below. If you redistribute LucidFrame, keep this file with it.

## AI models (bundled in `models/`)

The ONNX files in `models/` are format conversions of the following pretrained weights, made with `tools/convert_models.py` (each is pinned to an exact upstream revision and file hash in `models/manifest.json`). The conversions are numerically identical to the originals (verified against PyTorch to within 1e-5). All four are licensed **[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)**; changes made: converted from PyTorch/safetensors to ONNX, with the DySample sampling grid made size-independent (anime model only).

| Model id | Original name | Author | Source |
| --- | --- | --- | --- |
| `photo` | 4xNomosWebPhoto_RealPLKSR | Philip Hofmann (Phhofm) | https://huggingface.co/Phips/4xNomosWebPhoto_RealPLKSR |
| `anime` | 4xHFA2k_ludvae_realplksr_dysample | Philip Hofmann (Phhofm) | https://huggingface.co/Phips/4xHFA2k_ludvae_realplksr_dysample |
| `fast` | 2xNomosUni_compact_multijpg | Philip Hofmann (Phhofm) | https://huggingface.co/Phips/2xNomosUni_compact_multijpg |
| `fast-anime` | 2xHFA2kCompact | Philip Hofmann (Phhofm) | https://huggingface.co/Phips/2xHFA2kCompact |

Network architectures: RealPLKSR / PLKSR ([Lee et al., "Partial Large Kernel CNNs for Efficient Super-Resolution"](https://arxiv.org/abs/2404.11848), MIT; neosr implementation), DySample ([Liu et al., ICCV 2023](https://arxiv.org/abs/2308.15085)), and the SRVGGNetCompact architecture from [Real-ESRGAN](https://github.com/xinntao/Real-ESRGAN) (BSD-3-Clause). Training data and procedure are described on each model's page linked above. Conversion uses [spandrel](https://github.com/chaiNNer-org/spandrel) (MIT) and PyTorch (BSD-style) at development time only.

## Runtime components

| Component | License | Used for |
| --- | --- | --- |
| [ONNX Runtime](https://github.com/microsoft/onnxruntime) (`onnxruntime-node`) | MIT | Running the models on CPU, DirectML, CoreML and CUDA |
| [sharp](https://github.com/lovell/sharp) | Apache-2.0 | Reading, resizing and writing images |
| [libvips](https://github.com/libvips/libvips) (prebuilt with sharp) | LGPL-3.0-or-later | The image engine behind sharp |
| [FFmpeg](https://ffmpeg.org) via [`ffmpeg-static`](https://github.com/eugeneware/ffmpeg-static) | GPL-3.0-or-later (the bundled build enables GPL components such as x264) | Decoding and encoding video, as a **separate executable** started by the app. Source code: https://ffmpeg.org/download.html#get-sources — the exact build comes from the `ffmpeg-static` project's release for your platform. |
| [Electron](https://www.electronjs.org) (includes Chromium) | MIT and Chromium's licenses (see `LICENSES.chromium.html` inside the app) | Desktop shell |
| [React](https://react.dev) and React DOM | MIT | User interface |

DirectML (Windows) is a Microsoft component distributed inside the `onnxruntime-node` package; see that package for its license terms.

FFmpeg runs as its own program and is not linked into LucidFrame, so LucidFrame's MIT license applies to LucidFrame's own code; FFmpeg and the other components remain under their own licenses.

## Removed in v2

LucidFrame v1 used Real-ESRGAN and GFPGAN weights, PyTorch, BasicSR, FastAPI and Google Fonts. None of these are included or contacted by v2.
