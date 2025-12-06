import { app, BrowserWindow } from "electron";
import path from "path";
import fs from "fs/promises";
import { existsSync } from "fs";
import { spawn } from "child_process";

const WINDOW_WIDTH = 1200;
const WINDOW_HEIGHT = 800;

const isDev = !!process.env.ELECTRON_DEV_SERVER_URL;
const devServerUrl = process.env.ELECTRON_DEV_SERVER_URL;

const bundledRoot = process.resourcesPath;
const userDataRoot = path.join(app.getPath("userData"), "resources");
const backendLogPath = path.join(userDataRoot, "backend.log");
const backendPort = 8000;

let backendProcess = null;
let backendReady = false;
let backendStartedByApp = false;

async function isBackendAlive() {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1500);
    const res = await fetch(`http://127.0.0.1:${backendPort}/health`, {
      signal: controller.signal,
    });
    clearTimeout(timeout);
    return res.ok;
  } catch {
    return false;
  }
}

async function waitForBackendReady(maxMs = 12000, intervalMs = 400) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    if (backendReady || (await isBackendAlive())) {
      backendReady = true;
      return true;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

async function stopBackend(reason = "app-exit") {
  if (!backendProcess) return;
  if (!backendStartedByApp) {
    backendProcess = null;
    backendReady = false;
    return;
  }
  const proc = backendProcess;
  backendProcess = null;
  backendReady = false;
  try {
    proc.kill();
  } catch (err) {
    console.error("Failed to kill backend", err);
  }
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 1500);
    proc.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
  console.log(`Backend stopped (${reason})`);
}

async function copyDir(src, dest) {
  await fs.mkdir(dest, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      await copyDir(srcPath, destPath);
    } else if (entry.isFile()) {
      await fs.copyFile(srcPath, destPath);
    }
  }
}

async function ensureBundledResources() {
  const bundledModels = path.join(bundledRoot, "models");
  const bundledFfmpeg = path.join(bundledRoot, "bin", "ffmpeg.exe");
  const bundledBackendExe = path.join(bundledRoot, "backend", "backend.exe");

  const targetModels = path.join(userDataRoot, "models");
  const targetBin = path.join(userDataRoot, "bin");
  const targetFfmpeg = path.join(targetBin, "ffmpeg.exe");
  const targetBackendDir = path.join(userDataRoot, "backend");
  const targetBackendExe = path.join(targetBackendDir, "backend.exe");
  const targetTemp = path.join(userDataRoot, "tmp");

  if (existsSync(bundledModels) && !existsSync(targetModels)) {
    await copyDir(bundledModels, targetModels);
  }

  if (existsSync(bundledFfmpeg) && !existsSync(targetFfmpeg)) {
    await fs.mkdir(targetBin, { recursive: true });
    await fs.copyFile(bundledFfmpeg, targetFfmpeg);
  }

  if (existsSync(bundledBackendExe)) {
    await fs.mkdir(targetBackendDir, { recursive: true });
    await fs.copyFile(bundledBackendExe, targetBackendExe);
  }

  process.env.LUCIDFRAME_MODELS = targetModels;
  process.env.LUCIDFRAME_FFMPEG = targetFfmpeg;
  process.env.FFMPEG_PATH = targetFfmpeg;
  process.env.LUCIDFRAME_TEMP = targetTemp;
  process.env.LUCIDFRAME_HOST = "127.0.0.1";
  process.env.LUCIDFRAME_PORT = String(backendPort);
  await fs.mkdir(targetTemp, { recursive: true });
  await fs.mkdir(path.dirname(backendLogPath), { recursive: true });
}

function startBackend() {
  if (backendProcess) return backendProcess;

  const isPackaged = app.isPackaged;
  const projectRoot = app.getAppPath();
  const backendRoot = isPackaged
    ? path.join(userDataRoot, "backend")
    : path.join(projectRoot, "backend");

  const env = {
    ...process.env,
    PYTHONPATH: backendRoot,
    // Force numba to avoid TBB so we don't need tbb12.dll at runtime.
    NUMBA_THREADING_LAYER: process.env.NUMBA_THREADING_LAYER || "workqueue",
  };

  if (isPackaged) {
    const backendExe = path.join(backendRoot, "backend.exe");
    backendProcess = spawn(backendExe, [], {
      cwd: backendRoot,
      env,
      stdio: "pipe",
    });
    backendStartedByApp = true;
  } else {
    const pythonExe = process.env.PYTHON_PATH || "python";
    const args = [
      "-m",
      "uvicorn",
      "backend.main:app",
      "--host",
      "127.0.0.1",
      "--port",
      String(backendPort),
      "--workers",
      "1",
    ];

    backendProcess = spawn(pythonExe, args, {
      cwd: projectRoot,
      env,
      stdio: "pipe",
    });
    backendStartedByApp = true;
  }

  const logChunk = async (prefix, buf) => {
    const text = buf.toString();
    if (text.includes("Application startup complete")) {
      backendReady = true;
    }
    try {
      await fs.appendFile(backendLogPath, `[${prefix}] ${text}`);
    } catch (err) {
      console.error("Failed to write backend log", err);
    }
    console[prefix === "stderr" ? "error" : "log"](
      `[backend/${prefix}] ${text}`
    );
  };

  backendProcess.stdout?.on("data", (data) => {
    logChunk("stdout", data);
  });
  backendProcess.stderr?.on("data", (data) => {
    logChunk("stderr", data);
  });
  backendProcess.on("exit", (code) => {
    backendReady = false;
    backendProcess = null;
    backendStartedByApp = false;
    console.warn(`Backend exited with code ${code ?? "unknown"}`);
  });

  return backendProcess;
}

async function createWindow() {
  await ensureBundledResources();
  if (await isBackendAlive()) {
    backendReady = true;
    backendStartedByApp = false;
    console.log("Reusing existing backend on port", backendPort);
  } else {
    startBackend();
  }
  await waitForBackendReady();

  const win = new BrowserWindow({
    width: WINDOW_WIDTH,
    height: WINDOW_HEIGHT,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));

  if (isDev && devServerUrl) {
    await win.loadURL(devServerUrl);
    win.webContents.openDevTools({ mode: "detach" });
  } else {
    const indexPath = path.join(
      app.getAppPath(),
      "frontend",
      "dist",
      "index.html"
    );
    await win.loadFile(indexPath);
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(createWindow);

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
      stopBackend("window-all-closed").finally(() => app.quit());
    }
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });

  app.on("before-quit", () => {
    stopBackend("before-quit");
  });
}
