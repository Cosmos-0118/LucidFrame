import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import { rm, tmpDir, writePattern } from "./helpers.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(root, "bin", "lucidframe.js");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));

function run(args, { env = {} } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, ...args], { env: { ...process.env, LUCIDFRAME_DEVICE: "cpu", LUCIDFRAME_LOG_LEVEL: "error", ...env } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

describe("command line", () => {
  let dir;
  before(() => (dir = tmpDir()));
  after(() => rm(dir));

  it("prints its version and help", async () => {
    assert.equal((await run(["--version"])).stdout.trim(), pkg.version);
    const help = await run(["--help"]);
    assert.equal(help.code, 0);
    assert.match(help.stdout, /lucidframe <file...>/);
    assert.equal((await run([])).code, 2, "no arguments is a usage error");
  });

  it("lists models as JSON", async () => {
    const { code, stdout } = await run(["models", "--json"]);
    assert.equal(code, 0);
    assert.deepEqual(JSON.parse(stdout).map((m) => m.id), ["photo", "anime", "fast", "fast-anime"]);
  });

  it("doctor verifies models, inference, codecs and ffmpeg", async () => {
    const { code, stdout } = await run(["doctor", "--json"]);
    const report = JSON.parse(stdout);
    assert.equal(code, 0, stdout);
    assert.equal(report.ok, true);
    assert.deepEqual(report.checks.map((c) => c.name), ["models", "inference", "restore pipeline", "image codec", "ffmpeg"]);
  });

  it("upscales an image and reports machine-readable results", async () => {
    const input = await writePattern(path.join(dir, "in.png"), 40, 30);
    const outDir = path.join(dir, "out");
    const { code, stdout } = await run([input, "-m", "fast", "-s", "2", "--out-dir", outDir, "--json"]);
    assert.equal(code, 0, stdout);
    const res = JSON.parse(stdout);
    assert.equal(res.ok, true);
    assert.equal(res.results[0].width, 80);
    assert.ok(fs.existsSync(path.join(outDir, "in_lucid_2x.png")));
  });

  it("defaults the scale to the model's native scale and honours --output", async () => {
    const input = await writePattern(path.join(dir, "d.png"), 16, 16);
    const out = path.join(dir, "exact.webp");
    const { code, stdout } = await run([input, "-m", "photo", "-o", out, "--json"]);
    assert.equal(code, 0, stdout);
    assert.equal(JSON.parse(stdout).results[0].width, 64);
    assert.ok(fs.existsSync(out));
  });

  it("fails with a clear message and exit code 1 on bad input", async () => {
    const input = await writePattern(path.join(dir, "e.png"), 8, 8);
    let r = await run([input, "-m", "bogus"]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /unknown model "bogus"/);

    fs.writeFileSync(path.join(dir, "notes.txt"), "hi");
    r = await run([path.join(dir, "notes.txt")]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /not a supported image or video/);

    r = await run([input, input, "-o", path.join(dir, "x.png")]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /--output can only be used with a single input/);

    r = await run([input, "-s", "7", "-m", "fast"]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /scale must be one of/);

    r = await run([path.join(dir, "missing.png")]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /does not exist/);

    r = await run([input], { env: { LUCIDFRAME_DEVICE: "toaster" } });
    assert.notEqual(r.code, 0);
  });
});
