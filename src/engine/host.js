// Engine host: runs the engine in its own process (Electron utilityProcess, or a plain
// child_process.fork in tests/CLI tooling) and serves it over a tiny message protocol.
//
//   parent → host   { id, method, params }
//   host → parent   { id, ok: true, result } | { id, ok: false, error: { message, code, name } }
//   host → parent   { event: "progress", jobId, data }
//
// Running inference out of process means a crash (e.g. a GPU driver fault or running out of
// memory) takes down this process only; the app keeps running and restarts it.

import { Engine } from "./index.js";
import { log } from "./log.js";

const parent = process.parentPort ?? null; // Electron utilityProcess
const send = (msg) => (parent ? parent.postMessage(msg) : process.send?.(msg));

let engine = null;
const jobs = new Map(); // jobId → AbortController

// DOMException(AbortError).code is the legacy number 20, so check the name first.
const serialize = (err) => ({
  message: err?.message ?? String(err),
  code: err?.name === "AbortError" ? "cancelled" : typeof err?.code === "string" ? err.code : "failed",
  name: err?.name ?? "Error",
});

const handlers = {
  async init(params) {
    engine?.dispose();
    engine = new Engine(params ?? {});
    return engine.info();
  },
  async info() {
    return engine.info();
  },
  async warm() {
    return engine.warm();
  },
  async doctor() {
    return engine.doctor();
  },
  async process({ jobId, job }) {
    const controller = new AbortController();
    jobs.set(jobId, controller);
    try {
      return await engine.process({
        ...job,
        signal: controller.signal,
        onProgress: (data) => send({ event: "progress", jobId, data }),
      });
    } finally {
      jobs.delete(jobId);
    }
  },
  async cancel({ jobId }) {
    jobs.get(jobId)?.abort(new DOMException("cancelled", "AbortError"));
    return true;
  },
};

async function onMessage(msg) {
  const { id, method, params } = msg ?? {};
  if (typeof id !== "number" || typeof method !== "string") return;
  const handler = Object.hasOwn(handlers, method) ? handlers[method] : null;
  if (!handler) return send({ id, ok: false, error: { message: `unknown method ${method}`, code: "bad_request", name: "Error" } });
  if (!engine && method !== "init") return send({ id, ok: false, error: { message: "engine not initialised", code: "bad_request", name: "Error" } });
  try {
    send({ id, ok: true, result: await handler(params) });
  } catch (err) {
    if (err?.name !== "AbortError") log.error(err);
    send({ id, ok: false, error: serialize(err) });
  }
}

if (parent) parent.on("message", (e) => onMessage(e.data));
else process.on("message", onMessage);

process.on("uncaughtException", (err) => {
  log.error("uncaught exception in engine host", err);
  process.exit(1);
});
process.on("unhandledRejection", (err) => {
  log.error("unhandled rejection in engine host", err);
});
send({ event: "ready" });
