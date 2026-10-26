// `npm start`: build the UI if it is missing or stale, then launch the desktop app.
// This is the whole "start the backend and the frontend" story: there is only one thing to start.

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { sandboxFlags } from "../src/main/sandbox.js";

const root = path.resolve(import.meta.dirname, "..");
const require = createRequire(import.meta.url);
const distIndex = path.join(root, "dist", "renderer", "index.html");

function newestMtime(dir) {
  let newest = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    newest = Math.max(newest, entry.isDirectory() ? newestMtime(full) : fs.statSync(full).mtimeMs);
  }
  return newest;
}

const stale = !fs.existsSync(distIndex) || fs.statSync(distIndex).mtimeMs < newestMtime(path.join(root, "src", "renderer"));
if (stale) {
  console.log("Building the interface…");
  const { build } = await import("vite");
  await build({ configFile: path.join(root, "src", "renderer", "vite.config.js"), logLevel: "warn" });
}

let electron;
try {
  electron = require("electron");
} catch {
  console.error("Electron is not installed. Run `npm install` first.");
  process.exit(1);
}
if (typeof electron !== "string" || !fs.existsSync(electron)) {
  console.error("The Electron binary is missing (its download was probably interrupted). Run `npm install` again, or `node node_modules/electron/install.js`.");
  process.exit(1);
}

// Chromium refuses to start without its sandbox in containers (root) and on Ubuntu 23.10+; add the flag only then.
const child = spawn(electron, [...sandboxFlags(electron), root, ...process.argv.slice(2)], { stdio: "inherit", env: { ...process.env, ELECTRON_ENABLE_LOGGING: process.env.ELECTRON_ENABLE_LOGGING ?? "" } });
child.on("exit", (code, signal) => process.exit(signal ? 1 : (code ?? 0)));
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => child.kill(sig));
