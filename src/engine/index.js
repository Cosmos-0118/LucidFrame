// Public engine API, shared by the CLI, the Electron host process and the tests.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { ffmpegPath, runFfmpeg } from "./ffmpeg.js";
import { OUTPUT_FORMATS, upscaleImageFile } from "./image.js";
import { IMAGE_EXTENSIONS, VIDEO_EXTENSIONS, detectKind } from "./kinds.js";
import { log } from "./log.js";
import { SCALES, UpscaleError, Upscaler } from "./upscaler.js";
import { upscaleVideoFile } from "./video.js";

export { IMAGE_EXTENSIONS, VIDEO_EXTENSIONS, OUTPUT_FORMATS, SCALES, UpscaleError, Upscaler, detectKind };

const here = path.dirname(fileURLToPath(import.meta.url));

export function appVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(here, "..", "..", "package.json"), "utf8")).version;
  } catch {
    return "unknown";
  }
}

export class Engine {
  #upscaler;
  #queue = Promise.resolve();

  constructor(opts = {}) {
    this.previewDir = opts.previewDir;
    this.#upscaler = new Upscaler(opts);
  }

  models() {
    return this.#upscaler.listModels();
  }

  async info() {
    return {
      version: appVersion(),
      models: this.models(),
      device: this.#upscaler.deviceInfo(),
      scales: SCALES,
      formats: OUTPUT_FORMATS,
    };
  }

  /**
   * Run one job. Jobs are serialised: a second call waits for the first, which
   * keeps GPU memory and CPU predictable.
   * @param {object} job see upscaleImageFile / upscaleVideoFile; `kind` is auto-detected from the extension.
   */
  process(job) {
    const run = async () => {
      validateJob(job);
      const kind = job.kind ?? detectKind(job.input);
      if (!kind) throw new UpscaleError(`"${path.basename(job.input)}" is not a supported image or video file`, "unsupported");
      const full = { previewDir: this.previewDir, ...job };
      job.signal?.throwIfAborted();
      return kind === "video" ? upscaleVideoFile(this.#upscaler, full) : upscaleImageFile(this.#upscaler, full);
    };
    const result = this.#queue.then(run, run);
    this.#queue = result.catch(() => {});
    return result;
  }

  /** Run the smallest model on a tiny image so the real device (GPU or CPU) is known before the first job. */
  async warm() {
    const smallest = this.#upscaler.registry.models.reduce((a, b) => (a.size <= b.size ? a : b));
    const size = 48;
    const out = await this.#upscaler.upscaleRGB({ data: Buffer.alloc(size * size * 3, 128), width: size, height: size }, { model: smallest.id, scale: 2 });
    if (out.width !== size * 2) throw new Error("wrong output size");
    return { model: smallest.id, device: this.#upscaler.deviceInfo() };
  }

  /** End-to-end self test used by `lucidframe doctor` and the app's first-run check. */
  async doctor() {
    const checks = [];
    const check = async (name, fn) => {
      const t0 = performance.now();
      try {
        const detail = await fn();
        checks.push({ name, ok: true, detail, ms: Math.round(performance.now() - t0) });
      } catch (err) {
        checks.push({ name, ok: false, detail: String(err.message ?? err), ms: Math.round(performance.now() - t0) });
      }
    };

    await check("models", async () => {
      const list = this.models();
      for (const m of list) await this.#upscaler.registry.resolve(m.id); // verifies sha256
      return `${list.length} models verified (${list.map((m) => m.id).join(", ")})`;
    });
    await check("inference", async () => {
      const { model, device } = await this.warm();
      return `${model} ran on ${device.label}`;
    });
    await check("image codec", async () => `sharp ${sharp.versions.sharp}, libvips ${sharp.versions.vips}`);
    await check("ffmpeg", async () => {
      const { code, stdout } = await runFfmpeg(["-version"]);
      if (code !== 0) throw new Error(`ffmpeg exited with ${code}`);
      return `${stdout.toString().split("\n")[0]} (${ffmpegPath()})`;
    });
    return { ok: checks.every((c) => c.ok), version: appVersion(), platform: `${process.platform}-${process.arch}`, node: process.version, checks };
  }

  async dispose() {
    await this.#upscaler.dispose();
  }
}

function validateJob(job) {
  if (!job || typeof job !== "object") throw new UpscaleError("invalid job", "bad_request");
  if (typeof job.input !== "string" || !job.input) throw new UpscaleError("job.input must be a file path", "bad_request");
  if (!path.isAbsolute(job.input)) throw new UpscaleError("job.input must be an absolute path", "bad_request");
  let stat;
  try {
    stat = fs.statSync(job.input);
  } catch {
    throw new UpscaleError(`"${path.basename(job.input)}" does not exist`, "missing");
  }
  if (!stat.isFile()) throw new UpscaleError(`"${path.basename(job.input)}" is not a file`, "bad_request");
  if (!SCALES.includes(job.scale)) throw new UpscaleError(`scale must be one of ${SCALES.join(", ")}`, "bad_scale");
  if (typeof job.model !== "string") throw new UpscaleError("job.model is required", "bad_request");
  if (job.format != null && job.format !== "auto" && !OUTPUT_FORMATS.includes(job.format)) {
    throw new UpscaleError(`format must be auto or one of ${OUTPUT_FORMATS.join(", ")}`, "bad_format");
  }
  if (job.quality != null && !(Number.isInteger(job.quality) && job.quality >= 1 && job.quality <= 100)) {
    throw new UpscaleError("quality must be an integer 1–100", "bad_request");
  }
  if (job.output != null && !path.isAbsolute(job.output)) throw new UpscaleError("job.output must be an absolute path", "bad_request");
  if (job.outputDir != null && !path.isAbsolute(job.outputDir)) throw new UpscaleError("job.outputDir must be an absolute path", "bad_request");
}

export { log };
