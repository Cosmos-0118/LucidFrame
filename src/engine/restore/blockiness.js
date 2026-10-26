// Detects JPEG-style 8×8 block artifacts so the cleanup stage runs only on images that need it.
//
// JPEG compresses 8×8 pixel blocks independently, so heavily compressed images show a jump in brightness at block
// boundaries that isn't there inside blocks. For every position within the 8-pixel period we average the absolute
// brightness change across that boundary; a clean image has no preferred position (all eight about equal), a
// compressed one has one position clearly above the rest. The ratio between the strongest and the runner-up is the
// score, so a crop that moved the grid is still detected and a periodic texture (two strong positions) is not.

const PERIOD = 8;
const TARGET_SAMPLES = 4_000_000;

/**
 * @param {{data:Uint8Array|Buffer, width:number, height:number}} img interleaved 8-bit RGB
 * @returns {{score:number, horizontal:number, vertical:number}} score ≈ 1.0 for clean images, 1.3+ for visibly blocky ones
 */
export function measureBlockiness({ data, width, height }) {
  if (width < PERIOD * 4 || height < PERIOD * 4) return { score: 1, horizontal: 1, vertical: 1 };

  // Visit every pixel of a row but only some rows; an odd step reaches every row phase mod 8.
  let step = Math.max(1, Math.ceil((width * height) / TARGET_SAMPLES));
  if (step % 2 === 0) step += 1;

  const sumH = new Float64Array(PERIOD);
  const cntH = new Float64Array(PERIOD);
  const sumV = new Float64Array(PERIOD);
  const cntV = new Float64Array(PERIOD);
  const luma = (i) => (data[i] * 77 + data[i + 1] * 150 + data[i + 2] * 29) >> 8;

  for (let y = 0; y < height - 1; y += step) {
    const row = y * width * 3;
    const next = row + width * 3;
    const vPhase = y % PERIOD;
    let prev = luma(row);
    for (let x = 0; x < width - 1; x++) {
      const cur = luma(row + (x + 1) * 3);
      const p = x % PERIOD;
      sumH[p] += Math.abs(cur - prev);
      cntH[p]++;
      prev = cur;
      sumV[vPhase] += Math.abs(luma(next + x * 3) - luma(row + x * 3));
      cntV[vPhase]++;
    }
  }

  const horizontal = peakRatio(sumH, cntH);
  const vertical = peakRatio(sumV, cntV);
  return { score: (horizontal + vertical) / 2, horizontal, vertical };
}

/** Below this mean step between neighbouring pixels the interior is flat: block-aligned graphics, not compression. */
const MIN_INTERIOR_STEP = 0.4;

/**
 * Strongest phase relative to the *second* strongest. JPEG gives exactly one dominant phase; a periodic texture (a
 * checkerboard, fabric, a tiled pattern) lights up two or more equally and so scores about 1. Block-aligned flat
 * graphics (nearest-neighbour pixel art) have no texture between their block edges at all and are ruled out.
 */
function peakRatio(sum, count) {
  const mean = Array.from(sum, (s, i) => (count[i] ? s / count[i] : 0)).sort((a, b) => a - b);
  const peak = mean[mean.length - 1];
  const second = mean[mean.length - 2];
  if (second < MIN_INTERIOR_STEP) return 1;
  return peak / second;
}
