import React, { useCallback, useEffect, useRef, useState } from "react";
import { cleanUrl } from "../utils";

function VideoSection({ backendUrl }) {
  const videoInputRef = useRef(null);
  const pollRef = useRef(null);

  const [videoScale, setVideoScale] = useState(2);
  const [videoInterpolate, setVideoInterpolate] = useState(false);
  const [videoFace, setVideoFace] = useState(false);
  const [videoStatus, setVideoStatus] = useState("Drop a video to start");
  const [videoError, setVideoError] = useState("");
  const [videoJobId, setVideoJobId] = useState("");
  const [videoLoading, setVideoLoading] = useState(false);
  const [videoSrcUrl, setVideoSrcUrl] = useState("");
  const [videoOutUrl, setVideoOutUrl] = useState("");

  useEffect(() => {
    return () => {
      if (pollRef.current) clearTimeout(pollRef.current);
      if (videoSrcUrl) URL.revokeObjectURL(videoSrcUrl);
      if (videoOutUrl) URL.revokeObjectURL(videoOutUrl);
    };
  }, [videoOutUrl, videoSrcUrl]);

  const clearVideoInput = () => {
    if (videoInputRef.current) videoInputRef.current.value = "";
  };

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

  const onVideoFile = (file) => {
    if (!file) return;
    startVideoJob(file);
    clearVideoInput();
  };

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

  const downloadVideo = () => {
    if (!videoOutUrl) return;
    const link = document.createElement("a");
    link.href = videoOutUrl;
    link.download = "lucidframe.mp4";
    link.click();
  };

  return (
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
            <input type="checkbox" checked={videoInterpolate} onChange={(e) => setVideoInterpolate(e.target.checked)} />
            <span className="slider" />
          </label>
        </div>
        <div className="control-group">
          <span className="label">Face restore</span>
          <label className="switch">
            <input type="checkbox" checked={videoFace} onChange={(e) => setVideoFace(e.target.checked)} />
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
        onClick={() => videoInputRef.current?.click()}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") videoInputRef.current?.click();
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
            {videoSrcUrl ? <video src={videoSrcUrl} controls className="video-player" /> : <p className="placeholder">No video yet</p>}
          </div>
        </div>
        <div className="panel">
          <div className="panel-head">
            <span className="chip">Output</span>
            <span className="meta">Preview + download</span>
          </div>
          <div className="panel-body">
            {videoOutUrl ? <video src={videoOutUrl} controls className="video-player" /> : <p className="placeholder">Waiting for completion</p>}
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
  );
}

export default VideoSection;
