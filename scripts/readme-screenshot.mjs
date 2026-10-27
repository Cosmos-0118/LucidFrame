// Regenerates docs/screenshot.jpg from the real app: opens an image, upscales it 4x with the Photo model and
// captures the before/after comparison.
//   node scripts/readme-screenshot.mjs path/to/cat.png [docs/screenshot.jpg]
// Needs a display and the downloaded models (npm run models) and a built renderer (npm run build).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { _electron as electron } from "playwright-core";
import { sandboxFlags } from "../src/main/sandbox.js";

const root = path.resolve(import.meta.dirname, "..");
const [source, target = path.join(root, "docs", "screenshot.jpg")] = process.argv.slice(2);
if (!source) {
  console.error("usage: node scripts/readme-screenshot.mjs <image> [output.jpg]");
  process.exit(2);
}

const electronBinary = createRequire(import.meta.url)("electron");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lucidframe-shot-"));
// A copy, so the upscaled file lands in the temp folder and not next to the original.
const input = path.join(dir, path.basename(source));
fs.copyFileSync(source, input);

const app = await electron.launch({
  executablePath: electronBinary,
  args: [...sandboxFlags(electronBinary), `--user-data-dir=${path.join(dir, "userdata")}`, root, input],
  env: { ...process.env, LUCIDFRAME_LOG_LEVEL: "error" },
});
try {
  const page = await app.firstWindow();
  await page.setViewportSize({ width: 1240, height: 820 });
  await page.waitForSelector(".row .row-name");
  await page.waitForFunction(() => !document.querySelector(".device .spinner"), null, { timeout: 60_000 });
  await page.getByText("Photo", { exact: true }).first().click();
  await page.getByText("4×", { exact: true }).first().click();
  await page.getByRole("button", { name: /Upscale 1 file/ }).click();
  await page.waitForSelector(".compare", { timeout: 300_000 });
  await page.waitForFunction(() => [...document.querySelectorAll(".compare-img")].every((i) => i.complete && i.naturalWidth > 0));
  await page.mouse.move(2, 2); // keep hover states out of the picture
  await page.waitForTimeout(600);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  await page.screenshot({ path: target, type: "jpeg", quality: 90 });
  console.log("wrote", target);
} finally {
  await app.close().catch(() => {});
  fs.rmSync(dir, { recursive: true, force: true });
}
