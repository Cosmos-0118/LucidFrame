// `npm run models`: download the AI model files that are not stored in git (about 180 MB, first time only).
//   npm run models                 fetch what is missing
//   npm run models -- --verify     also re-hash the files already on disk
// Installers bundle these files and never need this.

import { consoleProgress, ensureModels } from "../src/engine/fetch-models.js";

const verify = process.argv.includes("--verify");
const progress = consoleProgress();
const t0 = performance.now();
try {
  const { present, downloaded, bytes } = await ensureModels({ verify, ...progress });
  const secs = ((performance.now() - t0) / 1000).toFixed(1);
  if (downloaded.length) console.log(`Downloaded ${downloaded.length} file${downloaded.length === 1 ? "" : "s"} (${(bytes / 1e6).toFixed(0)} MB) in ${secs}s; ${present.length} already present.`);
  else console.log(`All ${present.length} model files are present${verify ? " and verified" : ""}.`);
} catch (err) {
  console.error(`\nCould not get the model files: ${err.message}`);
  console.error("Check your connection and run `npm run models` again, or set LUCIDFRAME_MODELS_URL to a mirror.");
  process.exit(1);
}
