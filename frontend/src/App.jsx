import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";

const defaultBackend = "http://localhost:8000";

const cleanUrl = (url) => url.trim().replace(/\/$/, "");
const getStored = (key, fallback) => localStorage.getItem(key) || fallback;

function App() {
  const imageInputRef = useRef(null);
  const videoInputRef = useRef(null);
  const pollRef = useRef(null);
  const statusTimerRef = useRef(null);
  const loadingRef = useRef(false);
  const fileCacheRef = useRef({ key: "", afterBlob: null, warning: "", mp: "" });

  const [activeTab, setActiveTab] = useState("image");
  const [backendUrl, setBackendUrl] = useState(() => getStored("lucidframe.backend", defaultBackend));
  const [mode, setMode] = useState("photo");
  const [scale, setScale] = useState(2);
  const [faceRestore, setFaceRestore] = useState(false);
  const [textSafe, setTextSafe] = useState(false);
  const [sharpenStrength, setSharpenStrength] = useState(0);
  const [denoiseStrength, setDenoiseStrength] = useState(0);
  const [brightness, setBrightness] = useState(1);
  const [autoEnhance, setAutoEnhance] = useState(false);
  const [exposure, setExposure] = useState(1);
  const [contrast, setContrast] = useState(1);
  const [saturation, setSaturation] = useState(1);
  const [tonePreset, setTonePreset] = useState("none");
  const [presetIntensity, setPresetIntensity] = useState(1);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [inputHint, setInputHint] = useState("");
  const [beforeUrl, setBeforeUrl] = useState("");
  const [afterUrl, setAfterUrl] = useState("");
  const [status, setStatus] = useState("Drop an image to start");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [showAfter, setShowAfter] = useState(true);

  const [videoScale, setVideoScale] = useState(2);
  const [videoInterpolate, setVideoInterpolate] = useState(false);
  const [videoFace, setVideoFace] = useState(false);
  const [videoStatus, setVideoStatus] = useState("Drop a video to start");
  const [videoError, setVideoError] = useState("");
  const [videoJobId, setVideoJobId] = useState("");
  const [videoLoading, setVideoLoading] = useState(false);
  const [videoSrcUrl, setVideoSrcUrl] = useState("");
  const [videoOutUrl, setVideoOutUrl] = useState("");

  const [modelDir, setModelDir] = useState(() => getStored("lucidframe.modeldir", "models/"));
  const [ffmpegPath, setFfmpegPath] = useState(() => getStored("lucidframe.ffmpeg", "bin/ffmpeg.exe"));
  const [tileSize, setTileSize] = useState(() => getStored("lucidframe.tile", "256"));
  const [useFp16, setUseFp16] = useState(() => getStored("lucidframe.fp16", "true") === "true");
  const [health, setHealth] = useState({ status: "unknown", device: "", version: "" });
  const [healthLoading, setHealthLoading] = useState(true);

  useEffect(() => {
    localStorage.setItem("lucidframe.backend", backendUrl);
  }, [backendUrl]);

  useEffect(() => {
    localStorage.setItem("lucidframe.modeldir", modelDir);
  }, [modelDir]);

  useEffect(() => {
    localStorage.setItem("lucidframe.ffmpeg", ffmpegPath);
  }, [ffmpegPath]);

  useEffect(() => {
    localStorage.setItem("lucidframe.tile", tileSize);
  }, [tileSize]);

  useEffect(() => {
    localStorage.setItem("lucidframe.fp16", String(useFp16));
  }, [useFp16]);

  const fetchHealth = useCallback(async () => {
    setHealthLoading(true);
    try {
      const res = await fetch(`${cleanUrl(backendUrl)}/health`);
      if (!res.ok) throw new Error("health failed");
      const data = await res.json();
      setHealth({ status: "ok", device: data.device, version: data.version, amp: data.amp, half: data.half });
    } catch (err) {
      setHealth({ status: "unreachable", device: "", version: "" });
    } finally {
      setHealthLoading(false);
    }
  }, [backendUrl]);

  useEffect(() => {
    fetchHealth();
    return () => {
      if (statusTimerRef.current) clearTimeout(statusTimerRef.current);
      if (pollRef.current) clearTimeout(pollRef.current);
      if (beforeUrl) URL.revokeObjectURL(beforeUrl);
      if (afterUrl) URL.revokeObjectURL(afterUrl);
      if (videoSrcUrl) URL.revokeObjectURL(videoSrcUrl);
      if (videoOutUrl) URL.revokeObjectURL(videoOutUrl);
    };
  }, []); // run once

  useEffect(() => {
    if (!beforeUrl && !afterUrl && !loading) {
      setStatus(healthLoading ? "Warming backend…" : "Drop an image to start");
    }
  }, [afterUrl, beforeUrl, healthLoading, loading]);

  const clearImageInput = () => {
    if (imageInputRef.current) imageInputRef.current.value = "";
  };
  const clearVideoInput = () => {
    if (videoInputRef.current) videoInputRef.current.value = "";
  };

  const handleImageSelect = () => imageInputRef.current?.click();
  const handleVideoSelect = () => videoInputRef.current?.click();

  const resetImagePreview = useCallback(() => {
    if (statusTimerRef.current) {
      clearTimeout(statusTimerRef.current);
      statusTimerRef.current = null;
    }
    loadingRef.current = false;
    if (beforeUrl) URL.revokeObjectURL(beforeUrl);
    if (afterUrl) URL.revokeObjectURL(afterUrl);
    setBeforeUrl("");
    setAfterUrl("");
    setShowAfter(true);
    setStatus("Drop an image to start");
    setError("");
    setLoading(false);
    setInputHint("");
    clearImageInput();
  }, [afterUrl, beforeUrl]);

  const resetVideoPreview = useCallback(() => {
    if (videoSrcUrl) URL.revokeObjectURL(videoSrcUrl);
    if (videoOutUrl) URL.revokeObjectURL(videoOutUrl);
    setVideoSrcUrl("");
    setVideoOutUrl("");
    setVideoJobId("");
    setVideoStatus("Drop a video to start");
    setVideoError("");
    setVideoLoading(false);
    clearVideoInput();
    if (pollRef.current) clearTimeout(pollRef.current);
  }, [videoOutUrl, videoSrcUrl]);

  const analyzeImageFile = useCallback((file, reuseUrl) => {
    const url = reuseUrl || URL.createObjectURL(file);
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const mp = (img.width * img.height) / 1e6;
        let warning = "";
        if (mp > 12) warning = "Large input (>12MP); using safer tiling";
        else if (mp < 0.25) warning = "Tiny input; 4× recommended for better detail";
        resolve({ width: img.width, height: img.height, mp, warning, url });
        if (!reuseUrl) URL.revokeObjectURL(url);
      };
      img.onerror = () => {
        resolve({ width: 0, height: 0, mp: 0, warning: "" });
        if (!reuseUrl) URL.revokeObjectURL(url);
      };
      img.src = url;
    });
  }, []);

  const hashFile = useCallback(async (file) => {
    const buf = await file.arrayBuffer();
    const hashBuffer = await crypto.subtle.digest("SHA-256", buf);
    return Array.from(new Uint8Array(hashBuffer))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }, []);

  const resetAdvanced = useCallback(() => {
    setBrightness(1);
    setExposure(1);
    setContrast(1);
    setSaturation(1);
    setAutoEnhance(false);
    setDenoiseStrength(0);
    setTonePreset("none");
    setSharpenStrength(0);
    setPresetIntensity(1);
    setInputHint("");
  }, []);

  const applyPresetValues = useCallback(
    (preset, intensity = presetIntensity) => {
      if (preset === "none") {
        resetAdvanced();
        return;
      }

      const defs = {
        night: {
          label: "Night fix",
          autoEnhance: true,
          exposure: 1.2,
          contrast: 0.9,
          saturation: 1.12,
          denoise: 0.24,
          sharpen: 0.2,
        },
        portrait: {
          label: "Portrait clean",
          autoEnhance: true,
          exposure: 1.06,
          contrast: 1.05,
          saturation: 1.08,
          denoise: 0.16,
          sharpen: 0.16,
        },
        print: {
          label: "Print-ready",
          autoEnhance: false,
          exposure: 1.0,
          contrast: 1.18,
          saturation: 0.95,
          denoise: 0.08,
          sharpen: 0.26,
        },
      };

      const def = defs[preset];
      if (!def) return;
      setTonePreset(preset);
      setAdvancedOpen(true);

      const lerp = (target, neutral) => neutral + (target - neutral) * intensity;

      setAutoEnhance(def.autoEnhance);
      setExposure(lerp(def.exposure, 1));
      setContrast(lerp(def.contrast, 1));
      setSaturation(lerp(def.saturation, 1));
      setDenoiseStrength(lerp(def.denoise, 0));
      setSharpenStrength((v) => Math.max(v, lerp(def.sharpen, 0)));
      setInputHint(`${def.label} preset applied` + (intensity !== 1 ? ` (intensity ${intensity.toFixed(2)})` : ""));
    },
    [presetIntensity, resetAdvanced],
  );

  const applyTonePreset = useCallback(
    (preset) => {
      applyPresetValues(preset, presetIntensity);
    },
    [applyPresetValues, presetIntensity],
  );

  useEffect(() => {
    if (tonePreset !== "none") {
      applyPresetValues(tonePreset, presetIntensity);
    }
  }, [applyPresetValues, presetIntensity, tonePreset]);

  const onImageFile = (file) => {
    if (!file) return;
    startImageJob(file);
    clearImageInput();
  };

  const onVideoFile = (file) => {
    if (!file) return;
    startVideoJob(file);
    clearVideoInput();
  };

  const startImageJob = useCallback(
    async (file) => {
      setError("");
      setStatus("Inspecting input…");
      setLoading(true);
      loadingRef.current = true;

      if (statusTimerRef.current) {
        clearTimeout(statusTimerRef.current);
        statusTimerRef.current = null;
      }

      const isImage = file.type.startsWith("image/");
      if (!isImage) {
        setError("Please drop an image file.");
        setLoading(false);
        loadingRef.current = false;
        return;
      }

      const fileHash = await hashFile(file);
      const cacheKey = [
        fileHash,
        mode,
        scale,
        faceRestore,
        textSafe,
        autoEnhance,
        brightness,
        exposure,
        contrast,
        saturation,
        denoiseStrength,
        sharpenStrength,
        tonePreset,
        presetIntensity,
      ].join("|");

      if (fileCacheRef.current.key === cacheKey && fileCacheRef.current.afterBlob) {
        const cachedAfterUrl = URL.createObjectURL(fileCacheRef.current.afterBlob);
        const cachedBeforeUrl = URL.createObjectURL(file);
        resetImagePreview();
        setBeforeUrl(cachedBeforeUrl);
        setAfterUrl(cachedAfterUrl);
        setShowAfter(true);
        setLoading(false);
        setStatus("Loaded from cache (same file + settings)");
        setInputHint(fileCacheRef.current.warning || "Skipped upload via cache");
        return;
      }

      resetImagePreview();

      const beforeObjectUrl = URL.createObjectURL(file);
      const analysis = await analyzeImageFile(file, beforeObjectUrl);
      setBeforeUrl(beforeObjectUrl);
      setShowAfter(false);
      if (analysis.warning) {
        setInputHint(analysis.warning);
        setStatus(analysis.warning);
      } else {
        setStatus("Uploading…");
      }

      statusTimerRef.current = setTimeout(() => {
        if (loadingRef.current) setStatus("Processing…");
      }, 1200);

      const form = new FormData();
      form.append("file", file);
      form.append("mode", mode);
      form.append("scale", String(scale));
      form.append("face_restore", String(faceRestore));
      form.append("denoise_strength", String(denoiseStrength));
      form.append("sharpen_strength", String(sharpenStrength));
      form.append("text_mode", String(textSafe));
      form.append("brightness", String(brightness));
      form.append("auto_enhance", String(autoEnhance));
      form.append("exposure", String(exposure));
      form.append("contrast", String(contrast));
      form.append("saturation", String(saturation));

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
        if (statusTimerRef.current) {
          clearTimeout(statusTimerRef.current);
          statusTimerRef.current = null;
        }
        setStatus("Processing…");
        const warningHeader = response.headers.get("x-warning");
        const tileHeader = response.headers.get("x-tile");
        const mpHeader = response.headers.get("x-input-mp");
        const blob = await response.blob();
        const url = URL.createObjectURL(blob);
        setAfterUrl(url);
        const statusParts = ["Done"];
        if (warningHeader) statusParts.push(warningHeader);
        if (tileHeader) statusParts.push(`tile ${tileHeader}px`);
        if (mpHeader) statusParts.push(`${mpHeader} MP input`);
        setStatus(statusParts.join(" · "));
        const mergedWarning = warningHeader || analysis.warning || "";
        if (mergedWarning) setInputHint(mergedWarning);
        fileCacheRef.current = {
          key: cacheKey,
          afterBlob: blob,
          warning: mergedWarning,
          mp: mpHeader || String(analysis.mp || ""),
        };
        setShowAfter(true);
      } catch (err) {
        setError(err.message || "Upload failed");
        setStatus("Error");
      } finally {
        if (statusTimerRef.current) {
          clearTimeout(statusTimerRef.current);
          statusTimerRef.current = null;
        }
        setLoading(false);
        loadingRef.current = false;
      }
    },
    [analyzeImageFile, autoEnhance, backendUrl, brightness, contrast, denoiseStrength, exposure, faceRestore, hashFile, mode, resetImagePreview, saturation, scale, sharpenStrength, textSafe],
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
    link.download = "lucidframe.png";
    link.click();
  };

  const downloadVideo = () => {
    if (!videoOutUrl) return;
    const link = document.createElement("a");
    link.href = videoOutUrl;
    link.download = "lucidframe.mp4";
    link.click();
  };

  const canCompare = useMemo(() => beforeUrl && afterUrl, [afterUrl, beforeUrl]);
  const showPreviewOverlay = loading || error;

  return (
    <div className="page">
      {healthLoading && (
        <div className="boot-overlay" role="status" aria-live="polite">
          <div className="boot-card">
            <div className="spinner" aria-label="Starting backend" />
            <p className="boot-text">Starting app & backend…</p>
            <p className="boot-sub">This can take a few seconds while models load.</p>
          </div>
        </div>
      )}

      <div className="chrome">
        {health.status === "unreachable" && !healthLoading && (
          <div className="alert soft">
            Backend not reachable at <strong>{cleanUrl(backendUrl)}</strong>. Start the backend or update the URL, then
            hit Refresh.
          </div>
        )}

        <header className="header">
          <div>
            <p className="eyebrow">LucidFrame · MVP</p>
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
            <button className="ghost" type="button" onClick={fetchHealth} disabled={healthLoading}>
              {healthLoading ? "Checking…" : "Refresh health"}
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
                <select
                  className="select"
                  value={mode}
                  onChange={(e) => {
                    const val = e.target.value;
                    setMode(val);
                    if (val === "clean") setScale(4); // clean mode is 4x-only
                  }}
                >
                  <option value="photo">Photo</option>
                  <option value="anime">Anime</option>
                  <option value="clean">Clean (ESRNet 4×)</option>
                </select>
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
              <div className="control-group">
                <span className="label">Text-safe</span>
                <label className="switch">
                  <input
                    type="checkbox"
                    checked={textSafe}
                    onChange={(e) => {
                      const v = e.target.checked;
                      setTextSafe(v);
                      if (v) {
                        setFaceRestore(false);
                        if (sharpenStrength < 0.25) setSharpenStrength(0.25);
                        setMode("photo");
                      }
                    }}
                  />
                  <span className="slider" />
                </label>
              </div>
              <div className="control-group slider-group">
                <span className="label">Sharpen</span>
                <div className="range-field">
                  <input
                    type="range"
                    min="0"
                    max="0.6"
                    step="0.05"
                    value={sharpenStrength}
                    onChange={(e) => setSharpenStrength(Number(e.target.value))}
                  />
                  <span className="range-value">{sharpenStrength.toFixed(2)}</span>
                </div>
              </div>
            </section>

            <section className="advanced">
              <div className="advanced-head">
                <div>
                  <span className="label">Advanced overrides</span>
                  <p className="hint small">Tone tweaks apply per request and reset anytime.</p>
                </div>
                <div className="advanced-actions">
                  <button type="button" className="ghost small" onClick={() => setAdvancedOpen((v) => !v)}>
                    {advancedOpen ? "Hide tweaks" : "Show tweaks"}
                  </button>
                  <button type="button" className="ghost small" onClick={resetAdvanced}>
                    Reset tweaks
                  </button>
                </div>
              </div>

              {advancedOpen && (
                <div className="controls advanced-grid">
                  <div className="control-group">
                    <span className="label">Auto-enhance</span>
                    <label className="switch">
                      <input type="checkbox" checked={autoEnhance} onChange={(e) => setAutoEnhance(e.target.checked)} />
                      <span className="slider" />
                    </label>
                  </div>
                  <div className="control-group">
                    <span className="label">Document preset</span>
                    <button
                      type="button"
                      className="ghost small"
                      onClick={() => {
                        setTextSafe(true);
                        setFaceRestore(false);
                        setSharpenStrength((v) => (v < 0.25 ? 0.25 : v));
                      }}
                    >
                      Text-safe boost
                    </button>
                  </div>
                    <div className="control-group">
                      <span className="label">Tone preset</span>
                      <select
                        className="select"
                        value={tonePreset}
                        onChange={(e) => applyTonePreset(e.target.value)}
                      >
                        <option value="none">None</option>
                        <option value="night">Night fix</option>
                        <option value="portrait">Portrait clean</option>
                        <option value="print">Print-ready</option>
                      </select>
                    </div>
                    <div className="control-group slider-group">
                      <span className="label">Preset intensity</span>
                      <div className="range-field">
                        <input
                          type="range"
                          min="0.6"
                          max="1.6"
                          step="0.05"
                          value={presetIntensity}
                          onChange={(e) => setPresetIntensity(Number(e.target.value))}
                          disabled={tonePreset === "none"}
                        />
                        <span className="range-value">{presetIntensity.toFixed(2)}</span>
                      </div>
                    </div>
                    <div className="control-group slider-group">
                      <span className="label">Denoise</span>
                      <div className="range-field">
                        <input
                          type="range"
                          min="0"
                          max="0.3"
                          step="0.02"
                          value={denoiseStrength}
                          onChange={(e) => setDenoiseStrength(Number(e.target.value))}
                        />
                        <span className="range-value">{denoiseStrength.toFixed(2)}</span>
                      </div>
                    </div>
                  <div className="control-group slider-group">
                      <span className="label">Brightness</span>
                      <div className="range-field">
                        <input
                          type="range"
                          min="0.5"
                          max="1.5"
                          step="0.05"
                          value={brightness}
                          onChange={(e) => setBrightness(Number(e.target.value))}
                        />
                        <span className="range-value">{brightness.toFixed(2)}</span>
                      </div>
                    </div>
                    <div className="control-group slider-group">
                    <span className="label">Exposure</span>
                    <div className="range-field">
                      <input
                        type="range"
                        min="0.5"
                        max="1.5"
                        step="0.05"
                        value={exposure}
                        onChange={(e) => setExposure(Number(e.target.value))}
                      />
                      <span className="range-value">{exposure.toFixed(2)}</span>
                    </div>
                  </div>
                  <div className="control-group slider-group">
                    <span className="label">Contrast</span>
                    <div className="range-field">
                      <input
                        type="range"
                        min="0.5"
                        max="1.5"
                        step="0.05"
                        value={contrast}
                        onChange={(e) => setContrast(Number(e.target.value))}
                      />
                      <span className="range-value">{contrast.toFixed(2)}</span>
                    </div>
                  </div>
                  <div className="control-group slider-group">
                    <span className="label">Saturation</span>
                    <div className="range-field">
                      <input
                        type="range"
                        min="0.5"
                        max="1.5"
                        step="0.05"
                        value={saturation}
                        onChange={(e) => setSaturation(Number(e.target.value))}
                      />
                      <span className="range-value">{saturation.toFixed(2)}</span>
                    </div>
                  </div>
                </div>
              )}
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
                {inputHint && <p className="hint inline-hint">{inputHint}</p>}
                {loading && <div className="spinner" aria-label="Processing" />}
              </div>
            </section>

            {error && <div className="alert">{error}</div>}

            {beforeUrl && (
              <section className="compare">
                <div className="panel-head">
                  <span className="chip">Before / After</span>
                  {status && <span className="meta status-pill">{status}</span>}
                  <button
                    type="button"
                    className="ghost small"
                    onClick={() => setShowAfter((v) => !v)}
                    disabled={!afterUrl}
                  >
                    {showAfter ? "Show Before" : "Show After"}
                  </button>
                </div>
                <div className="compare-body">
                  {showPreviewOverlay && (
                    <div className="preview-overlay" role="status" aria-live="polite">
                      {loading && <div className="preview-spinner" aria-label={status || "Processing"} />}
                      <div className="preview-status-text">{loading ? status || "Working…" : "Error"}</div>
                      {loading && inputHint && <div className="preview-hint">{inputHint}</div>}
                      {error && <div className="preview-error">{error}</div>}
                    </div>
                  )}
                  <div className="compare-frame">
                    {loading && !afterUrl ? (
                      <div className="skeleton skeleton-img" aria-label="Loading preview" />
                    ) : (
                      <img
                        src={showAfter && afterUrl ? afterUrl : beforeUrl}
                        alt={showAfter && afterUrl ? "After" : "Before"}
                        className="compare-img"
                      />
                    )}
                  </div>
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
                      className={`pill ${scale === value ? "active" : ""}`}
                      onClick={() => setScale(value)}
                      type="button"
                      disabled={(mode === "anime" || mode === "clean") && value === 2}
                      title={value === 2 && (mode === "anime" || mode === "clean") ? "Only 4x is available for this mode" : undefined}
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
