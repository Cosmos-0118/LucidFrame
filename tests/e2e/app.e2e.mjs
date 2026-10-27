// End-to-end test of the real desktop app (Electron + UI + engine), driven by Playwright.
//   npm run test:e2e            (Linux CI wraps it in xvfb-run)
// Not part of `npm test` because it needs a display and the Electron binary.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { after, before, describe, it } from "node:test";
import { _electron as electron } from "playwright-core";
import sharp from "sharp";
import { sandboxFlags } from "../../src/main/sandbox.js";
import { patternRGB, rm, tmpDir } from "../helpers.js";

const root = path.resolve(import.meta.dirname, "..", "..");
const electronBinary = createRequire(import.meta.url)("electron");
const shots = process.env.LUCIDFRAME_SCREENSHOTS;

describe("desktop app", { timeout: 300_000 }, () => {
  let dir;
  let app;
  let page;
  let input;

  before(async () => {
    dir = tmpDir();
    input = path.join(dir, "holiday photo.png");
    await sharp(patternRGB(96, 72), { raw: { width: 96, height: 72, channels: 3 } }).png().toFile(input);
    const userData = path.join(dir, "userdata");
    app = await electron.launch({
      executablePath: electronBinary,
      args: [...sandboxFlags(electronBinary), `--user-data-dir=${userData}`, root, input],
      env: { ...process.env, LUCIDFRAME_DEVICE: "cpu", LUCIDFRAME_LOG_LEVEL: "error" },
    });
    page = await app.firstWindow();
    await page.setViewportSize({ width: 1240, height: 820 });
  });

  after(async () => {
    await app?.close().catch(() => {});
    rm(dir);
  });

  const shot = async (name) => shots && (fs.mkdirSync(shots, { recursive: true }), page.screenshot({ path: path.join(shots, `${name}.png`) }));

  it("starts, shows hardware, and picks up the file the OS opened it with", async () => {
    await page.waitForSelector(".sidebar");
    await page.waitForSelector(".row .row-name");
    assert.equal(await page.textContent(".row .row-name"), "holiday photo.png");
    await page.waitForFunction(() => !document.querySelector(".device .spinner"), null, { timeout: 60_000 });
    assert.equal((await page.textContent(".device")).trim(), "CPU");
    await shot("1-loaded");
  });

  it("has no filter controls any more", async () => {
    const text = (await page.textContent("body")).toLowerCase();
    for (const gone of ["brightness", "contrast", "saturation", "exposure", "sharpen", "denoise", "text-safe", "auto-enhance", "backend url", "tone preset"]) {
      assert.ok(!text.includes(gone), `UI still mentions "${gone}"`);
    }
  });

  it("lets the user choose a model, shows the result size, and keeps the sandbox tight", async () => {
    await page.getByText("Fast", { exact: true }).first().click();
    await page.waitForSelector(".segmented label.checked");
    assert.equal((await page.textContent(".segmented label.checked")).trim(), "2×");
    await page.waitForSelector(".sidebar .hint");
    assert.match(await page.textContent(".sidebar"), /96 × 72 → 192 × 144/);
    const env = await page.evaluate(() => ({ require: typeof require, process: typeof process, lucid: Object.keys(window.lucid).sort().join(",") }));
    assert.equal(env.require, "undefined");
    assert.equal(env.process, "undefined");
    assert.ok(env.lucid.includes("start") && !env.lucid.includes("readFile"));
  });

  it("upscales the file and shows an interactive before/after comparison", async () => {
    await page.getByRole("button", { name: /Upscale 1 file/ }).click();
    await page.waitForSelector(".compare", { timeout: 120_000 });
    const out = path.join(dir, "holiday photo_lucid_2x.png");
    assert.ok(fs.existsSync(out), "output file not written next to the original");
    const meta = await sharp(out).metadata();
    assert.deepEqual([meta.width, meta.height], [192, 144]);
    assert.match(await page.textContent(".result-bar"), /96 × 72\s*→\s*192 × 144/);
    // both images actually loaded through the lucid:// media protocol
    const loaded = await page.evaluate(() => [...document.querySelectorAll(".compare-img")].map((i) => i.complete && i.naturalWidth > 0));
    assert.deepEqual(loaded, [true, true]);
    await shot("2-compare");
  });

  it("the comparison divider moves with the keyboard and zoom works", async () => {
    const handle = page.getByRole("slider", { name: "Comparison divider" });
    assert.equal(await handle.getAttribute("aria-valuenow"), "50");
    await handle.focus();
    await page.keyboard.press("Home");
    assert.equal(await handle.getAttribute("aria-valuenow"), "0");
    await page.keyboard.press("End");
    assert.equal(await handle.getAttribute("aria-valuenow"), "100");
    const before = await page.textContent(".zoom-readout");
    await page.getByRole("button", { name: "Zoom in" }).click();
    assert.notEqual(await page.textContent(".zoom-readout"), before);
    await page.getByRole("button", { name: "Fit to window" }).click();
    assert.equal(await page.textContent(".zoom-readout"), before);
  });

  it("serves media only through issued tokens and refuses everything else", async () => {
    const results = await page.evaluate(async () => {
      const probe = (url) =>
        new Promise((resolve) => {
          const img = new Image();
          img.onload = () => resolve("loaded");
          img.onerror = () => resolve("refused");
          img.src = url;
        });
      const get = async (url) => {
        try {
          return (await fetch(url)).status;
        } catch {
          return "blocked";
        }
      };
      const issued = document.querySelector(".compare-img").src;
      return {
        issuedToken: await probe(issued),
        guessedToken: await probe("lucid://media/00000000000000000000000000000000"),
        traversal: await get("lucid://app/..%2f..%2fpackage.json"),
        fileScheme: await get("file:///etc/passwd"),
        remote: await get("https://example.com/"),
        remoteImage: await probe("https://example.com/x.png"),
        mediaFetch: await get(issued), // media is for <img>/<video> only, not scriptable fetch
      };
    });
    assert.equal(results.issuedToken, "loaded");
    assert.equal(results.guessedToken, "refused");
    assert.ok([403, 404, "blocked"].includes(results.traversal), `traversal → ${results.traversal}`);
    assert.equal(results.fileScheme, "blocked", "file:// must be blocked by CSP");
    assert.equal(results.remote, "blocked", "remote fetch must be blocked by CSP");
    assert.equal(results.remoteImage, "refused", "remote images must be blocked by CSP");
    assert.equal(results.mediaFetch, "blocked");
  });
});

describe("restore options in the app", { timeout: 300_000 }, () => {
  let dir;
  let app;
  let page;

  before(async () => {
    dir = tmpDir();
    // a small, heavily compressed portrait: needs cleanup, and has a small face to restore
    const input = path.join(dir, "old portrait.jpg");
    await sharp(path.join(import.meta.dirname, "..", "fixtures", "portrait.jpg")).resize(160).jpeg({ quality: 15 }).toFile(input);
    app = await electron.launch({
      executablePath: electronBinary,
      args: [...sandboxFlags(electronBinary), `--user-data-dir=${path.join(dir, "userdata")}`, root, input],
      env: { ...process.env, LUCIDFRAME_DEVICE: "cpu", LUCIDFRAME_LOG_LEVEL: "error" },
    });
    page = await app.firstWindow();
    await page.setViewportSize({ width: 1240, height: 900 });
  });

  after(async () => {
    await app?.close().catch(() => {});
    rm(dir);
  });

  const checked = async (group) => (await page.getByRole("radiogroup", { name: group }).locator("label.checked").textContent()).trim();

  it("offers both restore stages, on Auto by default", async () => {
    await page.waitForSelector(".row .row-name");
    assert.equal(await checked("Clean up blur and compression"), "Auto");
    assert.equal(await checked("Restore faces"), "Auto");
    // The explanation lives behind the "i" next to the heading rather than in a paragraph under each option.
    assert.doesNotMatch(await page.textContent(".sidebar"), /It invents detail/);
    await page.getByRole("button", { name: "About Restore" }).click();
    assert.match(await page.locator(".popover").textContent(), /It invents detail, so a likeness can change slightly/);
    await page.keyboard.press("Escape");
    assert.equal(await page.locator(".popover").count(), 0);
  });

  it("cleans up the compression and restores the face, and says so", async () => {
    await page.getByText("Fast", { exact: true }).first().click(); // 2×, keeps the test quick
    await page.getByRole("button", { name: /Upscale 1 file/ }).click();
    await page.waitForSelector(".compare", { timeout: 180_000 });
    const chips = await page.locator(".chips .chip").allTextContents();
    assert.ok(chips.some((c) => /Compression blocks removed|Blocks and blur cleaned up/.test(c)), `chips: ${chips}`);
    assert.ok(chips.some((c) => /1 face restored/.test(c)), `chips: ${chips}`);
  });

  it("switching a stage off reaches the engine: the chip disappears on the next run", async () => {
    await page.getByRole("radiogroup", { name: "Restore faces" }).getByText("Off", { exact: true }).click();
    await page.getByRole("radiogroup", { name: "Clean up blur and compression" }).getByText("Off", { exact: true }).click();
    await page.getByRole("button", { name: "Redo" }).click();
    // the run is quick, so wait for the end state rather than for the progress card
    await page.waitForFunction(() => !document.querySelector(".chips") && document.querySelector(".compare") && !document.querySelector(".progress-card"), null, { timeout: 180_000 });
    await page.waitForTimeout(1000);
    assert.equal(await page.locator(".chips .chip").count(), 0);
    assert.ok(await page.locator(".compare").isVisible(), "the second run must have produced a comparison");
  });
});
