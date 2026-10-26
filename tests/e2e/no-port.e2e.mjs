// The old design ran a FastAPI server on localhost:8000 with CORS "*", which any web page open in the
// user's browser could call. The new app must not listen on any port at all.
// Linux only (reads /proc); outgoing connections are fine, listening sockets are not.
// launched without Playwright because its debug endpoint is itself a listener.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { describe, it } from "node:test";
import { sandboxFlags } from "../../src/main/sandbox.js";
import { rm, tmpDir } from "../helpers.js";

const root = path.resolve(import.meta.dirname, "..", "..");
const electronBinary = createRequire(import.meta.url)("electron");

function descendants(rootPid) {
  const parent = new Map();
  for (const p of fs.readdirSync("/proc").filter((d) => /^\d+$/.test(d))) {
    try {
      const stat = fs.readFileSync(`/proc/${p}/stat`, "utf8");
      parent.set(Number(p), Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]));
    } catch {
      /* process vanished */
    }
  }
  const found = new Set([rootPid]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const [pid, ppid] of parent) if (found.has(ppid) && !found.has(pid)) (found.add(pid), (grew = true));
  }
  return found;
}

describe("network exposure", { skip: process.platform !== "linux" }, () => {
  it("the running app owns no listening TCP/UDP sockets", async () => {
    const dir = tmpDir();
    const child = spawn(electronBinary, [...sandboxFlags(electronBinary), `--user-data-dir=${dir}`, root], {
      env: { ...process.env, LUCIDFRAME_DEVICE: "cpu", LUCIDFRAME_LOG_LEVEL: "error" },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    let exited = null;
    child.stderr.on("data", (c) => (stderr = (stderr + c).slice(-4000)));
    child.on("exit", (code, signal) => (exited = `exit code ${code}, signal ${signal}`));
    try {
      await new Promise((r) => setTimeout(r, 10_000)); // window up, engine started, hardware detected
      const pids = descendants(child.pid);
      assert.ok(pids.size >= 3, `expected the app's process tree, found ${pids.size} processes (${exited ?? "still running"})\n${stderr}`);
      const inodes = new Set();
      for (const pid of pids) {
        let fds = [];
        try {
          fds = fs.readdirSync(`/proc/${pid}/fd`);
        } catch {
          continue;
        }
        for (const fd of fds) {
          try {
            const m = /socket:\[(\d+)\]/.exec(fs.readlinkSync(`/proc/${pid}/fd/${fd}`));
            if (m) inodes.add(m[1]);
          } catch {
            /* closed */
          }
        }
      }
      const listening = [];
      for (const table of ["tcp", "tcp6", "udp", "udp6"]) {
        const lines = fs.existsSync(`/proc/net/${table}`) ? fs.readFileSync(`/proc/net/${table}`, "utf8").split("\n").slice(1) : [];
        for (const line of lines) {
          const f = line.trim().split(/\s+/);
          if (f.length < 10 || !inodes.has(f[9])) continue;
          // TCP: state 0A is LISTEN. UDP: a socket still unconnected (remote 0.0.0.0:0) can receive from anyone; one
          // connected to a remote address (e.g. Chromium talking to the DNS server) is an outgoing client.
          const unconnected = /^0+:0+$/.test(f[2]);
          if (table.startsWith("udp") ? unconnected : f[3] === "0A") listening.push(`${table} local ${f[1]} remote ${f[2]}`);
        }
      }
      assert.deepEqual(listening, [], "the app must not listen on any port");
    } finally {
      child.kill("SIGKILL");
      await new Promise((r) => setTimeout(r, 500));
      rm(dir);
    }
  });
});
