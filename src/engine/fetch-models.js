// Fetches the model files that are not stored in git.
//
// The converted ONNX files (about 180 MB) are published as assets of a GitHub release named in
// models/manifest.json ("release"), and models/manifest.json pins each file's size and SHA-256. Source checkouts
// download what is missing the first time they need it; installers ship the files and never come here.
//
// A file is only ever put in place after it has been downloaded completely and its hash matches, so a dropped
// connection or a tampered mirror can never leave a half-written or wrong model behind.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { defaultModelsDir } from "./models.js";

export const RELEASE_URL = "https://github.com/Cosmos-0118/LucidFrame/releases/download";

export class ModelDownloadError extends Error {
  constructor(message, { retryable = false } = {}) {
    super(message);
    this.name = "ModelDownloadError";
    this.retryable = retryable;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function readManifest(dir) {
  const file = path.join(dir, "manifest.json");
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    throw new Error(`cannot read model manifest at ${file}: ${err.message}`);
  }
  const entries = [...(manifest.models ?? []), ...(manifest.tools ?? [])];
  if (!entries.length) throw new Error(`model manifest at ${file} lists no models`);
  return { manifest, entries };
}

/** Where the files of a manifest come from. `LUCIDFRAME_MODELS_URL` points at a mirror holding the same file names. */
export function baseUrlFor(manifest, override = process.env.LUCIDFRAME_MODELS_URL) {
  if (override) return override.replace(/\/+$/, "");
  if (!manifest.release) throw new Error("the model manifest names no release to download from");
  return `${RELEASE_URL}/${manifest.release}`;
}

/** Hash a file on disk. */
export function hashFile(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    fs.createReadStream(file)
      .on("data", (chunk) => hash.update(chunk))
      .on("end", () => resolve(hash.digest("hex")))
      .on("error", reject);
  });
}

/** What is on disk for one entry: "ok" (right size, and right hash when `verify`), "wrong" or "missing". */
async function inspect(dir, entry, verify) {
  let stat;
  try {
    stat = await fs.promises.stat(path.join(dir, entry.file));
  } catch {
    return "missing";
  }
  if (stat.size !== entry.size) return "wrong";
  if (verify && (await hashFile(path.join(dir, entry.file))) !== entry.sha256) return "wrong";
  return "ok";
}

async function downloadOnce(url, target, entry, { fetchImpl, signal, onProgress }) {
  let res;
  try {
    res = await fetchImpl(url, { signal, redirect: "follow" });
  } catch (err) {
    if (signal?.aborted) throw err;
    throw new ModelDownloadError(`could not reach ${new URL(url).host}: ${err.cause?.code ?? err.message}`, { retryable: true });
  }
  if (res.status === 404) {
    throw new ModelDownloadError(`${entry.file} was not found at ${url}. The model release may not be published yet, or LUCIDFRAME_MODELS_URL is wrong.`);
  }
  if (!res.ok) throw new ModelDownloadError(`${url} answered ${res.status} ${res.statusText}`, { retryable: res.status >= 500 || res.status === 429 });
  if (!res.body) throw new ModelDownloadError(`${url} sent no data`, { retryable: true });

  const hash = crypto.createHash("sha256");
  let received = 0;
  const meter = new Transform({
    transform(chunk, _enc, cb) {
      received += chunk.length;
      if (received > entry.size) return cb(new ModelDownloadError(`${entry.file} is larger than the manifest says (${entry.size} bytes)`));
      hash.update(chunk);
      onProgress?.({ file: entry.file, received, total: entry.size });
      cb(null, chunk);
    },
  });
  try {
    await pipeline(Readable.fromWeb(res.body), meter, fs.createWriteStream(target), ...(signal ? [{ signal }] : []));
  } catch (err) {
    fs.rmSync(target, { force: true });
    if (signal?.aborted || err instanceof ModelDownloadError) throw err;
    throw new ModelDownloadError(`download of ${entry.file} was interrupted: ${err.message}`, { retryable: true });
  }
  if (received !== entry.size) {
    fs.rmSync(target, { force: true });
    throw new ModelDownloadError(`${entry.file} arrived with ${received} of ${entry.size} bytes`, { retryable: true });
  }
  if (hash.digest("hex") !== entry.sha256) {
    fs.rmSync(target, { force: true });
    throw new ModelDownloadError(`${entry.file} failed its integrity check (sha256 mismatch): refusing to use it`);
  }
}

/**
 * Make sure every model file listed in the manifest is present and complete, downloading what is not.
 *
 * @param {object} [opts]
 * @param {string} [opts.dir] models directory (default: the one the engine uses)
 * @param {string} [opts.baseUrl] where to download from (default: the manifest's release)
 * @param {boolean} [opts.verify] also hash the files that are already there (slower)
 * @param {number} [opts.retries] attempts per file for transient failures
 * @param {number} [opts.concurrency] downloads in parallel
 * @param {AbortSignal} [opts.signal]
 * @param {(p:{file:string,received:number,total:number})=>void} [opts.onProgress]
 * @param {(e:{file:string,state:"present"|"downloading"|"done"})=>void} [opts.onFile]
 * @param {typeof fetch} [opts.fetchImpl]
 * @returns {Promise<{present:string[], downloaded:string[], bytes:number}>}
 */
export async function ensureModels({ dir = defaultModelsDir(), baseUrl, verify = false, retries = 3, concurrency = 2, signal, onProgress, onFile, fetchImpl = fetch, backoffMs = 1000 } = {}) {
  const { manifest, entries } = readManifest(dir);
  const states = await Promise.all(entries.map((e) => inspect(dir, e, verify)));
  const present = entries.filter((_, i) => states[i] === "ok").map((e) => e.file);
  const todo = entries.filter((_, i) => states[i] !== "ok");
  for (const file of present) onFile?.({ file, state: "present" });
  if (!todo.length) return { present, downloaded: [], bytes: 0 };

  const base = baseUrlFor(manifest, baseUrl);
  fs.mkdirSync(dir, { recursive: true });
  for (const f of fs.readdirSync(dir)) if (f.endsWith(".download")) fs.rmSync(path.join(dir, f), { force: true }); // leftovers of an interrupted run

  const downloaded = [];
  let bytes = 0;
  const queue = [...todo];
  const worker = async () => {
    for (let entry = queue.shift(); entry; entry = queue.shift()) {
      onFile?.({ file: entry.file, state: "downloading" });
      const target = path.join(dir, `${entry.file}.download`);
      for (let attempt = 1; ; attempt++) {
        try {
          await downloadOnce(`${base}/${entry.file}`, target, entry, { fetchImpl, signal, onProgress });
          break;
        } catch (err) {
          if (signal?.aborted || !err.retryable || attempt >= retries) throw err;
          await sleep(backoffMs * 2 ** (attempt - 1));
        }
      }
      fs.renameSync(target, path.join(dir, entry.file));
      downloaded.push(entry.file);
      bytes += entry.size;
      onFile?.({ file: entry.file, state: "done" });
    }
  };
  const results = await Promise.allSettled(Array.from({ length: Math.min(concurrency, todo.length) }, worker));
  const failure = results.find((r) => r.status === "rejected");
  if (failure) throw failure.reason;
  return { present, downloaded, bytes };
}

/** Terminal progress for `npm start` / `npm run models`. */
export function consoleProgress(stream = process.stderr) {
  let last = 0;
  const tty = stream.isTTY;
  const mb = (n) => (n / 1e6).toFixed(n < 1e7 ? 1 : 0);
  return {
    onFile: ({ file, state }) => {
      if (state === "present") return;
      if (state === "downloading" && !tty) stream.write(`  downloading ${file}…\n`);
      if (state === "done") stream.write(`${tty ? "\r" : ""}  ✔ ${file}${" ".repeat(tty ? 40 : 0)}\n`);
    },
    onProgress: ({ file, received, total }) => {
      if (!tty || Date.now() - last < 120) return;
      last = Date.now();
      stream.write(`\r  ${file}  ${mb(received)} / ${mb(total)} MB (${Math.round((received / total) * 100)}%)   `);
    },
  };
}
