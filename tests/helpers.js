import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { runFfmpeg } from "../src/engine/ffmpeg.js";

export function tmpDir(prefix = "lucidframe-test-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function rm(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

/** Deterministic RGB test pattern with smooth gradients, hard edges and fine texture. */
export function patternRGB(width, height) {
  const data = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 3;
      const cx = x - width / 2;
      const cy = y - height / 2;
      const disc = cx * cx + cy * cy < (Math.min(width, height) / 3) ** 2;
      const checker = ((x >> 2) + (y >> 2)) & 1;
      data[o] = disc ? 220 : Math.round((x / width) * 255);
      data[o + 1] = disc ? 60 + checker * 120 : Math.round((y / height) * 255);
      data[o + 2] = checker ? 200 : 40;
    }
  }
  return data;
}

export async function writePattern(file, width, height, { channels = 3, ...opts } = {}) {
  let img = sharp(patternRGB(width, height), { raw: { width, height, channels: 3 } });
  if (channels === 4) {
    const alpha = Buffer.alloc(width * height);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) alpha[y * width + x] = x < width / 2 ? 255 : 90;
    img = img.joinChannel(alpha, { raw: { width, height, channels: 1 } });
  }
  await img.toFile(file);
  return file;
}

/** Make a short test clip with ffmpeg's lavfi sources. */
export async function makeClip(file, { width = 96, height = 64, rate = "30", seconds = 1, audio = true, pixFmt = "yuv420p", extra = [] } = {}) {
  const args = ["-y", "-v", "error", "-f", "lavfi", "-i", `testsrc2=size=${width}x${height}:rate=${rate}:duration=${seconds}`];
  if (audio) args.push("-f", "lavfi", "-i", `sine=frequency=440:duration=${seconds}`);
  args.push("-c:v", "libx264", "-pix_fmt", pixFmt, ...extra);
  if (audio) args.push("-c:a", "aac", "-shortest");
  args.push(file);
  const { code, stderr } = await runFfmpeg(args);
  if (code !== 0) throw new Error(`could not create test clip: ${stderr}`);
  return file;
}
