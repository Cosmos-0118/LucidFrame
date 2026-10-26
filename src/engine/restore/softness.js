// Detects out-of-focus / smeared images, so the cleanup stage (which was also trained on blur) can run on them.
//
// For strong edges we measure how many pixels the brightness takes to go from one side to the other (the edge
// "width"). Sharp photos have narrow edges, blurred ones wide ones. The median over many edges is robust to a
// few genuinely soft areas such as a blurred background.

const MIN_STEP = 12; // brightness change across two pixels that counts as an edge
const MAX_WIDTH = 64;
const FLAT = 0.6; // a change smaller than this per pixel counts as the plateau
const MIN_EDGES = 120;
const MAX_EDGES = 6000;

/**
 * @param {{data:Uint8Array|Buffer, width:number, height:number}} img interleaved 8-bit RGB
 * @returns {{edgeWidth:number|null, edges:number}} median edge width in pixels (null if there are too few edges to judge)
 */
export function measureSoftness({ data, width, height }) {
  if (width < 64 || height < 64) return { edgeWidth: null, edges: 0 };
  const row = new Float32Array(width);
  const widths = [];
  const stepY = Math.max(1, Math.floor(height / 1500));

  for (let y = 0; y < height && widths.length < MAX_EDGES; y += stepY) {
    const base = y * width * 3;
    for (let x = 0; x < width; x++) row[x] = (data[base + x * 3] * 77 + data[base + x * 3 + 1] * 150 + data[base + x * 3 + 2] * 29) / 256;
    for (let x = 2; x < width - 2; x++) {
      const g = row[x + 1] - row[x - 1];
      const ag = Math.abs(g);
      if (ag < MIN_STEP || ag < Math.abs(row[x] - row[x - 2]) || ag < Math.abs(row[x + 2] - row[x])) continue; // not the steepest point
      const dir = g > 0 ? 1 : -1;
      // walk outwards while the brightness keeps moving the same way; stop at the plateau on either side
      let l = x;
      while (l > 0 && x - l < MAX_WIDTH && (row[l] - row[l - 1]) * dir > FLAT) l--;
      let r = x + 1;
      while (r < width - 1 && r - x < MAX_WIDTH && (row[r + 1] - row[r]) * dir > FLAT) r++;
      widths.push(r - l);
      x = r; // skip past this edge
    }
  }
  if (widths.length < MIN_EDGES) return { edgeWidth: null, edges: widths.length };
  widths.sort((a, b) => a - b);
  return { edgeWidth: widths[widths.length >> 1], edges: widths.length };
}
