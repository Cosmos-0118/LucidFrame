// ffmpeg discovery, probing and process helpers.

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

let cachedPath;

/** Absolute path of the ffmpeg binary: $LUCIDFRAME_FFMPEG, bundled ffmpeg-static, then PATH. */
export function ffmpegPath() {
  if (cachedPath) return cachedPath;
  const candidates = [];
  if (process.env.LUCIDFRAME_FFMPEG) candidates.push(process.env.LUCIDFRAME_FFMPEG);
  try {
    let p = require("ffmpeg-static");
    if (p) {
      // Inside an Electron asar the binary lives in app.asar.unpacked.
      candidates.push(p.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`));
    }
  } catch {
    /* optional dependency */
  }
  for (const c of candidates) {
    if (fs.existsSync(c)) return (cachedPath = c);
  }
  // Fall back to whatever is on PATH; spawn will fail with ENOENT if absent and we report that.
  return (cachedPath = "ffmpeg");
}

export class FfmpegError extends Error {
  constructor(message, stderr = "") {
    super(message);
    this.name = "FfmpegError";
    this.stderr = stderr;
  }
}

/** Last meaningful lines of ffmpeg stderr, for error messages. */
export function tail(stderr, lines = 4) {
  return stderr
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(-lines)
    .join(" | ");
}

/** Run ffmpeg to completion and capture stdout (Buffer) and stderr (string). */
export function runFfmpeg(args, { signal } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath(), args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    const out = [];
    let err = "";
    child.stdout.on("data", (c) => out.push(c));
    child.stderr.on("data", (c) => {
      err += c;
      if (err.length > 1 << 20) err = err.slice(-(1 << 19));
    });
    const onAbort = () => child.kill("SIGKILL");
    signal?.addEventListener("abort", onAbort, { once: true });
    child.on("error", (e) =>
      reject(
        e.code === "ENOENT"
          ? new FfmpegError("ffmpeg was not found. Reinstall LucidFrame, or set LUCIDFRAME_FFMPEG to an ffmpeg binary.")
          : e,
      ),
    );
    child.on("close", (code) => {
      signal?.removeEventListener("abort", onAbort);
      resolve({ code, stdout: Buffer.concat(out), stderr: err });
    });
  });
}

const NTSC = [
  [24000, 1001],
  [30000, 1001],
  [60000, 1001],
  [120000, 1001],
];

/** Map a printed frame rate (29.97) back to its exact rational so audio stays in sync on long clips. */
export function normalizeFps(fps) {
  for (const [n, d] of NTSC) {
    if (Math.abs(fps - n / d) < 0.01) return { value: n / d, rational: `${n}/${d}` };
  }
  const rounded = Math.round(fps * 1000) / 1000;
  return { value: rounded, rational: String(rounded) };
}

const MATRIX_NAMES = {
  bt709: "bt709",
  bt470bg: "bt601",
  smpte170m: "bt601",
  bt2020nc: "bt2020",
  bt2020c: "bt2020",
  smpte240m: "smpte240m",
};

/** Parse the banner `ffmpeg -i file` prints to stderr. Exported for tests. */
export function parseProbe(stderr) {
  const lines = stderr.split(/\r?\n/);
  const info = {
    duration: null,
    video: null,
    audio: null,
  };

  const dur = stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  if (dur) info.duration = +dur[1] * 3600 + +dur[2] * 60 + parseFloat(dur[3]);

  for (const line of lines) {
    const v = line.match(/Stream #\d+:\d+[^:]*:\s*Video:\s*([^\s,(]+)(.*)$/);
    if (v && !info.video && !/attached pic/i.test(line)) {
      const rest = v[2];
      const size = rest.match(/,\s*(\d{2,6})x(\d{2,6})(?=[\s,[]|$)/);
      if (!size) continue;
      const fps = rest.match(/([\d.]+)\s+fps/) || rest.match(/([\d.]+)\s+tbr/);
      const sar = rest.match(/SAR\s+(\d+):(\d+)/);
      const paren = rest.match(/\b(?:yuv|nv|rgb|gbr|gray|bgr|p0)[a-z0-9]*\(([^)]*)\)/i);
      const tags = paren ? paren[1] : "";
      const matrix = (tags.match(/bt709|bt470bg|smpte170m|bt2020nc|bt2020c|smpte240m/) || [])[0];
      info.video = {
        codec: v[1],
        width: +size[1],
        height: +size[2],
        fps: fps ? parseFloat(fps[1]) : null,
        sar: sar && +sar[1] > 0 && +sar[2] > 0 ? [+sar[1], +sar[2]] : [1, 1],
        matrix: matrix ? MATRIX_NAMES[matrix] : null,
        hdr: /smpte2084|arib-std-b67/.test(tags),
      };
      continue;
    }
    const a = line.match(/Stream #\d+:\d+[^:]*:\s*Audio:\s*([^\s,(]+)/);
    if (a && !info.audio) info.audio = { codec: a[1] };
  }
  return info;
}

/** Probe a media file with ffmpeg itself (ffmpeg-static ships no ffprobe). */
export async function probe(file, { signal } = {}) {
  const { stderr } = await runFfmpeg(["-hide_banner", "-nostdin", "-i", file], { signal });
  // ffmpeg exits non-zero here ("at least one output file must be specified"); that is expected.
  if (/No such file|Invalid data found|moov atom not found|does not contain any stream/i.test(stderr) && !/Stream #/.test(stderr)) {
    throw new FfmpegError(`cannot read "${path.basename(file)}": ${tail(stderr, 2)}`, stderr);
  }
  return parseProbe(stderr);
}

/** Pick the YUV↔RGB matrix: what the file declares, else the usual convention by resolution. */
export function pickMatrix(video) {
  return video.matrix ?? (video.height >= 720 || video.width >= 1280 ? "bt709" : "bt601");
}
