// Restore pipeline: the maths and decisions (no models), plus the pipeline orchestration with a fake upscaler.

import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";
import sharp from "sharp";
import { measureBlockiness } from "../src/engine/restore/blockiness.js";
import { measureSoftness } from "../src/engine/restore/softness.js";
import {
  CROP,
  FACE_TEMPLATE,
  applyTransform,
  boxBlur,
  decodeYuNet,
  faceMask,
  invertTransform,
  isPlausibleRestoration,
  iou,
  keepColours,
  maskIsPlausible,
  nonMaxSuppression,
  pasteFace,
  refineMask,
  restoreFaces,
  similarityTransform,
  warpToCrop,
} from "../src/engine/restore/faces.js";
import { CLEANUP_THRESHOLD, SOFT_EDGE_WIDTH, cleanupStrength, faceWeight, runImagePipeline } from "../src/engine/restore/pipeline.js";

const fixture = path.join(import.meta.dirname, "fixtures", "portrait.jpg");

async function decode(buffer) {
  const { data, info } = await sharp(buffer).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

/** The portrait fixture, optionally shrunk and re-compressed as JPEG. */
async function portrait({ width, quality } = {}) {
  let img = sharp(fixture);
  if (width) img = img.resize(width);
  if (quality) img = sharp(await img.jpeg({ quality }).toBuffer());
  return decode(await img.png().toBuffer());
}

describe("blockiness", () => {
  it("is near 1 for clean images and grows with JPEG compression", async () => {
    const clean = await decode(await sharp(fixture).png().toBuffer());
    const cleanScore = measureBlockiness(clean).score;
    assert.ok(cleanScore < 1.15, `a lightly compressed portrait scored ${cleanScore}`);

    const scores = [];
    for (const quality of [60, 30, 12]) scores.push(measureBlockiness(await portrait({ quality })).score);
    assert.ok(scores[0] < scores[1] && scores[1] < scores[2], `scores should rise as quality falls: ${scores}`);
    assert.ok(scores[2] > CLEANUP_THRESHOLD + 0.2, `quality 12 scored only ${scores[2]}`);
  });

  it("still sees the grid when the image was cropped off-grid", async () => {
    const compressed = await sharp(fixture).jpeg({ quality: 20 }).toBuffer();
    const cropped = await decode(await sharp(compressed).extract({ left: 3, top: 5, width: 500, height: 498 }).png().toBuffer());
    assert.ok(measureBlockiness(cropped).score > CLEANUP_THRESHOLD, "crop moved the 8×8 grid and the detector lost it");
  });

  it("does not mistake periodic textures or block-aligned graphics for JPEG blocks", () => {
    // 4-pixel checkerboard: strong edges at two positions of the 8-pixel period, not one
    const w = 256;
    const checker = Buffer.alloc(w * w * 3);
    for (let y = 0; y < w; y++) for (let x = 0; x < w; x++) checker.fill((((x >> 2) + (y >> 2)) & 1) * 200 + 20, (y * w + x) * 3, (y * w + x) * 3 + 3);
    assert.ok(measureBlockiness({ data: checker, width: w, height: w }).score < 1.1);
    // 8× nearest-neighbour pixel art: flat inside every block, steps only on the grid
    const art = Buffer.alloc(w * w * 3);
    for (let y = 0; y < w; y++) for (let x = 0; x < w; x++) art.fill(((((x >> 3) * 7 + (y >> 3) * 13) % 5) * 50) & 255, (y * w + x) * 3, (y * w + x) * 3 + 3);
    assert.equal(measureBlockiness({ data: art, width: w, height: w }).score, 1);
  });

  it("does not flag a flat, a noisy or a tiny image", () => {
    const flat = { data: Buffer.alloc(64 * 64 * 3, 90), width: 64, height: 64 };
    assert.equal(measureBlockiness(flat).score, 1);
    const noise = Buffer.alloc(256 * 256 * 3);
    let seed = 1;
    for (let i = 0; i < noise.length; i++) noise[i] = (seed = (seed * 1103515245 + 12345) & 0x7fffffff) >> 16;
    assert.ok(measureBlockiness({ data: noise, width: 256, height: 256 }).score < 1.1);
    assert.equal(measureBlockiness({ data: Buffer.alloc(16 * 16 * 3), width: 16, height: 16 }).score, 1);
  });
});

describe("softness", () => {
  /** A vertical step edge from dark to light whose transition is `blur` pixels wide, repeated every 24 px. */
  const edges = (blur, w = 480, h = 120) => {
    const data = Buffer.alloc(w * h * 3);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const t = (x % 48) - 24; // two edges per 48 px, going up then down
        const up = Math.min(1, Math.max(0, (t - -blur / 2) / blur + 0.5));
        const v = (x % 48 < 24 ? up : 1 - Math.min(1, Math.max(0, (t - 0 - blur / 2) / blur + 0.5))) * 200 + 20;
        data.fill(Math.round(v), (y * w + x) * 3, (y * w + x) * 3 + 3);
      }
    }
    return { data, width: w, height: h };
  };

  it("measures edge width: narrow for sharp edges, wide for blurred ones", () => {
    const sharpEdge = measureSoftness(edges(1)).edgeWidth;
    const soft = measureSoftness(edges(14)).edgeWidth;
    assert.ok(sharpEdge <= 3, `sharp edge measured ${sharpEdge}`);
    assert.ok(soft >= SOFT_EDGE_WIDTH, `a 14 px transition measured only ${soft}`);
  });

  it("says nothing when there are no edges to judge", () => {
    assert.equal(measureSoftness({ data: Buffer.alloc(200 * 200 * 3, 90), width: 200, height: 200 }).edgeWidth, null);
    assert.equal(measureSoftness({ data: Buffer.alloc(20 * 20 * 3), width: 20, height: 20 }).edgeWidth, null);
  });

  it("calls a sharp portrait sharp and a blurred one soft", async () => {
    const sharpPortrait = measureSoftness(await decode(await sharp(fixture).png().toBuffer())).edgeWidth;
    const blurred = measureSoftness(await decode(await sharp(fixture).blur(3).png().toBuffer())).edgeWidth;
    assert.ok(sharpPortrait < SOFT_EDGE_WIDTH, `sharp portrait measured ${sharpPortrait}`);
    assert.ok(blurred === null || blurred >= SOFT_EDGE_WIDTH, `blurred portrait measured ${blurred}`);
    assert.ok(blurred !== null, "a blurred portrait still has edges to measure");
  });
});

describe("similarity transform", () => {
  const known = { a: 0.8, b: -0.35, tx: 41, ty: -17 };

  it("recovers an exact transform from five landmarks", () => {
    const src = FACE_TEMPLATE.map(([x, y]) => applyTransform(invertTransform(known), x, y));
    const m = similarityTransform(src, FACE_TEMPLATE);
    for (const k of ["a", "b", "tx", "ty"]) assert.ok(Math.abs(m[k] - known[k]) < 1e-9, `${k}: ${m[k]} vs ${known[k]}`);
  });

  it("inverts cleanly", () => {
    const inv = invertTransform(known);
    const [x, y] = applyTransform(inv, ...applyTransform(known, 123.4, -56.7));
    assert.ok(Math.abs(x - 123.4) < 1e-9 && Math.abs(y + 56.7) < 1e-9);
  });

  it("never reflects: mirrored landmarks give a rotation, not a flipped face", () => {
    const mirrored = FACE_TEMPLATE.map(([x, y]) => [CROP - x, y]);
    const m = similarityTransform(mirrored, FACE_TEMPLATE);
    // a pure similarity has a·a + b·b = scale²; a reflection would need a negative determinant
    assert.ok(Math.hypot(m.a, m.b) > 0);
    const [ex, ey] = applyTransform(m, mirrored[0][0], mirrored[0][1]);
    assert.ok(Number.isFinite(ex) && Number.isFinite(ey));
  });

  it("is stable under landmark noise", () => {
    const noisy = FACE_TEMPLATE.map(([x, y], i) => [x + ((i * 7) % 5) - 2, y + ((i * 3) % 5) - 2]);
    const m = similarityTransform(noisy, FACE_TEMPLATE);
    assert.ok(Math.abs(Math.hypot(m.a, m.b) - 1) < 0.05);
  });

  it("rejects degenerate landmarks", () => {
    assert.throws(() => similarityTransform(Array(5).fill([10, 10]), FACE_TEMPLATE), /degenerate/);
  });
});

describe("crop, blend and paste", () => {
  const gradient = (w, h) => {
    const data = Buffer.alloc(w * h * 3);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const o = (y * w + x) * 3;
        data[o] = Math.round((x / w) * 255);
        data[o + 1] = Math.round((y / h) * 255);
        data[o + 2] = 128;
      }
    }
    return { data, width: w, height: h };
  };

  it("an identity warp returns the pixels it was given", () => {
    const img = gradient(600, 600);
    const crop = warpToCrop(img, { a: 1, b: 0, tx: 0, ty: 0 });
    for (const [x, y] of [[0, 0], [100, 200], [511, 511]]) {
      for (let c = 0; c < 3; c++) assert.ok(Math.abs(crop[c * CROP * CROP + y * CROP + x] * 255 - img.data[(y * 600 + x) * 3 + c]) < 0.01);
    }
  });

  it("fills outside the image instead of wrapping or crashing", () => {
    const img = gradient(100, 100);
    const crop = warpToCrop(img, { a: 1, b: 0, tx: 300, ty: 300 }, 64, [10, 20, 30]);
    assert.ok(Math.abs(crop[0] * 255 - 10) < 1e-3); // top-left of the crop is left of / above the image
  });

  it("pasting an unchanged crop back leaves the image unchanged", () => {
    const img = gradient(700, 700);
    const kps = FACE_TEMPLATE.map(([x, y]) => applyTransform({ a: 0.9, b: 0.2, tx: 90, ty: 60 }, x, y));
    const m = similarityTransform(kps, FACE_TEMPLATE);
    const crop = warpToCrop(img, m);
    const copy = { ...img, data: Buffer.from(img.data) };
    pasteFace(copy, m, crop, faceMask(), 1);
    let worst = 0;
    for (let i = 0; i < copy.data.length; i++) worst = Math.max(worst, Math.abs(copy.data[i] - img.data[i]));
    assert.ok(worst <= 3, `round trip changed pixels by up to ${worst} levels`);
  });

  it("only touches the area the crop covers, and fades toward its edge", () => {
    const img = { data: Buffer.alloc(900 * 900 * 3, 50), width: 900, height: 900 };
    const m = { a: 1, b: 0, tx: -100, ty: -100 }; // crop covers image x,y in [100, 612)
    const white = new Float32Array(3 * CROP * CROP).fill(1);
    pasteFace(img, m, white, faceMask(), 1);
    const at = (x, y) => img.data[(y * 900 + x) * 3];
    assert.equal(at(10, 10), 50);
    assert.equal(at(800, 800), 50);
    assert.equal(at(100 + 256, 100 + 270), 255, "the middle of the crop is fully replaced");
    const edge = at(100 + 4, 100 + 4);
    assert.ok(edge < 255 && edge >= 50, "the corner of the crop is blended, not replaced");
  });

  it("respects the weight", () => {
    const img = { data: Buffer.alloc(600 * 600 * 3, 0), width: 600, height: 600 };
    pasteFace(img, { a: 1, b: 0, tx: 0, ty: 0 }, new Float32Array(3 * CROP * CROP).fill(1), faceMask(), 0.5);
    const v = img.data[(270 * 600 + 256) * 3];
    assert.ok(Math.abs(v - 127.5) <= 1.5, `half weight gave ${v}`);
  });

  it("shrinks a restored crop before pasting it into a much smaller face (no aliasing)", () => {
    // The face is 128 px wide in the image, so the 512 px crop is shrunk 4×. A 1-pixel checkerboard must average to
    // mid-grey; plain point sampling would give black or white.
    const crop = new Float32Array(3 * CROP * CROP);
    for (let c = 0; c < 3; c++) for (let y = 0; y < CROP; y++) for (let x = 0; x < CROP; x++) crop[c * CROP * CROP + y * CROP + x] = (x + y) & 1;
    const img = { data: Buffer.alloc(200 * 200 * 3, 0), width: 200, height: 200 };
    pasteFace(img, { a: 4, b: 0, tx: -80, ty: -80 }, crop, faceMask(), 1); // crop covers image x,y in [20, 148)
    const v = img.data[(84 * 200 + 84) * 3];
    assert.ok(v > 90 && v < 165, `expected mid-grey, got ${v}`);
  });

  it("averages when a large face is reduced into the crop (no aliasing)", () => {
    // a 1-pixel checkerboard image seen at 0.25× must come out mid-grey, not black or white
    const w = 2200;
    const data = Buffer.alloc(w * w * 3);
    for (let y = 0; y < w; y++) for (let x = 0; x < w; x++) data.fill(((x + y) & 1) * 255, (y * w + x) * 3, (y * w + x) * 3 + 3);
    const crop = warpToCrop({ data, width: w, height: w }, { a: 0.25, b: 0, tx: 0, ty: 0 });
    for (const i of [1000, 70000, 150000, 250000]) assert.ok(Math.abs(crop[i] - 0.5) < 0.1, `sample ${i}: ${crop[i]}`);
  });

  it("the mask is 1 in the middle, 0 in the corners and never negative", () => {
    const mask = faceMask();
    assert.ok(mask[(CROP * 0.53 | 0) * CROP + CROP / 2] > 0.999);
    assert.equal(mask[0], 0);
    assert.equal(mask[CROP * CROP - 1], 0);
    assert.ok(mask.every((v) => v >= 0 && v <= 1));
  });

  it("enlarging a small face is smooth: a ramp stays a ramp instead of turning into blocky steps", () => {
    // a 40 px source with a horizontal ramp, cut into a 512 crop (about 10× magnification)
    const w = 40;
    const data = Buffer.alloc(w * w * 3);
    for (let y = 0; y < w; y++) for (let x = 0; x < w; x++) data.fill(Math.round((x / (w - 1)) * 255), (y * w + x) * 3, (y * w + x) * 3 + 3);
    const m = { a: 10, b: 0, tx: 0, ty: 0 };
    const crop = warpToCrop({ data, width: w, height: w }, m);
    // well inside the picture, neighbouring crop pixels differ by a tenth of a source step (0.65 levels), never a whole one
    let worstStep = 0;
    for (let x = 100; x < 350; x++) worstStep = Math.max(worstStep, Math.abs(crop[256 * CROP + x + 1] - crop[256 * CROP + x]) * 255);
    assert.ok(worstStep < 1.5, `largest jump between neighbouring crop pixels ${worstStep.toFixed(2)} levels`);
    // and it still lands on the right value: crop x 300 reads source x 30, whose ramp value is known
    const expected = (30 / (w - 1)) * 255;
    assert.ok(Math.abs(crop[256 * CROP + 300] * 255 - expected) < 1.5, `got ${(crop[256 * CROP + 300] * 255).toFixed(1)}, expected ${expected.toFixed(1)}`);
  });

  it("refineMask pulls the face outline in, feathers it and fades out at the crop border", () => {
    const raw = new Float32Array(CROP * CROP);
    for (let y = 100; y < 400; y++) raw.fill(1, y * CROP + 120, y * CROP + 390); // a rectangular "face"
    const mask = refineMask(raw);
    const at = (x, y) => mask[y * CROP + x];
    assert.ok(at(256, 250) > 0.999, "the middle of the face is fully replaced");
    assert.ok(at(60, 250) === 0 && at(450, 250) === 0, "nothing outside the face");
    assert.ok(at(120, 250) < 0.4, `at the face's own outline the mask is under half: ${at(120, 250).toFixed(2)}`);
    assert.ok(at(100, 250) < 0.1, "and it is nearly gone a little outside, where hair and background start");
    assert.ok(at(120, 250) < at(135, 250) && at(135, 250) < at(150, 250) && at(150, 250) < 1, "a smooth ramp, not a hard edge");
    assert.ok(mask.every((v) => v >= 0 && v <= 1));
    const full = refineMask(new Float32Array(CROP * CROP).fill(1));
    assert.ok(full[0] < 0.05 && full[10 * CROP + 256] < 0.2 && full[256 * CROP + 256] > 0.99, "faded at the very border of the crop");
  });

  it("only trusts a mask that covers a believable share of the crop", () => {
    const share = (f) => new Float32Array(1000).fill(0).fill(1, 0, Math.round(1000 * f));
    assert.equal(maskIsPlausible(share(0)), false, "no face found");
    assert.equal(maskIsPlausible(share(0.03)), false, "a speck");
    assert.equal(maskIsPlausible(share(0.3)), true, "a typical face fills about a third of the aligned crop");
    assert.equal(maskIsPlausible(share(0.95)), false, "everything is not a face");
  });

  describe("restoreFaces", () => {
    const FACE_KPS = FACE_TEMPLATE.map(([x, y]) => [x * 0.5 + 100, y * 0.5 + 80]); // a face half the crop's size, at (100, 80)
    const flat = (v, w, h) => ({ data: Buffer.alloc(w * h * 3, v), width: w, height: h });
    /** A restorer that records its crop and adds fine stripes (detail) without changing the tone, as a real one does. */
    const striper = () => {
      const seen = [];
      return {
        seen,
        infer: async (chw) => {
          seen.push(chw);
          const out = Float32Array.from(chw);
          for (let c = 0; c < 3; c++) for (let y = 0; y < CROP; y++) for (let x = 0; x < CROP; x++) out[c * CROP * CROP + y * CROP + x] += (x >> 2) & 1 ? 0.25 : -0.25;
          return out;
        },
      };
    };
    // Is the image changed near the spot where crop pixel (cx, cy) lands, for a face whose landmarks are `kps`?
    const changedAt = (img, kps, cx, cy) => {
      const m = similarityTransform(kps, FACE_TEMPLATE);
      const [x, y] = applyTransform(invertTransform(m), cx, cy);
      let worst = 0;
      for (let i = -6; i <= 6; i++) worst = Math.max(worst, Math.abs(img.data[(Math.round(y) * img.width + Math.round(x) + i) * 3] - 128));
      return worst > 20;
    };

    it("cuts the crop from the source pixels when they are given, and pastes into the upscaled image", async () => {
      const source = flat(40, 400, 300); // dark source
      const out = flat(200, 400, 300); // lighter "upscaled" picture (the kps are shared, so the geometry is the same)
      const r = striper();
      await restoreFaces(out, [{ kps: FACE_KPS, srcKps: FACE_KPS }], r, { source, strength: 1 });
      assert.ok(Math.abs(r.seen[0][100] * 255 - 40) < 1, `the restorer saw ${(r.seen[0][100] * 255).toFixed(0)}, the source was 40`);
      const r2 = striper();
      await restoreFaces(flat(200, 400, 300), [{ kps: FACE_KPS }], r2, { strength: 1 });
      assert.ok(Math.abs(r2.seen[0][100] * 255 - 200) < 1, "without a source it reads the image itself, as before");
    });

    it("blends through the parsing mask, not the ellipse, when a plausible one is available", async () => {
      const img = flat(128, 400, 300);
      // 1 on the left part of the crop only: x 30–250, y 60–450 (a third of the crop, like a real face)
      const parser = { mask: async () => { const m = new Float32Array(CROP * CROP); for (let y = 60; y < 450; y++) m.fill(1, y * CROP + 30, y * CROP + 250); return m; } };
      await restoreFaces(img, [{ kps: FACE_KPS }], striper(), { strength: 1, parser });
      assert.ok(changedAt(img, FACE_KPS, 140, 256), "inside the parsed face the restoration is pasted");
      assert.equal(changedAt(img, FACE_KPS, 380, 256), false, "outside the parsed face nothing is pasted (the ellipse would have painted here)");
    });

    it("falls back to the ellipse when the parser fails, and stops asking it", async () => {
      let asked = 0;
      const parser = { mask: async () => (asked++, Promise.reject(new Error("parser exploded"))) };
      const img = flat(128, 600, 300);
      const second = FACE_KPS.map(([x, y]) => [x + 250, y]);
      const n = await restoreFaces(img, [{ kps: FACE_KPS }, { kps: second }], striper(), { strength: 1, parser });
      assert.equal(n, 2);
      assert.equal(asked, 1, "a broken parser is not retried for every face");
      assert.ok(changedAt(img, FACE_KPS, 256, 300) && changedAt(img, second, 256, 300), "the ellipse still pasted both faces");
    });

    it("ignores a parser that finds nothing", async () => {
      const img = flat(128, 400, 300);
      await restoreFaces(img, [{ kps: FACE_KPS }], striper(), { strength: 1, parser: { mask: async () => new Float32Array(CROP * CROP) } });
      assert.ok(changedAt(img, FACE_KPS, 256, 300), "an empty mask must not erase the restoration");
    });
  });

  it("keepColours keeps detail from the restored face and tone from the original", () => {
    const n = 128;
    const original = new Float32Array(3 * n * n).fill(0.4);
    const restored = new Float32Array(3 * n * n);
    for (let c = 0; c < 3; c++) for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) restored[c * n * n + y * n + x] = 0.7 + (((x >> 1) + (y >> 1)) & 1 ? 0.08 : -0.08);
    const out = keepColours(restored, original, n, { amount: 1 });
    const mean = out.reduce((a, b) => a + b, 0) / out.length;
    assert.ok(Math.abs(mean - 0.4) < 0.02, `tone should follow the original: mean ${mean}`);
    const low = boxBlur(out.subarray(0, n * n), n, 8);
    const detail = Math.abs(out[n * 20 + 20] - low[n * 20 + 20]) + Math.abs(out[n * 20 + 22] - low[n * 20 + 22]);
    assert.ok(detail > 0.1, "the fine pattern must survive");
  });
});

describe("face detector output", () => {
  /** YuNet's twelve outputs for a 640×640 input, all zero except what we set. */
  const emptyOutput = () => {
    const out = {};
    for (const stride of [8, 16, 32]) {
      const n = (640 / stride) ** 2;
      out[`cls_${stride}`] = { data: new Float32Array(n) };
      out[`obj_${stride}`] = { data: new Float32Array(n) };
      out[`bbox_${stride}`] = { data: new Float32Array(n * 4) };
      out[`kps_${stride}`] = { data: new Float32Array(n * 10) };
    }
    return out;
  };

  it("decodes boxes and landmarks from grid cells", () => {
    const out = emptyOutput();
    const cols = 80;
    const i = 10 * cols + 20; // row 10, column 20 at stride 8
    out.cls_8.data[i] = 0.81;
    out.obj_8.data[i] = 0.81;
    out.bbox_8.data.set([0.5, 0.5, Math.log(4), Math.log(5)], i * 4);
    out.kps_8.data.set([-1, -1, 1, -1, 0, 0, -1, 2, 1, 2], i * 10);
    const [face, ...rest] = decodeYuNet(out);
    assert.equal(rest.length, 0);
    assert.ok(Math.abs(face.score - 0.81) < 1e-6);
    assert.deepEqual(face.box.map(Math.round), [148, 64, 180, 104]); // centre (164,84), 32×40
    assert.deepEqual(face.kps[0], [152, 72]); // (20 + −1)·8, (10 + −1)·8
    assert.deepEqual(face.kps[2], [160, 80]);
  });

  it("ignores low-confidence cells", () => {
    const out = emptyOutput();
    out.cls_16.data[5] = 0.3;
    out.obj_16.data[5] = 0.3;
    assert.deepEqual(decodeYuNet(out), []);
  });

  it("suppresses duplicates but keeps separate faces", () => {
    const faces = [
      { score: 0.9, box: [100, 100, 200, 220], kps: [] },
      { score: 0.8, box: [105, 98, 205, 218], kps: [] },
      { score: 0.7, box: [400, 100, 480, 200], kps: [] },
    ];
    const kept = nonMaxSuppression(faces);
    assert.deepEqual(kept.map((f) => f.score), [0.9, 0.7]);
    assert.equal(iou([0, 0, 10, 10], [20, 20, 30, 30]), 0);
  });
});

describe("GPU sanity check", () => {
  const input = new Float32Array(3 * 64 * 64).fill(0.5);
  it("accepts a restoration that stays close to its input and rejects garbage", () => {
    const near = Float32Array.from(input, (v, i) => v + ((i % 7) - 3) * 0.02);
    assert.ok(isPlausibleRestoration(input, near));
    assert.equal(isPlausibleRestoration(input, new Float32Array(input.length).fill(NaN)), false);
    assert.equal(isPlausibleRestoration(input, new Float32Array(input.length).fill(1)), false, "a white frame is not this face");
    assert.equal(isPlausibleRestoration(input, Float32Array.from(input, (_, i) => (i % 2 ? 0 : 1))), false, "noise");
    assert.equal(isPlausibleRestoration(input, new Float32Array(10)), false, "too short");
  });
});

describe("pipeline decisions", () => {
  it("cleanup strength ramps from half to full across the borderline range", () => {
    assert.equal(cleanupStrength({ blockiness: CLEANUP_THRESHOLD }, "auto"), 0.5);
    assert.equal(cleanupStrength({ blockiness: 1.6 }, "auto"), 1);
    const mid = cleanupStrength({ blockiness: 1.35 }, "auto");
    assert.ok(mid > 0.5 && mid < 1, `${mid}`);
    assert.equal(cleanupStrength({ blockiness: 1.0 }, "on"), 1);
  });

  it("blur strength ramps from 60% at the soft threshold to full, and the stronger reason wins", () => {
    assert.ok(Math.abs(cleanupStrength({ edgeWidth: SOFT_EDGE_WIDTH }, "auto") - 0.6) < 1e-9);
    assert.equal(cleanupStrength({ edgeWidth: 40 }, "auto"), 1);
    assert.equal(cleanupStrength({ edgeWidth: 40, blockiness: CLEANUP_THRESHOLD }, "auto"), 1);
  });

  it("face weight fades out as the source face gets bigger, unless forced", () => {
    assert.equal(faceWeight(80, "auto"), 1);
    assert.equal(faceWeight(200, "auto"), 1);
    assert.ok(Math.abs(faceWeight(280, "auto") - 0.5) < 1e-9);
    assert.equal(faceWeight(360, "auto"), 0);
    assert.equal(faceWeight(900, "auto"), 0);
    assert.equal(faceWeight(900, "always"), 1);
  });
});

describe("runImagePipeline (fake upscaler)", () => {
  function fake({ faces = [], cleanFails = false, findFails = false, restoreFails = false } = {}) {
    const calls = [];
    return {
      calls,
      registry: { get: () => ({ scale: 4 }) },
      async cleanRGB(img, { signal } = {}) {
        calls.push("clean");
        signal?.throwIfAborted();
        if (cleanFails) throw new Error("cleanup model exploded");
        return { data: Buffer.alloc(img.data.length, 77), width: img.width, height: img.height };
      },
      async upscaleRGB(img, { scale, onProgress }) {
        calls.push("upscale");
        onProgress?.({ fraction: 0.5 });
        return { data: Buffer.alloc(img.width * scale * img.height * scale * 3, 100), width: img.width * scale, height: img.height * scale };
      },
      async findFaces() {
        calls.push("find");
        if (findFails) throw new Error("detector exploded");
        return faces;
      },
      async restoreFaces(img, list, opts) {
        calls.push("restore");
        this.restored = list;
        opts.onFace?.(list.length, list.length);
        if (restoreFails) throw new Error("restorer exploded");
        return list.length;
      },
    };
  }
  const face = (width, over = {}) => ({ score: 0.95, box: [40, 30, 40 + width, 30 + width * 1.2], kps: [[50, 50], [70, 50], [60, 60], [52, 70], [68, 70]], ...over });
  const run = (up, img, opts = {}) => runImagePipeline(up, img, { model: "photo", scale: 4, ...opts });

  it("skips cleanup on a clean image in auto mode, runs it on a blocky one, and always when forced", async () => {
    const clean = await portrait({});
    const blocky = await portrait({ width: 192, quality: 12 });

    let up = fake();
    let r = await run(up, clean, { faces: "off" });
    assert.deepEqual(up.calls, ["upscale"]);
    assert.equal(r.restore.cleanup.applied, false);

    up = fake();
    r = await run(up, blocky, { faces: "off" });
    assert.deepEqual(up.calls, ["clean", "upscale"]);
    assert.equal(r.restore.cleanup.applied, true);
    assert.equal(r.restore.cleanup.strength, 1);

    up = fake();
    await run(up, clean, { cleanup: "on", faces: "off" });
    assert.deepEqual(up.calls, ["clean", "upscale"]);

    up = fake();
    r = await run(up, blocky, { cleanup: "off", faces: "off" });
    assert.deepEqual(up.calls, ["upscale"]);
    assert.equal(r.restore.cleanup.score, null, "an explicit off must not even analyse the image");
  });

  it("cleans a blurry image even though it has no compression blocks", async () => {
    const soft = await decode(await sharp(fixture).blur(3).png().toBuffer());
    const up = fake();
    const r = await run(up, soft, { faces: "off" });
    assert.deepEqual(up.calls, ["clean", "upscale"]);
    assert.deepEqual(r.restore.cleanup.reasons, ["blur"]);
    assert.ok(r.restore.cleanup.strength >= 0.6);
  });

  it("blends borderline cleanups instead of applying them at full strength", async () => {
    // mid-compression: the first JPEG quality (going down) whose score lands between the threshold and "clearly blocky"
    let mid;
    for (let quality = 60; quality >= 20 && !mid; quality -= 2) {
      const candidate = await portrait({ quality });
      const score = measureBlockiness(candidate).score;
      if (score > CLEANUP_THRESHOLD + 0.03 && score < 1.4) mid = candidate;
    }
    assert.ok(mid, "no JPEG quality gives a borderline score on the fixture");
    const up = fake();
    const r = await run(up, mid, { faces: "off" });
    assert.ok(r.restore.cleanup.strength > 0.5 && r.restore.cleanup.strength < 1);
    assert.ok(r.cleaned);
  });

  it("hands the restorer the source picture and each face's source landmarks", async () => {
    const img = { data: Buffer.alloc(300 * 200 * 3, 100), width: 300, height: 200 };
    const up = fake({ faces: [face(80)] });
    let seen;
    const restore = up.restoreFaces;
    up.restoreFaces = async function (result, list, opts) {
      seen = { result, list, opts };
      return restore.call(this, result, list, opts);
    };
    await run(up, img, { cleanup: "off" });
    assert.equal(seen.opts.source, img, "with no cleanup the source is the input image itself");
    assert.deepEqual(seen.list[0].srcKps, face(80).kps, "landmarks in source pixels, next to the ones in output pixels");
    assert.notDeepEqual(seen.list[0].kps, seen.list[0].srcKps);
    assert.equal(seen.result.width, 1200);
  });

  it("restores faces by size, maps landmarks to output pixels and skips weak or tiny detections", async () => {
    const img = { data: Buffer.alloc(300 * 200 * 3, 100), width: 300, height: 200 };
    const up = fake({ faces: [face(80), face(280, { score: 0.9 }), face(400), face(8), face(90, { score: 0.5 })] });
    const r = await run(up, img, { cleanup: "off" });
    assert.equal(r.restore.faces.found, 4, "the 0.5-confidence detection is dropped before counting");
    const weights = up.restored.map((f) => f.weight);
    assert.deepEqual(weights, [1, 0.5]);
    assert.deepEqual(up.restored[0].kps[0], [50 * 4 + 1.5, 50 * 4 + 1.5], "source pixel centres map to output pixel centres");
    assert.equal(r.restore.faces.restored, 2);
  });

  it("restores every large face when asked to", async () => {
    const img = { data: Buffer.alloc(300 * 200 * 3, 100), width: 300, height: 200 };
    const up = fake({ faces: [face(250)] });
    const r = await run(up, img, { cleanup: "off", faces: "always" });
    assert.equal(r.restore.faces.restored, 1);
    assert.equal(up.restored[0].weight, 1);
  });

  it("never looks for faces when they are switched off", async () => {
    const up = fake({ faces: [face(80)] });
    await run(up, { data: Buffer.alloc(64 * 64 * 3), width: 64, height: 64 }, { faces: "off", cleanup: "off" });
    assert.deepEqual(up.calls, ["upscale"]);
  });

  it("finishes the upscale and reports a warning when an optional stage fails", async () => {
    const blocky = await portrait({ width: 192, quality: 12 });
    for (const [opts, stage] of [[{ cleanFails: true }, "JPEG cleanup"], [{ findFails: true, faces: [face(80)] }, "Face restoration"], [{ restoreFails: true, faces: [face(80)] }, "Face restoration"]]) {
      const r = await run(fake(opts), blocky);
      assert.equal(r.result.width, 192 * 4, "the upscaled image is still returned");
      assert.ok(r.warnings.some((w) => w.startsWith(`${stage} was skipped`)), `${stage}: ${r.warnings}`);
    }
  });

  it("does not swallow cancellation", async () => {
    const blocky = await portrait({ width: 192, quality: 12 });
    const ctl = new AbortController();
    ctl.abort(new DOMException("cancelled", "AbortError"));
    await assert.rejects(run(fake(), blocky, { signal: ctl.signal }), (err) => err.name === "AbortError");
  });

  it("reports monotonic progress that ends at 1", async () => {
    const seen = [];
    await run(fake({ faces: [face(80)] }), await portrait({ width: 192, quality: 12 }), { onProgress: (p) => seen.push(p.fraction) });
    assert.equal(seen.at(-1), 1);
    for (let i = 1; i < seen.length; i++) assert.ok(seen[i] >= seen[i - 1] - 1e-9, `progress went backwards at ${i}: ${seen.slice(i - 1, i + 1)}`);
    assert.ok(seen.every((f) => f >= 0 && f <= 1));
  });
});
