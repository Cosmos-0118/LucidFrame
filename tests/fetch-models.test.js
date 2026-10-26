// The model downloader, against a local HTTP server standing in for the GitHub release.

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { baseUrlFor, ensureModels, hashFile } from "../src/engine/fetch-models.js";
import { rm, tmpDir } from "./helpers.js";

const sha = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

describe("model downloader", () => {
  const files = {
    "a.onnx": crypto.randomBytes(300_000),
    "b.onnx": crypto.randomBytes(120_000),
    "c.onnx": crypto.randomBytes(5_000),
  };
  let server;
  let base;
  let dir;
  let hits;
  let behaviour; // per-test hooks for the server

  const manifest = () => ({
    version: 4,
    release: "models-test",
    models: [
      { id: "a", file: "a.onnx", size: files["a.onnx"].length, sha256: sha(files["a.onnx"]) },
      { id: "b", file: "b.onnx", size: files["b.onnx"].length, sha256: sha(files["b.onnx"]) },
    ],
    tools: [{ id: "c", role: "cleanup", file: "c.onnx", size: files["c.onnx"].length, sha256: sha(files["c.onnx"]) }],
  });

  before(async () => {
    server = http.createServer((req, res) => {
      const name = decodeURIComponent(req.url.split("/").pop());
      hits.push(name);
      const custom = behaviour(name, hits.filter((h) => h === name).length, res);
      if (custom === "handled") return;
      const body = custom ?? files[name];
      if (!body) {
        res.writeHead(404).end("nope");
        return;
      }
      res.writeHead(200, { "Content-Length": body.length });
      res.end(body);
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${server.address().port}/dl`;
  });
  after(() => server.close());

  beforeEach(() => {
    dir = tmpDir();
    fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest()));
    hits = [];
    behaviour = () => undefined;
  });
  afterEach(() => rm(dir));

  const run = (extra = {}) => ensureModels({ dir, baseUrl: base, backoffMs: 5, ...extra });
  const onDisk = (n) => fs.readFileSync(path.join(dir, n));

  it("downloads every missing file, verified and complete", async () => {
    const progress = [];
    const states = [];
    const r = await run({ onProgress: (p) => progress.push(p), onFile: (e) => states.push(`${e.file}:${e.state}`) });
    assert.deepEqual(r.downloaded.sort(), ["a.onnx", "b.onnx", "c.onnx"]);
    for (const [n, buf] of Object.entries(files)) assert.ok(onDisk(n).equals(buf), `${n} content`);
    assert.ok(progress.some((p) => p.file === "a.onnx" && p.received === p.total), "progress must reach 100%");
    assert.ok(states.includes("a.onnx:done"));
    assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith(".download")), [], "no temporary files left");
  });

  it("does not touch the network when everything is already there", async () => {
    for (const [n, buf] of Object.entries(files)) fs.writeFileSync(path.join(dir, n), buf);
    const r = await run();
    assert.deepEqual(r.downloaded, []);
    assert.equal(r.present.length, 3);
    assert.deepEqual(hits, []);
  });

  it("replaces a truncated file and fetches only what it needs", async () => {
    fs.writeFileSync(path.join(dir, "a.onnx"), files["a.onnx"].subarray(0, 1000));
    fs.writeFileSync(path.join(dir, "b.onnx"), files["b.onnx"]);
    await run();
    assert.deepEqual(hits.sort(), ["a.onnx", "c.onnx"]);
    assert.ok(onDisk("a.onnx").equals(files["a.onnx"]));
  });

  it("with verify, also replaces a same-size file whose contents are wrong", async () => {
    const bad = Buffer.from(files["b.onnx"]);
    bad[10] ^= 0xff;
    for (const n of ["a.onnx", "c.onnx"]) fs.writeFileSync(path.join(dir, n), files[n]);
    fs.writeFileSync(path.join(dir, "b.onnx"), bad);
    assert.deepEqual((await run()).downloaded, [], "a size-only check cannot see this");
    assert.deepEqual((await run({ verify: true })).downloaded, ["b.onnx"]);
    assert.ok(onDisk("b.onnx").equals(files["b.onnx"]));
  });

  it("refuses a file with the wrong hash and never puts it in place", async () => {
    const evil = Buffer.from(files["c.onnx"]);
    evil[0] ^= 1;
    behaviour = (name) => (name === "c.onnx" ? evil : undefined);
    await assert.rejects(run(), /integrity check/);
    assert.equal(fs.existsSync(path.join(dir, "c.onnx")), false);
    assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith(".download")), []);
    assert.equal(hits.filter((h) => h === "c.onnx").length, 1, "a tampered file is not retried");
  });

  it("retries a server error and then succeeds", async () => {
    behaviour = (name, count, res) => {
      if (name === "b.onnx" && count < 3) {
        res.writeHead(503).end();
        return "handled";
      }
    };
    await run();
    assert.equal(hits.filter((h) => h === "b.onnx").length, 3);
    assert.ok(onDisk("b.onnx").equals(files["b.onnx"]));
  });

  it("retries when a download is cut short, and gives up after the retry limit", async () => {
    behaviour = (name, count, res) => {
      if (name === "c.onnx") {
        res.writeHead(200, { "Content-Length": files["c.onnx"].length });
        res.write(files["c.onnx"].subarray(0, 100));
        res.destroy(); // connection drops mid-file
        return "handled";
      }
    };
    await assert.rejects(run({ retries: 2 }), /interrupted|arrived with|could not reach/);
    assert.equal(hits.filter((h) => h === "c.onnx").length, 2);
    assert.equal(fs.existsSync(path.join(dir, "c.onnx")), false);
  });

  it("explains a missing release instead of retrying", async () => {
    behaviour = (name) => (name === "a.onnx" ? null : undefined);
    server.once("request", () => {});
    const originalFiles = files["a.onnx"];
    delete files["a.onnx"];
    try {
      behaviour = () => undefined;
      await assert.rejects(run(), /was not found at .*release may not be published/);
      assert.equal(hits.filter((h) => h === "a.onnx").length, 1, "404 is final");
    } finally {
      files["a.onnx"] = originalFiles;
    }
  });

  it("refuses a body bigger than the manifest says", async () => {
    behaviour = (name) => (name === "c.onnx" ? Buffer.concat([files["c.onnx"], Buffer.alloc(50)]) : undefined);
    await assert.rejects(run(), /larger than the manifest|arrived with|interrupted/);
    assert.equal(fs.existsSync(path.join(dir, "c.onnx")), false);
  });

  it("removes leftovers of an interrupted earlier run", async () => {
    fs.writeFileSync(path.join(dir, "a.onnx.download"), "half a file");
    await run();
    assert.equal(fs.existsSync(path.join(dir, "a.onnx.download")), false);
  });

  it("can be cancelled", async () => {
    const ctl = new AbortController();
    behaviour = (name, count, res) => {
      ctl.abort(new DOMException("cancelled", "AbortError"));
    };
    await assert.rejects(run({ signal: ctl.signal }), (err) => err.name === "AbortError" || /abort|cancel/i.test(err.message));
    assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith(".download")), []);
  });

  it("builds the default URL from the manifest's release, honours a mirror, and hashes files", async () => {
    assert.equal(baseUrlFor({ release: "models-3" }, ""), "https://github.com/Cosmos-0118/LucidFrame/releases/download/models-3");
    assert.equal(baseUrlFor({ release: "x" }, "https://mirror.example/m/"), "https://mirror.example/m");
    assert.throws(() => baseUrlFor({}, ""), /names no release/);
    const f = path.join(dir, "c.onnx");
    fs.writeFileSync(f, files["c.onnx"]);
    assert.equal(await hashFile(f), sha(files["c.onnx"]));
  });

  it("reads LUCIDFRAME_MODELS_URL when no URL is passed", async () => {
    process.env.LUCIDFRAME_MODELS_URL = base;
    try {
      const r = await ensureModels({ dir, backoffMs: 5 });
      assert.equal(r.downloaded.length, 3);
    } finally {
      delete process.env.LUCIDFRAME_MODELS_URL;
    }
  });
});

describe("the shipped manifest", () => {
  it("names a release and lists sizes and hashes for every file", () => {
    const m = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "..", "models", "manifest.json"), "utf8"));
    assert.match(m.release, /^models-\d+$/);
    for (const e of [...m.models, ...m.tools]) {
      assert.ok(Number.isInteger(e.size) && e.size > 0, e.id);
      assert.match(e.sha256, /^[0-9a-f]{64}$/, e.id);
    }
  });
});
