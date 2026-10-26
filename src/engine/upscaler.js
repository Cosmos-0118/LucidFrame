// High-level upscaling of an in-memory RGB image: model selection, tiled
// inference, multi-pass for scales the model doesn't hit natively, exact
// final resize, and automatic recovery when a GPU runs out of memory.

import sharp from "sharp";
import { log } from "./log.js";
import { ModelRegistry } from "./models.js";
import { PROVIDER_LABELS, Runtime } from "./runtime.js";
import { upscaleTiled } from "./tiling.js";

/** Largest image we will produce (matches sharp/libvips' own ceiling, 16383²). */
export const MAX_OUTPUT_PIXELS = 268_000_000;

// Context margin and blend overlap, in input pixels (see tests/tiling.test.js for the evidence behind these).
const MARGIN = 12;
const OVERLAP = 16;

export const SCALES = [2, 3, 4];

/** Number of model passes needed to reach at least `scale` from native scale `n`, and the scale they reach. */
export function planPasses(n, scale) {
  let reached = n;
  let passes = 1;
  while (reached < scale) {
    reached *= n;
    passes++;
  }
  return { passes, reached };
}

export class UpscaleError extends Error {
  constructor(message, code = "upscale_failed") {
    super(message);
    this.name = "UpscaleError";
    this.code = code;
  }
}

export class Upscaler {
  /**
   * @param {{modelsDir?:string, device?:string}} [opts]
   */
  constructor({ modelsDir, device } = {}) {
    this.registry = new ModelRegistry(modelsDir);
    this.runtime = new Runtime({ device });
    this.lastDevice = null;
  }

  listModels() {
    return this.registry.list();
  }

  /** Human-readable description of what will run (or last ran) the models. */
  deviceInfo() {
    const provider = this.lastDevice ?? this.runtime.preferredProvider;
    return { provider, label: PROVIDER_LABELS[provider] ?? provider, verified: this.lastDevice != null };
  }

  /** Check a request fits in memory before spending minutes on it. */
  static assertFits(width, height, scale, nativeScale) {
    const { reached } = planPasses(nativeScale, scale);
    const worst = width * height * reached * reached;
    if (worst > MAX_OUTPUT_PIXELS) {
      const mp = (n) => (n / 1e6).toFixed(0);
      throw new UpscaleError(
        `${width}×${height} at ${scale}× needs a ${mp(worst)} megapixel working image; the limit is ${mp(MAX_OUTPUT_PIXELS)} MP. Choose a smaller scale.`,
        "too_large",
      );
    }
  }

  /**
   * @param {{data:Buffer, width:number, height:number}} img interleaved 8-bit RGB
   * @param {object} opts
   * @param {string} opts.model model id
   * @param {number} opts.scale 2 | 3 | 4
   * @param {AbortSignal} [opts.signal]
   * @param {(p:{fraction:number, message?:string})=>void} [opts.onProgress]
   * @returns {Promise<{data:Buffer, width:number, height:number}>}
   */
  async upscaleRGB(img, { model: modelId, scale, signal, onProgress }) {
    if (!SCALES.includes(scale)) throw new UpscaleError(`scale must be one of ${SCALES.join(", ")}`, "bad_scale");
    const { model, file } = await this.registry.resolve(modelId);
    Upscaler.assertFits(img.width, img.height, scale, model.scale);

    const { passes } = planPasses(model.scale, scale);
    // Weight passes by the pixels they process so overall progress is linear in work.
    const weights = Array.from({ length: passes }, (_, k) => (img.width * img.height) * (model.scale ** (2 * k)));
    const totalWeight = weights.reduce((a, b) => a + b, 0);

    let current = img;
    let doneWeight = 0;
    for (let k = 0; k < passes; k++) {
      current = await this.#pass(current, model, file, {
        signal,
        onTile: (done, total) =>
          onProgress?.({ fraction: (doneWeight + weights[k] * (total ? done / total : 1)) / totalWeight }),
        onRetry: (message) => onProgress?.({ fraction: doneWeight / totalWeight, message }),
      });
      doneWeight += weights[k];
    }

    const targetW = img.width * scale;
    const targetH = img.height * scale;
    if (current.width !== targetW || current.height !== targetH) {
      signal?.throwIfAborted();
      current = await resizeRGB(current, targetW, targetH);
    }
    onProgress?.({ fraction: 1 });
    return current;
  }

  async #pass(img, model, file, { signal, onTile, onRetry }) {
    let maxSize = Infinity;
    for (let attempt = 0; ; attempt++) {
      const session = await this.runtime.load(model, file, { maxSize });
      this.lastDevice = session.provider;
      try {
        return await upscaleTiled(img, {
          maxSize: session.maxSize,
          fixed: session.fixed,
          scale: model.scale,
          margin: MARGIN,
          overlap: OVERLAP,
          infer: (chw, w, h) => session.infer(chw, w, h),
          onTile,
          signal,
        });
      } catch (err) {
        if (signal?.aborted || err?.name === "AbortError") throw err;
        if (session.provider === "cpu" || attempt >= 3) {
          throw new UpscaleError(`inference failed on ${PROVIDER_LABELS[session.provider]}: ${err.message}`);
        }
        log.warn(`inference failed on ${session.provider} @${session.maxSize}px: ${err.message}`);
        if (session.maxSize > 256) {
          maxSize = 256;
          onRetry?.("Graphics memory ran short — retrying with smaller tiles…");
        } else {
          this.runtime.markFailed(session.provider);
          maxSize = Infinity;
          onRetry?.("GPU failed — continuing on CPU…");
        }
      }
    }
  }

  async dispose() {
    await this.runtime.dispose();
  }
}

/** Lanczos resize of an interleaved RGB buffer. */
export async function resizeRGB(img, width, height) {
  const { data, info } = await sharp(img.data, {
    raw: { width: img.width, height: img.height, channels: 3 },
    limitInputPixels: false,
  })
    .resize(width, height, { kernel: "lanczos3", fastShrinkOnLoad: false })
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}
