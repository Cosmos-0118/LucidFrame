// File-type tables. Pure data so the Electron main process can use them without loading native modules.

import path from "node:path";

// Exactly what sharp's prebuilt libvips can decode (no BMP, no HEIC). tests/image.test.js proves each one.
export const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".tif", ".tiff", ".gif", ".avif"]);
export const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".mkv", ".webm", ".avi", ".m4v", ".wmv", ".flv", ".mpg", ".mpeg", ".ts", ".mts", ".m2ts", ".3gp"]);

/** "image" | "video" | null, decided by extension (content is validated when the job runs). */
export function detectKind(file) {
  const ext = path.extname(file).toLowerCase();
  if (IMAGE_EXTENSIONS.has(ext)) return "image";
  if (VIDEO_EXTENSIONS.has(ext)) return "video";
  return null;
}
