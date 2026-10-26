// Talks to the engine host process. Starts it on demand, restarts it after a crash, and turns a
// dead process into an ordinary rejected promise instead of a hung UI.
//
// `spawn` is injected so the same client drives Electron's utilityProcess in the app and
// child_process.fork in tests.

import { EventEmitter } from "node:events";

const READY_TIMEOUT_MS = 30_000;
const CRASH_WINDOW_MS = 60_000;
const MAX_CRASHES = 3;

export class EngineError extends Error {
  constructor(message, code = "failed") {
    super(message);
    this.name = "EngineError";
    this.code = code;
  }
}

export class EngineClient extends EventEmitter {
  #spawn;
  #initParams;
  #child = null;
  #ready = false; // true only once the host has said hello *and* finished init
  #starting = null;
  #nextId = 1;
  #pending = new Map(); // id → { resolve, reject }
  #crashes = [];
  #stopping = false;

  /**
   * @param {{spawn: () => {postMessage?:Function, send?:Function, on:Function, kill:Function}, initParams?: object}} opts
   */
  constructor({ spawn, initParams = {} }) {
    super();
    this.#spawn = spawn;
    this.#initParams = initParams;
  }

  get running() {
    return this.#child != null;
  }

  async #start() {
    if (this.#ready) return;
    if (this.#starting) return this.#starting; // concurrent first callers share one startup
    this.#starting = (async () => {
      const recent = this.#crashes.filter((t) => Date.now() - t < CRASH_WINDOW_MS);
      if (recent.length >= MAX_CRASHES) {
        throw new EngineError("The processing engine keeps crashing, so LucidFrame stopped retrying. Restart the app; if it persists, run “lucidframe doctor” or check the log.", "crash_loop");
      }
      const child = this.#spawn();
      const post = (m) => (child.postMessage ? child.postMessage(m) : child.send(m));

      const ready = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new EngineError("The processing engine did not start in time.", "start_timeout")), READY_TIMEOUT_MS);
        child.on("message", (msg) => {
          if (msg?.event === "ready") {
            clearTimeout(timer);
            resolve();
          }
        });
        child.once("exit", (code) => {
          clearTimeout(timer);
          reject(new EngineError(`The processing engine exited while starting (code ${code}).`, "start_failed"));
        });
      });

      child.on("message", (msg) => this.#onMessage(msg));
      child.on("exit", (code) => this.#onExit(child, code));
      this.#child = child;
      this.#post = post;
      try {
        await ready;
        await this.#call("init", this.#initParams);
        this.#ready = true;
      } catch (err) {
        this.#child = null;
        try {
          child.kill();
        } catch {
          /* already dead */
        }
        throw err;
      }
    })().finally(() => (this.#starting = null));
    return this.#starting;
  }

  #post = () => {};

  #onMessage(msg) {
    if (!msg) return;
    if (msg.event === "progress") return this.emit("progress", msg.jobId, msg.data);
    if (typeof msg.id === "number") {
      const entry = this.#pending.get(msg.id);
      if (!entry) return;
      this.#pending.delete(msg.id);
      if (msg.ok) entry.resolve(msg.result);
      else entry.reject(Object.assign(new EngineError(msg.error?.message ?? "failed", msg.error?.code), { name: msg.error?.name === "AbortError" ? "AbortError" : "EngineError" }));
    }
  }

  #onExit(child, code) {
    if (this.#child !== child) return;
    this.#child = null;
    this.#ready = false;
    const expected = this.#stopping;
    if (!expected) this.#crashes.push(Date.now());
    const err = new EngineError(
      expected
        ? "The processing engine was stopped."
        : `The processing engine stopped unexpectedly (code ${code}). This usually means the computer ran out of memory — try a smaller scale or the Fast model.`,
      expected ? "stopped" : "crashed",
    );
    for (const { reject } of this.#pending.values()) reject(err);
    this.#pending.clear();
    this.emit("exit", { code, expected });
  }

  #call(method, params) {
    return new Promise((resolve, reject) => {
      const id = this.#nextId++;
      this.#pending.set(id, { resolve, reject });
      try {
        this.#post({ id, method, params });
      } catch (err) {
        this.#pending.delete(id);
        reject(err);
      }
    });
  }

  async request(method, params) {
    this.#stopping = false;
    await this.#start();
    return this.#call(method, params);
  }

  /** Best-effort cancel; never throws. */
  cancel(jobId) {
    if (!this.#child) return;
    try {
      this.#post({ id: this.#nextId++, method: "cancel", params: { jobId } });
    } catch {
      /* host is gone */
    }
  }

  async stop() {
    const child = this.#child;
    if (!child) return;
    this.#stopping = true;
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 2000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      try {
        child.kill();
      } catch {
        resolve();
      }
    });
  }
}
