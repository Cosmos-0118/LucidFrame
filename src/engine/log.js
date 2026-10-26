// Tiny leveled logger. Writes to stderr (stdout is reserved for machine output)
// and, when LUCIDFRAME_LOG_FILE is set, to a size-capped file.

import fs from "node:fs";
import path from "node:path";

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const MAX_LOG_BYTES = 2 * 1024 * 1024;

let sink = null;
let sinkPath = null;

function openSink() {
  const file = process.env.LUCIDFRAME_LOG_FILE;
  if (!file) return null;
  if (sink && sinkPath === file) return sink;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    try {
      if (fs.statSync(file).size > MAX_LOG_BYTES) fs.renameSync(file, `${file}.1`);
    } catch {
      /* no log yet */
    }
    sink = fs.createWriteStream(file, { flags: "a" });
    sink.on("error", () => (sink = null));
    sinkPath = file;
  } catch {
    sink = null;
  }
  return sink;
}

function emit(level, args) {
  const threshold = LEVELS[process.env.LUCIDFRAME_LOG_LEVEL] ?? LEVELS.info;
  if (LEVELS[level] < threshold) return;
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${args
    .map((a) => (a instanceof Error ? a.stack || a.message : typeof a === "string" ? a : JSON.stringify(a)))
    .join(" ")}\n`;
  if (process.env.LUCIDFRAME_QUIET !== "1") process.stderr.write(line);
  openSink()?.write(line);
}

export const log = {
  debug: (...a) => emit("debug", a),
  info: (...a) => emit("info", a),
  warn: (...a) => emit("warn", a),
  error: (...a) => emit("error", a),
};
