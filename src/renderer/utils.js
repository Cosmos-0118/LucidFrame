export const MAX_OUTPUT_PIXELS = 268_000_000; // must match the engine's limit

export function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 ? v.toFixed(0) : v.toFixed(1)} ${units[i]}`;
}

export function fmtDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "";
  if (seconds < 10) return `${seconds.toFixed(1)}s`;
  const s = Math.round(seconds);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

export const fmtDims = (w, h) => `${w.toLocaleString()} × ${h.toLocaleString()}`;
export const megapixels = (w, h) => (w * h) / 1e6;

/** Scale the engine actually reaches before its final resize (multi-pass for small native scales). */
export function reachedScale(native, scale) {
  let reached = native;
  while (reached < scale) reached *= native;
  return reached;
}

/** Does this source at this scale fit within the engine's working-image limit? */
export function fits(w, h, scale, nativeScale) {
  const r = reachedScale(nativeScale, scale);
  return w * h * r * r <= MAX_OUTPUT_PIXELS;
}

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
