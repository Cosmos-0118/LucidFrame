// Tile planning, mirrored gathering and seam-free blending.
//
// A network sees windows cut from the image with a mirrored context margin D
// on every side (so image borders get real context instead of zeros). Only the
// inner "usable" region of each window is kept; neighbouring usable regions
// overlap by at least O pixels and are cross-faded there, which hides any
// residual difference between tiles.
//
// Two planning modes:
//  - adaptive (CPU): window edge is chosen per axis so tiles are evenly sized
//    and nothing is computed twice more than necessary.
//  - fixed (GPU): the window is always exactly `maxSize` (static shapes are
//    faster on GPUs); starts are spread evenly so the last tile isn't a sliver.
//
// Everything here is plain typed-array math with no native dependencies so it
// can be tested exactly against a fake model.

/** Index into a signal of length n, mirrored at both edges (edge pixel repeated). Works for any n >= 1. */
export function mirrorIndex(i, n) {
  if (n === 1) return 0;
  const period = 2 * n;
  let m = i % period;
  if (m < 0) m += period;
  return m < n ? m : period - 1 - m;
}

/**
 * Plan tiles along one axis of `len` pixels.
 * @returns {{size:number, tiles:{origin:number,start:number,end:number,ramp:number}[]}}
 *   size: window edge for every tile on this axis
 *   origin: input coordinate of the window's first pixel (may be negative → mirrored)
 *   start/end: usable range in input coordinates, clipped to [0,len]
 *   ramp: leading pixels of [start,end) that cross-fade with the previous tile
 */
export function planAxis(len, maxSize, margin, overlap, { fixed = false } = {}) {
  const usableMax = maxSize - 2 * margin;
  if (usableMax <= overlap + 1 || usableMax <= 0) throw new Error("tile too small for margin/overlap");

  if (len <= usableMax) {
    const size = fixed ? maxSize : len + 2 * margin;
    return { size, tiles: [{ origin: -margin, start: 0, end: len, ramp: 0 }] };
  }

  // +1 slack so rounding the starts can never shrink an overlap below `overlap`.
  const n = Math.ceil((len - overlap - 1) / (usableMax - overlap - 1));
  const usable = fixed ? usableMax : Math.ceil((len + (n - 1) * (overlap + 1)) / n);
  const size = usable + 2 * margin;
  const step = (len - usable) / (n - 1);

  const tiles = [];
  for (let k = 0; k < n; k++) {
    const start = k === n - 1 ? len - usable : Math.floor(k * step);
    const end = start + usable;
    tiles.push({ origin: start - margin, start, end, ramp: k === 0 ? 0 : tiles[k - 1].end - start });
  }
  return { size: Math.max(size, 1), tiles };
}

/** Cross-fade weight for pixel i of a ramp of n pixels: strictly inside (0, 1). */
export function rampWeight(i, n) {
  return (i + 0.5) / n;
}

/**
 * Copy the SW×SH window at (ox, oy) out of an interleaved 8-bit RGB image into
 * planar Float32 CHW in [0,1], mirroring at the image borders.
 * @param {Float32Array} dst length ≥ 3*SW*SH (reused between calls)
 */
export function gatherTile(rgb, width, height, ox, oy, SW, SH, dst) {
  const plane = SW * SH;
  const cols = new Int32Array(SW);
  for (let x = 0; x < SW; x++) cols[x] = mirrorIndex(ox + x, width) * 3;
  const inv = 1 / 255;
  for (let y = 0; y < SH; y++) {
    const rowBase = mirrorIndex(oy + y, height) * width * 3;
    const o = y * SW;
    for (let x = 0; x < SW; x++) {
      const p = rowBase + cols[x];
      dst[o + x] = rgb[p] * inv;
      dst[plane + o + x] = rgb[p + 1] * inv;
      dst[2 * plane + o + x] = rgb[p + 2] * inv;
    }
  }
  return dst;
}

/**
 * Paint a model output tile into the interleaved 8-bit RGB result, cross-fading
 * over the ramps against what is already there.
 *
 * @param {Uint8Array|Buffer} out interleaved RGB, outW*outH*3
 * @param {Float32Array} tile planar CHW, 3×(SH·n)×(SW·n)
 * @param {number} TW tile output width in pixels (SW·n); also the row stride
 * @param {number} TH tile output height in pixels (SH·n)
 * @param {number} n model scale
 * @param {object} X,Y per-axis tile entries from planAxis (input coordinates)
 */
export function paintTile(out, outW, tile, TW, TH, n, X, Y) {
  const plane = TW * TH;
  const x0 = X.start * n;
  const x1 = X.end * n;
  const y0 = Y.start * n;
  const y1 = Y.end * n;
  const rampX = X.ramp * n;
  const rampY = Y.ramp * n;
  // offset of the usable region inside the tile (the margin, in output pixels)
  const tx0 = (X.start - X.origin) * n;
  const ty0 = (Y.start - Y.origin) * n;

  for (let y = y0; y < y1; y++) {
    const trow = (ty0 + (y - y0)) * TW;
    const wy = y - y0 < rampY ? rampWeight(y - y0, rampY) : 1;
    let o = (y * outW + x0) * 3;
    for (let x = x0; x < x1; x++, o += 3) {
      const tp = trow + tx0 + (x - x0);
      const wx = x - x0 < rampX ? rampWeight(x - x0, rampX) : 1;
      const w = wx * wy;
      let r = tile[tp] * 255;
      let g = tile[plane + tp] * 255;
      let b = tile[2 * plane + tp] * 255;
      if (w < 1) {
        r = out[o] + (r - out[o]) * w;
        g = out[o + 1] + (g - out[o + 1]) * w;
        b = out[o + 2] + (b - out[o + 2]) * w;
      }
      out[o] = r < 0 ? 0 : r > 255 ? 255 : (r + 0.5) | 0;
      out[o + 1] = g < 0 ? 0 : g > 255 ? 255 : (g + 0.5) | 0;
      out[o + 2] = b < 0 ? 0 : b > 255 ? 255 : (b + 0.5) | 0;
    }
  }
}

/**
 * Run `infer` over every tile of an image and assemble the upscaled result.
 *
 * @param {object} img { data: interleaved RGB, width, height }
 * @param {object} opts
 * @param {number} opts.maxSize largest window edge allowed
 * @param {boolean} [opts.fixed] always use exactly maxSize×maxSize windows (GPU static shapes)
 * @param {number} opts.scale model scale n
 * @param {number} opts.margin context margin D (input px)
 * @param {number} opts.overlap blend overlap O (input px)
 * @param {(chw:Float32Array, w:number, h:number)=>Promise<Float32Array>} opts.infer
 * @param {(done:number,total:number)=>void} [opts.onTile]
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<{data:Buffer, width:number, height:number}>}
 */
export async function upscaleTiled(img, opts) {
  const { maxSize, fixed = false, scale, margin, overlap, infer, onTile, signal } = opts;
  const { width, height } = img;
  const outW = width * scale;
  const outH = height * scale;
  const out = Buffer.allocUnsafe(outW * outH * 3);

  const X = planAxis(width, maxSize, margin, overlap, { fixed });
  const Y = planAxis(height, maxSize, margin, overlap, { fixed });
  const total = X.tiles.length * Y.tiles.length;
  const input = new Float32Array(3 * X.size * Y.size);
  const TW = X.size * scale;
  const TH = Y.size * scale;

  let done = 0;
  onTile?.(0, total);
  for (const ty of Y.tiles) {
    for (const tx of X.tiles) {
      signal?.throwIfAborted();
      gatherTile(img.data, width, height, tx.origin, ty.origin, X.size, Y.size, input);
      const tile = await infer(input, X.size, Y.size);
      if (tile.length !== 3 * TW * TH) throw new Error(`model returned ${tile.length} values, expected ${3 * TW * TH}`);
      paintTile(out, outW, tile, TW, TH, scale, tx, ty);
      onTile?.(++done, total);
    }
  }
  return { data: out, width: outW, height: outH };
}
