// Pure helpers for the main process's trust boundary. Everything the renderer sends is
// untrusted input; these functions are what turn it into something safe to act on.

import path from "node:path";

const SCALES = [2, 3, 4];
const FORMATS = ["auto", "png", "jpeg", "webp"];
const CLEANUP_MODES = ["auto", "on", "off"];
const FACE_MODES = ["auto", "always", "off"];

/**
 * Validate a "start job" request from the renderer.
 * @param {unknown} req
 * @param {{models: {id:string}[]}} ctx
 */
export function validateStart(req, { models }) {
  if (!req || typeof req !== "object") throw new TypeError("invalid request");
  const { itemId, model, scale, format = "auto", smooth = false, cleanup = "auto", faces = "auto" } = req;
  if (typeof itemId !== "string" || itemId.length > 64) throw new TypeError("invalid item");
  if (typeof model !== "string" || !models.some((m) => m.id === model)) throw new TypeError("unknown model");
  if (!SCALES.includes(scale)) throw new TypeError("scale must be 2, 3 or 4");
  if (!FORMATS.includes(format)) throw new TypeError("invalid output format");
  if (typeof smooth !== "boolean") throw new TypeError("invalid smooth flag");
  if (!CLEANUP_MODES.includes(cleanup)) throw new TypeError("invalid cleanup mode");
  if (!FACE_MODES.includes(faces)) throw new TypeError("invalid face mode");
  return { itemId, model, scale, format, smooth, cleanup, faces };
}

/**
 * Parse an HTTP Range header for a file of `size` bytes.
 * @returns {{start:number,end:number}|null|"invalid"} null → no range requested
 */
export function parseRange(header, size) {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === "" && m[2] === "")) return "invalid";
  let start;
  let end;
  if (m[1] === "") {
    const suffix = Number(m[2]);
    if (suffix === 0) return "invalid";
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (!(start <= end) || start >= size) return "invalid";
  return { start, end };
}

/** Resolve a URL path inside `root`, or null if it would escape it. */
export function safeJoin(root, urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  if (decoded.includes("\0")) return null;
  const rel = decoded === "/" || decoded === "" ? "index.html" : decoded.replace(/^[/\\]+/, "");
  const full = path.resolve(root, rel);
  const base = path.resolve(root) + path.sep;
  return full.startsWith(base) ? full : null;
}

const EXTERNAL_ALLOWLIST = ["https://github.com/Cosmos-0118/LucidFrame"];

/** Only our own project pages may be opened in the system browser. */
export function isSafeExternalUrl(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== "https:") return false;
  return EXTERNAL_ALLOWLIST.some((allowed) => u.href === allowed || u.href.startsWith(`${allowed}/`) || u.href.startsWith(`${allowed}?`) || u.href.startsWith(`${allowed}#`));
}

export const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' lucid://media blob: data:",
  "media-src lucid://media blob:",
  "font-src 'self'",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");
