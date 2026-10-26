import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";
import { CSP, isSafeExternalUrl, parseRange, safeJoin, validateStart } from "../src/main/validate.js";
import { FileRegistry } from "../src/main/files.js";
import { createSettings } from "../src/main/settings.js";
import { rm, tmpDir } from "./helpers.js";
import fs from "node:fs";

const models = [{ id: "photo" }, { id: "fast" }];

describe("validateStart", () => {
  const ok = { itemId: "abc", model: "photo", scale: 4 };
  it("accepts a good request and fills defaults", () => {
    assert.deepEqual(validateStart(ok, { models }), { itemId: "abc", model: "photo", scale: 4, format: "auto", smooth: false });
  });
  it("rejects everything else", () => {
    for (const bad of [null, "x", 5, {}, { ...ok, model: "../../etc/passwd" }, { ...ok, model: "nope" }, { ...ok, scale: 5 }, { ...ok, scale: "4" }, { ...ok, format: "exe" }, { ...ok, smooth: "yes" }, { ...ok, itemId: 7 }, { ...ok, itemId: "x".repeat(100) }]) {
      assert.throws(() => validateStart(bad, { models }), TypeError, JSON.stringify(bad));
    }
  });
});

describe("parseRange", () => {
  it("handles the shapes browsers send", () => {
    assert.equal(parseRange(undefined, 100), null);
    assert.deepEqual(parseRange("bytes=0-", 100), { start: 0, end: 99 });
    assert.deepEqual(parseRange("bytes=10-19", 100), { start: 10, end: 19 });
    assert.deepEqual(parseRange("bytes=90-500", 100), { start: 90, end: 99 });
    assert.deepEqual(parseRange("bytes=-10", 100), { start: 90, end: 99 });
  });
  it("rejects malformed or unsatisfiable ranges", () => {
    for (const h of ["bytes=100-", "bytes=5-2", "bytes=-", "bytes=-0", "items=0-5", "bytes=0-5,10-20", "garbage"]) assert.equal(parseRange(h, 100), "invalid", h);
  });
});

describe("safeJoin (no path traversal out of the app directory)", () => {
  const root = path.resolve("/srv/app/dist");
  it("serves normal assets and the index", () => {
    assert.equal(safeJoin(root, "/"), path.join(root, "index.html"));
    assert.equal(safeJoin(root, "/assets/a.js"), path.join(root, "assets", "a.js"));
  });
  it("blocks traversal, encoded traversal and NUL bytes", () => {
    for (const p of ["/../secret", "/..%2fsecret", "/%2e%2e/secret", "/assets/../../x", "/a%00b", "/%", "//..//..//etc/passwd"]) {
      const r = safeJoin(root, p);
      assert.ok(r === null || r.startsWith(root + path.sep), `${p} → ${r}`);
    }
    assert.equal(safeJoin(root, "/..%2fsecret"), null);
    assert.equal(safeJoin(root, "/a%00b"), null);
    assert.equal(safeJoin(root, "/%"), null);
  });
});

describe("isSafeExternalUrl", () => {
  it("only allows the project's own https pages", () => {
    assert.equal(isSafeExternalUrl("https://github.com/Cosmos-0118/LucidFrame"), true);
    assert.equal(isSafeExternalUrl("https://github.com/Cosmos-0118/LucidFrame/releases"), true);
    for (const u of ["http://github.com/Cosmos-0118/LucidFrame", "https://github.com/Cosmos-0118/LucidFrame-evil", "https://evil.com/https://github.com/Cosmos-0118/LucidFrame", "file:///etc/passwd", "javascript:alert(1)", "https://github.com.evil.com/Cosmos-0118/LucidFrame", "nonsense"]) {
      assert.equal(isSafeExternalUrl(u), false, u);
    }
  });
});

describe("CSP", () => {
  it("forbids remote code, inline script and frames", () => {
    assert.match(CSP, /default-src 'none'/);
    assert.match(CSP, /script-src 'self'(;|$)/);
    assert.doesNotMatch(CSP, /unsafe-inline|unsafe-eval|https?:/);
  });
});

describe("FileRegistry", () => {
  it("issues ids and tokens only for real media, and expands folders", () => {
    const dir = tmpDir();
    try {
      fs.writeFileSync(path.join(dir, "a.png"), "x");
      fs.writeFileSync(path.join(dir, "b.MP4"), "x");
      fs.writeFileSync(path.join(dir, "notes.txt"), "x");
      fs.writeFileSync(path.join(dir, ".hidden.png"), "x");
      const reg = new FileRegistry();
      const { items, rejected } = reg.register([dir, path.join(dir, "notes.txt"), path.join(dir, "gone.png"), "relative.png", 42]);
      assert.deepEqual(items.map((i) => [i.name, i.kind]), [["a.png", "image"], ["b.MP4", "video"]]);
      assert.equal(rejected.length, 4);
      assert.match(items[0].sourceUrl, /^lucid:\/\/media\/[0-9a-f]{32}$/);
      assert.equal(reg.mediaPath(items[0].sourceUrl.split("/").pop()), path.join(dir, "a.png"));
      assert.equal(reg.mediaPath("../../etc/passwd"), undefined);
      assert.equal(reg.get(items[0].id).path, path.join(dir, "a.png"));
      assert.equal(reg.isKnown(path.join(dir, "notes.txt")), false);
      // same file → same id, same token
      assert.equal(reg.register([path.join(dir, "a.png")]).items[0].id, items[0].id);
    } finally {
      rm(dir);
    }
  });
});

describe("settings store", () => {
  it("persists valid values and refuses bad ones", () => {
    const dir = tmpDir();
    try {
      const file = path.join(dir, "settings.json");
      const s = createSettings(file);
      assert.deepEqual(s.get(), { outputDir: null });
      assert.deepEqual(s.set({ outputDir: dir }), { outputDir: dir });
      assert.deepEqual(createSettings(file).get(), { outputDir: dir });
      assert.throws(() => s.set({ outputDir: "relative/dir" }), /existing folder/);
      assert.throws(() => s.set({ outputDir: path.join(dir, "missing") }), /existing folder/);
      assert.throws(() => s.set({ outputDir: 5 }), /existing folder/);
      s.set({ outputDir: null });
      assert.deepEqual(createSettings(file).get(), { outputDir: null });
      // a folder that disappeared is dropped on load instead of breaking every job
      s.set({ outputDir: dir });
      fs.rmSync(file + ".gone", { force: true });
      const gone = path.join(dir, "gone");
      fs.mkdirSync(gone);
      s.set({ outputDir: gone });
      fs.rmdirSync(gone);
      assert.deepEqual(createSettings(file).get(), { outputDir: null });
      fs.writeFileSync(file, "{ broken json");
      assert.deepEqual(createSettings(file).get(), { outputDir: null });
    } finally {
      rm(dir);
    }
  });
});
