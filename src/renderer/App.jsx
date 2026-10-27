import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import EmptyState from "./components/EmptyState";
import Header from "./components/Header";
import Queue from "./components/Queue";
import Sidebar from "./components/Sidebar";
import Viewer from "./components/Viewer";
import { IconAlert, IconUpload, Logo } from "./components/icons";
import { initialState, reducer } from "./store";

const OPTIONS_KEY = "lucidframe.options.v2";
const DEFAULT_OPTIONS = { model: "photo", scale: 4, format: "auto", smooth: false, cleanup: "auto", faces: "auto" };

function loadOptions(models) {
  try {
    const saved = JSON.parse(localStorage.getItem(OPTIONS_KEY) ?? "{}");
    const model = models.find((m) => m.id === saved.model && m.available) ?? models.find((m) => m.available) ?? models[0];
    return {
      model: model.id,
      scale: [2, 3, 4].includes(saved.scale) ? saved.scale : model.scale,
      format: ["auto", "png", "jpeg", "webp"].includes(saved.format) ? saved.format : "auto",
      smooth: saved.smooth === true,
      cleanup: ["auto", "on", "off"].includes(saved.cleanup) ? saved.cleanup : "auto",
      faces: ["auto", "always", "off"].includes(saved.faces) ? saved.faces : "auto",
    };
  } catch {
    return { ...DEFAULT_OPTIONS };
  }
}

export default function App() {
  const lucid = window.lucid;
  const [boot, setBoot] = useState({ state: "loading", error: null });
  const [info, setInfo] = useState(null);
  const [device, setDevice] = useState({ state: "detecting", label: "Detecting hardware…", provider: null });
  const [settings, setSettings] = useState({ outputDir: null });
  const [options, setOptionsState] = useState(DEFAULT_OPTIONS);
  const [state, dispatch] = useReducer(reducer, initialState);
  const [running, setRunning] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [notice, setNotice] = useState(null);
  const [runRequest, setRunRequest] = useState(0);

  // Refs so the long-running queue loop always sees current values.
  const stateRef = useRef(state);
  const optionsRef = useRef(options);
  const runningRef = useRef(false);
  const cancelRequested = useRef(false);
  const currentJob = useRef(null);
  const waiters = useRef(new Map());
  const finished = useRef(new Set());
  stateRef.current = state;
  optionsRef.current = options;

  const noticeTimer = useRef(null);
  const showNotice = useCallback((text) => {
    setNotice(text);
    window.clearTimeout(noticeTimer.current);
    noticeTimer.current = window.setTimeout(() => setNotice(null), 8000);
  }, []);

  // ── startup ──
  const load = useCallback(async () => {
    setBoot({ state: "loading", error: null });
    try {
      const data = await lucid.info();
      setInfo(data);
      setDevice(data.device);
      setSettings(data.settings);
      setOptionsState(loadOptions(data.models));
      setBoot({ state: "ready", error: null });
    } catch (err) {
      setBoot({ state: "error", error: String(err?.message ?? err).replace(/^Error invoking remote method '[^']+': (Error: )?/, "") });
    }
  }, [lucid]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => lucid.onDevice(setDevice), [lucid]);

  const setOptions = useCallback((patch) => {
    setOptionsState((prev) => {
      const next = { ...prev, ...patch };
      try {
        localStorage.setItem(OPTIONS_KEY, JSON.stringify(next));
      } catch {
        /* storage unavailable: options just won't persist */
      }
      return next;
    });
  }, []);

  // ── adding files ──
  const addResult = useCallback(
    ({ items, rejected }) => {
      if (items.length) dispatch({ type: "add", items });
      if (rejected?.length) {
        const first = rejected[0];
        const name = first.path.split(/[\\/]/).pop();
        showNotice(rejected.length === 1 ? `Skipped ${name}: ${first.reason}.` : `Skipped ${rejected.length} files (${name}: ${first.reason}, …).`);
      }
    },
    [showNotice],
  );

  const addPaths = useCallback(async (paths) => paths.length && addResult(await lucid.register(paths)), [addResult, lucid]);
  const addFiles = useCallback(async () => addResult(await lucid.pickFiles()), [addResult, lucid]);
  const addFolder = useCallback(async () => addResult(await lucid.pickFolder()), [addResult, lucid]);

  useEffect(() => lucid.onOpenFiles(addResult), [addResult, lucid]);

  useEffect(() => {
    let depth = 0;
    const hasFiles = (e) => e.dataTransfer?.types?.includes("Files");
    const enter = (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth++;
      setDragging(true);
    };
    const over = (e) => hasFiles(e) && e.preventDefault();
    const leave = (e) => {
      if (!hasFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (!depth) setDragging(false);
    };
    const drop = (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      setDragging(false);
      addPaths(lucid.pathsForFiles(e.dataTransfer.files));
    };
    window.addEventListener("dragenter", enter);
    window.addEventListener("dragover", over);
    window.addEventListener("dragleave", leave);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragenter", enter);
      window.removeEventListener("dragover", over);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("drop", drop);
    };
  }, [addPaths, lucid]);

  // ── job events ──
  useEffect(
    () =>
      lucid.onJob((ev) => {
        switch (ev.type) {
          case "progress":
            dispatch({ type: "progress", id: ev.itemId, data: ev });
            return;
          case "done":
            dispatch({ type: "done", id: ev.itemId, result: ev.result });
            break;
          case "cancelled":
            dispatch({ type: "cancelled", id: ev.itemId });
            break;
          case "error":
            dispatch({ type: "error", id: ev.itemId, message: ev.message });
            break;
          default:
            return;
        }
        finished.current.add(ev.jobId);
        waiters.current.get(ev.jobId)?.();
      }),
    [lucid],
  );

  const runQueue = useCallback(async () => {
    if (runningRef.current) return;
    runningRef.current = true;
    cancelRequested.current = false;
    setRunning(true);
    try {
      while (!cancelRequested.current) {
        const next = stateRef.current.items.find((i) => i.status === "queued");
        if (!next) break;
        const o = optionsRef.current;
        dispatch({ type: "start", id: next.id });
        dispatch({ type: "select", id: next.id });
        let jobId;
        try {
          ({ jobId } = await lucid.start({ itemId: next.id, model: o.model, scale: o.scale, format: next.kind === "image" ? o.format : "auto", smooth: next.kind === "video" ? o.smooth : false, cleanup: o.cleanup, faces: o.faces }));
        } catch (err) {
          dispatch({ type: "error", id: next.id, message: String(err?.message ?? err).replace(/^Error invoking remote method '[^']+': (Error: )?/, "") });
          continue;
        }
        currentJob.current = jobId;
        if (!finished.current.has(jobId)) await new Promise((resolve) => waiters.current.set(jobId, resolve));
        waiters.current.delete(jobId);
        finished.current.delete(jobId);
        currentJob.current = null;
      }
    } finally {
      runningRef.current = false;
      setRunning(false);
    }
  }, [lucid]);

  const cancel = useCallback(() => {
    cancelRequested.current = true;
    if (currentJob.current) lucid.cancel(currentJob.current);
  }, [lucid]);

  // ── actions passed to the viewer ──
  const actions = useMemo(
    () => ({
      reveal: (p) => lucid.reveal(p).catch(() => {}),
      open: (p) => lucid.open(p).catch((e) => showNotice(String(e?.message ?? e))),
      saveCopy: (p) => lucid.saveCopy(p).then((saved) => saved && showNotice(`Saved a copy to ${saved}`)),
      // The queue loop reads the item list from the latest render, so it must start after the requeue has rendered.
      redo: (id) => {
        dispatch({ type: "requeue", id });
        setRunRequest((n) => n + 1);
      },
    }),
    [lucid, showNotice],
  );

  useEffect(() => {
    if (runRequest > 0) runQueue();
  }, [runRequest, runQueue]);

  const selected = state.items.find((i) => i.id === state.selectedId) ?? null;
  const queuedCount = state.items.filter((i) => i.status === "queued").length;
  const hasImage = state.items.some((i) => i.kind === "image");
  const hasVideo = state.items.some((i) => i.kind === "video");

  const chooseOutputFolder = useCallback(async () => setSettings(await lucid.chooseOutputFolder()), [lucid]);
  const resetOutputFolder = useCallback(async () => setSettings(await lucid.setSettings({ outputDir: null })), [lucid]);

  // ── render ──
  if (boot.state !== "ready") {
    return (
      <div className="splash" role={boot.state === "error" ? "alert" : "status"}>
        <Logo size={40} />
        {boot.state === "loading" ? (
          <>
            <h1>LucidFrame</h1>
            <p>Starting up…</p>
            <span className="spinner big" aria-hidden="true" />
          </>
        ) : (
          <>
            <h1>LucidFrame couldn’t start its engine</h1>
            <p className="error-text">{boot.error}</p>
            <div className="empty-actions">
              <button type="button" className="btn primary" onClick={load}>
                Try again
              </button>
              <button type="button" className="btn" onClick={() => lucid.openLogs()}>
                Open log folder
              </button>
            </div>
          </>
        )}
      </div>
    );
  }

  return (
    <div className="app">
      <Header device={device} selected={selected} />
      <Sidebar
        info={info}
        device={device}
        options={options}
        setOptions={setOptions}
        selected={selected}
        hasItems={state.items.length > 0}
        hasImage={hasImage || !hasVideo}
        hasVideo={hasVideo}
        settings={settings}
        onChooseFolder={chooseOutputFolder}
        onResetFolder={resetOutputFolder}
        queuedCount={queuedCount}
        running={running}
        onStart={runQueue}
        onCancel={cancel}
      />
      <main className="main">
        {notice && (
          <div className="notice" role="status">
            <IconAlert size={16} />
            <span>{notice}</span>
            <button type="button" className="icon-btn" onClick={() => setNotice(null)} aria-label="Dismiss">
              ×
            </button>
          </div>
        )}
        {state.items.length === 0 ? (
          <EmptyState onAddFiles={addFiles} onAddFolder={addFolder} />
        ) : (
          <>
            {selected && <Viewer item={selected} actions={actions} onDims={(id, w, h) => dispatch({ type: "dims", id, w, h })} onCancel={cancel} />}
            <Queue
              state={state}
              running={running}
              onSelect={(id) => dispatch({ type: "select", id })}
              onRemove={(id) => dispatch({ type: "remove", id })}
              onClear={() => dispatch({ type: "clear" })}
              onAddFiles={addFiles}
              onAddFolder={addFolder}
            />
          </>
        )}
      </main>
      {dragging && (
        <div className="drop-overlay" aria-hidden="true">
          <div>
            <IconUpload size={28} />
            <p>Drop to add to the queue</p>
          </div>
        </div>
      )}
    </div>
  );
}
