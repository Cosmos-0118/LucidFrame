// LucidFrame — Electron main process.
//
//   renderer (React, sandboxed)  ⇄  preload (frozen API)  ⇄  main (this file)  ⇄  engine host (utility process)
//
// There is no HTTP server and no open port: the UI talks to the engine over Electron IPC, so there is
// nothing for another program or web page on the machine to connect to, and nothing to "start".

import { app, BrowserWindow, dialog, ipcMain, Menu, protocol, session, shell, utilityProcess } from "electron";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { IMAGE_EXTENSIONS, VIDEO_EXTENSIONS } from "../engine/kinds.js";
import { log } from "../engine/log.js";
import { EngineClient } from "./engine-client.js";
import { FileRegistry, MIME } from "./files.js";
import { needsNoSandbox } from "./sandbox.js";
import { createSettings } from "./settings.js";
import { CSP, isSafeExternalUrl, parseRange, safeJoin, validateStart } from "./validate.js";

const root = path.resolve(import.meta.dirname, "..", "..");
const distDir = path.join(root, "dist", "renderer");
const devUrl = process.env.LUCIDFRAME_DEV_URL || null; // set by `npm run dev`
const smokeTest = process.argv.includes("--smoke-test");
const PROJECT_URL = "https://github.com/Cosmos-0118/LucidFrame";

protocol.registerSchemesAsPrivileged([{ scheme: "lucid", privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }]);

// Launchers (npm start, tests) pass --no-sandbox themselves when needed; this covers apps started directly.
if (needsNoSandbox(process.execPath)) app.commandLine.appendSwitch("no-sandbox");

if (!smokeTest && !app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

// ───────────────────────────── state ─────────────────────────────

const userData = app.getPath("userData");
const logsDir = path.join(userData, "logs");
process.env.LUCIDFRAME_LOG_FILE = path.join(logsDir, "main.log");
const previewDir = path.join(app.getPath("temp"), "lucidframe-previews");
const settings = createSettings(path.join(userData, "settings.json"));
const files = new FileRegistry();

const modelsDir = process.env.LUCIDFRAME_MODELS || (app.isPackaged ? path.join(process.resourcesPath, "models") : path.join(root, "models"));
const client = new EngineClient({
  spawn: () =>
    utilityProcess.fork(path.join(root, "src", "engine", "host.js"), [], {
      serviceName: "LucidFrame Engine",
      // Inherit (never "pipe"): an undrained pipe fills at ~64 KB and would block the engine mid-job.
      stdio: "inherit",
      env: { ...process.env, LUCIDFRAME_LOG_FILE: path.join(logsDir, "engine.log") },
    }),
  initParams: { modelsDir, device: process.env.LUCIDFRAME_DEVICE, previewDir },
});

let mainWindow = null;
let engineInfo = null; // models, scales, formats
let device = { state: "detecting", label: "Detecting hardware…", provider: null };
const running = new Map(); // jobId → itemId

const sendToUi = (channel, payload) => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
};

// ──────────────────────── lucid:// protocol ────────────────────────

const CONTENT_TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json", ".woff2": "font/woff2", ".ico": "image/x-icon" };

async function serveApp(pathname) {
  const file = safeJoin(distDir, pathname);
  if (!file) return new Response("Forbidden", { status: 403 });
  try {
    const body = await fs.promises.readFile(file);
    return new Response(body, {
      headers: {
        "Content-Type": CONTENT_TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream",
        "Content-Security-Policy": CSP,
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "no-store",
      },
    });
  } catch {
    return new Response("Not found", { status: 404 });
  }
}

async function serveMedia(token, request) {
  const file = files.mediaPath(token);
  if (!file) return new Response("Not found", { status: 404 });
  let stat;
  try {
    stat = await fs.promises.stat(file);
  } catch {
    return new Response("Not found", { status: 404 });
  }
  const headers = {
    "Content-Type": MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream",
    "Accept-Ranges": "bytes",
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "no-store",
  };
  const range = parseRange(request.headers.get("range"), stat.size);
  if (range === "invalid") return new Response("Range Not Satisfiable", { status: 416, headers: { ...headers, "Content-Range": `bytes */${stat.size}` } });
  const stream = (opts) => Readable.toWeb(fs.createReadStream(file, opts));
  if (!range) return new Response(stream(), { status: 200, headers: { ...headers, "Content-Length": String(stat.size) } });
  return new Response(stream({ start: range.start, end: range.end }), {
    status: 206,
    headers: { ...headers, "Content-Range": `bytes ${range.start}-${range.end}/${stat.size}`, "Content-Length": String(range.end - range.start + 1) },
  });
}

function registerProtocol() {
  protocol.handle("lucid", (request) => {
    const url = new URL(request.url);
    if (url.host === "app") return serveApp(url.pathname);
    if (url.host === "media") return serveMedia(url.pathname.slice(1), request);
    return new Response("Not found", { status: 404 });
  });
}

// ─────────────────────────────── IPC ───────────────────────────────

const trusted = (event) => {
  const url = event.senderFrame?.url ?? "";
  return url.startsWith("lucid://app/") || (devUrl != null && url.startsWith(devUrl));
};

function handle(channel, fn) {
  ipcMain.handle(channel, (event, ...args) => {
    if (!trusted(event)) throw new Error("untrusted sender");
    return fn(event, ...args);
  });
}

function friendlyError(err) {
  const msg = String(err?.message ?? err);
  if (/EACCES|EPERM|EROFS/.test(msg)) return "LucidFrame can't write there. Choose another folder under “Save to”.";
  if (/ENOSPC/.test(msg)) return "The disk is full.";
  return msg;
}

async function startJob(req) {
  const opts = validateStart(req, { models: engineInfo?.models ?? (await loadInfo()).models });
  const item = files.get(opts.itemId);
  if (!item) throw new Error("That file is no longer available. Add it again.");
  const jobId = crypto.randomUUID();
  running.set(jobId, item.id);

  (async () => {
    try {
      const outputDir = settings.get().outputDir ?? undefined;
      const result = await client.request("process", {
        jobId,
        job: { input: item.path, model: opts.model, scale: opts.scale, format: opts.format, smooth: opts.smooth, outputDir },
      });
      files.allow(result.output);
      sendToUi("job:event", {
        type: "done",
        jobId,
        itemId: item.id,
        result: {
          ...result,
          outputName: path.basename(result.output),
          outputUrl: files.mediaUrl(result.output),
          previewUrl: result.preview ? files.mediaUrl(result.preview) : null,
        },
      });
      if (result.device?.provider) setDevice(result.device);
    } catch (err) {
      const cancelled = err?.name === "AbortError" || err?.code === "cancelled";
      if (!cancelled) log.error(`job ${jobId} failed`, err);
      sendToUi("job:event", { type: cancelled ? "cancelled" : "error", jobId, itemId: item.id, message: friendlyError(err) });
    } finally {
      running.delete(jobId);
    }
  })();
  return { jobId };
}

function setDevice(d) {
  device = { state: "ready", label: d.label, provider: d.provider };
  sendToUi("device:update", device);
}

async function loadInfo() {
  engineInfo = await client.request("info");
  return engineInfo;
}

async function detectDevice() {
  try {
    const { device: d } = await client.request("warm");
    setDevice(d);
  } catch (err) {
    log.error("hardware detection failed", err);
    device = { state: "error", label: "Engine unavailable", provider: null, error: friendlyError(err) };
    sendToUi("device:update", device);
  }
}

function registerIpc() {
  handle("app:info", async () => {
    const info = engineInfo ?? (await loadInfo());
    return { ...info, device, platform: process.platform, settings: settings.get(), extensions: { image: [...IMAGE_EXTENSIONS], video: [...VIDEO_EXTENSIONS] } };
  });

  handle("files:register", (_e, paths) => {
    if (!Array.isArray(paths) || paths.length > 2000) throw new TypeError("invalid paths");
    return files.register(paths);
  });

  handle("files:pick", async () => {
    const strip = (set) => [...set].map((e) => e.slice(1));
    const res = await dialog.showOpenDialog(mainWindow, {
      title: "Choose images or videos",
      properties: ["openFile", "multiSelections"],
      filters: [
        { name: "Images and videos", extensions: [...strip(IMAGE_EXTENSIONS), ...strip(VIDEO_EXTENSIONS)] },
        { name: "Images", extensions: strip(IMAGE_EXTENSIONS) },
        { name: "Videos", extensions: strip(VIDEO_EXTENSIONS) },
      ],
    });
    return res.canceled ? { items: [], rejected: [] } : files.register(res.filePaths);
  });

  handle("files:pickFolder", async () => {
    const res = await dialog.showOpenDialog(mainWindow, { title: "Choose a folder of images or videos", properties: ["openDirectory"] });
    return res.canceled ? { items: [], rejected: [] } : files.register(res.filePaths);
  });

  handle("job:start", (_e, req) => startJob(req));
  handle("job:cancel", (_e, jobId) => {
    if (typeof jobId === "string" && running.has(jobId)) client.cancel(jobId);
    return true;
  });

  const known = (p) => typeof p === "string" && path.isAbsolute(p) && files.isKnown(p) && fs.existsSync(p);
  handle("file:reveal", (_e, p) => {
    if (!known(p)) throw new Error("unknown file");
    shell.showItemInFolder(p);
    return true;
  });
  handle("file:open", async (_e, p) => {
    if (!known(p)) throw new Error("unknown file");
    const err = await shell.openPath(p);
    if (err) throw new Error(err);
    return true;
  });
  handle("file:saveCopy", async (_e, p) => {
    if (!known(p)) throw new Error("unknown file");
    const res = await dialog.showSaveDialog(mainWindow, { title: "Save a copy", defaultPath: path.basename(p) });
    if (res.canceled || !res.filePath) return null;
    await fs.promises.copyFile(p, res.filePath);
    return res.filePath;
  });

  handle("settings:get", () => settings.get());
  handle("settings:set", (_e, patch) => settings.set(patch && typeof patch === "object" && Object.hasOwn(patch, "outputDir") ? { outputDir: patch.outputDir } : {}));
  handle("settings:chooseOutputFolder", async () => {
    const res = await dialog.showOpenDialog(mainWindow, { title: "Save upscaled files to…", properties: ["openDirectory", "createDirectory"] });
    return res.canceled ? settings.get() : settings.set({ outputDir: res.filePaths[0] });
  });

  handle("app:openLogs", async () => {
    fs.mkdirSync(logsDir, { recursive: true });
    await shell.openPath(logsDir);
    return true;
  });
  handle("app:openProjectPage", () => shell.openExternal(PROJECT_URL).then(() => true));
}

// ────────────────────────────── window ──────────────────────────────

function hardenSession() {
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((_wc, _perm, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
  ses.setDevicePermissionHandler(() => false);
}

app.on("web-contents-created", (_e, contents) => {
  contents.on("will-attach-webview", (e) => e.preventDefault());
  contents.on("will-navigate", (e, url) => {
    if (!(url.startsWith("lucid://app/") || (devUrl && url.startsWith(devUrl)))) e.preventDefault();
  });
  contents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternalUrl(url)) shell.openExternal(url);
    return { action: "deny" };
  });
});

function createWindow() {
  const win = new BrowserWindow({
    width: 1240,
    height: 820,
    minWidth: 920,
    minHeight: 640,
    show: false,
    title: "LucidFrame",
    backgroundColor: "#0e1014",
    autoHideMenuBar: true,
    icon: path.join(root, "build", "icon.png"),
    webPreferences: {
      preload: path.join(import.meta.dirname, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      spellcheck: false,
      devTools: !app.isPackaged,
    },
  });
  mainWindow = win;
  win.once("ready-to-show", () => !smokeTest && win.show());
  win.on("closed", () => {
    if (mainWindow === win) mainWindow = null;
  });
  win.loadURL(devUrl ?? "lucid://app/index.html");
  return win;
}

/** Help → Run self-check: the app's equivalent of `lucidframe doctor`. */
async function runSelfCheck() {
  try {
    const report = await client.request("doctor");
    await dialog.showMessageBox(mainWindow, {
      type: report.ok ? "info" : "warning",
      title: "LucidFrame self-check",
      message: report.ok ? "Everything works." : "Something is wrong.",
      detail: `${report.checks.map((c) => `${c.ok ? "✔" : "✘"} ${c.name}: ${c.detail}`).join("\n")}\n\nDevice: ${device.label}\nLucidFrame ${report.version} · ${report.platform}`,
    });
  } catch (err) {
    dialog.showErrorBox("Self-check failed", friendlyError(err));
  }
}

function buildMenu() {
  const isMac = process.platform === "darwin";
  const template = [
    ...(isMac ? [{ role: "appMenu" }] : []),
    { label: "File", submenu: [isMac ? { role: "close" } : { role: "quit" }] },
    { role: "editMenu" },
    { label: "View", submenu: [{ role: "resetZoom" }, { role: "zoomIn" }, { role: "zoomOut" }, { type: "separator" }, { role: "togglefullscreen" }, ...(app.isPackaged ? [] : [{ role: "toggleDevTools" }])] },
    { role: "windowMenu" },
    {
      label: "Help",
      submenu: [
        { label: "Run self-check…", click: () => runSelfCheck() },
        { label: "Open log folder", click: () => shell.openPath(logsDir) },
        { type: "separator" },
        { label: "Project page", click: () => shell.openExternal(PROJECT_URL) },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/** Files handed to us by the OS ("Open with…", command line). */
function pathsFromArgv(argv) {
  return argv.slice(app.isPackaged ? 1 : 2).filter((a) => !a.startsWith("-") && path.isAbsolute(path.resolve(a)) && fs.existsSync(path.resolve(a))).map((a) => path.resolve(a));
}

function openFromOs(paths) {
  if (!paths.length) return;
  const result = files.register(paths);
  if (result.items.length && mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
    sendToUi("files:opened", result);
  }
}

async function runSmokeTest() {
  const finish = (ok, detail) => {
    const line = `${JSON.stringify({ ok, ...detail })}\n`;
    process.stdout.write(line);
    // Windows GUI apps have no console; CI reads the result from a file instead.
    if (process.env.LUCIDFRAME_SMOKE_OUT) fs.writeFileSync(process.env.LUCIDFRAME_SMOKE_OUT, line);
    app.exit(ok ? 0 : 1);
  };
  const timer = setTimeout(() => finish(false, { error: "smoke test timed out" }), 120_000);
  try {
    await new Promise((resolve, reject) => {
      mainWindow.webContents.once("did-finish-load", resolve);
      mainWindow.webContents.once("did-fail-load", (_e, code, desc) => reject(new Error(`UI failed to load: ${desc} (${code})`)));
    });
    // Give React a moment to mount, then check the preload bridge and the rendered UI.
    let ui = null;
    for (let i = 0; i < 50 && !ui?.mounted; i++) {
      ui = await mainWindow.webContents.executeJavaScript(`({ mounted: document.getElementById('root')?.childElementCount > 0, bridge: typeof window.lucid?.info === 'function', node: typeof require !== 'undefined' || typeof process !== 'undefined' })`);
      if (!ui.mounted) await new Promise((r) => setTimeout(r, 200));
    }
    if (!ui.mounted) throw new Error("UI did not render");
    if (!ui.bridge) throw new Error("preload bridge missing");
    if (ui.node) throw new Error("renderer has Node access (sandbox is broken)");
    const report = await client.request("doctor");
    clearTimeout(timer);
    finish(report.ok, { ui, doctor: report });
  } catch (err) {
    clearTimeout(timer);
    finish(false, { error: String(err?.message ?? err) });
  }
}

// ─────────────────────────────── lifecycle ───────────────────────────────

app.on("second-instance", (_e, argv) => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
  openFromOs(pathsFromArgv(argv));
});

app.on("open-file", (event, filePath) => {
  event.preventDefault();
  openFromOs([filePath]);
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0 && app.isReady()) createWindow();
});

let quitting = false;
app.on("before-quit", (event) => {
  if (quitting) return;
  quitting = true;
  event.preventDefault();
  client
    .stop()
    .catch(() => {})
    .finally(() => {
      fs.rmSync(previewDir, { recursive: true, force: true });
      app.quit();
    });
});

process.on("uncaughtException", (err) => {
  log.error("uncaught exception in main", err);
});
process.on("unhandledRejection", (err) => {
  log.error("unhandled rejection in main", err);
});

app.whenReady().then(async () => {
  app.setAppUserModelId("com.lucidframe.app");
  fs.rmSync(previewDir, { recursive: true, force: true }); // leftovers from a crash
  registerProtocol();
  hardenSession();
  registerIpc();
  buildMenu();
  const win = createWindow();
  client.on("progress", (jobId, data) => {
    const itemId = running.get(jobId);
    if (itemId) sendToUi("job:event", { type: "progress", jobId, itemId, ...data });
  });
  if (smokeTest) return runSmokeTest();
  win.webContents.once("did-finish-load", () => {
    openFromOs(pathsFromArgv(process.argv));
  });
  detectDevice(); // in the background; the UI shows "Detecting hardware…" until it lands
});
