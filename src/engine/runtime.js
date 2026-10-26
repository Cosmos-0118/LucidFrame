// ONNX Runtime session management: picks the best execution provider that
// actually works on this machine and falls back (GPU → smaller tile → CPU)
// instead of failing the job.

import os from "node:os";
import { InferenceSession, Tensor, env } from "onnxruntime-node";
import { log } from "./log.js";

// A missing GPU provider is expected and handled (we fall back); don't let ORT print it as an error.
env.logLevel = "fatal";

export const PROVIDER_LABELS = {
  dml: "GPU (DirectML)",
  cuda: "NVIDIA GPU (CUDA)",
  coreml: "Apple GPU (CoreML)",
  cpu: "CPU",
};

/** Largest window edge on CPU. Per-pixel cost is flat with tile size; this bounds cancel latency and memory. */
export const CPU_MAX_TILE = 256;

/** Provider preference order for this platform. `LUCIDFRAME_DEVICE` (auto|cpu|dml|cuda|coreml) overrides. */
export function candidateProviders(preferred = process.env.LUCIDFRAME_DEVICE || "auto") {
  if (preferred !== "auto") {
    if (!(preferred in PROVIDER_LABELS)) throw new Error(`unknown device "${preferred}" (use auto, cpu, dml, cuda or coreml)`);
    return preferred === "cpu" ? ["cpu"] : [preferred, "cpu"];
  }
  if (process.platform === "win32") return ["dml", "cpu"];
  if (process.platform === "darwin") return ["coreml", "cpu"];
  if (process.platform === "linux" && process.arch === "x64") return ["cuda", "cpu"];
  return ["cpu"];
}

/** Fixed window sizes to try per provider, largest first. GPUs amortise call overhead with big windows. */
function tileLadder(provider) {
  return provider === "cpu" ? [CPU_MAX_TILE] : [512, 256];
}

/** DirectML adapter index. ORT orders adapters high-performance first, so 0 is right for most machines. */
function dmlDeviceId() {
  const n = Number(process.env.LUCIDFRAME_DML_DEVICE ?? 0);
  return Number.isInteger(n) && n >= 0 ? n : 0;
}

function sessionOptions(provider, model, size) {
  const fixedShape = size == null; // model files with static shapes (face detector / restorer)
  const opts = {
    executionProviders: [provider === "dml" ? { name: "dml", deviceId: dmlDeviceId() } : provider],
    graphOptimizationLevel: "all",
    logSeverityLevel: 3,
  };
  if (provider === "cpu") {
    opts.intraOpNumThreads = Math.max(1, os.availableParallelism());
    // Dynamic shapes: the planner sizes tiles to the image, so no tile is wasted.
  } else if (!fixedShape) {
    // GPUs: fixed window ⇒ static shapes ⇒ better memory planning and kernel selection.
    opts.freeDimensionOverrides = { h: size, w: size, oh: size * model.scale, ow: size * model.scale };
  }
  if (provider === "dml") {
    // DirectML requirements.
    opts.enableMemPattern = false;
    opts.executionMode = "sequential";
  }
  return opts;
}

/** A loaded model bound to one provider (and, on GPUs, one window size). */
export class ModelSession {
  constructor(session, { provider, size, fixed, model }) {
    this.session = session;
    this.provider = provider;
    /** Largest window edge this session accepts. */
    this.maxSize = size;
    /** True when the graph only accepts exactly maxSize×maxSize windows. */
    this.fixed = fixed;
    this.model = model;
    this.inputName = session.inputNames[0];
    this.outputName = session.outputNames[0];
  }

  /** @param {Float32Array} chw planar RGB 3×h×w in [0,1] @returns {Promise<Float32Array>} 3×(h·n)×(w·n) */
  async infer(chw, w, h) {
    const input = new Tensor("float32", chw.length === 3 * w * h ? chw : chw.subarray(0, 3 * w * h), [1, 3, h, w]);
    const out = await this.session.run({ [this.inputName]: input });
    return out[this.outputName].data;
  }

  /** Run with explicit named inputs; returns every output as `{data, dims}` (used by the face detector). */
  async run(feeds) {
    const inputs = {};
    for (const [name, { data, dims }] of Object.entries(feeds)) inputs[name] = new Tensor("float32", data, dims);
    const out = await this.session.run(inputs);
    return Object.fromEntries(Object.entries(out).map(([k, t]) => [k, { data: t.data, dims: t.dims }]));
  }

  async release() {
    try {
      await this.session.release();
    } catch {
      /* already gone */
    }
  }
}

async function open(model, modelPath, provider, size) {
  const t0 = performance.now();
  let session;
  try {
    session = await InferenceSession.create(modelPath, sessionOptions(provider, model, size));
  } catch (err) {
    // The provider itself can't start (missing driver/library): a smaller tile won't help.
    err.providerUnavailable = true;
    throw err;
  }
  const ms = new ModelSession(session, { provider, size, fixed: provider !== "cpu", model });
  if (provider !== "cpu") {
    // Prove the GPU path works end to end now. A broken driver surfaces here, not halfway through a job.
    try {
      const out = await ms.infer(new Float32Array(3 * size * size).fill(0.5), size, size);
      const expected = 3 * (size * model.scale) ** 2;
      if (out.length !== expected) throw new Error(`unexpected output size ${out.length} (expected ${expected})`);
    } catch (err) {
      await ms.release();
      throw err;
    }
  }
  log.info(`loaded ${model.id} on ${provider}${ms.fixed ? ` @${size}px` : ""} in ${(performance.now() - t0).toFixed(0)}ms`);
  return ms;
}

/**
 * Open the best working session for a model. Walks providers in order and, per
 * provider, window sizes from large to small. Providers that fail are remembered
 * so later loads skip them.
 */
export class Runtime {
  #failed = new Set();
  #cache = new Map(); // model id → ModelSession (one resident model at a time keeps VRAM predictable)

  constructor({ device } = {}) {
    this.device = device;
  }

  get providers() {
    return candidateProviders(this.device).filter((p) => !this.#failed.has(p));
  }

  /** Name of the provider the next load will try first. */
  get preferredProvider() {
    return this.providers[0] ?? "cpu";
  }

  markFailed(provider) {
    if (provider !== "cpu") {
      log.warn(`disabling ${provider} for this session`);
      this.#failed.add(provider);
    }
    for (const [k, v] of this.#cache) {
      if (v.provider === provider) {
        this.#cache.delete(k);
        v.release();
      }
    }
  }

  /**
   * @param {object} model manifest entry
   * @param {string} modelPath absolute path to the .onnx
   * @param {{maxSize?:number}} [opts] cap the window size (used after an out-of-memory retry)
   */
  async load(model, modelPath, { maxSize = Infinity } = {}) {
    const cached = this.#cache.get(model.id);
    if (cached && cached.maxSize <= maxSize && !this.#failed.has(cached.provider)) return cached;
    // Only keep one tiled model resident; switching models (or shrinking tiles) frees the old session.
    for (const [k, v] of this.#cache) {
      if (k.startsWith("static:")) continue;
      this.#cache.delete(k);
      await v.release();
    }

    const errors = [];
    for (const provider of this.providers) {
      for (const size of tileLadder(provider).filter((s) => s <= maxSize)) {
        try {
          const ms = await open(model, modelPath, provider, size);
          this.#cache.set(model.id, ms);
          return ms;
        } catch (err) {
          const reason = String(err.message).split("\n")[0];
          log.warn(`${provider}${provider === "cpu" ? "" : ` @${size}px`} unavailable: ${reason}`);
          errors.push(`${provider}: ${reason}`);
          if (err.providerUnavailable) break;
        }
      }
      if (provider !== "cpu") this.#failed.add(provider);
    }
    throw new Error(`could not load ${model.id} on any device:\n${errors.join("\n")}`);
  }

  /**
   * Open a model whose input shape is fixed in the file (face detector, face restorer). These are small
   * and used alongside the tiled upscalers, so they live in their own cache.
   * @param {{id:string}} model manifest entry
   * @param {string} modelPath
   * @param {number[]} probeDims input shape used to prove the device works, e.g. [1,3,512,512]
   * @param {{cpuOnly?:boolean}} [opts] tiny models run on CPU: a GPU round trip would cost more than it saves
   */
  async loadStatic(model, modelPath, probeDims, { cpuOnly = false } = {}) {
    const key = `static:${model.id}`;
    const cached = this.#cache.get(key);
    if (cached && !this.#failed.has(cached.provider)) return cached;

    const errors = [];
    for (const provider of cpuOnly ? ["cpu"] : this.providers) {
      const t0 = performance.now();
      try {
        const session = await InferenceSession.create(modelPath, sessionOptions(provider, model, null));
        const ms = new ModelSession(session, { provider, size: 0, fixed: true, model });
        if (provider !== "cpu") {
          try {
            await ms.run({ [ms.inputName]: { data: new Float32Array(probeDims.reduce((a, b) => a * b, 1)).fill(0.5), dims: probeDims } });
          } catch (err) {
            await ms.release();
            throw err;
          }
        }
        log.info(`loaded ${model.id} on ${provider} in ${(performance.now() - t0).toFixed(0)}ms`);
        this.#cache.set(key, ms);
        return ms;
      } catch (err) {
        const reason = String(err.message).split("\n")[0];
        log.warn(`${model.id} on ${provider} unavailable: ${reason}`);
        errors.push(`${provider}: ${reason}`);
        if (provider !== "cpu" && !cpuOnly) this.#failed.add(provider);
      }
    }
    throw new Error(`could not load ${model.id} on any device:\n${errors.join("\n")}`);
  }

  async dispose() {
    for (const [k, v] of this.#cache) {
      this.#cache.delete(k);
      await v.release();
    }
  }
}
