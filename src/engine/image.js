// Image decode → upscale → encode.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import sharp from "sharp";
import { UpscaleError, resizeRGB } from "./upscaler.js";

// sharp's default is 268 MP; we cap the *input* lower because the working image is 16× bigger at 4×.
const MAX_INPUT_PIXELS = 150_000_000;
const PREVIEW_ABOVE_PIXELS = 16_000_000;
const PREVIEW_LONG_SIDE = 2560;

export const OUTPUT_FORMATS = ["png", "jpeg", "webp"];

sharp.cache(false); // we manage our own buffers; libvips' operation cache only adds memory pressure.

/** Decode any supported image into straight 8-bit sRGB + optional alpha plane. */
export async function decodeImage(input) {
  let meta;
  try {
    meta = await sharp(input, { limitInputPixels: MAX_INPUT_PIXELS }).metadata();
  } catch (err) {
    throw new UpscaleError(explainSharp(err, input), "bad_image");
  }
  if (!meta.width || !meta.height) throw new UpscaleError("could not read the image dimensions", "bad_image");

  const base = () => sharp(input, { limitInputPixels: MAX_INPUT_PIXELS, failOn: "error" }).rotate();
  try {
    const { data, info } = await base().removeAlpha().toColourspace("srgb").raw().toBuffer({ resolveWithObject: true });
    if (info.channels !== 3) throw new Error(`unexpected channel count ${info.channels}`);
    let alpha = null;
    if (meta.hasAlpha) {
      alpha = await base().ensureAlpha().extractChannel(3).raw().toBuffer();
    }
    const warnings = [];
    if ((meta.pages ?? 1) > 1) warnings.push("Animated image: only the first frame was upscaled.");
    return {
      rgb: { data, width: info.width, height: info.height },
      alpha,
      format: meta.format,
      warnings,
    };
  } catch (err) {
    throw new UpscaleError(explainSharp(err, input), "bad_image");
  }
}

function explainSharp(err, input) {
  const name = typeof input === "string" ? `"${path.basename(input)}"` : "image";
  const msg = String(err?.message ?? err);
  if (/pixel limit|exceeds/i.test(msg)) {
    return `${name} is larger than the ${MAX_INPUT_PIXELS / 1e6} megapixel input limit`;
  }
  if (/unsupported image format|Input file contains unsupported|Input buffer contains unsupported/i.test(msg)) {
    return `${name} is not a supported image format`;
  }
  if (/ENOENT|no such file/i.test(msg)) return `${name} does not exist`;
  return `could not read ${name}: ${msg}`;
}

/** Choose an output encoder: keep the source format when we can write it, PNG otherwise. */
export function pickFormat(requested, sourceFormat, hasAlpha) {
  if (requested && requested !== "auto") {
    if (!OUTPUT_FORMATS.includes(requested)) throw new UpscaleError(`output format must be one of ${OUTPUT_FORMATS.join(", ")}`, "bad_format");
    return requested;
  }
  if (sourceFormat === "jpeg" && !hasAlpha) return "jpeg";
  if (sourceFormat === "webp") return "webp";
  return "png";
}

/** Build a sharp encoder pipeline (not yet written) for a finished RGB(+alpha) image. */
export async function encoderFor(rgb, alpha, { format = "png", quality = 95 } = {}) {
  let img = sharp(rgb.data, { raw: { width: rgb.width, height: rgb.height, channels: 3 }, limitInputPixels: false });
  if (alpha) {
    if (format === "jpeg") {
      // JPEG has no alpha: composite onto white like every image editor does.
      img = sharp(
        await sharp(rgb.data, { raw: { width: rgb.width, height: rgb.height, channels: 3 }, limitInputPixels: false })
          .joinChannel(alpha, { raw: { width: rgb.width, height: rgb.height, channels: 1 } })
          .flatten({ background: "#ffffff" })
          .raw()
          .toBuffer(),
        { raw: { width: rgb.width, height: rgb.height, channels: 3 }, limitInputPixels: false },
      );
    } else {
      img = img.joinChannel(alpha, { raw: { width: rgb.width, height: rgb.height, channels: 1 } });
    }
  }
  switch (format) {
    case "png":
      return img.png({ compressionLevel: 6 });
    case "jpeg":
      if (rgb.width > 65500 || rgb.height > 65500) throw new UpscaleError("result is too large for JPEG (65500 px limit)", "too_large");
      return img.jpeg({ quality, mozjpeg: true, chromaSubsampling: "4:4:4" });
    case "webp":
      if (rgb.width > 16383 || rgb.height > 16383) throw new UpscaleError("result is too large for WebP (16383 px limit); choose PNG", "too_large");
      return img.webp({ quality, effort: 4, smartSubsample: false });
    default:
      throw new UpscaleError(`unknown output format ${format}`, "bad_format");
  }
}

/** `<dir>/<name>_lucid_<scale>x.<ext>`, with -2, -3… if that exists. Never overwrites. */
export function suggestOutputPath(input, { scale, ext, outputDir } = {}) {
  const dir = outputDir ?? path.dirname(input);
  const stem = path.basename(input, path.extname(input));
  let candidate = path.join(dir, `${stem}_lucid_${scale}x.${ext}`);
  for (let i = 2; fs.existsSync(candidate); i++) {
    candidate = path.join(dir, `${stem}_lucid_${scale}x-${i}.${ext}`);
  }
  return candidate;
}

/** Temp sibling used for atomic writes; keeps the extension so sharp/ffmpeg pick the right encoder. */
export function partialPath(finalPath) {
  const ext = path.extname(finalPath);
  const tag = crypto.randomBytes(4).toString("hex");
  return path.join(path.dirname(finalPath), `.${path.basename(finalPath, ext)}.${tag}.partial${ext}`);
}

/**
 * Upscale one image file.
 * @param {import("./upscaler.js").Upscaler} upscaler
 * @param {object} job
 * @param {string} job.input
 * @param {string} [job.output]
 * @param {string} job.model
 * @param {number} job.scale
 * @param {"auto"|"png"|"jpeg"|"webp"} [job.format]
 * @param {number} [job.quality]
 * @param {string} [job.outputDir]
 * @param {string} [job.previewDir] where to put a downsized preview for very large results
 * @param {number} [job.previewAbovePixels] result size above which a preview is made (default 16 MP)
 * @param {AbortSignal} [job.signal]
 * @param {(p:{phase:string,fraction:number,message?:string})=>void} [job.onProgress]
 */
export async function upscaleImageFile(upscaler, job) {
  const { input, model, scale, signal, onProgress } = job;
  const started = performance.now();
  const report = (phase, fraction, message) => onProgress?.({ phase, fraction, message });

  report("decode", 0, "Reading image…");
  const decoded = await decodeImage(input);
  const { rgb, alpha, warnings } = decoded;
  signal?.throwIfAborted();

  const result = await upscaler.upscaleRGB(rgb, {
    model,
    scale,
    signal,
    onProgress: ({ fraction, message }) => report("upscale", 0.03 + 0.89 * fraction, message),
  });

  let alphaOut = null;
  if (alpha) {
    // toColourspace("b-w") keeps the result single-channel; sharp otherwise promotes it to 3-channel sRGB.
    const { data, info } = await sharp(alpha, { raw: { width: rgb.width, height: rgb.height, channels: 1 }, limitInputPixels: false })
      .resize(result.width, result.height, { kernel: "lanczos3" })
      .toColourspace("b-w")
      .raw()
      .toBuffer({ resolveWithObject: true });
    if (info.channels !== 1) throw new UpscaleError(`internal error: alpha plane has ${info.channels} channels`);
    alphaOut = data;
  }
  signal?.throwIfAborted();

  const format = pickFormat(job.format, decoded.format, Boolean(alpha));
  const ext = format === "jpeg" ? "jpg" : format;
  const output = job.output ?? suggestOutputPath(input, { scale, ext, outputDir: job.outputDir });
  fs.mkdirSync(path.dirname(output), { recursive: true });

  report("encode", 0.92, "Saving…");
  const tmp = partialPath(output);
  try {
    const encoder = await encoderFor(result, alphaOut, { format, quality: job.quality });
    await encoder.toFile(tmp);
    signal?.throwIfAborted();
    fs.renameSync(tmp, output);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }

  let preview = null;
  if (job.previewDir && result.width * result.height > (job.previewAbovePixels ?? PREVIEW_ABOVE_PIXELS)) {
    fs.mkdirSync(job.previewDir, { recursive: true });
    const long = Math.max(result.width, result.height);
    const k = Math.min(1, PREVIEW_LONG_SIDE / long);
    const small = await resizeRGB(result, Math.max(1, Math.round(result.width * k)), Math.max(1, Math.round(result.height * k)));
    preview = path.join(job.previewDir, `${crypto.randomBytes(6).toString("hex")}.jpg`);
    await sharp(small.data, { raw: { width: small.width, height: small.height, channels: 3 } })
      .jpeg({ quality: 88 })
      .toFile(preview);
  }

  report("encode", 1);
  return {
    kind: "image",
    input,
    output,
    preview,
    width: result.width,
    height: result.height,
    sourceWidth: rgb.width,
    sourceHeight: rgb.height,
    model,
    scale,
    format,
    seconds: (performance.now() - started) / 1000,
    device: upscaler.deviceInfo(),
    warnings,
  };
}
