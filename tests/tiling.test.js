import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { gatherTile, mirrorIndex, paintTile, planAxis, upscaleTiled } from "../src/engine/tiling.js";
import { patternRGB } from "./helpers.js";

describe("mirrorIndex", () => {
  it("reflects at both edges, repeating the edge pixel", () => {
    assert.deepEqual([-3, -2, -1, 0, 1, 2, 3, 4, 5, 6, 7, 8].map((i) => mirrorIndex(i, 4)), [2, 1, 0, 0, 1, 2, 3, 3, 2, 1, 0, 0]);
  });
  it("works for single-pixel and tiny axes (no reflect-pad crash)", () => {
    for (const i of [-100, -1, 0, 1, 57]) assert.equal(mirrorIndex(i, 1), 0);
    for (let i = -50; i < 50; i++) {
      const v = mirrorIndex(i, 2);
      assert.ok(v === 0 || v === 1);
    }
  });
});

describe("planAxis", () => {
  const D = 12;
  const O = 16;

  for (const fixed of [false, true]) {
    it(`covers every pixel exactly with enough overlap (fixed=${fixed}), for all lengths 1..700`, () => {
      for (let len = 1; len <= 700; len++) {
        const { size, tiles } = planAxis(len, 256, D, O, { fixed });
        assert.ok(size <= 256, `size ${size} > max for len ${len}`);
        assert.equal(tiles[0].start, 0, `len ${len}`);
        assert.equal(tiles.at(-1).end, len, `len ${len}`);
        const usable = size - 2 * D;
        for (let k = 0; k < tiles.length; k++) {
          const t = tiles[k];
          assert.ok(t.end - t.start <= usable, `usable overflow at len ${len}`);
          assert.equal(t.origin, t.start - D);
          if (k > 0) {
            const prev = tiles[k - 1];
            assert.ok(t.start > prev.start, `starts must increase (len ${len})`);
            assert.equal(t.ramp, prev.end - t.start);
            assert.ok(t.ramp >= O, `overlap ${t.ramp} < ${O} at len ${len}`);
            assert.ok(t.ramp < t.end - t.start, "ramp must fit inside the tile");
          } else assert.equal(t.ramp, 0);
        }
      }
    });
  }

  it("adaptive mode uses one exactly-fitting window for small axes (no wasted compute)", () => {
    const { size, tiles } = planAxis(100, 256, D, O);
    assert.equal(tiles.length, 1);
    assert.equal(size, 100 + 2 * D);
  });

  it("evenly sized tiles beat greedy fixed placement on awkward lengths", () => {
    const adaptive = planAxis(512, 256, D, O);
    const fixed = planAxis(512, 256, D, O, { fixed: true });
    assert.ok(adaptive.tiles.length * adaptive.size ** 2 <= fixed.tiles.length * fixed.size ** 2);
    assert.ok(adaptive.size < 256, "adaptive should shrink the window to what is needed");
  });

  it("rejects margins that leave no room", () => {
    assert.throws(() => planAxis(500, 40, 20, 16));
  });
});

/** A "model" that upsamples by pixel replication: exactly checkable and local. */
function nearestModel(scale) {
  return async (chw, w, h) => {
    const T = w * scale;
    const U = h * scale;
    const out = new Float32Array(3 * T * U);
    for (let c = 0; c < 3; c++)
      for (let y = 0; y < U; y++)
        for (let x = 0; x < T; x++) out[c * T * U + y * T + x] = chw[c * w * h + Math.floor(y / scale) * w + Math.floor(x / scale)];
    return out;
  };
}

function nearestReference(img, scale) {
  const W = img.width * scale;
  const H = img.height * scale;
  const out = Buffer.alloc(W * H * 3);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++)
      for (let c = 0; c < 3; c++) out[(y * W + x) * 3 + c] = img.data[(Math.floor(y / scale) * img.width + Math.floor(x / scale)) * 3 + c];
  return out;
}

describe("upscaleTiled", () => {
  const sizes = [
    [1, 1],
    [3, 2],
    [17, 5],
    [64, 64],
    [100, 37],
    [233, 31], // just under / over one usable window
    [260, 300], // several tiles in both axes
  ];

  for (const fixed of [false, true]) {
    for (const scale of [2, 3, 4]) {
      it(`reproduces the untiled result exactly (scale ${scale}, fixed=${fixed})`, async () => {
        for (const [width, height] of sizes) {
          const img = { data: patternRGB(width, height), width, height };
          const out = await upscaleTiled(img, {
            maxSize: 96,
            fixed,
            scale,
            margin: 12,
            overlap: 16,
            infer: nearestModel(scale),
          });
          assert.equal(out.width, width * scale);
          assert.equal(out.height, height * scale);
          assert.ok(out.data.equals(nearestReference(img, scale)), `mismatch for ${width}x${height} (fixed=${fixed})`);
        }
      });
    }
  }

  it("cross-fades smoothly between tiles that disagree (no hard seams)", async () => {
    // Each call returns a different flat level; any seam would show as a big jump between neighbours.
    const width = 300;
    const height = 20;
    const img = { data: Buffer.alloc(width * height * 3, 0), width, height };
    let call = 0;
    const out = await upscaleTiled(img, {
      maxSize: 96,
      scale: 1,
      margin: 12,
      overlap: 16,
      infer: async (chw, w, h) => new Float32Array(3 * w * h).fill(++call % 2 ? 0.2 : 0.4),
    });
    let maxJump = 0;
    for (let x = 1; x < width; x++) maxJump = Math.max(maxJump, Math.abs(out.data[x * 3] - out.data[(x - 1) * 3]));
    assert.ok(call > 3, "expected several tiles");
    assert.ok(maxJump <= 6, `neighbouring pixels jumped by ${maxJump}; a 0.2 level gap (51) should be spread over the overlap`);
  });

  it("reports progress and honours abort", async () => {
    const img = { data: patternRGB(200, 200), width: 200, height: 200 };
    const seen = [];
    await upscaleTiled(img, { maxSize: 96, scale: 2, margin: 12, overlap: 16, infer: nearestModel(2), onTile: (d, t) => seen.push([d, t]) });
    assert.deepEqual(seen[0].map(Number), [0, seen[0][1]]);
    assert.equal(seen.at(-1)[0], seen.at(-1)[1]);

    const ctl = new AbortController();
    let calls = 0;
    await assert.rejects(
      upscaleTiled(img, {
        maxSize: 96,
        scale: 2,
        margin: 12,
        overlap: 16,
        signal: ctl.signal,
        infer: async (...a) => {
          if (++calls === 2) ctl.abort();
          return nearestModel(2)(...a);
        },
      }),
      { name: "AbortError" },
    );
    assert.equal(calls, 2, "must stop before running another tile");
  });

  it("rejects a model that returns the wrong amount of data", async () => {
    const img = { data: patternRGB(20, 20), width: 20, height: 20 };
    await assert.rejects(upscaleTiled(img, { maxSize: 96, scale: 2, margin: 12, overlap: 16, infer: async () => new Float32Array(10) }), /expected/);
  });
});

describe("gatherTile / paintTile", () => {
  it("gathers mirrored context outside the image", () => {
    const rgb = Buffer.from([10, 10, 10, 200, 200, 200]); // 2×1 image
    const dst = new Float32Array(3 * 6 * 1);
    gatherTile(rgb, 2, 1, -2, 0, 6, 1, dst);
    const row = Array.from(dst.subarray(0, 6)).map((v) => Math.round(v * 255));
    assert.deepEqual(row, [200, 10, 10, 200, 200, 10]);
  });

  it("clamps out-of-range model output", () => {
    const out = Buffer.alloc(3);
    const tile = Float32Array.from([-0.5, 1.7, 0.5]);
    paintTile(out, 1, tile, 1, 1, 1, { origin: 0, start: 0, end: 1, ramp: 0 }, { origin: 0, start: 0, end: 1, ramp: 0 });
    assert.deepEqual([...out], [0, 255, 128]);
  });
});
