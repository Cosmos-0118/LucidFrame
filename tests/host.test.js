// The engine host protocol and the main-process client, exercised over a real child process.
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import { EngineClient } from "../src/main/engine-client.js";
import { rm, tmpDir, writePattern } from "./helpers.js";

const hostPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "engine", "host.js");
const spawnHost = (env = {}) => () => fork(hostPath, [], { env: { ...process.env, LUCIDFRAME_LOG_LEVEL: "error", ...env }, stdio: ["ignore", "inherit", "inherit", "ipc"] });

describe("engine host + client", () => {
  let dir;
  let client;
  before(() => {
    dir = tmpDir();
    client = new EngineClient({ spawn: spawnHost(), initParams: { device: "cpu" } });
  });
  after(async () => {
    await client.stop();
    rm(dir);
  });

  it("starts on demand and reports models", async () => {
    assert.equal(client.running, false);
    const info = await client.request("info");
    assert.equal(client.running, true);
    assert.deepEqual(info.models.map((m) => m.id), ["photo", "anime", "fast", "fast-anime"]);
    assert.deepEqual(info.scales, [2, 3, 4]);
  });

  it("lets several callers hit a not-yet-started engine at once (startup race)", async () => {
    const fresh = new EngineClient({ spawn: spawnHost(), initParams: { device: "cpu" } });
    try {
      const [a, b, c] = await Promise.all([fresh.request("info"), fresh.request("warm"), fresh.request("info")]);
      assert.equal(a.models.length, 4);
      assert.equal(c.models.length, 4);
      assert.equal(b.device.provider, "cpu");
    } finally {
      await fresh.stop();
    }
  });

  it("detects the device by warming the smallest model", async () => {
    const { device } = await client.request("warm");
    assert.equal(device.provider, "cpu");
  });

  it("runs a job and streams progress events tagged with the job id", async () => {
    const input = await writePattern(path.join(dir, "a.png"), 40, 30);
    const events = [];
    client.on("progress", (jobId, data) => events.push([jobId, data]));
    const result = await client.request("process", { jobId: "job-1", job: { input, model: "fast", scale: 2, outputDir: dir } });
    assert.equal(result.width, 80);
    assert.ok(fs.existsSync(result.output));
    assert.ok(events.length > 2);
    assert.ok(events.every(([id]) => id === "job-1"));
    assert.equal(events.at(-1)[1].fraction, 1);
    client.removeAllListeners("progress");
  });

  it("cancels a running job by id and the job rejects as cancelled", async () => {
    const input = await writePattern(path.join(dir, "big.png"), 160, 160);
    client.on("progress", (jobId, data) => data.phase === "upscale" && client.cancel(jobId));
    await assert.rejects(client.request("process", { jobId: "job-2", job: { input, model: "photo", scale: 4, outputDir: path.join(dir, "cancelled") } }), (err) => err.name === "AbortError" && err.code === "cancelled");
    client.removeAllListeners("progress");
    assert.deepEqual(fs.existsSync(path.join(dir, "cancelled")) ? fs.readdirSync(path.join(dir, "cancelled")) : [], []);
  });

  it("passes engine errors through with their message and code", async () => {
    await assert.rejects(client.request("process", { jobId: "j3", job: { input: path.join(dir, "nope.png"), model: "fast", scale: 2 } }), (err) => err.code === "missing" && /does not exist/.test(err.message));
    await assert.rejects(client.request("bogus"), /unknown method bogus/);
  });

  it("survives a crashed engine: pending work fails clearly, the next request restarts it", async () => {
    let child;
    const crashy = new EngineClient({
      spawn: () => (child = spawnHost()()),
      initParams: { device: "cpu" },
    });
    await crashy.request("info");
    const firstPid = child.pid;
    const input = await writePattern(path.join(dir, "c.png"), 200, 200);
    let killed = false;
    crashy.on("progress", () => {
      if (!killed) {
        killed = true;
        process.kill(firstPid, "SIGKILL"); // simulate a native crash (driver fault, OOM kill) mid-job
      }
    });
    await assert.rejects(
      crashy.request("process", { jobId: "c1", job: { input, model: "photo", scale: 4, outputDir: dir } }),
      (err) => err.code === "crashed" && /stopped unexpectedly/.test(err.message) && /out of memory/.test(err.message),
    );
    assert.equal(crashy.running, false);

    const again = await crashy.request("info"); // transparently restarts
    assert.equal(again.models.length, 4);
    assert.notEqual(child.pid, firstPid);
    await crashy.stop();
  });

  it("gives up after repeated crashes instead of looping forever", async () => {
    const dying = new EngineClient({ spawn: () => fork(path.join(dir, "does-not-exist.js"), [], { stdio: ["ignore", "ignore", "ignore", "ipc"] }) });
    for (let i = 0; i < 3; i++) await assert.rejects(dying.request("info"), /exited while starting/);
  });
});
