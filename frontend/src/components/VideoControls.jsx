import React from "react";

function VideoControls({
  mode,
  videoScale,
  setVideoScale,
  videoInterpolate,
  setVideoInterpolate,
  videoFace,
  setVideoFace,
  videoStatus,
  videoLoading,
}) {
  return (
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
              disabled={(mode === "anime" || mode === "clean") && value === 2}
              title={
                value === 2 && (mode === "anime" || mode === "clean")
                  ? "Only 4x is available for this mode"
                  : undefined
              }
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
          <input type="checkbox" checked={videoFace} onChange={(e) => setVideoFace(e.target.checked)} />
          <span className="slider" />
        </label>
      </div>
      <div className="control-group status">
        <span className="label">Status</span>
        <p className="status-text">{videoLoading ? "Working…" : videoStatus}</p>
      </div>
    </section>
  );
}

export default VideoControls;
