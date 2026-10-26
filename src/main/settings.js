// Tiny validated settings store (userData/settings.json). Only known keys with valid values are
// accepted, whatever the renderer sends, and writes are atomic so a crash can't corrupt the file.

import fs from "node:fs";
import path from "node:path";

const DEFAULTS = Object.freeze({ outputDir: null });

function isUsableDir(dir) {
  try {
    return path.isAbsolute(dir) && fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

export function createSettings(file) {
  let state = { ...DEFAULTS };
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    if (typeof raw.outputDir === "string" && isUsableDir(raw.outputDir)) state.outputDir = raw.outputDir;
  } catch {
    /* first run or unreadable: defaults */
  }

  return {
    get: () => ({ ...state }),
    /** @param {{outputDir?: string|null}} patch */
    set(patch) {
      if (patch && "outputDir" in patch) {
        if (patch.outputDir === null) state.outputDir = null;
        else if (typeof patch.outputDir === "string" && isUsableDir(patch.outputDir)) state.outputDir = patch.outputDir;
        else throw new Error("outputDir must be an existing folder");
      }
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const tmp = `${file}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
        fs.renameSync(tmp, file);
      } catch {
        /* settings are a convenience; never fail the app over them */
      }
      return { ...state };
    },
  };
}
