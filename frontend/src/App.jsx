import React, { useCallback, useEffect, useRef, useState } from "react";
import Header from "./components/Header";
import Tabs from "./components/Tabs";
import ImageControls from "./components/ImageControls";
import ImageDropzone from "./components/ImageDropzone";
import ImageCompare from "./components/ImageCompare";
import VideoControls from "./components/VideoControls";
import VideoDropzone from "./components/VideoDropzone";
import VideoPanels from "./components/VideoPanels";
import SettingsPanel from "./components/SettingsPanel";

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

  const applyDocumentPreset = useCallback(() => {
    setTextSafe(true);
    setFaceRestore(false);
    setSharpenStrength((v) => (v < 0.25 ? 0.25 : v));
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

        <Header
          backendUrl={backendUrl}
          setBackendUrl={setBackendUrl}
          fetchHealth={fetchHealth}
          healthLoading={healthLoading}
        />

        <Tabs activeTab={activeTab} onChange={setActiveTab} />

        {activeTab === "image" && (
          <>
            <ImageControls
              mode={mode}
              scale={scale}
              setMode={setMode}
              setScale={setScale}
              faceRestore={faceRestore}
              setFaceRestore={setFaceRestore}
              textSafe={textSafe}
              setTextSafe={setTextSafe}
              sharpenStrength={sharpenStrength}
              setSharpenStrength={setSharpenStrength}
              advancedOpen={advancedOpen}
              setAdvancedOpen={setAdvancedOpen}
              autoEnhance={autoEnhance}
              setAutoEnhance={setAutoEnhance}
              applyTonePreset={applyTonePreset}
              tonePreset={tonePreset}
              presetIntensity={presetIntensity}
              setPresetIntensity={setPresetIntensity}
              denoiseStrength={denoiseStrength}
              setDenoiseStrength={setDenoiseStrength}
              brightness={brightness}
              setBrightness={setBrightness}
              exposure={exposure}
              setExposure={setExposure}
              contrast={contrast}
              setContrast={setContrast}
              saturation={saturation}
              setSaturation={setSaturation}
              resetAdvanced={resetAdvanced}
              onDocumentPreset={applyDocumentPreset}
            />

            <ImageDropzone loading={loading} inputHint={inputHint} onFile={onImageFile} onSelect={handleImageSelect} inputRef={imageInputRef} />

            {error && <div className="alert">{error}</div>}

            {beforeUrl && (
              <ImageCompare
                beforeUrl={beforeUrl}
                afterUrl={afterUrl}
                status={status}
                showAfter={showAfter}
                setShowAfter={setShowAfter}
                loading={loading}
                inputHint={inputHint}
                error={error}
              />
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
            <VideoControls
              mode={mode}
              videoScale={videoScale}
              setVideoScale={setVideoScale}
              videoInterpolate={videoInterpolate}
              setVideoInterpolate={setVideoInterpolate}
              videoFace={videoFace}
              setVideoFace={setVideoFace}
              videoStatus={videoStatus}
              videoLoading={videoLoading}
            />

            <VideoDropzone
              videoLoading={videoLoading}
              onFile={onVideoFile}
              onSelect={handleVideoSelect}
              inputRef={videoInputRef}
            />

            {videoError && <div className="alert">{videoError}</div>}

            <VideoPanels videoSrcUrl={videoSrcUrl} videoOutUrl={videoOutUrl} videoJobId={videoJobId} />

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

        <SettingsPanel
          modelDir={modelDir}
          setModelDir={setModelDir}
          ffmpegPath={ffmpegPath}
          setFfmpegPath={setFfmpegPath}
          tileSize={tileSize}
          setTileSize={setTileSize}
          useFp16={useFp16}
          setUseFp16={setUseFp16}
          health={health}
        />
      </div>
    </div>
  );
}

export default App;
