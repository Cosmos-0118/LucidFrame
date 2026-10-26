// `npm run dev`: Vite dev server with hot reload + the desktop app pointed at it.

import { spawn } from "node:child_process";
import path from "node:path";
import { createRequire } from "node:module";
import { createServer } from "vite";

const root = path.resolve(import.meta.dirname, "..");
const require = createRequire(import.meta.url);

const server = await createServer({ configFile: path.join(root, "src", "renderer", "vite.config.js") });
await server.listen();
const url = server.resolvedUrls.local[0].replace(/\/$/, "");
console.log(`UI dev server at ${url}`);

const rootOnLinux = process.platform === "linux" && process.getuid?.() === 0;
const child = spawn(require("electron"), [...(rootOnLinux ? ["--no-sandbox"] : []), root, ...process.argv.slice(2)], { stdio: "inherit", env: { ...process.env, LUCIDFRAME_DEV_URL: `${url}/` } });
child.on("exit", async (code) => {
  await server.close();
  process.exit(code ?? 0);
});
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => child.kill(sig));
