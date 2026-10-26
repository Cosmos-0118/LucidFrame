// electron-builder afterPack: drop native binaries for platforms and architectures this build
// does not target. onnxruntime-node ships all of them (≈550 MB); a user needs only their own.
const fs = require("node:fs");
const path = require("node:path");

const ARCH = { 0: "ia32", 1: "x64", 2: "armv7l", 3: "arm64", 4: "universal" };

function resourcesDir(context) {
  const { appOutDir, packager, electronPlatformName } = context;
  if (electronPlatformName === "darwin") return path.join(appOutDir, `${packager.appInfo.productFilename}.app`, "Contents", "Resources");
  return path.join(appOutDir, "resources");
}

function rm(target, log) {
  if (!fs.existsSync(target)) return 0;
  const size = dirSize(target);
  fs.rmSync(target, { recursive: true, force: true });
  log(`  removed ${path.relative(process.cwd(), target) || target} (${(size / 1e6).toFixed(0)} MB)`);
  return size;
}

function dirSize(p) {
  const st = fs.statSync(p);
  if (!st.isDirectory()) return st.size;
  return fs.readdirSync(p).reduce((n, f) => n + dirSize(path.join(p, f)), 0);
}

exports.default = async function afterPack(context) {
  const platform = context.electronPlatformName; // win32 | darwin | linux
  const arch = ARCH[context.arch];
  const log = (m) => console.log(`  • afterPack: ${m}`);
  const unpacked = path.join(resourcesDir(context), "app.asar.unpacked", "node_modules");
  let saved = 0;

  const ort = path.join(unpacked, "onnxruntime-node", "bin", "napi-v6");
  if (fs.existsSync(ort)) {
    for (const plat of fs.readdirSync(ort)) {
      const platDir = path.join(ort, plat);
      if (plat !== platform) {
        saved += rm(platDir, log);
        continue;
      }
      for (const a of fs.readdirSync(platDir)) if (a !== arch) saved += rm(path.join(platDir, a), log);
    }
    if (platform === "linux") {
      // CUDA needs the user to install CUDA + cuDNN themselves; shipping 300 MB of provider libraries
      // that almost nobody can use is dead weight. (Running from source keeps them.)
      const dir = path.join(ort, "linux", arch);
      for (const f of ["libonnxruntime_providers_cuda.so", "libonnxruntime_providers_tensorrt.so"]) saved += rm(path.join(dir, f), log);
    }
  }
  log(`saved ${(saved / 1e6).toFixed(0)} MB of unused native binaries`);

  // Make sure the engine's binaries survived unpacking; a broken package should fail the build, not ship.
  const need = [
    path.join(unpacked, "onnxruntime-node", "bin", "napi-v6", platform, arch, "onnxruntime_binding.node"),
    path.join(unpacked, "ffmpeg-static", platform === "win32" ? "ffmpeg.exe" : "ffmpeg"),
    path.join(resourcesDir(context), "models", "manifest.json"),
  ];
  for (const f of need) if (!fs.existsSync(f)) throw new Error(`packaging check failed: ${f} is missing`);
  if (!fs.readdirSync(path.join(unpacked, "@img")).some((d) => d.startsWith("sharp-"))) throw new Error("packaging check failed: no sharp native package was bundled");
};
