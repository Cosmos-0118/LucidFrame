import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import path from "node:path";

const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
const root = process.cwd();

const cleanTargets = [
  "frontend/dist",
  "build/backend-dist",
  "build/backend-build",
  "dist",
];

function clean() {
  console.log("\n[clean] Removing old build artifacts...\n");
  for (const rel of cleanTargets) {
    const target = path.join(root, rel);
    rmSync(target, { recursive: true, force: true });
  }
}

function runStep(name, args) {
  console.log(`\n[${name}] ${npmCmd} ${args.join(" ")}`);
  const result = spawnSync(npmCmd, args, { stdio: "inherit", cwd: root });
  if (result.status !== 0) {
    throw new Error(`[${name}] failed with exit code ${result.status ?? "unknown"}`);
  }
}

function main() {
  try {
    clean();
    runStep("frontend", ["run", "build:front"]);
    runStep("backend", ["run", "build:backend"]);
    runStep("windows-dist", ["run", "dist:win"]);
    console.log("\nAll steps completed successfully.\n");
  } catch (err) {
    console.error(err.message || err);
    process.exit(1);
  }
}

main();
