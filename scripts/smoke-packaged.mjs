// Launches the packaged app (from `npm run pack`) in smoke-test mode and checks it works end to end:
// UI renders, sandbox is intact, models verify, inference runs, ffmpeg and image codecs load.
//   npm run pack && node scripts/smoke-packaged.mjs

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const release = path.join(root, "release");

const candidates = {
  linux: ["linux-unpacked/lucidframe"],
  win32: ["win-unpacked/LucidFrame.exe"],
  darwin: ["mac-arm64/LucidFrame.app/Contents/MacOS/LucidFrame", "mac/LucidFrame.app/Contents/MacOS/LucidFrame"],
}[process.platform];

const bin = candidates?.map((c) => path.join(release, c)).find((p) => fs.existsSync(p));
if (!bin) {
  console.error(`No packaged app found under ${release}. Run \`npm run pack\` first.`);
  process.exit(2);
}

const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "lucidframe-smoke-")), "result.json");
const userData = path.join(path.dirname(out), "userdata");
const cmd = process.platform === "linux" && process.env.DISPLAY === undefined ? "xvfb-run" : bin;
const asRoot = process.platform === "linux" && process.getuid?.() === 0; // containers: Chromium refuses to sandbox as root
const args = [...(asRoot ? ["--no-sandbox"] : []), `--user-data-dir=${userData}`, "--smoke-test"];
const full = cmd === "xvfb-run" ? ["-a", bin, ...args] : args;

console.log(`Smoke-testing ${bin}`);
const res = spawnSync(cmd, full, { stdio: ["ignore", "inherit", "inherit"], env: { ...process.env, LUCIDFRAME_SMOKE_OUT: out }, timeout: 180_000 });

let report = null;
try {
  report = JSON.parse(fs.readFileSync(out, "utf8"));
} catch {
  /* handled below */
}
if (!report) {
  console.error(`The app produced no smoke-test result (exit ${res.status}${res.error ? `, ${res.error.message}` : ""}).`);
  process.exit(1);
}
for (const c of report.doctor?.checks ?? []) console.log(`  ${c.ok ? "✔" : "✘"} ${c.name}: ${c.detail}`);
if (report.error) console.error(`  ✘ ${report.error}`);
console.log(report.ok ? "Packaged app OK." : "Packaged app FAILED.");
process.exit(report.ok ? 0 : 1);
