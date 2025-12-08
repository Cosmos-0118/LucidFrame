import React from "react";

function ImageDropzone({ loading, inputHint, onFile, onSelect, inputRef }) {
  return (
    <section
      className={`dropzone ${loading ? "is-loading" : ""}`}
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
        accept="image/*"
        hidden
        onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])}
      />
      <div className="drop-inner">
        <div className="badge">Step 4.2</div>
        <p className="drop-title">Drop an image or click to browse</p>
        <p className="hint">We send it to the backend and stream back a PNG.</p>
        {inputHint && <p className="hint inline-hint">{inputHint}</p>}
        {loading && <div className="spinner" aria-label="Processing" />}
      </div>
    </section>
  );
}

export default ImageDropzone;
