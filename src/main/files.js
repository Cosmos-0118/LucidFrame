// The set of files the UI is allowed to touch. The renderer never gets raw filesystem access: it
// refers to inputs by id and to media (previews, results) by unguessable token, and the main
// process only honours ids/tokens it issued itself.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { detectKind } from "../engine/kinds.js";

const MAX_FOLDER_FILES = 500;

export const MIME = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".avif": "image/avif",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".mkv": "video/x-matroska",
};

export class FileRegistry {
  #items = new Map(); // id → item
  #byPath = new Map(); // path → id
  #media = new Map(); // token → absolute path
  #mediaByPath = new Map(); // absolute path → token
  #known = new Set(); // every path we have issued something for

  /** @returns {{items: object[], rejected: {path:string, reason:string}[]}} */
  register(paths) {
    const items = [];
    const rejected = [];
    const queue = [];
    for (const p of paths) {
      if (typeof p !== "string" || !path.isAbsolute(p)) {
        rejected.push({ path: String(p), reason: "not an absolute path" });
        continue;
      }
      let stat;
      try {
        stat = fs.statSync(p);
      } catch {
        rejected.push({ path: p, reason: "file not found" });
        continue;
      }
      if (stat.isDirectory()) {
        try {
          const entries = fs
            .readdirSync(p, { withFileTypes: true })
            .filter((e) => e.isFile() && !e.name.startsWith("."))
            .map((e) => path.join(p, e.name))
            .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
          queue.push(...entries.slice(0, MAX_FOLDER_FILES));
          if (entries.length > MAX_FOLDER_FILES) rejected.push({ path: p, reason: `folder has more than ${MAX_FOLDER_FILES} files; only the first ${MAX_FOLDER_FILES} were added` });
        } catch {
          rejected.push({ path: p, reason: "folder cannot be read" });
        }
      } else queue.push(p);
    }

    for (const p of new Set(queue)) {
      let stat;
      try {
        stat = fs.statSync(p);
      } catch {
        rejected.push({ path: p, reason: "file not found" });
        continue;
      }
      const kind = detectKind(p);
      if (!stat.isFile() || !kind) {
        // Folder contents that aren't media are skipped silently; explicit files get a message.
        if (paths.includes(p)) rejected.push({ path: p, reason: "not an image or video file" });
        continue;
      }
      let id = this.#byPath.get(p);
      if (!id) {
        id = crypto.randomUUID();
        this.#byPath.set(p, id);
        this.#known.add(p);
      }
      const item = { id, path: p, name: path.basename(p), kind, size: stat.size };
      this.#items.set(id, item);
      items.push({ ...item, sourceUrl: this.mediaUrl(p) });
    }
    return { items, rejected };
  }

  get(id) {
    return this.#items.get(id);
  }

  /** Allow the UI to display/reveal a file we produced. */
  allow(file) {
    this.#known.add(path.resolve(file));
  }

  isKnown(file) {
    return this.#known.has(path.resolve(file));
  }

  mediaUrl(file) {
    const abs = path.resolve(file);
    this.#known.add(abs);
    let token = this.#mediaByPath.get(abs);
    if (!token) {
      token = crypto.randomBytes(16).toString("hex");
      this.#mediaByPath.set(abs, token);
      this.#media.set(token, abs);
    }
    return `lucid://media/${token}`;
  }

  mediaPath(token) {
    return this.#media.get(token);
  }
}
