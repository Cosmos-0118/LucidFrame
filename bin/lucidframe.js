#!/usr/bin/env node
// LucidFrame command line: the same engine as the desktop app, no window.
//
//   lucidframe photo.jpg                      upscale with the best photo model, 4×
//   lucidframe clip.mp4 -m fast -s 2          upscale a video 2× with the fast model
//   lucidframe *.png --out-dir upscaled       batch
//   lucidframe models | lucidframe doctor

import path from "node:path";
import { parseArgs } from "node:util";
import { Engine, appVersion, detectKind, OUTPUT_FORMATS, SCALES } from "../src/engine/index.js";

const HELP = `LucidFrame ${appVersion()} — offline AI image & video upscaler

Usage
  lucidframe <file...> [options]    upscale images and videos
  lucidframe models                 list models
  lucidframe doctor                 verify models, GPU/CPU inference, codecs and ffmpeg

Options
  -m, --model <id>      photo | anime | fast | fast-anime   (default: photo for images, fast for video)
  -s, --scale <n>       ${SCALES.join(" | ")}                                (default: the model's native scale)
  -o, --output <file>   output path (single input only)
      --out-dir <dir>   write results here instead of next to the input
      --format <fmt>    ${["auto", ...OUTPUT_FORMATS].join(" | ")}  image output format        (default: auto)
      --quality <1-100> JPEG/WebP quality                                (default: 95)
      --smooth          video: motion-interpolate to double the frame rate
      --device <name>   auto | cpu | dml | cuda | coreml                 (default: auto)
      --json            machine-readable output
  -h, --help            show this help
  -v, --version
`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    model: { type: "string", short: "m" },
    scale: { type: "string", short: "s" },
    output: { type: "string", short: "o" },
    "out-dir": { type: "string" },
    format: { type: "string" },
    quality: { type: "string" },
    smooth: { type: "boolean" },
    device: { type: "string" },
    json: { type: "boolean" },
    help: { type: "boolean", short: "h" },
    version: { type: "boolean", short: "v" },
  },
});

if (values.version) {
  console.log(appVersion());
  process.exit(0);
}
if (values.help || positionals.length === 0) {
  console.log(HELP);
  process.exit(values.help ? 0 : 2);
}

const json = Boolean(values.json);
if (json) process.env.LUCIDFRAME_QUIET = "1";
const out = (...a) => (json ? null : console.log(...a));
const fail = (msg) => {
  if (json) console.log(JSON.stringify({ ok: false, error: msg }));
  else console.error(`error: ${msg}`);
  process.exit(1);
};

const engine = new Engine({ device: values.device });
const abort = new AbortController();
process.on("SIGINT", () => {
  if (abort.signal.aborted) process.exit(130);
  abort.abort(new DOMException("cancelled", "AbortError"));
  out("\nCancelling… (press Ctrl+C again to force quit)");
});

function bar(p) {
  if (json || !process.stderr.isTTY) return;
  const pct = Math.round((p.fraction ?? 0) * 100);
  const filled = Math.round(pct / 5);
  let line = `  [${"█".repeat(filled)}${"░".repeat(20 - filled)}] ${String(pct).padStart(3)}%`;
  if (p.frame) line += `  frame ${p.frame}${p.frames ? `/${p.frames}` : ""}${p.fps ? ` · ${p.fps.toFixed(1)} fps` : ""}`;
  if (p.etaSeconds > 0) line += `  ETA ${fmtDuration(p.etaSeconds)}`;
  if (p.message) line += `  ${p.message}`;
  process.stderr.write(`\r${line.padEnd(78)}`);
}

const fmtDuration = (s) => (s >= 3600 ? `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m` : s >= 60 ? `${Math.floor(s / 60)}m${String(Math.round(s % 60)).padStart(2, "0")}s` : `${Math.round(s)}s`);

try {
  if (positionals[0] === "models") {
    const models = engine.models();
    if (json) console.log(JSON.stringify(models, null, 2));
    else {
      for (const m of models) console.log(`${m.id.padEnd(11)} ${String(m.scale) + "×"}  ${m.name.padEnd(12)} ${m.tagline}  [${m.license}, ${m.author}]`);
    }
    process.exit(0);
  }

  if (positionals[0] === "doctor") {
    const report = await engine.doctor();
    if (json) console.log(JSON.stringify(report, null, 2));
    else {
      console.log(`LucidFrame ${report.version} · ${report.platform} · node ${report.node}`);
      for (const c of report.checks) console.log(`  ${c.ok ? "✔" : "✘"} ${c.name.padEnd(12)} ${c.detail}  (${c.ms} ms)`);
      console.log(report.ok ? "\nAll good." : "\nSomething is wrong — see the ✘ lines above.");
    }
    await engine.dispose();
    process.exit(report.ok ? 0 : 1);
  }

  if (values.output && positionals.length > 1) fail("--output can only be used with a single input; use --out-dir for several");
  const models = new Map(engine.models().map((m) => [m.id, m]));
  if (values.model && !models.has(values.model)) fail(`unknown model "${values.model}" (try: ${[...models.keys()].join(", ")})`);

  const results = [];
  for (const [i, file] of positionals.entries()) {
    const input = path.resolve(file);
    const kind = detectKind(input);
    if (!kind) fail(`"${file}" is not a supported image or video file`);
    const modelId = values.model ?? (kind === "video" ? "fast" : "photo");
    const scale = values.scale ? Number(values.scale) : models.get(modelId).scale;
    out(`${positionals.length > 1 ? `[${i + 1}/${positionals.length}] ` : ""}${path.basename(input)}  ${modelId} ${scale}×`);
    const result = await engine.process({
      input,
      model: modelId,
      scale,
      output: values.output ? path.resolve(values.output) : undefined,
      outputDir: values["out-dir"] ? path.resolve(values["out-dir"]) : undefined,
      format: values.format,
      quality: values.quality ? Number(values.quality) : undefined,
      smooth: values.smooth,
      signal: abort.signal,
      onProgress: bar,
    });
    if (process.stderr.isTTY && !json) process.stderr.write("\r".padEnd(80) + "\r");
    for (const w of result.warnings) out(`  ! ${w}`);
    out(`  → ${result.output}  (${result.sourceWidth}×${result.sourceHeight} → ${result.width}×${result.height}, ${result.seconds.toFixed(1)}s on ${result.device.label})`);
    results.push(result);
  }
  if (json) console.log(JSON.stringify({ ok: true, results }, null, 2));
  await engine.dispose();
} catch (err) {
  if (err?.name === "AbortError") {
    out("Cancelled.");
    process.exit(130);
  }
  fail(err?.message ?? String(err));
}
