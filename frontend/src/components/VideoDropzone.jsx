import React from "react";

function VideoDropzone({ videoLoading, onFile, onSelect, inputRef }) {
  return (
    <section
      className={`dropzone ${videoLoading ? "is-loading" : ""}`}
      onDrop={(e) => {
        e.preventDefault();
        const file = e.dataTransfer.files?.[0];
        if (file) onFile(file);
      }}
      onDragOver={(e) => e.preventDefault()}
      onClick={onSelect}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") onSelect();
      }}
    >
      <input
        ref={inputRef}
        type="file"
        accept="video/*"
        hidden
        onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])}
      />
      <div className="drop-inner">
        <div className="badge">Step 4.3</div>
        <p className="drop-title">Drop a video or click to browse</p>
        <p className="hint">Starts a backend job and polls until ready.</p>
        {videoLoading && <div className="spinner" aria-label="Processing" />}
      </div>
    </section>
  );
}

export default VideoDropzone;
