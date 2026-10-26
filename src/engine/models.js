// Model registry. Models ship with the app (models/*.onnx + manifest.json), so
// there is nothing to download and everything works offline. Each file is
// checked against the manifest hash before first use, so a truncated or
// tampered file fails loudly instead of producing garbage.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { log } from "./log.js";

const here = path.dirname(fileURLToPath(import.meta.url));

export function defaultModelsDir() {
  if (process.env.LUCIDFRAME_MODELS) return path.resolve(process.env.LUCIDFRAME_MODELS);
  const dev = path.resolve(here, "..", "..", "models");
  if (fs.existsSync(path.join(dev, "manifest.json"))) return dev;
  // Packaged app: electron-builder copies models/ to <resources>/models.
  if (process.resourcesPath) return path.join(process.resourcesPath, "models");
  return dev;
}

export class ModelRegistry {
  #verified = new Map(); // id → `${size}:${mtimeMs}` that passed the hash check

  constructor(dir = defaultModelsDir()) {
    this.dir = dir;
    const manifestPath = path.join(dir, "manifest.json");
    let manifest;
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    } catch (err) {
      throw new Error(`cannot read model manifest at ${manifestPath}: ${err.message}`);
    }
    if (!Array.isArray(manifest.models) || manifest.models.length === 0) {
      throw new Error(`model manifest at ${manifestPath} lists no models`);
    }
    this.models = manifest.models;
    /** Pipeline stages (JPEG cleanup, face detector, face restorer): never offered as upscalers. */
    this.tools = Array.isArray(manifest.tools) ? manifest.tools : [];
  }

  list() {
    return this.models.map((m) => ({
      id: m.id,
      name: m.name,
      tagline: m.tagline,
      description: m.description,
      kind: m.kind,
      scale: m.scale,
      license: m.license,
      author: m.author,
      available: fs.existsSync(path.join(this.dir, m.file)),
    }));
  }

  /** The restore pipeline's stages, with whether their files are present. */
  listTools() {
    return this.tools.map((t) => ({
      id: t.id,
      role: t.role,
      name: t.name,
      license: t.license,
      author: t.author,
      available: fs.existsSync(path.join(this.dir, t.file)),
    }));
  }

  /** An upscaler by id. Pipeline stages are looked up with `tool()` so a stage can never be picked as a model. */
  get(id) {
    const model = this.models.find((m) => m.id === id);
    if (!model) {
      throw new Error(`unknown model "${id}" (available: ${this.models.map((m) => m.id).join(", ")})`);
    }
    return model;
  }

  tool(id) {
    const tool = this.tools.find((t) => t.id === id);
    if (!tool) throw new Error(`the "${id}" component is missing from the model manifest — reinstall LucidFrame`);
    return tool;
  }

  /** Absolute path to a model file after verifying its integrity. */
  async resolve(id) {
    return this.#verify(id, this.get(id));
  }

  /** Same for a pipeline stage. */
  async resolveTool(id) {
    return this.#verify(id, this.tool(id));
  }

  async #verify(id, model) {
    const file = path.join(this.dir, model.file);
    let stat;
    try {
      stat = await fs.promises.stat(file);
    } catch {
      throw new Error(`model file missing: ${file} — run \`npm run models\` (or reinstall LucidFrame)`);
    }
    const stamp = `${stat.size}:${stat.mtimeMs}`;
    if (this.#verified.get(id) !== stamp) {
      if (stat.size !== model.size) {
        throw new Error(`model ${id} is ${stat.size} bytes, expected ${model.size} — file is truncated or corrupt`);
      }
      const digest = await sha256File(file);
      if (digest !== model.sha256) {
        throw new Error(`model ${id} failed its integrity check (sha256 mismatch) — file is corrupt or modified — run \`npm run models -- --verify\``);
      }
      this.#verified.set(id, stamp);
      log.debug(`verified ${id}`);
    }
    return { model, file };
  }
}

export function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    fs.createReadStream(file)
      .on("data", (c) => hash.update(c))
      .on("end", () => resolve(hash.digest("hex")))
      .on("error", reject);
  });
}
