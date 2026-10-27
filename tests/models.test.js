import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { ModelRegistry, defaultModelsDir, sha256File } from "../src/engine/models.js";
import { rm, tmpDir } from "./helpers.js";

describe("model registry", () => {
  const registry = new ModelRegistry();

  it("ships the four models with licences and attribution", () => {
    const list = registry.list();
    assert.deepEqual(list.map((m) => m.id), ["photo", "anime", "fast", "fast-anime"]);
    for (const m of list) {
      assert.ok(m.available, `${m.id} file missing`);
      assert.equal(m.license, "CC-BY-4.0");
      assert.ok(m.author && m.tagline && m.description);
    }
  });

  it("manifest hashes match the files on disk", async () => {
    for (const m of registry.models) {
      const file = path.join(defaultModelsDir(), m.file);
      assert.equal(fs.statSync(file).size, m.size, `${m.id} size`);
      assert.equal(await sha256File(file), m.sha256, `${m.id} sha256`);
    }
  });

  it("every model is pinned to an upstream revision", () => {
    for (const m of registry.models) {
      assert.match(m.source.revision, /^[0-9a-f]{40}$/);
      assert.match(m.source.sha256, /^[0-9a-f]{64}$/);
    }
  });

  it("ships the restore components with their licences, hashes and licence texts", async () => {
    const tools = registry.listTools();
    assert.deepEqual(tools.map((t) => [t.id, t.role, t.license]), [
      ["dejpeg", "cleanup", "CC-BY-4.0"],
      ["face-detect", "face-detect", "MIT"],
      ["face-restore", "face-restore", "Apache-2.0"],
      ["face-parse", "face-parse", "MIT"],
    ]);
    // each component's licence text is its own licensor's, so they are looked up by component, not by licence name
    const texts = { dejpeg: "CC-BY-4.0.txt", "face-detect": "YuNet-MIT.txt", "face-restore": "RestoreFormerPlusPlus-Apache-2.0.txt", "face-parse": "BiSeNet-face-parsing-MIT.txt" };
    for (const t of registry.tools) {
      assert.ok(tools.find((x) => x.id === t.id).available, `${t.id} file missing`);
      const file = path.join(defaultModelsDir(), t.file);
      assert.equal(fs.statSync(file).size, t.size, `${t.id} size`);
      assert.equal(await sha256File(file), t.sha256, `${t.id} sha256`);
      assert.match(t.source.sha256, /^[0-9a-f]{64}$/);
      assert.ok(t.source.revision && t.source.url.startsWith("https://"), `${t.id} must be pinned to an upstream revision`);
      assert.ok(fs.existsSync(path.join(import.meta.dirname, "..", "licenses", texts[t.id])), `licence text for ${t.id}`);
    }
    // models also under CC BY must have the text shipped
    assert.ok(fs.existsSync(path.join(import.meta.dirname, "..", "licenses", "CC-BY-4.0.txt")));
  });

  it("keeps pipeline stages out of the model list and models out of the stage lookup", () => {
    assert.throws(() => registry.get("dejpeg"), /unknown model "dejpeg"/);
    assert.throws(() => registry.tool("photo"), /missing from the model manifest/);
    assert.equal(registry.list().some((m) => m.id.startsWith("face")), false);
  });

  it("refuses a tampered restore component", async () => {
    const dir = tmpDir();
    try {
      fs.copyFileSync(path.join(defaultModelsDir(), "manifest.json"), path.join(dir, "manifest.json"));
      const src = fs.readFileSync(path.join(defaultModelsDir(), "face-detect.onnx"));
      const reg = new ModelRegistry(dir);
      await assert.rejects(reg.resolveTool("face-detect"), /model file missing/);
      fs.writeFileSync(path.join(dir, "face-detect.onnx"), src.subarray(0, src.length - 4));
      await assert.rejects(reg.resolveTool("face-detect"), /truncated or corrupt/);
      const evil = Buffer.from(src);
      evil[1000] ^= 0xff;
      fs.writeFileSync(path.join(dir, "face-detect.onnx"), evil);
      await assert.rejects(reg.resolveTool("face-detect"), /integrity check/);
      fs.writeFileSync(path.join(dir, "face-detect.onnx"), src);
      assert.ok((await reg.resolveTool("face-detect")).file.endsWith("face-detect.onnx"));
    } finally {
      rm(dir);
    }
  });

  it("rejects unknown ids with the list of valid ones", () => {
    assert.throws(() => registry.get("nope"), /unknown model "nope" \(available: photo, anime, fast, fast-anime\)/);
  });

  it("refuses truncated and tampered model files", async () => {
    const dir = tmpDir();
    try {
      fs.copyFileSync(path.join(defaultModelsDir(), "manifest.json"), path.join(dir, "manifest.json"));
      const src = fs.readFileSync(path.join(defaultModelsDir(), "fast.onnx"));
      const reg = new ModelRegistry(dir);

      await assert.rejects(reg.resolve("fast"), /model file missing/);

      fs.writeFileSync(path.join(dir, "fast.onnx"), src.subarray(0, src.length - 10));
      await assert.rejects(reg.resolve("fast"), /truncated or corrupt/);

      const tampered = Buffer.from(src);
      tampered[1000] ^= 0xff;
      fs.writeFileSync(path.join(dir, "fast.onnx"), tampered);
      await assert.rejects(reg.resolve("fast"), /integrity check/);

      fs.writeFileSync(path.join(dir, "fast.onnx"), src);
      const { file } = await reg.resolve("fast");
      assert.equal(file, path.join(dir, "fast.onnx"));
    } finally {
      rm(dir);
    }
  });

  it("explains a missing or broken manifest", () => {
    const dir = tmpDir();
    try {
      assert.throws(() => new ModelRegistry(dir), /cannot read model manifest/);
      fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ models: [] }));
      assert.throws(() => new ModelRegistry(dir), /lists no models/);
    } finally {
      rm(dir);
    }
  });
});
