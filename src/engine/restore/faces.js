// Face stage of the Restore pipeline.
//
//   detect   YuNet finds faces and five landmarks (eyes, nose, mouth corners) on the source image.
//   align    a similarity transform maps those landmarks onto the template GFPGAN was trained with (512×512).
//   restore  GFPGAN rebuilds the aligned crop.
//   paste    the result is warped back and blended over the upscaled image through a soft mask.
//
// Everything here works on plain typed arrays so it can be unit-tested without a model.

import sharp from "sharp";

export const CROP = 512;
export const DETECT_SIZE = 640;

/** Landmark positions GFPGAN/FFHQ expects in a 512×512 crop: left eye, right eye, nose, left mouth, right mouth. */
export const FACE_TEMPLATE = [
  [192.98138, 239.94708],
  [318.90277, 240.1936],
  [256.63416, 314.01935],
  [201.26117, 371.41043],
  [313.08905, 371.15118],
];

// ───────────────────────────── geometry ─────────────────────────────

/**
 * Least-squares rotation + uniform scale + translation (no reflection) taking `src` points onto `dst`:
 *   x' = a·x − b·y + tx,   y' = b·x + a·y + ty
 */
export function similarityTransform(src, dst) {
  const n = src.length;
  let sx = 0, sy = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) {
    sx += src[i][0]; sy += src[i][1]; dx += dst[i][0]; dy += dst[i][1];
  }
  sx /= n; sy /= n; dx /= n; dy /= n;
  // Treat points as complex numbers: the best multiplier is Σ conj(u)·v / Σ |u|².
  let re = 0, im = 0, norm = 0;
  for (let i = 0; i < n; i++) {
    const ux = src[i][0] - sx, uy = src[i][1] - sy;
    const vx = dst[i][0] - dx, vy = dst[i][1] - dy;
    re += ux * vx + uy * vy;
    im += ux * vy - uy * vx;
    norm += ux * ux + uy * uy;
  }
  if (norm < 1e-9) throw new Error("degenerate landmarks");
  const a = re / norm;
  const b = im / norm;
  return { a, b, tx: dx - (a * sx - b * sy), ty: dy - (b * sx + a * sy) };
}

export const applyTransform = (m, x, y) => [m.a * x - m.b * y + m.tx, m.b * x + m.a * y + m.ty];

export function invertTransform(m) {
  const det = m.a * m.a + m.b * m.b;
  const a = m.a / det;
  const b = -m.b / det;
  return { a, b, tx: -(a * m.tx - b * m.ty), ty: -(b * m.tx + a * m.ty) };
}

/** Scale factor of a similarity transform. */
export const transformScale = (m) => Math.hypot(m.a, m.b);

// ───────────────────────────── sampling ─────────────────────────────

/**
 * Sample an interleaved 8-bit RGB image into a planar float CHW crop through `m` (image → crop).
 * Pixels outside the image take `fill`. Bilinear; when the face in the image is much bigger than the crop
 * (so the crop is a reduction) each crop pixel averages several samples to avoid aliasing.
 */
export function warpToCrop(image, m, size = CROP, fill = [135, 133, 132]) {
  const { data, width, height } = image;
  const inv = invertTransform(m);
  const out = new Float32Array(3 * size * size);
  const plane = size * size;
  const scale = transformScale(m);
  const ss = scale < 0.7 ? Math.min(4, Math.ceil(1 / scale)) : 1;
  const px = (xi, yi, c) => (xi < 0 || yi < 0 || xi >= width || yi >= height ? fill[c] : data[(yi * width + xi) * 3 + c]);
  const sample = (sx, sy, c) => {
    const x0 = Math.floor(sx);
    const y0 = Math.floor(sy);
    const fx = sx - x0;
    const fy = sy - y0;
    return px(x0, y0, c) * (1 - fx) * (1 - fy) + px(x0 + 1, y0, c) * fx * (1 - fy) + px(x0, y0 + 1, c) * (1 - fx) * fy + px(x0 + 1, y0 + 1, c) * fx * fy;
  };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const o = y * size + x;
      for (let c = 0; c < 3; c++) {
        let sum = 0;
        for (let j = 0; j < ss; j++) {
          for (let i = 0; i < ss; i++) {
            const [sx, sy] = applyTransform(inv, x + (i + 0.5) / ss - 0.5, y + (j + 0.5) / ss - 0.5);
            sum += sample(sx, sy, c);
          }
        }
        out[c * plane + o] = sum / (ss * ss) / 255;
      }
    }
  }
  return out;
}

/** Separable box blur (several passes ≈ Gaussian) on one planar channel; edges clamp. */
export function boxBlur(src, size, radius, passes = 3) {
  let a = Float32Array.from(src);
  let b = new Float32Array(a.length);
  const window = 2 * radius + 1;
  for (let p = 0; p < passes; p++) {
    for (let y = 0; y < size; y++) {
      const row = y * size;
      let sum = 0;
      for (let k = -radius; k <= radius; k++) sum += a[row + Math.min(size - 1, Math.max(0, k))];
      for (let x = 0; x < size; x++) {
        b[row + x] = sum / window;
        sum += a[row + Math.min(size - 1, x + radius + 1)] - a[row + Math.max(0, x - radius)];
      }
    }
    for (let x = 0; x < size; x++) {
      let sum = 0;
      for (let k = -radius; k <= radius; k++) sum += b[Math.min(size - 1, Math.max(0, k)) * size + x];
      for (let y = 0; y < size; y++) {
        a[y * size + x] = sum / window;
        sum += b[Math.min(size - 1, y + radius + 1) * size + x] - b[Math.max(0, y - radius) * size + x];
      }
    }
  }
  return a;
}

/**
 * Keep the restorer's fine detail but the original's broad colour and tone: GFPGAN tends to shift skin tone, eye
 * colour and exposure. out = restored + amount · (lowpass(original) − lowpass(restored)).
 */
export function keepColours(restored, original, size = CROP, { radius = 8, amount = 0.85 } = {}) {
  const plane = size * size;
  const out = new Float32Array(restored.length);
  for (let c = 0; c < 3; c++) {
    const r = restored.subarray(c * plane, (c + 1) * plane);
    const o = original.subarray(c * plane, (c + 1) * plane);
    const lowR = boxBlur(r, size, radius);
    const lowO = boxBlur(o, size, radius);
    for (let i = 0; i < plane; i++) out[c * plane + i] = r[i] + amount * (lowO[i] - lowR[i]);
  }
  return out;
}

/**
 * Soft mask over the crop: 1 across the head (face, hair, ears, neck), easing to 0 at the edge of the crop.
 * Wide on purpose: at low resolution the upscaler garbles the whole head, and a tight mask leaves a restored face
 * pasted inside that wreckage.
 */
export function faceMask(size = CROP) {
  const mask = new Float32Array(size * size);
  const cx = size * 0.5;
  const cy = size * 0.53;
  const rx = size * 0.5;
  const ry = size * 0.52;
  const inner = 0.66; // fully restored inside this fraction of the radius
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot((x - cx) / rx, (y - cy) / ry);
      const t = Math.min(1, Math.max(0, (1 - d) / (1 - inner)));
      mask[y * size + x] = t * t * (3 - 2 * t);
    }
  }
  return mask;
}

/** Average `f`×`f` blocks: a cheap pre-filter so shrinking a crop does not alias. */
export function shrinkPlanar(src, size, channels, f) {
  const n = Math.floor(size / f);
  const out = new Float32Array(channels * n * n);
  for (let c = 0; c < channels; c++) {
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        let sum = 0;
        for (let j = 0; j < f; j++) for (let i = 0; i < f; i++) sum += src[c * size * size + (y * f + j) * size + x * f + i];
        out[c * n * n + y * n + x] = sum / (f * f);
      }
    }
  }
  return { data: out, size: n };
}

function sampleBilinear(plane, size, offset, x, y) {
  const x0 = Math.min(size - 2, Math.max(0, Math.floor(x)));
  const y0 = Math.min(size - 2, Math.max(0, Math.floor(y)));
  const fx = Math.min(1, Math.max(0, x - x0));
  const fy = Math.min(1, Math.max(0, y - y0));
  const i = offset + y0 * size + x0;
  return plane[i] * (1 - fx) * (1 - fy) + plane[i + 1] * fx * (1 - fy) + plane[i + size] * (1 - fx) * fy + plane[i + size + 1] * fx * fy;
}

/**
 * Blend a restored 512 crop back into the image, in place.
 * @param {{data:Buffer, width:number, height:number}} image interleaved RGB, modified
 * @param {{a:number,b:number,tx:number,ty:number}} m the image → crop transform used to make the crop
 * @param {Float32Array} restored planar CHW [0,1]
 * @param {Float32Array} mask size×size
 * @param {number} weight 0..1 overall strength
 */
export function pasteFace(image, m, restored, mask, weight, size = CROP) {
  const { data, width, height } = image;
  const inv = invertTransform(m);
  // Region of the image the crop covers.
  const corners = [[0, 0], [size, 0], [0, size], [size, size]].map(([x, y]) => applyTransform(inv, x, y));
  const x0 = Math.max(0, Math.floor(Math.min(...corners.map((p) => p[0]))));
  const x1 = Math.min(width - 1, Math.ceil(Math.max(...corners.map((p) => p[0]))));
  const y0 = Math.max(0, Math.floor(Math.min(...corners.map((p) => p[1]))));
  const y1 = Math.min(height - 1, Math.ceil(Math.max(...corners.map((p) => p[1]))));

  // A face smaller than the crop (scale > 1: one image pixel spans several crop pixels) means shrinking the
  // restored crop when it goes back. Past ~1.3× plain bilinear sampling would alias, so pre-average blocks.
  const scale = transformScale(m);
  const f = scale > 1.3 ? Math.min(8, Math.round(scale)) : 1;
  let rest = restored;
  let msk = mask;
  let rsize = size;
  if (f > 1) {
    const r = shrinkPlanar(restored, size, 3, f);
    rest = r.data;
    rsize = r.size;
    msk = shrinkPlanar(mask, size, 1, f).data;
  }
  const rplane = rsize * rsize;

  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const [u, v] = applyTransform(m, x, y);
      if (u < 0 || v < 0 || u > size - 1 || v > size - 1) continue;
      const su = u / f;
      const sv = v / f;
      const w = sampleBilinear(msk, rsize, 0, su, sv) * weight;
      if (w <= 0.002) continue;
      const i = (y * width + x) * 3;
      for (let c = 0; c < 3; c++) {
        const r = Math.min(1, Math.max(0, sampleBilinear(rest, rsize, c * rplane, su, sv))) * 255;
        data[i + c] = Math.round(data[i + c] * (1 - w) + r * w);
      }
    }
  }
}

// ───────────────────────────── detection ─────────────────────────────

const STRIDES = [8, 16, 32];

/**
 * Decode YuNet's twelve output tensors into faces (coordinates in the 640×640 input).
 * @param {Record<string,{data:Float32Array}>} out
 */
export function decodeYuNet(out, { threshold = 0.6, size = DETECT_SIZE } = {}) {
  const faces = [];
  for (const stride of STRIDES) {
    const cols = size / stride;
    const cls = out[`cls_${stride}`].data;
    const obj = out[`obj_${stride}`].data;
    const bbox = out[`bbox_${stride}`].data;
    const kps = out[`kps_${stride}`].data;
    for (let i = 0; i < cls.length; i++) {
      const score = Math.sqrt(Math.min(1, Math.max(0, cls[i])) * Math.min(1, Math.max(0, obj[i])));
      if (score < threshold) continue;
      const r = Math.floor(i / cols);
      const c = i % cols;
      const cx = (c + bbox[i * 4]) * stride;
      const cy = (r + bbox[i * 4 + 1]) * stride;
      const w = Math.exp(bbox[i * 4 + 2]) * stride;
      const h = Math.exp(bbox[i * 4 + 3]) * stride;
      const points = [];
      for (let k = 0; k < 5; k++) points.push([(kps[i * 10 + 2 * k] + c) * stride, (kps[i * 10 + 2 * k + 1] + r) * stride]);
      faces.push({ score, box: [cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2], kps: points });
    }
  }
  return faces;
}

const area = (b) => Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);

export function iou(a, b) {
  const inter = area([Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])]);
  return inter / (area(a) + area(b) - inter || 1);
}

/** Highest score first, dropping anything that overlaps an already kept face. */
export function nonMaxSuppression(faces, threshold = 0.3) {
  const kept = [];
  for (const f of [...faces].sort((a, b) => b.score - a.score)) {
    if (kept.every((k) => iou(k.box, f.box) < threshold)) kept.push(f);
  }
  return kept;
}

/** One YuNet pass over a window of the image, scaled to fit the 640×640 input. Faces come back in image coordinates. */
async function detectWindow(session, image, window, scale) {
  const { x, y, w, h } = window;
  const sw = Math.max(1, Math.round(w * scale));
  const sh = Math.max(1, Math.round(h * scale));
  const { data } = await sharp(image.data, { raw: { width: image.width, height: image.height, channels: 3 }, limitInputPixels: false })
    .extract({ left: x, top: y, width: w, height: h })
    .resize(sw, sh, { kernel: "lanczos3", fit: "fill" })
    .raw()
    .toBuffer({ resolveWithObject: true });
  // BGR, 0..255, planar, zero padded to 640×640.
  const plane = DETECT_SIZE * DETECT_SIZE;
  const input = new Float32Array(3 * plane);
  for (let j = 0; j < sh; j++) {
    for (let i = 0; i < sw; i++) {
      const s = (j * sw + i) * 3;
      const o = j * DETECT_SIZE + i;
      input[o] = data[s + 2];
      input[plane + o] = data[s + 1];
      input[2 * plane + o] = data[s];
    }
  }
  const out = await session.run({ [session.inputName]: { data: input, dims: [1, 3, DETECT_SIZE, DETECT_SIZE] } });
  return decodeYuNet(out).map((f) => ({
    score: f.score,
    box: [f.box[0] / scale + x, f.box[1] / scale + y, f.box[2] / scale + x, f.box[3] / scale + y],
    kps: f.kps.map(([px, py]) => [px / scale + x, py / scale + y]),
  }));
}

/**
 * Find faces in an image. YuNet sees faces from about 10 to 300 px at its 640 px input, so large images are
 * searched twice: once shrunk to fit (large faces) and once in native-resolution tiles (small faces).
 * @returns {Promise<Array<{score:number, box:number[], kps:number[][]}>>}
 */
export async function detectFaces(session, image, { signal } = {}) {
  const { width, height } = image;
  const long = Math.max(width, height);
  const found = [];
  const whole = { x: 0, y: 0, w: width, h: height };

  found.push(...(await detectWindow(session, image, whole, Math.min(1, DETECT_SIZE / long))));
  if (long <= DETECT_SIZE) {
    // Small image: a face can also be bigger than the detector's range, so look at half size too.
    if (long >= 160) found.push(...(await detectWindow(session, image, whole, 0.5)));
  } else {
    const step = Math.round(DETECT_SIZE * 0.75);
    let tiles = 0;
    for (let y = 0; y < height && tiles < 36; y += step) {
      for (let x = 0; x < width && tiles < 36; x += step) {
        signal?.throwIfAborted();
        const w = Math.min(DETECT_SIZE, width - x);
        const h = Math.min(DETECT_SIZE, height - y);
        if (w < 48 || h < 48) continue;
        found.push(...(await detectWindow(session, image, { x, y, w, h }, 1)));
        tiles++;
      }
    }
  }
  return nonMaxSuppression(found);
}

// ───────────────────────────── restoration ─────────────────────────────

/**
 * Restore the faces of an already-upscaled image, in place.
 *
 * @param {{data:Buffer,width:number,height:number}} image upscaled RGB (modified)
 * @param {Array<{score:number, box:number[], kps:number[][]}>} faces landmarks in *image* coordinates
 * @param {{infer:(chw:Float32Array,w:number,h:number)=>Promise<Float32Array>}} restorer
 * @param {object} [opts]
 * @param {number} [opts.strength] 0..1 how much of the restored face replaces the original
 * @param {AbortSignal} [opts.signal]
 * @param {(done:number,total:number)=>void} [opts.onFace]
 * @returns {Promise<number>} faces restored
 */
export async function restoreFaces(image, faces, restorer, { strength = 0.85, signal, onFace } = {}) {
  const mask = faceMask();
  let restoredCount = 0;
  for (let i = 0; i < faces.length; i++) {
    signal?.throwIfAborted();
    const { kps, weight = 1 } = faces[i];
    if (weight <= 0) {
      onFace?.(i + 1, faces.length);
      continue;
    }
    const m = similarityTransform(kps, FACE_TEMPLATE);
    const crop = warpToCrop(image, m);
    const raw = await restorer.infer(crop, CROP, CROP);
    const restored = keepColours(raw.length === crop.length ? raw : raw.subarray(0, crop.length), crop);
    pasteFace(image, m, restored, mask, Math.min(1, strength * weight));
    restoredCount++;
    onFace?.(i + 1, faces.length);
  }
  return restoredCount;
}
