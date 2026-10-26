import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";
import { normalizeFps, parseProbe, pickMatrix, probe } from "../src/engine/ffmpeg.js";
import { makeClip, rm, tmpDir } from "./helpers.js";

const MP4 = `Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'x.mp4':
  Metadata:
    major_brand     : isom
  Duration: 00:01:02.50, start: 0.000000, bitrate: 4500 kb/s
  Stream #0:0[0x1](und): Video: h264 (High) (avc1 / 0x31637661), yuv420p(tv, bt709/bt709/bt709, progressive), 1920x1080 [SAR 1:1 DAR 16:9], 4300 kb/s, 29.97 fps, 29.97 tbr, 30k tbn (default)
  Stream #0:1[0x2](und): Audio: aac (LC) (mp4a / 0x6134706d), 48000 Hz, stereo, fltp, 192 kb/s (default)
At least one output file must be specified`;

describe("parseProbe", () => {
  it("reads size, fps, duration, colour matrix and audio", () => {
    const p = parseProbe(MP4);
    assert.equal(p.duration, 62.5);
    assert.deepEqual(p.video, { codec: "h264", width: 1920, height: 1080, fps: 29.97, sar: [1, 1], matrix: "bt709", hdr: false });
    assert.deepEqual(p.audio, { codec: "aac" });
  });

  it("does not mistake the codec tag hex (0x31637661) for a resolution", () => {
    assert.equal(parseProbe(MP4).video.width, 1920);
  });

  it("reads anamorphic SAR and untagged colour", () => {
    const p = parseProbe(`  Duration: 00:00:10.00, start: 0.0, bitrate: 1 kb/s
  Stream #0:0: Video: mpeg2video (Main), yuv420p(tv, progressive), 720x480 [SAR 32:27 DAR 16:9], 25 fps, 25 tbr, 1200k tbn
`);
    assert.deepEqual(p.video.sar, [32, 27]);
    assert.equal(p.video.matrix, null);
    assert.equal(p.audio, null);
  });

  it("flags HDR transfer functions", () => {
    const p = parseProbe(`  Stream #0:0: Video: hevc (Main 10), yuv420p10le(tv, bt2020nc/bt2020/smpte2084), 3840x2160, 24 fps, 24 tbr, 1k tbn`);
    assert.equal(p.video.hdr, true);
    assert.equal(p.video.matrix, "bt2020");
  });

  it("ignores cover-art 'video' streams and finds the real one", () => {
    const p = parseProbe(`  Stream #0:0: Audio: mp3, 44100 Hz, stereo, fltp, 128 kb/s
  Stream #0:1: Video: mjpeg (Baseline), yuvj420p(pc, bt470bg/unknown/unknown), 500x500 [SAR 1:1 DAR 1:1], 90k tbr, 90k tbn (attached pic)`);
    assert.equal(p.video, null);
    assert.equal(p.audio.codec, "mp3");
  });

  it("falls back to tbr when fps is not printed", () => {
    const p = parseProbe(`  Stream #0:0: Video: vp9 (Profile 0), yuv420p(tv), 640x360, 30 tbr, 1k tbn`);
    assert.equal(p.video.fps, 30);
  });
});

describe("normalizeFps", () => {
  it("restores exact NTSC rationals so audio stays in sync", () => {
    assert.equal(normalizeFps(29.97).rational, "30000/1001");
    assert.equal(normalizeFps(23.976).rational, "24000/1001");
    assert.equal(normalizeFps(59.94).rational, "60000/1001");
    assert.equal(normalizeFps(25).rational, "25");
    assert.equal(normalizeFps(30).rational, "30");
  });
});

describe("pickMatrix", () => {
  it("prefers what the file declares, else guesses by resolution", () => {
    assert.equal(pickMatrix({ matrix: "bt601", width: 1920, height: 1080 }), "bt601");
    assert.equal(pickMatrix({ matrix: null, width: 1920, height: 1080 }), "bt709");
    assert.equal(pickMatrix({ matrix: null, width: 640, height: 360 }), "bt601");
  });
});

describe("probe (real ffmpeg)", () => {
  it("probes a generated clip", async () => {
    const dir = tmpDir();
    try {
      const file = await makeClip(path.join(dir, "a.mp4"), { width: 128, height: 72, rate: "25", seconds: 1 });
      const p = await probe(file);
      assert.equal(p.video.width, 128);
      assert.equal(p.video.height, 72);
      assert.equal(p.video.fps, 25);
      assert.equal(p.audio.codec, "aac");
    } finally {
      rm(dir);
    }
  });

  it("reports unreadable files clearly", async () => {
    const dir = tmpDir();
    try {
      const file = path.join(dir, "junk.mp4");
      (await import("node:fs")).writeFileSync(file, "this is not a video");
      await assert.rejects(probe(file), /cannot read "junk.mp4"/);
    } finally {
      rm(dir);
    }
  });
});
