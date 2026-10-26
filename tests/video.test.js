import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { runFfmpeg, probe } from "../src/engine/ffmpeg.js";
import { Engine } from "../src/engine/index.js";
import { makeClip, rm, tmpDir } from "./helpers.js";

process.env.LUCIDFRAME_LOG_LEVEL = "error";

// Decode the video stream and read ffmpeg's machine-readable progress (the human stats line on stderr is throttled and
// platform-dependent, which made this count flaky).
async function countFrames(file) {
  const { stdout } = await runFfmpeg(["-v", "error", "-nostats", "-progress", "pipe:1", "-i", file, "-map", "0:v:0", "-f", "null", "-"]);
  const m = [...stdout.toString().matchAll(/^frame=(\d+)$/gm)].pop();
  return m ? Number(m[1]) : 0;
}

// Packet-level dump of a file's video stream, attached to assertion messages so a failure on a machine we can't
// reproduce on (CI) shows what was actually written.
async function describeVideo(file) {
  const info = await runFfmpeg(["-hide_banner", "-i", file]);
  const crc = await runFfmpeg(["-v", "error", "-i", file, "-map", "0:v:0", "-c", "copy", "-f", "framecrc", "-"]);
  return `${info.stderr.split("\n").filter((l) => /Stream|Duration/.test(l)).join("\n")}\n${crc.stdout.toString().split("\n").slice(0, 40).join("\n")}`;
}

describe("video upscaling (real models, real ffmpeg)", () => {
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

  it("upscales every frame, keeps fps, duration and audio", async () => {
    const input = await makeClip(path.join(dir, "a.mp4"), { width: 96, height: 64, rate: "30", seconds: 1 });
    const progress = [];
    const r = await upscale(input, { onProgress: (p) => progress.push(p) });
    assert.equal(r.kind, "video");
    assert.deepEqual([r.width, r.height], [192, 128]);
    assert.equal(r.hasAudio, true);
    const out = await probe(r.output);
    assert.deepEqual([out.video.width, out.video.height], [192, 128]);
    assert.equal(out.video.fps, 30);
    assert.equal(out.video.codec, "h264");
    assert.equal(out.audio.codec, "aac");
    assert.ok(Math.abs(out.duration - 1) < 0.1, `duration ${out.duration}`);
    const expectedFrames = await countFrames(input);
    assert.equal(expectedFrames, 30);
    assert.equal(r.frames, expectedFrames, "frames the engine processed");
    const written = await countFrames(r.output);
    assert.equal(written, expectedFrames, `frames in the written file\n${written === expectedFrames ? "" : await describeVideo(r.output)}`);
    assert.ok(progress.some((p) => p.frame > 1 && p.fps >= 0));
    assert.equal(progress.at(-1).phase, "done");
    // no partial/temporary files are left behind
    assert.deepEqual(fs.readdirSync(dir).filter((f) => f.includes("partial")), []);
  });

  it("preserves NTSC frame rates exactly", async () => {
    const input = await makeClip(path.join(dir, "ntsc.mp4"), { rate: "30000/1001", seconds: 1, audio: false });
    const r = await upscale(input);
    const out = await probe(r.output);
    assert.equal(out.video.fps, 29.97);
    assert.equal(r.hasAudio, false);
  });

  it("handles odd dimensions and non-native scales (always encodes even-sized frames)", async () => {
    const input = await makeClip(path.join(dir, "odd.mp4"), { width: 50, height: 34, seconds: 1, audio: false, pixFmt: "yuv444p", extra: ["-vf", "format=yuv444p,crop=49:33"] });
    const src = await probe(input);
    assert.deepEqual([src.video.width, src.video.height], [49, 33]);
    const r = await upscale(input, { scale: 3 });
    assert.deepEqual([r.width, r.height], [147, 99]); // what we computed…
    const out = await probe(r.output);
    assert.deepEqual([out.video.width, out.video.height], [146, 98]); // …and what H.264 4:2:0 requires
    assert.equal(out.video.codec, "h264");
  });

  it("re-encodes audio that mp4 can't carry as-is", async () => {
    const input = path.join(dir, "vorbis.mkv");
    const { code } = await runFfmpeg(["-y", "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=64x48:rate=15:duration=1", "-f", "lavfi", "-i", "sine=duration=1", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "libvorbis", "-shortest", input]);
    assert.equal(code, 0);
    const r = await upscale(input);
    assert.equal((await probe(r.output)).audio.codec, "aac");
  });

  it("square-pixel-corrects anamorphic sources instead of keeping the wrong aspect", async () => {
    const input = await makeClip(path.join(dir, "sar.mp4"), { width: 48, height: 48, seconds: 1, audio: false, extra: ["-vf", "setsar=2/1"] });
    assert.deepEqual((await probe(input)).video.sar, [2, 1]);
    const r = await upscale(input);
    assert.deepEqual([r.sourceWidth, r.sourceHeight], [96, 48]);
    const out = await probe(r.output);
    assert.deepEqual([out.video.width, out.video.height], [192, 96]);
    assert.deepEqual(out.video.sar, [1, 1]);
  });

  it("keeps BT.709 tagging for HD-style sources", async () => {
    const input = await makeClip(path.join(dir, "bt709.mp4"), { width: 64, height: 48, seconds: 1, audio: false, extra: ["-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709"] });
    assert.equal((await probe(input)).video.matrix, "bt709");
    const r = await upscale(input);
    assert.equal((await probe(r.output)).video.matrix, "bt709");
  });

  it("can interpolate to double the frame rate", async () => {
    const input = await makeClip(path.join(dir, "smooth.mp4"), { width: 64, height: 48, rate: "10", seconds: 1, audio: false });
    const r = await upscale(input, { smooth: true });
    const out = await probe(r.output);
    assert.equal(out.video.fps, 20);
    // 10 source frames → 20 output frames, including the tail that minterpolate alone would drop.
    assert.equal(await countFrames(r.output), 20);
    assert.ok(Math.abs(out.duration - 1) < 0.1, `duration ${out.duration}`);
  });

  it("works with the 4× quality model too (downscaled to the requested size)", async () => {
    const input = await makeClip(path.join(dir, "q.mp4"), { width: 32, height: 32, rate: "5", seconds: 1, audio: false });
    const r = await engine.process({ input, model: "photo", scale: 2, outputDir: dir });
    assert.deepEqual([r.width, r.height], [64, 64]);
  });

  it("cancels promptly, kills ffmpeg and leaves nothing behind", async () => {
    const input = await makeClip(path.join(dir, "long.mp4"), { width: 96, height: 64, rate: "30", seconds: 6, audio: true });
    const out = path.join(dir, "cancel-out");
    const ctl = new AbortController();
    const t0 = performance.now();
    await assert.rejects(
      upscale(input, { outputDir: out, signal: ctl.signal, onProgress: (p) => p.frame >= 5 && ctl.abort() }),
      { name: "AbortError" },
    );
    assert.ok(performance.now() - t0 < 15000);
    assert.deepEqual(fs.existsSync(out) ? fs.readdirSync(out) : [], []);
  });

  it("reports files that are not videos", async () => {
    const junk = path.join(dir, "junk.mp4");
    fs.writeFileSync(junk, "not a video at all");
    await assert.rejects(upscale(junk), /cannot read|no video stream|no frames/);
    const audioOnly = path.join(dir, "tone.mp4");
    await runFfmpeg(["-y", "-v", "error", "-f", "lavfi", "-i", "sine=duration=1", "-c:a", "aac", audioOnly]);
    await assert.rejects(upscale(audioOnly), /no video stream/);
  });

  it("refuses frames that would be too large right after decoding one frame", async () => {
    const input = await makeClip(path.join(dir, "huge.mp4"), { width: 6000, height: 4000, rate: "1", seconds: 1, audio: false });
    const t0 = performance.now();
    // 24 MP × 16 = 384 MP > the 268 MP ceiling
    await assert.rejects(engine.process({ input, model: "photo", scale: 4, outputDir: dir }), /megapixel working image/);
    assert.ok(performance.now() - t0 < 30000, "must fail fast, not after upscaling");
  });
});
