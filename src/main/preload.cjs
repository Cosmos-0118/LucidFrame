// Preload script (sandboxed, so CommonJS). Exposes one small, frozen API to the page. Every call
// is a plain request to the main process, which validates it; the page never touches Node,
// the filesystem or raw paths beyond what the user dropped or picked.
const { contextBridge, ipcRenderer, webUtils } = require("electron");

const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args);

function subscribe(channel, callback) {
  if (typeof callback !== "function") throw new TypeError("callback must be a function");
  const handler = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

contextBridge.exposeInMainWorld(
  "lucid",
  Object.freeze({
    platform: process.platform,
    info: () => invoke("app:info"),
    onDevice: (cb) => subscribe("device:update", cb),
    onJob: (cb) => subscribe("job:event", cb),
    onOpenFiles: (cb) => subscribe("files:opened", cb),

    /** Paths of files dropped onto the window (File objects → real paths). */
    pathsForFiles: (files) => Array.from(files ?? [], (f) => webUtils.getPathForFile(f)).filter(Boolean),
    register: (paths) => invoke("files:register", paths),
    pickFiles: () => invoke("files:pick"),
    pickFolder: () => invoke("files:pickFolder"),

    start: (request) => invoke("job:start", request),
    cancel: (jobId) => invoke("job:cancel", jobId),

    reveal: (filePath) => invoke("file:reveal", filePath),
    open: (filePath) => invoke("file:open", filePath),
    saveCopy: (filePath) => invoke("file:saveCopy", filePath),

    getSettings: () => invoke("settings:get"),
    setSettings: (patch) => invoke("settings:set", patch),
    chooseOutputFolder: () => invoke("settings:chooseOutputFolder"),

    openLogs: () => invoke("app:openLogs"),
    openProjectPage: () => invoke("app:openProjectPage"),
  }),
);
