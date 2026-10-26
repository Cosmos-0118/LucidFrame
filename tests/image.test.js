import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import sharp from "sharp";
import { Engine } from "../src/engine/index.js";
import { patternRGB, rm, tmpDir, writePattern } from "./helpers.js";

process.env.LUCIDFRAME_LOG_LEVEL = "error";

describe("image upscaling (real models)", () => {
  let engine;
  let dir;
  before(() => {
    dir = tmpDir();
    engine = new Engine({ device: "cpu" });
  });
  after(async () => {
    await engine.dispose();
    rm(dir);
  });

  const upscale = (input, extra = {}) => engine.process({ input, model: "fast", scale: 2, outputDir: dir, ...extra });

  it("upscales a PNG to exactly scale× and writes next to the requested dir", async () => {
    const input = await writePattern(path.join(dir, "a.png"), 64, 48);
    const progress = [];
    const r = await upscale(input, { onProgress: (p) => progress.push(p) });
    assert.equal(r.kind, "image");
    assert.equal(r.width, 128);
    assert.equal(r.height, 96);
    assert.equal(path.basename(r.output), "a_lucid_2x.png");
    const meta = await sharp(r.output).metadata();
    assert.deepEqual([meta.width, meta.height, meta.format], [128, 96, "png"]);
    assert.equal(r.device.provider, "cpu");
    // progress is monotonic and ends at 1
    const fr = progress.map((p) => p.fraction);
    assert.deepEqual(fr, [...fr].sort((a, b) => a - b));
    assert.equal(fr.at(-1), 1);
  });

  it("is faithful to its input: averaging the result back down recovers the original", async () => {
    // A super-resolution result must be consistent with the low-res image it came from.
    const input = await writePattern(path.join(dir, "sim.png"), 96, 96);
    const r = await upscale(input);
    const back = await sharp(r.output).resize(96, 96, { kernel: "cubic", fastShrinkOnLoad: false }).removeAlpha().raw().toBuffer();
    const orig = await sharp(input).removeAlpha().raw().toBuffer();
    let sum = 0;
    const channelDelta = [0, 0, 0];
    for (let i = 0; i < back.length; i++) {
      sum += Math.abs(back[i] - orig[i]);
      channelDelta[i % 3] += back[i] - orig[i];
    }
    const mad = sum / back.length;
    assert.ok(mad < 12, `round-trip mean abs error ${mad.toFixed(2)}`);
    for (const d of channelDelta) assert.ok(Math.abs(d / (back.length / 3)) < 6, `colour cast ${(d / (back.length / 3)).toFixed(1)}`);
  });

  it("never overwrites an existing file", async () => {
    const input = await writePattern(path.join(dir, "dup.png"), 32, 32);
    const first = await upscale(input);
    const second = await upscale(input);
    assert.notEqual(first.output, second.output);
    assert.equal(path.basename(second.output), "dup_lucid_2x-2.png");
    assert.ok(fs.existsSync(first.output) && fs.existsSync(second.output));
  });

  it("supports 3× (non-native) and 4× via a second pass or resize, with exact dimensions", async () => {
    const input = await writePattern(path.join(dir, "s.png"), 30, 20);
    const r3 = await upscale(input, { scale: 3 });
    assert.deepEqual([r3.width, r3.height], [90, 60]);
    const r4 = await upscale(input, { scale: 4 });
    assert.deepEqual([r4.width, r4.height], [120, 80]);
  });

  it("a 4× model gives 2× by resizing down, with exact dimensions", async () => {
    const input = await writePattern(path.join(dir, "q.png"), 24, 24);
    const r = await engine.process({ input, model: "photo", scale: 2, outputDir: dir });
    assert.deepEqual([r.width, r.height], [48, 48]);
  });

  it("keeps transparency", async () => {
    const input = await writePattern(path.join(dir, "alpha.png"), 40, 40, { channels: 4 });
    const r = await upscale(input);
    const meta = await sharp(r.output).metadata();
    assert.equal(meta.hasAlpha, true);
    const alpha = await sharp(r.output).ensureAlpha().extractChannel(3).raw().toBuffer();
    // left half opaque, right half ~90
    assert.ok(alpha[5 * 80 + 5] > 240);
    assert.ok(Math.abs(alpha[5 * 80 + 70] - 90) < 6);
  });

  it("honours EXIF orientation instead of producing a sideways image", async () => {
    const input = path.join(dir, "rot.jpg");
    await sharp(patternRGB(60, 30), { raw: { width: 60, height: 30, channels: 3 } }).jpeg().withMetadata({ orientation: 6 }).toFile(input);
    const r = await upscale(input);
    assert.deepEqual([r.sourceWidth, r.sourceHeight], [30, 60]);
    assert.deepEqual([r.width, r.height], [60, 120]);
  });

  it("handles grayscale, 16-bit, palette and CMYK sources", async () => {
    const gray = path.join(dir, "gray.png");
    await sharp(patternRGB(32, 32), { raw: { width: 32, height: 32, channels: 3 } }).grayscale().toFile(gray);
    const g = await upscale(gray);
    assert.deepEqual([g.width, g.height], [64, 64]);

    const deep = path.join(dir, "deep.png");
    await sharp(patternRGB(32, 32), { raw: { width: 32, height: 32, channels: 3 } }).toColourspace("rgb16").png().toFile(deep);
    assert.equal((await upscale(deep)).width, 64);

    const pal = path.join(dir, "pal.png");
    await sharp(patternRGB(32, 32), { raw: { width: 32, height: 32, channels: 3 } }).png({ palette: true, colours: 16 }).toFile(pal);
    assert.equal((await upscale(pal)).width, 64);

    const cmyk = path.join(dir, "cmyk.jpg");
    await sharp(patternRGB(32, 32), { raw: { width: 32, height: 32, channels: 3 } }).toColourspace("cmyk").jpeg().toFile(cmyk);
    assert.equal((await upscale(cmyk)).width, 64);
  });

  it("tiny (1×1) and thin images work", async () => {
    const one = path.join(dir, "one.png");
    await sharp({ create: { width: 1, height: 1, channels: 3, background: "#336699" } }).png().toFile(one);
    const r = await upscale(one);
    assert.deepEqual([r.width, r.height], [2, 2]);
    const thin = path.join(dir, "thin.png");
    await writePattern(thin, 3, 200);
    assert.deepEqual((await upscale(thin)).height, 400);
  });

  it("writes JPEG and WebP on request, and flattens alpha for JPEG", async () => {
    const input = await writePattern(path.join(dir, "fmt.png"), 32, 32, { channels: 4 });
    const j = await upscale(input, { format: "jpeg", quality: 90 });
    assert.equal(path.extname(j.output), ".jpg");
    const jm = await sharp(j.output).metadata();
    assert.equal(jm.format, "jpeg");
    assert.equal(jm.hasAlpha, false);
    const w = await upscale(input, { format: "webp" });
    assert.equal((await sharp(w.output).metadata()).format, "webp");
  });

  it("auto format keeps JPEG for JPEG sources", async () => {
    const input = path.join(dir, "photo.jpeg");
    await sharp(patternRGB(32, 32), { raw: { width: 32, height: 32, channels: 3 } }).jpeg().toFile(input);
    const r = await upscale(input);
    assert.equal(r.format, "jpeg");
    assert.equal(path.extname(r.output), ".jpg");
  });

  it("reads every format it advertises (and nothing it can't decode is advertised)", async () => {
    const { IMAGE_EXTENSIONS } = await import("../src/engine/kinds.js");
    const writers = { ".png": (i) => i.png(), ".jpg": (i) => i.jpeg(), ".jpeg": (i) => i.jpeg(), ".webp": (i) => i.webp(), ".tif": (i) => i.tiff(), ".tiff": (i) => i.tiff(), ".gif": (i) => i.gif(), ".avif": (i) => i.avif() };
    assert.deepEqual([...IMAGE_EXTENSIONS].sort(), Object.keys(writers).sort(), "every advertised extension needs a real round-trip below");
    for (const [ext, write] of Object.entries(writers)) {
      const input = path.join(dir, `fmt${ext}`);
      await write(sharp(patternRGB(24, 18), { raw: { width: 24, height: 18, channels: 3 } })).toFile(input);
      const r = await upscale(input);
      assert.deepEqual([r.width, r.height], [48, 36], ext);
    }
  });

  it("writes a downsized preview only for very large results, never enlarging", async () => {
    const input = await writePattern(path.join(dir, "small.png"), 32, 32);
    const none = await upscale(input, { previewDir: path.join(dir, "prev") });
    assert.equal(none.preview, null);
    const forced = await upscale(input, { previewDir: path.join(dir, "prev"), previewAbovePixels: 1 });
    assert.ok(fs.existsSync(forced.preview));
    const meta = await sharp(forced.preview).metadata();
    assert.deepEqual([meta.width, meta.height, meta.format], [64, 64, "jpeg"], "a preview must never be larger than the result");
  });

  it("explains bad input instead of crashing", async () => {
    const junk = path.join(dir, "junk.png");
    fs.writeFileSync(junk, "definitely not a png");
    await assert.rejects(upscale(junk), /not a supported image format|could not read/);
    await assert.rejects(upscale(path.join(dir, "missing.png")), /does not exist/);
    await assert.rejects(upscale(await writePattern(path.join(dir, "ok.png"), 8, 8), { scale: 5 }), /scale must be one of/);
    await assert.rejects(engine.process({ input: await writePattern(path.join(dir, "ok2.png"), 8, 8), model: "nope", scale: 2 }), /unknown model "nope"/);
    await assert.rejects(engine.process({ input: path.join(dir, "notes.txt"), model: "fast", scale: 2 }), /does not exist|not a supported/);
    await assert.rejects(engine.process({ input: "relative.png", model: "fast", scale: 2 }), /absolute path/);
  });

  it("refuses requests that cannot fit in memory, before doing any work", async () => {
    // 12000×12000 at 4× would need 2.3 gigapixels.
    const big = path.join(dir, "big.png");
    await sharp({ create: { width: 12000, height: 12000, channels: 3, background: "#000" } }).png({ compressionLevel: 9 }).toFile(big);
    const t0 = performance.now();
    await assert.rejects(engine.process({ input: big, model: "photo", scale: 4, outputDir: dir }), /megapixel working image/);
    assert.ok(performance.now() - t0 < 20000);
  });

  it("can be cancelled and leaves no partial output", async () => {
    const input = await writePattern(path.join(dir, "cancel.png"), 200, 200);
    const ctl = new AbortController();
    const out = path.join(dir, "cancel-out");
    const job = engine.process({
      input,
      model: "photo",
      scale: 4,
      outputDir: out,
      signal: ctl.signal,
      onProgress: (p) => p.phase === "upscale" && ctl.abort(),
    });
    await assert.rejects(job, { name: "AbortError" });
    const left = fs.existsSync(out) ? fs.readdirSync(out) : [];
    assert.deepEqual(left, []);
  });

  it("runs queued jobs one at a time", async () => {
    const input = await writePattern(path.join(dir, "q1.png"), 16, 16);
    const order = [];
    const mk = (tag) =>
      engine
        .process({ input, model: "fast", scale: 2, outputDir: dir, onProgress: (p) => p.phase === "decode" && order.push(`start-${tag}`) })
        .then(() => order.push(`end-${tag}`));
    await Promise.all([mk("a"), mk("b")]);
    assert.deepEqual(order, ["start-a", "end-a", "start-b", "end-b"]);
  });
});
