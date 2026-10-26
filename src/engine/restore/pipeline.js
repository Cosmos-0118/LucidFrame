// The Restore pipeline for one image: clean → upscale → faces.
//
//   1. Cleanup        Heavily compressed or out-of-focus images are first passed through a 1× restoration model
//                     (trained on JPEG damage and blur). Without it the upscaler treats 8×8 compression blocks as real
//                     structure and enlarges them into mosaics, and simply enlarges blur.
//   2. Upscale        The chosen model (and the usual multi-pass / resize to the requested scale).
//   3. Faces          Faces are found on the source, redrawn by a face-restoration model at 512 px, and blended
//                     back into the upscaled image. Only faces that are small or degraded in the source are
//                     touched in "auto" mode: a face that is already large is better served by the upscaler.
//
// Cleanup and faces are optional extras: if a stage cannot run, the job still finishes and says so in `warnings`.

import { log } from "../log.js";
import { planPasses } from "../upscaler.js";
import { measureBlockiness } from "./blockiness.js";
import { measureSoftness } from "./softness.js";

export const CLEANUP_MODES = ["auto", "on", "off"];
export const FACE_MODES = ["auto", "always", "off"];

/** Blockiness score from which "auto" cleans (clean photos score 1.0–1.05; JPEG quality ≈ 55 scores 1.25–1.3). */
export const CLEANUP_THRESHOLD = 1.25;
/** From the threshold up to here the cleanup is blended in at half to full strength; beyond it, full. */
const CLEANUP_FULL = 1.45;

/** Median edge width (pixels) from which an image counts as soft/out of focus; sharp photos measure 2–6, blur of 2 px or more 9+. */
export const SOFT_EDGE_WIDTH = 9;
/** Soft images are cleaned at 60% strength at the threshold, full strength from here. */
const SOFT_FULL = 16;

const MIN_FACE_SCORE = 0.7;
/** Faces smaller than this in the *output* have too little to anchor a restoration. */
const MIN_FACE_OUTPUT_PX = 48;
/** "auto": source faces up to this wide are restored fully; the weight fades out to zero at FADE_END. */
const AUTO_FULL_PX = 200;
const AUTO_FADE_END = 360;
/** A restoration this faint would cost a model run and change nothing visible. */
const MIN_WEIGHT = 0.05;

export const clamp01 = (x) => Math.min(1, Math.max(0, x));

/**
 * How strongly cleanup is blended in: 1 for clearly damaged images, less for borderline ones.
 * @param {{blockiness?:number|null, edgeWidth?:number|null}} measures
 */
export function cleanupStrength({ blockiness, edgeWidth }, mode) {
  if (mode === "on") return 1;
  const blocks = blockiness != null && blockiness >= CLEANUP_THRESHOLD ? 0.5 + 0.5 * clamp01((blockiness - CLEANUP_THRESHOLD) / (CLEANUP_FULL - CLEANUP_THRESHOLD)) : 0;
  const blur = edgeWidth != null && edgeWidth >= SOFT_EDGE_WIDTH ? 0.6 + 0.4 * clamp01((edgeWidth - SOFT_EDGE_WIDTH) / (SOFT_FULL - SOFT_EDGE_WIDTH)) : 0;
  return Math.max(blocks, blur, 0.5);
}

/** Weight of one face for a given mode: 1 = fully restore, 0 = leave alone. `width` is the face width in source px. */
export function faceWeight(width, mode) {
  if (mode === "always") return 1;
  return clamp01((AUTO_FADE_END - width) / (AUTO_FADE_END - AUTO_FULL_PX));
}

/** Blend two same-size RGB buffers: out = a·(1−t) + b·t. */
function mix(a, b, t) {
  const out = Buffer.allocUnsafe(a.data.length);
  for (let i = 0; i < out.length; i++) out[i] = Math.round(a.data[i] + (b.data[i] - a.data[i]) * t);
  return { data: out, width: a.width, height: a.height };
}

/**
 * @param {import("../upscaler.js").Upscaler} upscaler
 * @param {{data:Buffer,width:number,height:number}} rgb source image
 * @param {object} opts
 * @param {string} opts.model
 * @param {number} opts.scale
 * @param {"auto"|"on"|"off"} [opts.cleanup]
 * @param {"auto"|"always"|"off"} [opts.faces]
 * @param {number} [opts.faceStrength]
 * @param {AbortSignal} [opts.signal]
 * @param {(p:{fraction:number,message?:string})=>void} [opts.onProgress]
 */
export async function runImagePipeline(upscaler, rgb, opts) {
  const { model, scale, signal, onProgress } = opts;
  const cleanup = opts.cleanup ?? "auto";
  const faces = opts.faces ?? "auto";
  const warnings = [];
  const restore = {
    cleanup: { mode: cleanup, applied: false, score: null, edgeWidth: null, reasons: [], strength: 0 },
    faces: { mode: faces, found: 0, restored: 0 },
  };
  const progress = (fraction, message) => onProgress?.({ fraction: clamp01(fraction), message });
  const optional = async (what, fn) => {
    try {
      return await fn();
    } catch (err) {
      if (signal?.aborted || err?.name === "AbortError") throw err;
      log.warn(`${what} skipped: ${err.message}`);
      warnings.push(`${what} was skipped: ${String(err.message).split("\n")[0]}`);
      return null;
    }
  };

  // ── 1. cleanup ──
  let work = rgb;
  let doCleanup = false;
  if (cleanup !== "off") {
    const { score } = measureBlockiness(rgb);
    const { edgeWidth } = measureSoftness(rgb);
    restore.cleanup.score = Math.round(score * 100) / 100;
    restore.cleanup.edgeWidth = edgeWidth;
    if (score >= CLEANUP_THRESHOLD) restore.cleanup.reasons.push("blocks");
    if (edgeWidth != null && edgeWidth >= SOFT_EDGE_WIDTH) restore.cleanup.reasons.push("blur");
    doCleanup = cleanup === "on" || restore.cleanup.reasons.length > 0;
  }
  const faceSpan = faces === "off" ? 0 : 0.1;
  const modelEntry = upscaler.registry.get(model);
  const upscalePasses = planPasses(modelEntry.scale, scale).passes;
  const total = (doCleanup ? 1 : 0) + upscalePasses;
  const body = 1 - faceSpan;
  const cleanSpan = doCleanup ? body / total : 0;

  if (doCleanup) {
    progress(0, restore.cleanup.reasons.includes("blur") && !restore.cleanup.reasons.includes("blocks") ? "Reducing blur…" : "Cleaning up compression and blur…");
    const cleaned = await optional("JPEG cleanup", () =>
      upscaler.cleanRGB(rgb, { signal, onProgress: ({ fraction, message }) => progress(cleanSpan * fraction, message) }),
    );
    if (cleaned) {
      const strength = cleanupStrength({ blockiness: restore.cleanup.score, edgeWidth: restore.cleanup.edgeWidth }, cleanup);
      work = strength >= 0.999 ? cleaned : mix(rgb, cleaned, strength);
      restore.cleanup.applied = true;
      restore.cleanup.strength = Math.round(strength * 100) / 100;
    }
  }
  signal?.throwIfAborted();

  // ── 2. upscale ──
  const result = await upscaler.upscaleRGB(work, {
    model,
    scale,
    signal,
    onProgress: ({ fraction, message }) => progress(cleanSpan + (body - cleanSpan) * fraction, message),
  });

  // ── 3. faces ──
  if (faces !== "off") {
    progress(body, "Looking for faces…");
    await optional("Face restoration", async () => {
      const found = (await upscaler.findFaces(work, { signal })).filter((f) => f.score >= MIN_FACE_SCORE);
      restore.faces.found = found.length;
      // Source → output coordinates (pixel centres, as the resize maps them).
      const k = result.width / work.width;
      const shift = (k - 1) / 2;
      const todo = [];
      for (const f of found) {
        const width = f.box[2] - f.box[0];
        const weight = faceWeight(width, faces);
        if (weight < MIN_WEIGHT || width * k < MIN_FACE_OUTPUT_PX) continue;
        todo.push({ score: f.score, weight, kps: f.kps.map(([x, y]) => [x * k + shift, y * (result.height / work.height) + (result.height / work.height - 1) / 2]) });
      }
      if (!todo.length) return;
      progress(body, todo.length === 1 ? "Restoring face…" : `Restoring ${todo.length} faces…`);
      restore.faces.restored = await upscaler.restoreFaces(result, todo, {
        strength: opts.faceStrength,
        signal,
        onFace: (done, count) => progress(body + faceSpan * (done / count), count === 1 ? "Restoring face…" : `Restoring face ${done} of ${count}…`),
      });
    });
  }
  progress(1);
  return { result, restore, warnings, cleaned: work !== rgb };
}
