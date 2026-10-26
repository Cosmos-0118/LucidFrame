// Streaming video upscaling.
//
//   ffmpeg (decode → raw RGB) ──pipe──▶ model ──pipe──▶ ffmpeg (encode H.264 + original audio)
//
// Frames never touch the disk (the old design wrote every frame as a PNG, then
// re-read them), the source frame rate is preserved, and audio is carried over.

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { once } from "node:events";
import { log } from "./log.js";
import { FfmpegError, ffmpegPath, normalizeFps, pickMatrix, probe, runFfmpeg, tail } from "./ffmpeg.js";
import { partialPath, suggestOutputPath } from "./image.js";
import { UpscaleError, Upscaler } from "./upscaler.js";
import sharp from "sharp";

const COPYABLE_AUDIO = new Set(["aac", "mp3", "ac3", "eac3", "alac"]);

function decodeFilters({ video, fps, smooth, matrix, duration }) {
  const filters = [`fps=${fps.rational}`];
  const [sn, sd] = video.sar;
  if (sn !== sd) filters.push(`scale='trunc(iw*${sn}/${sd}/2)*2':ih`, "setsar=1"); // anamorphic → square pixels
  if (smooth) {
    // minterpolate needs look-ahead and otherwise drops the last few output frames. Pad the source with
    // clones of its final frame so the real frames all get interpolated, then trim back to `duration`
    // in the decoder so the clip (and its audio) keeps its exact length.
    if (duration) filters.push("tpad=stop_mode=clone:stop_duration=1");
    filters.push(`minterpolate=fps=${fps.value * 2}:mi_mode=mci:mc_mode=aobmc:me_mode=bidir:vsbmc=1`);
  }
  filters.push(`scale=in_color_matrix=${matrix}:in_range=auto:out_range=pc`, "format=rgb24");
  return filters.join(",");
}

const COLOR_TAGS = {
  bt709: ["-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709"],
  bt601: ["-colorspace", "smpte170m", "-color_primaries", "smpte170m", "-color_trc", "smpte170m"],
  bt2020: ["-colorspace", "bt2020nc", "-color_primaries", "bt2020", "-color_trc", "bt709"],
  smpte240m: [],
};

/** Frame size after the decode filters: decode exactly one frame and read its dimensions. */
async function measureFrame(input, filters, signal) {
  const { code, stdout, stderr } = await runFfmpeg(
    ["-v", "error", "-nostdin", "-i", input, "-map", "0:v:0", "-an", "-sn", "-vf", filters.replace(/,format=rgb24$/, ""), "-frames:v", "1", "-f", "image2pipe", "-c:v", "png", "-"],
    { signal },
  );
  if (code !== 0 || stdout.length === 0) {
    throw new UpscaleError(`could not decode the first frame: ${tail(stderr, 2) || `ffmpeg exited with ${code}`}`, "bad_video");
  }
  const meta = await sharp(stdout).metadata();
  return { width: meta.width, height: meta.height };
}

/**
 * Upscale one video file.
 * @param {Upscaler} upscaler
 * @param {object} job
 * @param {string} job.input
 * @param {string} [job.output]
 * @param {string} job.model
 * @param {number} job.scale
 * @param {boolean} [job.smooth] interpolate to 2× the frame rate (motion-compensated)
 * @param {string} [job.outputDir]
 * @param {AbortSignal} [job.signal]
 * @param {(p:{phase:string,fraction:number,message?:string,frame?:number,frames?:number,fps?:number,etaSeconds?:number})=>void} [job.onProgress]
 */
export async function upscaleVideoFile(upscaler, job) {
  const { input, model, scale, signal, onProgress } = job;
  const smooth = Boolean(job.smooth);
  const started = performance.now();
  const report = (p) => onProgress?.(p);

  report({ phase: "probe", fraction: 0, message: "Reading video…" });
  const info = await probe(input, { signal });
  if (!info.video) throw new UpscaleError("no video stream found in this file", "bad_video");
  const { video } = info;
  const fps = normalizeFps(video.fps ?? 30);
  const matrix = pickMatrix(video);
  const warnings = [];
  if (video.hdr) warnings.push("HDR source: colours will look flatter than the original (tone-mapping is not applied).");

  const { model: modelEntry } = await upscaler.registry.resolve(model);
  const filters = decodeFilters({ video, fps, smooth, matrix, duration: info.duration });
  const frame = await measureFrame(input, filters, signal);
  Upscaler.assertFits(frame.width, frame.height, scale, modelEntry.scale);

  const outW = frame.width * scale;
  const outH = frame.height * scale;
  const outFps = smooth ? fps.value * 2 : fps.value;
  const estFrames = info.duration ? Math.max(1, Math.round(info.duration * outFps)) : null;

  const output = job.output ?? suggestOutputPath(input, { scale, ext: "mp4", outputDir: job.outputDir });
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const tmp = partialPath(output);

  const copyAudio = info.audio && COPYABLE_AUDIO.has(info.audio.codec);
  // Two steps on purpose. The encoder reads its frames from a pipe, so it must not also be given the audio and
  // `-shortest`: ffmpeg ≤ 6.0 (the macOS build) ends the whole output as soon as the always-ready audio stream hits
  // EOF, which cut videos down to a single frame. Encode video alone, then mux with the original audio from files.
  const videoOnly = tmp.replace(/(\.[^.]+)$/, ".video$1");
  const encArgs = [
    "-y", "-v", "error", "-nostdin",
    "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", `${outW}x${outH}`, "-framerate", String(outFps), "-i", "pipe:0",
    "-map", "0:v:0",
    "-vf", `scale='trunc(iw/2)*2':'trunc(ih/2)*2':out_color_matrix=${matrix}:out_range=tv,format=yuv420p`,
    "-c:v", "libx264", "-preset", "fast", "-crf", "17",
    ...(COLOR_TAGS[matrix] ?? []), "-color_range", "tv",
    videoOnly,
  ];
  const muxArgs = [
    "-y", "-v", "error", "-nostdin",
    "-i", videoOnly, "-i", input,
    "-map", "0:v:0", "-map", "1:a?",
    "-map_metadata", "1",
    "-c:v", "copy",
    ...(info.audio ? (copyAudio ? ["-c:a", "copy"] : ["-c:a", "aac", "-b:a", "192k"]) : []),
    ...(info.audio ? ["-shortest"] : []),
    "-movflags", "+faststart",
    tmp,
  ];
  const decArgs = ["-v", "error", "-nostdin", "-i", input, "-map", "0:v:0", "-an", "-sn", "-dn", "-vf", filters, ...(smooth && info.duration ? ["-t", String(info.duration)] : []), "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"];

  log.info(`video ${path.basename(input)}: ${frame.width}x${frame.height}@${fps.value} → ${outW}x${outH}@${outFps}${smooth ? " (smooth)" : ""}`);

  const bin = ffmpegPath();
  const dec = spawn(bin, decArgs, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  const enc = spawn(bin, encArgs, { stdio: ["pipe", "ignore", "pipe"], windowsHide: true });
  let decErr = "";
  let encErr = "";
  dec.stderr.on("data", (c) => (decErr = (decErr + c).slice(-8192)));
  enc.stderr.on("data", (c) => (encErr = (encErr + c).slice(-8192)));
  enc.stdin.on("error", () => {}); // encoder death is reported via its exit code
  const decExit = new Promise((resolve) => dec.on("close", (code) => resolve(code)));
  const encExit = new Promise((resolve) => enc.on("close", (code) => resolve(code)));
  const spawnFail = new Promise((_, reject) => {
    for (const p of [dec, enc]) {
      p.on("error", (e) => reject(e.code === "ENOENT" ? new FfmpegError("ffmpeg was not found. Reinstall LucidFrame.") : e));
    }
  });

  const kill = () => {
    dec.kill("SIGKILL");
    enc.kill("SIGKILL");
  };
  signal?.addEventListener("abort", kill, { once: true });

  const frameBytes = frame.width * frame.height * 3;
  let frames = 0;
  let pending = Buffer.allocUnsafe(frameBytes);
  let filled = 0;
  const recent = []; // [timestamp] of the last few finished frames, for fps/ETA

  const processFrame = async () => {
    const result = await upscaler.upscaleRGB({ data: pending, width: frame.width, height: frame.height }, { model, scale, signal });
    if (!enc.stdin.write(result.data)) await Promise.race([once(enc.stdin, "drain"), encExit.then(() => {})]);
    pending = Buffer.allocUnsafe(frameBytes);
    filled = 0;
    frames++;
    const now = performance.now();
    recent.push(now);
    if (recent.length > 12) recent.shift();
    const rate = recent.length > 1 ? ((recent.length - 1) * 1000) / (now - recent[0]) : 0;
    const total = estFrames && frames <= estFrames ? estFrames : null;
    report({
      phase: "upscale",
      fraction: total ? Math.min(0.99, frames / total) : 0,
      frame: frames,
      frames: total,
      fps: rate,
      etaSeconds: total && rate > 0 ? (total - frames) / rate : null,
    });
  };

  try {
    const pump = (async () => {
      for await (const chunk of dec.stdout) {
        let offset = 0;
        while (offset < chunk.length) {
          const take = Math.min(frameBytes - filled, chunk.length - offset);
          chunk.copy(pending, filled, offset, offset + take);
          filled += take;
          offset += take;
          if (filled === frameBytes) {
            signal?.throwIfAborted();
            await processFrame();
          }
        }
      }
      enc.stdin.end();
    })();

    await Promise.race([pump, spawnFail]);
    const [decCode, encCode] = await Promise.all([decExit, encExit]);
    signal?.throwIfAborted();
    if (frames === 0) throw new UpscaleError(`no frames could be decoded: ${tail(decErr, 3) || `ffmpeg exited with ${decCode}`}`, "bad_video");
    if (decCode !== 0) log.warn(`decoder exited with ${decCode}: ${tail(decErr, 3)}`);
    if (encCode !== 0) throw new UpscaleError(`video encoder failed: ${tail(encErr, 3) || `ffmpeg exited with ${encCode}`}`, "encode_failed");
    report({ phase: "finalize", fraction: 0.99, frame: frames, frames: estFrames, message: info.audio ? "Adding audio…" : "Finishing…" });
    const mux = await runFfmpeg(muxArgs, { signal });
    signal?.throwIfAborted();
    if (mux.code !== 0) throw new UpscaleError(`could not write the output file: ${tail(mux.stderr, 3) || `ffmpeg exited with ${mux.code}`}`, "encode_failed");
    fs.renameSync(tmp, output);
  } catch (err) {
    kill();
    await Promise.allSettled([decExit, encExit]);
    fs.rmSync(tmp, { force: true });
    if (signal?.aborted) throw signal.reason ?? err;
    throw err;
  } finally {
    fs.rmSync(videoOnly, { force: true });
    signal?.removeEventListener("abort", kill);
  }

  report({ phase: "done", fraction: 1, frame: frames, frames });
  return {
    kind: "video",
    input,
    output,
    preview: null,
    width: outW,
    height: outH,
    sourceWidth: frame.width,
    sourceHeight: frame.height,
    model,
    scale,
    smooth,
    frames,
    fps: outFps,
    hasAudio: Boolean(info.audio),
    seconds: (performance.now() - started) / 1000,
    device: upscaler.deviceInfo(),
    warnings,
  };
}
