// The restore pipeline with the real models (CPU): each stage must do what its job says, on a real face.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import sharp from "sharp";
import { Engine } from "../src/engine/index.js";
import { measureBlockiness } from "../src/engine/restore/blockiness.js";
import { CROP, FACE_TEMPLATE } from "../src/engine/restore/faces.js";
import { Upscaler } from "../src/engine/upscaler.js";
import { rm, tmpDir } from "./helpers.js";

process.env.LUCIDFRAME_LOG_LEVEL = "error";
const fixture = path.join(import.meta.dirname, "fixtures", "portrait.jpg");
// where the face is in the 512×512 fixture (found once with the detector, checked by eye)
const FACE = { left: 179, top: 63, width: 91, height: 111 };

async function rawOf(input) {
  const { data, info } = await sharp(input).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

describe("restore pipeline with the real models", () => {
  let upscaler;
  let dir;
  before(() => {
    upscaler = new Upscaler({ device: "cpu" });
    dir = tmpDir();
  });
  after(async () => {
    await upscaler.dispose();
    rm(dir);
  });

  it("JPEG cleanup removes block artifacts and keeps the picture", async () => {
    const blocky = await rawOf(await sharp(fixture).resize(192).jpeg({ quality: 12 }).toBuffer());
    const before = measureBlockiness(blocky).score;
    const cleaned = await upscaler.cleanRGB(blocky);
    assert.deepEqual([cleaned.width, cleaned.height], [blocky.width, blocky.height]);
    const after = measureBlockiness(cleaned).score;
    assert.ok(before > 1.5 && after < before - 0.3, `blockiness ${before.toFixed(2)} → ${after.toFixed(2)}`);
    // still the same picture: mean colour within a few levels
    const mean = (img) => img.data.reduce((a, b) => a + b, 0) / img.data.length;
    assert.ok(Math.abs(mean(cleaned) - mean(blocky)) < 6);
  });

  it("finds the face in a portrait, with landmarks in the order the restorer expects", async () => {
    const faces = await upscaler.findFaces(await rawOf(fixture));
    assert.equal(faces.length, 1);
    const [f] = faces;
    assert.ok(f.score > 0.8);
    const cx = (f.box[0] + f.box[2]) / 2;
    const cy = (f.box[1] + f.box[3]) / 2;
    assert.ok(Math.abs(cx - (FACE.left + FACE.width / 2)) < 12 && Math.abs(cy - (FACE.top + FACE.height / 2)) < 15, `centre ${cx},${cy}`);
    const [leftEye, rightEye, nose, leftMouth, rightMouth] = f.kps;
    assert.ok(leftEye[0] < nose[0] && nose[0] < rightEye[0], "eyes must be left/right of the nose");
    assert.ok(leftEye[1] < nose[1] && nose[1] < leftMouth[1], "nose between eyes and mouth");
    assert.ok(leftMouth[0] < rightMouth[0]);
    // the same geometry as the template, so the alignment maps it to an upright crop
    assert.ok(FACE_TEMPLATE[0][0] < FACE_TEMPLATE[1][0] && FACE_TEMPLATE[3][0] < FACE_TEMPLATE[4][0]);
  });

  it("finds nothing in a picture without faces, at any size", async () => {
    const flat = { data: Buffer.alloc(300 * 200 * 3, 120), width: 300, height: 200 };
    assert.deepEqual(await upscaler.findFaces(flat), []);
    const big = { data: Buffer.alloc(1800 * 1300 * 3, 90), width: 1800, height: 1300 }; // exercises the tiled search
    assert.deepEqual(await upscaler.findFaces(big), []);
  });

  it("finds a face in the middle of a large photo", async () => {
    // paste the portrait into a 2000×1500 canvas, so the face is small relative to the image and only the tiles see it
    const canvas = await sharp({ create: { width: 2000, height: 1500, channels: 3, background: "#808080" } })
      .composite([{ input: await sharp(fixture).resize(360).toBuffer(), left: 1100, top: 700 }])
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const faces = await upscaler.findFaces({ data: canvas.data, width: 2000, height: 1500 });
    assert.equal(faces.length, 1);
    const cx = (faces[0].box[0] + faces[0].box[2]) / 2;
    assert.ok(cx > 1100 && cx < 1460, `face centre x ${cx}`);
  });

  it("restores a face in place and leaves the rest of the picture alone", async () => {
    const soft = await rawOf(await sharp(fixture).blur(3).png().toBuffer());
    const [face] = await upscaler.findFaces(soft);
    assert.ok(face, "the blurred face should still be found");
    const work = { ...soft, data: Buffer.from(soft.data) };
    assert.equal(await upscaler.restoreFaces(work, [{ ...face, weight: 1 }], { strength: 1 }), 1);

    // mean absolute Laplacian of the green channel: a plain measure of how much fine detail is there
    const detail = (img, { left, top, width, height }) => {
      let sum = 0;
      let n = 0;
      for (let y = top + 1; y < top + height - 1; y++) {
        for (let x = left + 1; x < left + width - 1; x++) {
          const g = (xx, yy) => img.data[(yy * img.width + xx) * 3 + 1];
          sum += Math.abs(4 * g(x, y) - g(x - 1, y) - g(x + 1, y) - g(x, y - 1) - g(x, y + 1));
          n++;
        }
      }
      return sum / n;
    };
    const eyes = { left: FACE.left + 10, top: FACE.top + 25, width: 70, height: 25 };
    assert.ok(detail(work, eyes) > detail(soft, eyes) * 2.5, `eye region detail ${detail(soft, eyes).toFixed(2)} → ${detail(work, eyes).toFixed(2)}`);

    // far from the face nothing changed, bit for bit
    for (const [x, y] of [[3, 3], [500, 20], [20, 500], [505, 505], [60, 300]]) {
      for (let c = 0; c < 3; c++) assert.equal(work.data[(y * 512 + x) * 3 + c], soft.data[(y * 512 + x) * 3 + c], `pixel ${x},${y}`);
    }
  });

  describe("end to end", () => {
    let engine;
    before(() => {
      engine = new Engine({ device: "cpu" });
    });
    after(() => engine.dispose());

    // Face-region PSNR against the sharp fixture, after bringing the 4× result back to its size.
    async function facePsnr(file, k) {
      const gt = await sharp(fixture).extract(FACE).raw().toBuffer();
      const got = await sharp(file)
        .extract({ left: FACE.left * k, top: FACE.top * k, width: FACE.width * k, height: FACE.height * k })
        .resize(FACE.width, FACE.height, { kernel: "lanczos3" })
        .raw()
        .toBuffer();
      let mse = 0;
      for (let i = 0; i < gt.length; i++) mse += (gt[i] - got[i]) ** 2;
      return 10 * Math.log10((255 * 255) / (mse / gt.length));
    }

    it("an out-of-focus, compressed portrait comes back closer to the truth than with the photo model alone", async () => {
      const input = path.join(dir, "soft.jpg");
      await sharp(fixture).resize(256).blur(2.5).jpeg({ quality: 60 }).toFile(input);
      const base = await engine.process({ input, model: "photo", scale: 4, output: path.join(dir, "base.png"), format: "png", cleanup: "off", faces: "off" });
      const full = await engine.process({ input, model: "photo", scale: 4, output: path.join(dir, "full.png"), format: "png" });
      assert.equal(base.restore.faces.restored, 0);
      assert.equal(full.restore.faces.restored, 1);
      assert.deepEqual([full.width, full.height], [1024, 1024]);
      const [a, b] = [await facePsnr(base.output, 2), await facePsnr(full.output, 2)];
      assert.ok(b > a + 0.7, `face PSNR ${a.toFixed(2)} dB → ${b.toFixed(2)} dB`);
    });

    it("a face that is already large is left alone in auto mode and restored when told to", async () => {
      // the fixture at 1400 px: the face is about 250 px wide in the source (auto fades out from 200 to 360 px)
      const input = path.join(dir, "large-face.png");
      await sharp(fixture).resize(1400).png().toFile(input);
      const big = path.join(dir, "large-face-big.png");
      await sharp(fixture).resize(2000).png().toFile(big);
      // 2000 px: ~400 px face, beyond the fade-out. The cheapest honest run is 2× with the fast model.
      const auto = await engine.process({ input: big, model: "fast", scale: 2, output: path.join(dir, "auto.png"), format: "png", cleanup: "off", faces: "auto" });
      assert.equal(auto.restore.faces.found, 1);
      assert.equal(auto.restore.faces.restored, 0, "a large, already detailed face must be left to the upscaler");
      const always = await engine.process({ input: big, model: "fast", scale: 2, output: path.join(dir, "always.png"), format: "png", cleanup: "off", faces: "always" });
      assert.equal(always.restore.faces.restored, 1);
    });

    it("refuses nonsense options", async () => {
      const input = path.join(dir, "ok.png");
      await sharp(fixture).resize(64).png().toFile(input);
      for (const bad of [{ cleanup: "sometimes" }, { faces: "yes" }, { faceStrength: 2 }]) {
        await assert.rejects(engine.process({ input, model: "photo", scale: 2, ...bad }), /must be/);
      }
    });

    it("leaves no partial or temporary files behind", () => {
      assert.deepEqual(fs.readdirSync(dir).filter((f) => f.includes("partial")), []);
    });
  });
});

describe("face restoration falls back to the CPU when a GPU misbehaves", () => {
  it("retries on the CPU after an implausible GPU result", async () => {
    const up = new Upscaler({ device: "cpu" });
    const real = up.runtime;
    const failed = [];
    const garbage = new Float32Array(3 * CROP * CROP).fill(NaN);
    let loads = 0;
    // The first load of the restorer pretends to be a GPU that returns NaNs; the second is the real CPU session.
    // (Other components, such as the face parser, load normally.)
    up.runtime = {
      markFailed: (p) => failed.push(p),
      loadStatic: async (model, file, dims, opts) => {
        if (model.id !== "face-restore") return real.loadStatic(model, file, dims, opts);
        loads++;
        if (loads > 1) return real.loadStatic(model, file, dims, opts);
        return { provider: "dml", infer: async () => garbage, release: async () => {} };
      },
      dispose: () => real.dispose(),
    };
    const img = { data: Buffer.alloc(600 * 600 * 3, 120), width: 600, height: 600 };
    const restored = await up.restoreFaces(img, [{ kps: FACE_TEMPLATE.map(([x, y]) => [x + 40, y + 40]), weight: 1 }], { strength: 1 });
    assert.equal(restored, 1);
    assert.deepEqual(failed, ["dml"], "the bad provider must be disabled");
    assert.equal(loads, 2);
    assert.equal(up.deviceInfo().provider, "cpu");
    assert.ok(!img.data.some((v, i) => Number.isNaN(v)), "no NaN reached the image");
    await up.dispose();
  });
});
