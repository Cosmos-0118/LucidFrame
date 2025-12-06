import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";

const defaultBackend = "http://localhost:8000";

const cleanUrl = (url) => url.trim().replace(/\/$/, "");
const getStored = (key, fallback) => localStorage.getItem(key) || fallback;

function App() {
  const imageInputRef = useRef(null);
  const videoInputRef = useRef(null);
  const pollRef = useRef(null);

  const [activeTab, setActiveTab] = useState("image");
  const [backendUrl, setBackendUrl] = useState(() => getStored("hyperrestore.backend", defaultBackend));
  const [mode, setMode] = useState("photo");
  const [scale, setScale] = useState(2);
  const [faceRestore, setFaceRestore] = useState(false);
  const [beforeUrl, setBeforeUrl] = useState("");
  const [afterUrl, setAfterUrl] = useState("");
  const [status, setStatus] = useState("Drop an image to start");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [slider, setSlider] = useState(50);

  const [videoScale, setVideoScale] = useState(2);
  const [videoInterpolate, setVideoInterpolate] = useState(false);
  const [videoFace, setVideoFace] = useState(false);
  const [videoStatus, setVideoStatus] = useState("Drop a video to start");
  const [videoError, setVideoError] = useState("");
  const [videoJobId, setVideoJobId] = useState("");
  const [videoLoading, setVideoLoading] = useState(false);
  const [videoSrcUrl, setVideoSrcUrl] = useState("");
  const [videoOutUrl, setVideoOutUrl] = useState("");

  const [modelDir, setModelDir] = useState(() => getStored("hyperrestore.modeldir", "models/"));
  const [ffmpegPath, setFfmpegPath] = useState(() => getStored("hyperrestore.ffmpeg", "bin/ffmpeg.exe"));
  const [tileSize, setTileSize] = useState(() => getStored("hyperrestore.tile", "256"));
  const [useFp16, setUseFp16] = useState(() => getStored("hyperrestore.fp16", "true") === "true");
  const [health, setHealth] = useState({ status: "unknown", device: "", version: "" });

  useEffect(() => {
    localStorage.setItem("hyperrestore.backend", backendUrl);
  }, [backendUrl]);

  useEffect(() => {
    localStorage.setItem("hyperrestore.modeldir", modelDir);
  }, [modelDir]);

  useEffect(() => {
    localStorage.setItem("hyperrestore.ffmpeg", ffmpegPath);
  }, [ffmpegPath]);

  useEffect(() => {
    localStorage.setItem("hyperrestore.tile", tileSize);
  }, [tileSize]);

  useEffect(() => {
    localStorage.setItem("hyperrestore.fp16", String(useFp16));
  }, [useFp16]);

  const fetchHealth = useCallback(async () => {
    try {
      const res = await fetch(`${cleanUrl(backendUrl)}/health`);
      if (!res.ok) throw new Error("health failed");
      const data = await res.json();
      setHealth({ status: "ok", device: data.device, version: data.version, amp: data.amp, half: data.half });
    } catch (err) {
      setHealth({ status: "unreachable", device: "", version: "" });
    }
  }, [backendUrl]);

  useEffect(() => {
    fetchHealth();
    return () => {
      if (pollRef.current) clearTimeout(pollRef.current);
      if (beforeUrl) URL.revokeObjectURL(beforeUrl);
      if (afterUrl) URL.revokeObjectURL(afterUrl);
      if (videoSrcUrl) URL.revokeObjectURL(videoSrcUrl);
      if (videoOutUrl) URL.revokeObjectURL(videoOutUrl);
    };
  }, []); // run once

  const handleImageSelect = () => imageInputRef.current?.click();
  const handleVideoSelect = () => videoInputRef.current?.click();

  const resetImagePreview = useCallback(() => {
    if (beforeUrl) URL.revokeObjectURL(beforeUrl);
    if (afterUrl) URL.revokeObjectURL(afterUrl);
    setBeforeUrl("");
    setAfterUrl("");
    setSlider(50);
  }, [afterUrl, beforeUrl]);

  const resetVideoPreview = useCallback(() => {
    if (videoSrcUrl) URL.revokeObjectURL(videoSrcUrl);
    if (videoOutUrl) URL.revokeObjectURL(videoOutUrl);
    setVideoSrcUrl("");
    setVideoOutUrl("");
    setVideoJobId("");
    setVideoStatus("Drop a video to start");
    setVideoError("");
    if (pollRef.current) clearTimeout(pollRef.current);
  }, [videoOutUrl, videoSrcUrl]);

  const onImageFile = (file) => {
    startImageJob(file);
  };

  const onVideoFile = (file) => {
    startVideoJob(file);
  };

  const startImageJob = useCallback(
    async (file) => {
      resetImagePreview();
      setError("");
      setStatus("Uploading...");
      setLoading(true);

      const isImage = file.type.startsWith("image/");
      if (!isImage) {
        setError("Please drop an image file.");
        setLoading(false);
        return;
      }

      const beforeObjectUrl = URL.createObjectURL(file);
      setBeforeUrl(beforeObjectUrl);

      const form = new FormData();
      form.append("file", file);
      form.append("mode", mode);
      form.append("scale", String(scale));
      form.append("face_restore", String(faceRestore));

      const endpoint = `${cleanUrl(backendUrl)}/image/upscale`;

      try {
        const response = await fetch(endpoint, {
          method: "POST",
          body: form,
        });
        if (!response.ok) {
          const text = await response.text();
          throw new Error(text || "Request failed");
        }
        setStatus("Processing...");
        const blob = await response.blob();
        const url = URL.createObjectURL(blob);
        setAfterUrl(url);
        setStatus("Done");
      } catch (err) {
        setError(err.message || "Upload failed");
        setStatus("Error");
      } finally {
        setLoading(false);
      }
    },
    [backendUrl, faceRestore, mode, resetImagePreview, scale],
  );

  const pollJob = useCallback(
    async (jobId) => {
      try {
        const res = await fetch(`${cleanUrl(backendUrl)}/jobs/${jobId}`);
        if (!res.ok) throw new Error("job status failed");
        const data = await res.json();
        setVideoStatus(`${data.status}: ${data.message || ""}`.trim());

        if (data.status === "completed") {
          const result = await fetch(`${cleanUrl(backendUrl)}/jobs/${jobId}/result`);
          if (!result.ok) throw new Error("could not download result");
          const blob = await result.blob();
          const url = URL.createObjectURL(blob);
          setVideoOutUrl(url);
          setVideoLoading(false);
          setVideoStatus("Done");
          return;
        }

        if (data.status === "failed") {
          setVideoError(data.message || "Job failed");
          setVideoLoading(false);
          return;
        }

        pollRef.current = setTimeout(() => pollJob(jobId), 2000);
      } catch (err) {
        setVideoError(err.message || "Polling failed");
        setVideoLoading(false);
      }
    },
    [backendUrl],
  );

  const startVideoJob = useCallback(
    async (file) => {
      resetVideoPreview();
      setVideoLoading(true);
      setVideoError("");
      setVideoStatus("Uploading...");

      const isVideo = file.type.startsWith("video/");
      if (!isVideo) {
        setVideoError("Please drop a video file.");
        setVideoLoading(false);
        return;
      }

      const srcUrl = URL.createObjectURL(file);
      setVideoSrcUrl(srcUrl);

      const form = new FormData();
      form.append("file", file);
      form.append("scale", String(videoScale));
      form.append("face_restore", String(videoFace));
      form.append("interpolate", String(videoInterpolate));

      const endpoint = `${cleanUrl(backendUrl)}/video/upscale`;
      try {
        const response = await fetch(endpoint, { method: "POST", body: form });
        if (!response.ok) {
          const text = await response.text();
          throw new Error(text || "Video request failed");
        }
        const data = await response.json();
        setVideoJobId(data.job_id);
        setVideoStatus(data.message || "queued");
        pollJob(data.job_id);
      } catch (err) {
        setVideoError(err.message || "Video upload failed");
        setVideoStatus("Error");
        setVideoLoading(false);
      }
    },
    [backendUrl, pollJob, resetVideoPreview, videoFace, videoInterpolate, videoScale],
  );

  const downloadAfter = () => {
    if (!afterUrl) return;
    const link = document.createElement("a");
    link.href = afterUrl;
    link.download = "hyperrestore.png";
    link.click();
  };

  const downloadVideo = () => {
    if (!videoOutUrl) return;
    const link = document.createElement("a");
    link.href = videoOutUrl;
    link.download = "hyperrestore.mp4";
    link.click();
  };

  const canCompare = useMemo(() => beforeUrl && afterUrl, [afterUrl, beforeUrl]);

  return (
    <div className="page">
      <div className="chrome">
        <header className="header">
          <div>
            <p className="eyebrow">HyperRestore · MVP</p>
            <h1>Upscale with confidence.</h1>
            <p className="lede">Drop media, pick a mode, and let the backend do the heavy lifting.</p>
          </div>
          <div className="backend">
            <label className="label" htmlFor="backend-url">
              Backend URL
            </label>
            <input
              id="backend-url"
              type="text"
              value={backendUrl}
              onChange={(e) => setBackendUrl(e.target.value)}
              placeholder={defaultBackend}
            />
            <button className="ghost" type="button" onClick={fetchHealth}>
              Refresh health
            </button>
          </div>
        </header>

        <div className="tabs">
          {[
            { key: "image", label: "Image" },
            { key: "video", label: "Video" },
          ].map((tab) => (
            <button
              key={tab.key}
              className={`tab ${activeTab === tab.key ? "active" : ""}`}
              type="button"
              onClick={() => setActiveTab(tab.key)}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {activeTab === "image" && (
          <>
            <section className="controls">
              <div className="control-group">
                <span className="label">Mode</span>
                <div className="pill-group">
                  {["photo", "anime"].map((value) => (
                    <button
                      key={value}
                      className={`pill ${mode === value ? "active" : ""}`}
                      onClick={() => setMode(value)}
                      type="button"
                    >
                      {value === "photo" ? "Photo" : "Anime"}
                    </button>
                  ))}
                </div>
              </div>
              <div className="control-group">
                <span className="label">Scale</span>
                <div className="pill-group">
                  {[2, 4].map((value) => (
                    <button
                      key={value}
                      className={`pill ${scale === value ? "active" : ""}`}
                      onClick={() => setScale(value)}
                      type="button"
                    >
                      {value}×
                    </button>
                  ))}
                </div>
              </div>
              <div className="control-group">
                <span className="label">Face restore</span>
                <label className="switch">
                  <input
                    type="checkbox"
                    checked={faceRestore}
                    onChange={(e) => setFaceRestore(e.target.checked)}
                  />
                  <span className="slider" />
                </label>
              </div>
              <div className="control-group status">
                <span className="label">Status</span>
                <p className="status-text">{loading ? "Working…" : status}</p>
              </div>
            </section>

            <section
              className={`dropzone ${loading ? "is-loading" : ""}`}
              onDrop={(e) => {
                e.preventDefault();
                const file = e.dataTransfer.files?.[0];
                if (file) onImageFile(file);
              }}
              onDragOver={(e) => e.preventDefault()}
              onClick={handleImageSelect}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") handleImageSelect();
              }}
            >
              <input ref={imageInputRef} type="file" accept="image/*" hidden onChange={(e) => e.target.files?.[0] && onImageFile(e.target.files[0])} />
              <div className="drop-inner">
                <div className="badge">Step 4.2</div>
                <p className="drop-title">Drop an image or click to browse</p>
                <p className="hint">We send it to the backend and stream back a PNG.</p>
                {loading && <div className="spinner" aria-label="Processing" />}
              </div>
            </section>

            {error && <div className="alert">{error}</div>}

            <section className="gallery">
              <div className="panel">
                <div className="panel-head">
                  <span className="chip">Before</span>
                  <span className="meta">Drag file to preview</span>
                </div>
                <div className="panel-body">
                  {beforeUrl ? <img src={beforeUrl} alt="Before" /> : <p className="placeholder">No image yet</p>}
                </div>
              </div>
              <div className="panel">
                <div className="panel-head">
                  <span className="chip">After</span>
                  <span className="meta">Processed output</span>
                </div>
                <div className="panel-body">
                  {afterUrl ? <img src={afterUrl} alt="After" /> : <p className="placeholder">Run a job to see results</p>}
                </div>
              </div>
            </section>

            {canCompare && (
              <section className="compare">
                <div className="panel-head">
                  <span className="chip">Before / After</span>
                  <span className="meta">Slide to inspect differences</span>
                </div>
                <div className="compare-body">
                  <div className="compare-frame">
                    <img src={beforeUrl} alt="Before" className="compare-img" />
                    <div className="compare-overlay" style={{ width: `${slider}%` }}>
                      <img src={afterUrl} alt="After" className="compare-img" />
                    </div>
                  </div>
                  <input
                    type="range"
                    min="0"
                    max="100"
                    value={slider}
                    onChange={(e) => setSlider(Number(e.target.value))}
                  />
                </div>
              </section>
            )}

            <section className="actions">
              <button type="button" className="ghost" onClick={resetImagePreview} disabled={!beforeUrl && !afterUrl}>
                Reset
              </button>
              <button type="button" className="primary" onClick={downloadAfter} disabled={!afterUrl}>
                Download PNG
              </button>
            </section>
          </>
        )}

        {activeTab === "video" && (
          <>
            <section className="controls">
              <div className="control-group">
                <span className="label">Scale</span>
                <div className="pill-group">
                  {[2, 4].map((value) => (
                    <button
                      key={value}
                      className={`pill ${videoScale === value ? "active" : ""}`}
                      onClick={() => setVideoScale(value)}
                      type="button"
                    >
                      {value}×
                    </button>
                  ))}
                </div>
              </div>
              <div className="control-group">
                <span className="label">Interpolate</span>
                <label className="switch">
                  <input
                    type="checkbox"
                    checked={videoInterpolate}
                    onChange={(e) => setVideoInterpolate(e.target.checked)}
                  />
                  <span className="slider" />
                </label>
              </div>
              <div className="control-group">
                <span className="label">Face restore</span>
                <label className="switch">
                  <input
                    type="checkbox"
                    checked={videoFace}
                    onChange={(e) => setVideoFace(e.target.checked)}
                  />
                  <span className="slider" />
                </label>
              </div>
              <div className="control-group status">
                <span className="label">Status</span>
                <p className="status-text">{videoLoading ? "Working…" : videoStatus}</p>
              </div>
            </section>

            <section
              className={`dropzone ${videoLoading ? "is-loading" : ""}`}
              onDrop={(e) => {
                e.preventDefault();
                const file = e.dataTransfer.files?.[0];
                if (file) onVideoFile(file);
              }}
              onDragOver={(e) => e.preventDefault()}
              onClick={handleVideoSelect}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") handleVideoSelect();
              }}
            >
              <input ref={videoInputRef} type="file" accept="video/*" hidden onChange={(e) => e.target.files?.[0] && onVideoFile(e.target.files[0])} />
              <div className="drop-inner">
                <div className="badge">Step 4.3</div>
                <p className="drop-title">Drop a video or click to browse</p>
                <p className="hint">Starts a backend job and polls until ready.</p>
                {videoLoading && <div className="spinner" aria-label="Processing" />}
              </div>
            </section>

            {videoError && <div className="alert">{videoError}</div>}

            <section className="video-grid">
              <div className="panel">
                <div className="panel-head">
                  <span className="chip">Source</span>
                  {videoJobId && <span className="meta">Job: {videoJobId}</span>}
                </div>
                <div className="panel-body">
                  {videoSrcUrl ? (
                    <video src={videoSrcUrl} controls className="video-player" />
                  ) : (
                    <p className="placeholder">No video yet</p>
                  )}
                </div>
              </div>
              <div className="panel">
                <div className="panel-head">
                  <span className="chip">Output</span>
                  <span className="meta">Preview + download</span>
                </div>
                <div className="panel-body">
                  {videoOutUrl ? (
                    <video src={videoOutUrl} controls className="video-player" />
                  ) : (
                    <p className="placeholder">Waiting for completion</p>
                  )}
                </div>
              </div>
            </section>

            <section className="actions">
              <button type="button" className="ghost" onClick={resetVideoPreview} disabled={!videoSrcUrl && !videoOutUrl}>
                Reset
              </button>
              <button type="button" className="primary" onClick={downloadVideo} disabled={!videoOutUrl}>
                Download MP4
              </button>
            </section>
          </>
        )}

        <section className="settings">
          <div className="panel">
            <div className="panel-head">
              <span className="chip">Settings</span>
              <span className="meta">Step 4.4</span>
            </div>
            <div className="settings-grid">
              <label className="field">
                <span className="label">Models directory</span>
                <input type="text" value={modelDir} onChange={(e) => setModelDir(e.target.value)} />
              </label>
              <label className="field">
                <span className="label">FFmpeg path</span>
                <input type="text" value={ffmpegPath} onChange={(e) => setFfmpegPath(e.target.value)} />
              </label>
              <label className="field">
                <span className="label">Tile size</span>
                <input type="number" min="64" max="512" value={tileSize} onChange={(e) => setTileSize(e.target.value)} />
              </label>
              <label className="field switch-field">
                <span className="label">FP16</span>
                <label className="switch">
                  <input type="checkbox" checked={useFp16} onChange={(e) => setUseFp16(e.target.checked)} />
                  <span className="slider" />
                </label>
              </label>
            </div>
          </div>
          <div className="panel">
            <div className="panel-head">
              <span className="chip">System</span>
              <span className="meta">Health</span>
            </div>
            <div className="system">
              <p className="meta">Status: {health.status}</p>
              {health.device && <p className="meta">Device: {health.device}</p>}
              {health.version && <p className="meta">Backend v{health.version}</p>}
              {health.amp !== undefined && (
                <p className="meta">AMP: {health.amp ? "on" : "off"} · Half: {health.half ? "yes" : "no"}</p>
              )}
              <p className="hint">Settings are stored locally for now.</p>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}

export default App;
