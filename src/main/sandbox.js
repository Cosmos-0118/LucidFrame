// Linux: decide whether Chromium can sandbox itself on this machine. Pure Node (no Electron import) so launchers
// and tests can ask the same question *before* starting Electron — the sandbox check aborts the process during
// Chromium start-up, earlier than any JavaScript in the app can run.

import fs from "node:fs";
import path from "node:path";

/**
 * True when Chromium would refuse to start with its sandbox on: running as root (containers), or Ubuntu 23.10+
 * blocking unprivileged user namespaces with no setuid `chrome-sandbox` helper to fall back on.
 * @param {string} electronPath path of the Electron (or packaged app) executable
 */
export function needsNoSandbox(electronPath) {
  if (process.platform !== "linux") return false;
  if (process.getuid?.() === 0) return true;
  let restricted = false;
  try {
    restricted = fs.readFileSync("/proc/sys/kernel/apparmor_restrict_unprivileged_userns", "utf8").trim() === "1";
  } catch {
    /* file absent: not restricted */
  }
  if (!restricted) return false;
  try {
    const st = fs.statSync(path.join(path.dirname(electronPath), "chrome-sandbox"));
    return !(st.uid === 0 && (st.mode & 0o4000) !== 0);
  } catch {
    return true; // no helper at all
  }
}

/** Command-line flags to prepend when launching Electron from a script. */
export const sandboxFlags = (electronPath) => (needsNoSandbox(electronPath) ? ["--no-sandbox"] : []);
